// Package config 集中存放 MQTT 连接参数。
//
// 原始参数写在一个 const 块里，这里导出成首字母大写，方便 pub/sub 两个
// 可执行程序共用；以后要改成从配置文件或环境变量读取，只动这个包即可。
package config

import (
	"fmt"
	"os"
)

const (
	Broker   = "127.0.0.1"
	Port     = 1883
	ClientID = "esp32_001"
	QoS      = 1

	// 简单 pub/sub 脚本用的主题。
	Topic = "device/esp32_001/telemetry"

	// cmd/device（进阶版）用的主题，按 <业务>/<设备>/up|down 规范组织。
	// 用常量拼接 ClientID，改设备名时只需要动上面那一行。
	TelemetryTopic = "warehouse/shelf/" + ClientID + "/up/telemetry"
	StatusTopic    = "warehouse/shelf/" + ClientID + "/status"
	CmdTopic       = "warehouse/shelf/" + ClientID + "/down/led_ctrl"
)

// Addr 返回 paho 需要的 broker 地址，例如 tcp://127.0.0.1:1883。
//
// 设置 MQTT_ADDR 可以临时指向别的 broker（例如另一个开了 -v 的调试实例），
// 不用改代码：MQTT_ADDR=tcp://127.0.0.1:1884 go run ./cmd/publisher
func Addr() string {
	if addr := os.Getenv("MQTT_ADDR"); addr != "" {
		return addr
	}
	return fmt.Sprintf("tcp://%s:%d", Broker, Port)
}
