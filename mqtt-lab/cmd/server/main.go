// server 是订阅端的进阶版：一个常驻的"后端服务"，负责感知所有设备上下线、
// 并向指定设备下发控制指令。
//
//  1. 监听所有设备状态：通配订阅 AllStatusTopic（+ 匹配一层设备 ID）；
//  2. 指令下发：控制台输入 led_on|led_off [deviceID]，按设备 ID 拼下发主题。
//
// 与 cmd/subscriber 的区别：后者是固定主题的调试订阅器；这里是服务，用持久会话
// （CleanSession=false）保证重连期间的状态变化不丢，ClientID 固定为 backend_server_001。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"mqtt-lab/config"
	"mqtt-lab/internal/mqttx"
)

// TelemetryData 与 cmd/device 上报的结构保持一致。
type TelemetryData struct {
	DeviceID    string  `json:"device_id"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	LedStatus   string  `json:"led_status"`
	Timestamp   int64   `json:"timestamp"`
}

// StatusData 注意 json 字段是 timestamp，和设备端的定义对齐（原稿写的是 time，会解析成 0）。
type StatusData struct {
	DeviceID  string `json:"device_id"`
	Status    string `json:"status"`
	Timestamp int64  `json:"timestamp"`
}

// CmdData 下发给设备的指令。
type CmdData struct {
	Cmd       string `json:"cmd"`
	Timestamp int64  `json:"time"`
}

func main() {
	log.SetFlags(log.Lmicroseconds)

	// 同一 ClientID 只能有一个实例：否则两个进程会互相踢下线、疯狂重连。
	release, err := mqttx.AcquireLock(config.ServerClientID)
	if err != nil {
		log.Fatal(err)
	}
	defer release()

	client, err := mqttx.ConnectWith(mqttx.Options{
		ClientID:     config.ServerClientID,
		CleanSession: false,
		KeepAlive:    60 * time.Second,
		OnConnect: func(c mqtt.Client) {
			// OnConnect 跑在 paho 的内部协程里，订阅放到独立协程，避免阻塞消息分发。
			go subscribeAll(c)
		},
		// 持久会话重连时 broker 会紧接着 CONNACK 补发离线消息，那时订阅还没完成；
		// 用默认处理器兜底，按主题分流后交给同一套处理函数。
		DefaultHandler: dispatch,
	})
	if err != nil {
		log.Fatalf("connect failed: %v", err)
	}

	go handleConsoleInput(client)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	client.Disconnect(250)
	log.Println("bye")
}

// subscribeAll 在每次（重）连成功后调用；重复订阅同一 filter 是幂等的。
func subscribeAll(c mqtt.Client) {
	// 状态主题是 retained 的，订阅成功后 broker 会立刻把每台设备的当前状态推过来，
	// 相当于启动时就拿到一份"设备状态快照"。
	if err := subscribe(c, config.AllStatusTopic, handleStatus); err != nil {
		log.Printf("subscribe %q: %v", config.AllStatusTopic, err)
	} else {
		log.Printf("subscribed %q", config.AllStatusTopic)
	}

	if err := subscribe(c, config.AllTelemetryTopic, handleTelemetry); err != nil {
		log.Printf("subscribe %q: %v", config.AllTelemetryTopic, err)
	} else {
		log.Printf("subscribed %q", config.AllTelemetryTopic)
	}
}

func subscribe(c mqtt.Client, topic string, h mqtt.MessageHandler) error {
	token := c.Subscribe(topic, byte(config.QoS), h)
	if !token.WaitTimeout(5 * time.Second) {
		return fmt.Errorf("timeout")
	}
	return token.Error()
}

// dispatch 是 DefaultHandler：只处理自己认识的主题，其余忽略。
func dispatch(_ mqtt.Client, msg mqtt.Message) {
	switch {
	case strings.HasSuffix(msg.Topic(), "/status"):
		handleStatus(nil, msg)
	case strings.HasSuffix(msg.Topic(), "/up/telemetry"):
		handleTelemetry(nil, msg)
	}
}

// handleStatus 感知设备上下线；retained=true 的那条是设备当前状态，不是新事件。
func handleStatus(_ mqtt.Client, msg mqtt.Message) {
	var data StatusData
	if err := json.Unmarshal(msg.Payload(), &data); err != nil {
		log.Printf("invalid status on %s: %v", msg.Topic(), err)
		return
	}
	if data.DeviceID == "" {
		data.DeviceID = deviceIDFromTopic(msg.Topic())
	}
	log.Printf("<- status %s = %s (retained=%v)", data.DeviceID, data.Status, msg.Retained())
}

func handleTelemetry(_ mqtt.Client, msg mqtt.Message) {
	var data TelemetryData
	if err := json.Unmarshal(msg.Payload(), &data); err != nil {
		log.Printf("invalid telemetry on %s: %v", msg.Topic(), err)
		return
	}
	if data.DeviceID == "" {
		data.DeviceID = deviceIDFromTopic(msg.Topic())
	}
	log.Printf("<- telemetry %s: %.1fC %.1f%% led=%s", data.DeviceID, data.Temperature, data.Humidity, data.LedStatus)
}

// deviceIDFromTopic 从 warehouse/shelf/<id>/... 中取出设备 ID。
func deviceIDFromTopic(topic string) string {
	parts := strings.Split(topic, "/")
	if len(parts) >= 3 {
		return parts[2]
	}
	return topic
}

// handleConsoleInput 读取控制台输入下发指令：led_on [deviceID]，不写设备 ID 时用 config.ClientID。
func handleConsoleInput(c mqtt.Client) {
	log.Printf("commands: led_on|led_off [deviceID], default device %q", config.ClientID)

	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 {
			continue
		}

		cmd := fields[0]
		if cmd != "led_on" && cmd != "led_off" {
			log.Printf("unknown command %q, use led_on|led_off [deviceID]", cmd)
			continue
		}

		deviceID := config.ClientID
		if len(fields) > 1 {
			deviceID = fields[1]
		}

		if err := publishCmd(c, deviceID, cmd); err != nil {
			log.Printf("publish cmd %s to %s: %v", cmd, deviceID, err)
			continue
		}
		log.Printf("-> cmd %s to %s", cmd, deviceID)
	}
	if err := scanner.Err(); err != nil {
		log.Printf("stdin: %v", err)
	}
}

func publishCmd(c mqtt.Client, deviceID, cmd string) error {
	payload, err := json.Marshal(CmdData{Cmd: cmd, Timestamp: time.Now().Unix()})
	if err != nil {
		return err
	}

	// retain=false：指令是一次性动作。若用 retained，设备每次重连/重启都会被重放一遍
	// （比如重启后灯又被打开）；设备离线时的补发由持久会话的离线队列负责。
	token := c.Publish(config.CmdTopicFor(deviceID), byte(config.QoS), false, payload)
	if !token.WaitTimeout(3 * time.Second) {
		return fmt.Errorf("timeout")
	}
	return token.Error()
}
