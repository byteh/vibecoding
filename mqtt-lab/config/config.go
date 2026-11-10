// Package config 集中存放 MQTT 连接参数。
//
// 原始参数写在一个 const 块里，这里导出成首字母大写，方便 pub/sub 两个
// 可执行程序共用；以后要改成从配置文件或环境变量读取，只动这个包即可。
package config

import (
	"fmt"
	"os"
	"time"
)

const (
	Broker = "127.0.0.1"
	Port   = 1883
	QoS    = 1

	// 多设备模拟：cmd/device 启动时按 1..MaxDevices 顺序抢占空闲槽位，
	// 生成 esp32_001 / esp32_002 / esp32_003 这样的 ClientID。
	// 想同时模拟更多设备，改 MaxDevices 即可（每个进程占一个槽位）。
	DeviceIDPrefix = "esp32"
	MaxDevices     = 3

	// 默认设备 ID：简单 pub/sub 脚本和 server 的默认下发目标用它。
	ClientID = DeviceIDPrefix + "_001"

	// 设备上报遥测的周期（cmd/device 的定时器）。
	TelemetryInterval = 10 * time.Second

	// 简单 pub/sub 脚本用的主题。
	Topic = "device/esp32_001/telemetry"

	// 进阶版（cmd/device 与 cmd/server）的主题，按 <业务>/<设备>/up|down 组织。
	// 这些常量只对应默认设备，多设备场景用下面的 *TopicFor 函数按 ID 生成。
	TopicPrefix    = "warehouse/shelf/"
	TelemetryTopic = TopicPrefix + ClientID + "/up/telemetry"
	StatusTopic    = TopicPrefix + ClientID + "/status"
	CmdTopic       = TopicPrefix + ClientID + "/down/led_ctrl"

	// cmd/server 的身份与通配订阅：+ 只匹配一层，正好对应一台设备的 ID。
	ServerClientID    = "backend_server_001"
	AllTelemetryTopic = TopicPrefix + "+/up/telemetry"
	AllStatusTopic    = TopicPrefix + "+/status"
)

// DeviceID 返回第 i 台设备的 ClientID（i 从 1 开始）：esp32_001、esp32_002 ...
func DeviceID(i int) string {
	return fmt.Sprintf("%s_%03d", DeviceIDPrefix, i)
}

// TelemetryTopicFor 返回指定设备的上报主题。
func TelemetryTopicFor(deviceID string) string {
	return TopicPrefix + deviceID + "/up/telemetry"
}

// StatusTopicFor 返回指定设备的状态主题。
func StatusTopicFor(deviceID string) string {
	return TopicPrefix + deviceID + "/status"
}

// CmdTopicFor 返回指定设备的下行指令主题。
func CmdTopicFor(deviceID string) string {
	return TopicPrefix + deviceID + "/down/led_ctrl"
}

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
