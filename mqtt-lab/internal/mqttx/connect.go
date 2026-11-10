// Package mqttx 封装两个测试脚本共用的连接逻辑。
package mqttx

import (
	"fmt"
	"log"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"mqtt-lab/config"
)

// Will 是遗嘱消息：客户端异常断线时由 broker 代为发布，正常 DISCONNECT 不会触发。
type Will struct {
	Topic   string
	Payload []byte
	QoS     byte
	Retain  bool
}

// Options 是连接参数。零值可用：CleanSession=false、KeepAlive 取 30s、不设遗嘱。
type Options struct {
	ClientID string

	// CleanSession=false 才是持久会话，前提是 ClientID 固定不变，
	// 否则 broker 会当成另一台设备，订阅和离线消息都对不上。
	CleanSession bool

	// KeepAlive 为 0 时默认 30s。
	KeepAlive time.Duration

	// Will 为 nil 时不设置遗嘱。
	Will *Will

	// OnConnect 在每次（包括重连后）握手成功时调用，适合放"上报在线状态 + 重新订阅"。
	OnConnect func(mqtt.Client)

	// DefaultHandler 接收"本地还没有对应订阅路由"的消息。
	// 持久会话重连时 broker 会在 CONNACK 之后立刻补发离线消息，而 OnConnect 里的订阅
	// 往往还没走完，没有它这些消息会被 paho 直接丢掉。
	DefaultHandler func(mqtt.Client, mqtt.Message)
}

// Connect 建立默认配置的连接，供简单的 pub/sub 脚本使用。
func Connect(clientID string) (mqtt.Client, error) {
	return ConnectWith(Options{ClientID: clientID})
}

// ConnectWith 按 Options 建立连接并同步等待 CONNACK。
//
// 故意关掉 ConnectRetry：首次连接失败要立刻报错退出，而不是静默重试，
// 方便确认 broker 是否启动、端口是否可达；连上之后的断线重连由 AutoReconnect 负责。
func ConnectWith(o Options) (mqtt.Client, error) {
	if o.KeepAlive <= 0 {
		o.KeepAlive = 30 * time.Second
	}

	opts := mqtt.NewClientOptions().
		AddBroker(config.Addr()).
		SetClientID(o.ClientID).
		SetCleanSession(o.CleanSession).
		SetAutoReconnect(true).
		SetConnectRetry(false).
		SetConnectTimeout(5 * time.Second).
		SetMaxReconnectInterval(10 * time.Second).
		SetKeepAlive(o.KeepAlive)

	if o.Will != nil {
		opts.SetWill(o.Will.Topic, string(o.Will.Payload), o.Will.QoS, o.Will.Retain)
	}

	if o.DefaultHandler != nil {
		opts.SetDefaultPublishHandler(o.DefaultHandler)
	}

	opts.SetOnConnectHandler(func(c mqtt.Client) {
		if o.CleanSession {
			log.Printf("[%s] connected to %s (clean session)", o.ClientID, config.Addr())
		} else {
			log.Printf("[%s] connected to %s (persistent session)", o.ClientID, config.Addr())
		}
		if o.OnConnect != nil {
			o.OnConnect(c)
		}
	})
	opts.SetConnectionLostHandler(func(_ mqtt.Client, err error) {
		log.Printf("[%s] connection lost: %v, reconnecting...", o.ClientID, err)
	})

	c := mqtt.NewClient(opts)
	token := c.Connect()
	if !token.WaitTimeout(5 * time.Second) {
		return nil, fmt.Errorf("connect to %s: timeout", config.Addr())
	}
	if err := token.Error(); err != nil {
		return nil, fmt.Errorf("connect to %s: %w", config.Addr(), err)
	}
	return c, nil
}
