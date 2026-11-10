// subscriber 订阅遥测主题并打印消息元信息。
//
// 观察点：日志里的 qos 是 broker 实际投递时使用的 QoS —— 订阅时申请 QoS 1，
// 但真正生效的是 min(发布 QoS, 订阅 QoS)，所以可以用它验证降级行为。
package main

import (
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"

	"mqtt-lab/config"
	"mqtt-lab/internal/mqttx"
)

const clientIDSuffix = "_sub"

func main() {
	log.SetFlags(log.Lmicroseconds)

	client, err := mqttx.Connect(config.ClientID + clientIDSuffix)
	if err != nil {
		log.Fatalf("connect failed: %v", err)
	}
	defer client.Disconnect(250)

	token := client.Subscribe(config.Topic, byte(config.QoS), onMessage)
	if !token.WaitTimeout(5 * time.Second) {
		log.Fatalf("subscribe timeout")
	}
	if err := token.Error(); err != nil {
		log.Fatalf("subscribe %q: %v", config.Topic, err)
	}
	log.Printf("subscribed topic=%q qos=%d, waiting for messages, Ctrl+C to stop", config.Topic, config.QoS)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	client.Unsubscribe(config.Topic)
	log.Println("bye")
}

func onMessage(_ mqtt.Client, msg mqtt.Message) {
	log.Printf("<- topic=%s qos=%d retained=%v dup=%v payload=%s",
		msg.Topic(), msg.Qos(), msg.Retained(), msg.Duplicate(), msg.Payload())
}
