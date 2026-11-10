// publisher 模拟 ESP32 设备，按固定周期向 telemetry 主题发布数据。
//
// 观察点：QoS 1 下每条 PUBLISH 都要等 broker 回 PUBACK，日志里会先打印
// "-> publish"，等 token 完成后再打印 "PUBACK received"。
package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"syscall"
	"time"

	"mqtt-lab/config"
	"mqtt-lab/internal/mqttx"
)

// clientID 后缀不能少：broker 认为 ClientID 唯一，两个进程用同一个 ID 会互相踢下线。
const clientIDSuffix = "_pub"

// telemetry 是设备上报的负载，用 JSON 便于订阅端直接解析。
type telemetry struct {
	DeviceID    string  `json:"device_id"`
	Temperature float64 `json:"temperature"`
	Humidity    float64 `json:"humidity"`
	Timestamp   int64   `json:"ts"`
}

func main() {
	log.SetFlags(log.Lmicroseconds)

	client, err := mqttx.Connect(config.ClientID + clientIDSuffix)
	if err != nil {
		log.Fatalf("connect failed: %v", err)
	}
	defer client.Disconnect(250)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	log.Printf("publishing to topic=%q qos=%d every 2s, Ctrl+C to stop", config.Topic, config.QoS)

	for {
		select {
		case <-stop:
			log.Println("bye")
			return
		case <-ticker.C:
			payload, err := json.Marshal(newTelemetry())
			if err != nil {
				log.Printf("marshal: %v", err)
				continue
			}

			// retained=false：遥测只对在线订阅者有意义，不需要 broker 保留最后一条。
			token := client.Publish(config.Topic, byte(config.QoS), false, payload)
			log.Printf("-> publish %s", payload)

			// QoS 0 时这里是 nil-ish 立即完成，QoS 1 时才真正代表收到 PUBACK。
			if !token.WaitTimeout(3 * time.Second) {
				log.Printf("publish timeout (no PUBACK)")
				continue
			}
			if err := token.Error(); err != nil {
				log.Printf("publish failed: %v", err)
				continue
			}
			log.Printf("PUBACK received")
		}
	}
}

func newTelemetry() telemetry {
	return telemetry{
		DeviceID:    config.ClientID,
		Temperature: 20 + rand.Float64()*5, // 20~25℃
		Humidity:    45 + rand.Float64()*10,
		Timestamp:   time.Now().Unix(),
	}
}
