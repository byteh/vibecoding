// device 是进阶版模拟设备，把四个能力落在现有架构上：
//
//  1. 断网自动重连 + 持久会话：CleanSession=false + 固定 ClientID（config.ClientID）；
//  2. 遗嘱消息：连接时通过 mqttx.Options.Will 注册，异常断线由 broker 代发 offline；
//  3. 保留状态：publishStatus 用 retained=true，后上线的订阅者立刻拿到当前状态；
//  4. 下行指令：每次（重）连成功后订阅 CmdTopic，回调里改 LED 状态。
//
// 与 cmd/publisher 的区别：publisher 是一次性的上报脚本，这里是有生命周期的"设备"，
// 所以 ClientID 不需要加后缀——它本来就是独立的一台设备；但同一 ClientID 只能有一个实例在跑。
package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"mqtt-lab/config"
	"mqtt-lab/internal/mqttx"
)

// TelemetryData 遥测数据。
type TelemetryData struct {
	DeviceID    string  `json:"device_id"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	LedStatus   string  `json:"led_status"`
	Timestamp   int64   `json:"timestamp"`
}

// StatusData 设备状态，online/offline 都发到 StatusTopic 上。
type StatusData struct {
	DeviceID  string `json:"device_id"`
	Status    string `json:"status"`
	Timestamp int64  `json:"timestamp"`
}

// CmdData 下行指令。
type CmdData struct {
	Cmd       string `json:"cmd"` // led_on / led_off
	Timestamp int64  `json:"time"`
}

// device 只保存本地状态；client 由各函数传参，避免回调与主循环间的竞态。
type device struct {
	mu  sync.RWMutex
	led string
}

func (d *device) setLED(state string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.led = state
}

func (d *device) ledState() string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.led
}

func main() {
	log.SetFlags(log.Lmicroseconds)

	d := &device{led: "off"}

	// 遗嘱的 payload 在连接时就被 broker 记下了，时间戳是连接时间而不是掉线时间。
	willPayload, err := json.Marshal(newStatus("offline"))
	if err != nil {
		log.Fatalf("marshal will: %v", err)
	}

	client, err := mqttx.ConnectWith(mqttx.Options{
		// 持久会话要求 ClientID 稳定，所以这里直接用配置里的设备 ID。
		ClientID:     config.ClientID,
		CleanSession: false,
		KeepAlive:    60 * time.Second,
		Will: &mqttx.Will{
			Topic:   config.StatusTopic,
			Payload: willPayload,
			QoS:     byte(config.QoS),
			// retain=true：设备掉线后，任何后订阅 status 的人也能看到 offline。
			Retain: true,
		},
		OnConnect: func(c mqtt.Client) {
			// OnConnect 跑在 paho 的内部协程里，这里不阻塞等待 token，
			// 把"上报在线状态 + 订阅指令"放到独立协程执行。
			go func() {
				publishStatus(c, "online")
				subscribeCmd(c, d)
			}()
		},
		// 持久会话重连时，broker 补发的离线指令会在订阅完成之前到达，
		// 用默认处理器兜底，避免被丢掉。
		DefaultHandler: d.onCmd,
	})
	if err != nil {
		log.Fatalf("connect failed: %v", err)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	log.Printf("device %s running: publish %q, subscribe %q", config.ClientID, config.TelemetryTopic, config.CmdTopic)

	for {
		select {
		case <-stop:
			// 正常 DISCONNECT 不会触发遗嘱，所以主动补一条 retained 的 offline。
			publishStatus(client, "offline")
			client.Disconnect(250)
			log.Println("bye")
			return
		case <-ticker.C:
			publishTelemetry(client, d)
		}
	}
}

func newStatus(status string) StatusData {
	return StatusData{
		DeviceID:  config.ClientID,
		Status:    status,
		Timestamp: time.Now().Unix(),
	}
}

// publishStatus 上报设备状态；retained 让新订阅者不必等下一次上报。
func publishStatus(c mqtt.Client, status string) {
	payload, err := json.Marshal(newStatus(status))
	if err != nil {
		log.Printf("marshal status: %v", err)
		return
	}

	token := c.Publish(config.StatusTopic, byte(config.QoS), true, payload)
	if !token.WaitTimeout(3 * time.Second) {
		log.Printf("publish status %q: timeout", status)
		return
	}
	if err := token.Error(); err != nil {
		log.Printf("publish status %q: %v", status, err)
		return
	}
	log.Printf("-> status %q (retained)", status)
}

func publishTelemetry(c mqtt.Client, d *device) {
	data := TelemetryData{
		DeviceID:    config.ClientID,
		Temperature: 22 + rand.Float64()*8,
		Humidity:    50 + rand.Float64()*20,
		LedStatus:   d.ledState(),
		Timestamp:   time.Now().Unix(),
	}
	payload, err := json.Marshal(data)
	if err != nil {
		log.Printf("marshal telemetry: %v", err)
		return
	}

	// 遥测不需要 retained：它只在设备存活期间有意义，离线状态由 status 主题表达。
	token := c.Publish(config.TelemetryTopic, byte(config.QoS), false, payload)
	if !token.WaitTimeout(3 * time.Second) {
		log.Printf("publish telemetry: timeout")
		return
	}
	if err := token.Error(); err != nil {
		log.Printf("publish telemetry: %v", err)
		return
	}
	log.Printf("-> telemetry %.1fC led=%s", data.Temperature, data.LedStatus)
}

// subscribeCmd 订阅下行指令。OnConnect 每次重连都会调它，重复订阅同一 filter 是幂等的，
// 但如果 broker 重启过、持久会话丢了，这一步就是恢复订阅的关键。
func subscribeCmd(c mqtt.Client, d *device) {
	token := c.Subscribe(config.CmdTopic, byte(config.QoS), d.onCmd)
	if !token.WaitTimeout(5 * time.Second) {
		log.Printf("subscribe %q: timeout", config.CmdTopic)
		return
	}
	if err := token.Error(); err != nil {
		log.Printf("subscribe %q: %v", config.CmdTopic, err)
		return
	}
	log.Printf("subscribed %q", config.CmdTopic)
}

// onCmd 在 paho 的消息分发协程里执行，只改本地状态、不阻塞等待 token。
// 它同时是 CmdTopic 的订阅回调，也是 Options.DefaultHandler，所以要自己过滤主题。
func (d *device) onCmd(_ mqtt.Client, msg mqtt.Message) {
	if msg.Topic() != config.CmdTopic {
		return
	}

	var cmd CmdData
	if err := json.Unmarshal(msg.Payload(), &cmd); err != nil {
		log.Printf("<- invalid cmd: %v", err)
		return
	}

	switch cmd.Cmd {
	case "led_on":
		d.setLED("on")
	case "led_off":
		d.setLED("off")
	default:
		log.Printf("<- unknown cmd %q, ignored", cmd.Cmd)
		return
	}
	log.Printf("<- cmd %s, led=%s", cmd.Cmd, d.ledState())
}
