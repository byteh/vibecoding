# mqtt-lab

MQTT 3.1.1 学习用的最小工程：两个基础脚本（发布/订阅）加一个进阶版模拟设备。

## 代码结构

```
mqtt-lab/
├── config/config.go          # 唯一的参数来源：broker/port/clientID/qos/各主题
├── internal/mqttx/connect.go # 建连封装：持久会话/遗嘱/默认处理器 + 重连日志
└── cmd/
    ├── publisher/main.go     # 基础版：每 2s 发一条 JSON 遥测，等 PUBACK
    ├── subscriber/main.go    # 基础版：订阅主题，打印 qos/retained/dup
    └── device/main.go        # 进阶版：持久会话 + 遗嘱 + 保留状态 + 下行指令
```

`cmd/` 放可执行入口，`internal/` 放不对外暴露的实现，`config/` 是可以被外部包引用的参数层。
以后加功能就在 `cmd/` 下新增目录，参数仍集中在 `config`。

基础版两个脚本调 `mqttx.Connect(clientID)`（clean session、无遗嘱）；
进阶版设备调 `mqttx.ConnectWith(mqttx.Options{...})`，连接手势都在 `Options` 里声明。


## 运行

需要本机有一个 broker 监听 `127.0.0.1:1883`（本机是用 Docker 起的 `eclipse-mosquitto`），两个终端分别跑：

```bash
go run ./cmd/subscriber   # 先起订阅端
go run ./cmd/publisher    # 再起发布端
```

## 进阶设备：cmd/device

四个能力和代码的对应关系：

- **断网自动重连 + 持久会话**：`mqttx.Options.CleanSession=false`，ClientID 固定用 `config.ClientID`（不加后缀）；`AutoReconnect` 负责重连，`OnConnect` 每次重连后补一次订阅——broker 重启丢了会话时靠它恢复。
- **遗嘱消息**：`Options.Will` 指向 status 主题、QoS 1、`retained=true`。payload 在连接时就被 broker 记下，所以里面的时间戳是**连接时间**，不是掉线时间。正常 `DISCONNECT` 不会触发遗嘱。
- **保留状态**：`publishStatus` 用 `retained=true`，新订阅者一连上就能拿到当前状态；正常退出时主动补一条 `offline`。
- **下行指令**：订阅 `CmdTopic`，回调里改 LED 状态，下一次遥测的 `led_status` 会体现出来。

三个主题都在 `config/config.go` 里用 ClientID 拼出来：

- 上报 `warehouse/shelf/esp32_001/up/telemetry`（不 retained）
- 状态 `warehouse/shelf/esp32_001/status`（retained）
- 指令 `warehouse/shelf/esp32_001/down/led_ctrl`

### 验证这四个能力

```bash
go run ./cmd/device
```

用 broker 容器里自带的客户端扮演"云端"（宿主机没装 mosquitto 客户端）：

```bash
# 1. 保留状态：一订阅立刻拿到 online
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t 'warehouse/shelf/esp32_001/status' -C 1 -v

# 2. 下行指令：设备日志出现 <- cmd led_on, led=on，之后遥测变成 led_status:"on"
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -t 'warehouse/shelf/esp32_001/down/led_ctrl' -q 1 -m '{"cmd":"led_on"}'

# 3. 遗嘱：kill -9 模拟掉电，随后订阅 status 能拿到 offline（retained）
pkill -9 -f 'exe/device'
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t 'warehouse/shelf/esp32_001/status' -C 1 -v

# 4. 持久会话：设备离线期间发一条指令，重启设备后能收到
```

第 4 点有个容易踩的坑：paho 的 `Connect()` 文档写明，QoS 1 且 `CleanSession=false` 时要在 `Connect()` **之前**注册路由，因为 broker 会在 CONNACK 之后立刻补发离线消息，此时 `OnConnect` 里的订阅往往还没完成，没有路由的消息会被 paho 直接丢掉。所以 `mqttx.Options` 提供了 `DefaultHandler`，`cmd/device` 用它兜底接收重连瞬间到达的指令（回调里按主题过滤）。

持久会话会一直挂在 broker 上。想清掉，用同一 ClientID 以 clean session 连一次：

```bash
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -i esp32_001 -t '$SYS/broker/version' -C 1
```

## 打开报文级日志：mosquitto -v

`docker logs mosquitto` 只有 notice 级别，看得到「谁连上来了」，看不到 PUBLISH/PUBACK。
要看完整报文，broker 必须用 `-v` 启动（等价于 `log_type all`）。

**方式 A：另起一个调试实例，不动现有的 1883**（推荐）

`-v` 是进程启动参数，改不了已在跑的容器，所以用同一份配置在 1884 再起一个：

```bash
docker run -d --name mqtt-verbose -p 1884:1883 \
  -v /Users/byteh/docker-data/mosquitto/config/mosquitto.conf:/mosquitto/config/mosquitto.conf \
  eclipse-mosquitto:latest mosquitto -c /mosquitto/config/mosquitto.conf -v

docker logs -f mqtt-verbose          # 终端 A，盯着报文
MQTT_ADDR=tcp://127.0.0.1:1884 go run ./cmd/subscriber   # 终端 B
MQTT_ADDR=tcp://127.0.0.1:1884 go run ./cmd/publisher    # 终端 C

docker rm -f mqtt-verbose            # 用完删掉
```

注意命令要写全 `mosquitto -c ... -v`：该镜像的 entrypoint 是 `exec "$@"`，直接写 `-c` 会被当成 shell 选项。

**方式 B：直接让现有 broker 带 -v**

`persistence false`，重建容器不丢数据（retained 消息在内存里，会丢）：

```bash
docker rm -f mosquitto
docker run -d --name mosquitto -p 1883:1883 \
  -v /Users/byteh/docker-data/mosquitto/config/mosquitto.conf:/mosquitto/config/mosquitto.conf \
  -v /Users/byteh/docker-data/mosquitto/log:/mosquitto/log \
  eclipse-mosquitto:latest mosquitto -c /mosquitto/config/mosquitto.conf -v
```

想让 -v 日志同时落文件，在 `mosquitto.conf` 里加 `log_dest file /mosquitto/log/mosquitto.log`。

## 对照着读：一行 broker 日志 ↔ 一行项目日志

下面是真实抓到的一组（QoS 1，订阅端先连）：

```
broker (docker logs -f)                                   项目日志
New client connected ... as esp32_001_sub (p4, c1, k30)   [esp32_001_sub] connected ...
Sending CONNACK to esp32_001_sub (0, 0)                    ← Connect() 里的 token.Wait 返回
Received SUBSCRIBE from esp32_001_sub / (QoS 1)            client.Subscribe(...)
Sending SUBACK to esp32_001_sub                            ← Subscribe token 返回
Received PUBLISH from esp32_001_pub (d0, q1, r0, m1, ...)  -> publish {...}
Sending PUBLISH to esp32_001_sub (d0, q1, r0, m1, ...)     ← onMessage 回调
Sending PUBACK to esp32_001_pub (m1, rc0)                  PUBACK received
Received PUBACK from esp32_001_sub (Mid: 1, RC:0)
Received UNSUBSCRIBE / Sending UNSUBACK                    client.Unsubscribe(...)
Received DISCONNECT from ...                               client.Disconnect(250)
```

字段含义（读懂这几个基本就通了）：

- `p4` = 协议级别 4 = MQTT 3.1.1（`p5` 是 MQTT 5.0）；`c1` = clean session 1；`k30` = keepalive 30s —— 正对应 `connect.go` 里的 `SetCleanSession(true)`、`SetKeepAlive(30s)`。
- PUBLISH 括号里 `d0` = dup=0、`q1` = QoS 1、`r0` = retain=0、`m1` = 报文标识符（Message ID），和订阅端打印的 `dup/qos/retained` 一一对应。
- `PUBACK ... rc0` = return code 成功；`No will message specified` 是因为 `connect.go` 没设 `SetWill`。
- 顺序值得注意：broker **先给发布端回 PUBACK 再收订阅端的 PUBACK**，所以「PUBACK received」只代表 broker 收到并落库，不代表对端已消费。

## 几个值得观察的点

- **ClientID 必须唯一**：两个脚本分别用 `esp32_001_pub` / `esp32_001_sub`。若两端都用 `esp32_001`，broker 会把先连上的踢下线，现象是订阅端反复重连、收不到消息。
- **QoS 1 是"至少一次"**：发布端日志里 `-> publish` 之后要等到 `PUBACK received`，说明 broker 已落库；重复投递时订阅端会看到 `dup=true`。
- **实际投递 QoS = min(发布 QoS, 订阅 QoS)**：把 `config.QoS` 改成 0 或把某端写成 0，对比订阅端打印的 `qos` 字段。
- **retained 消息会立刻送达**：如果之前有人用 retained 发过同主题消息，订阅端一建立订阅就会先收到一条 `retained=true` 的旧数据——这也是本项目里没能避免的现象。
- **clean session = true**：基础脚本每次连接都是新会话，断线期间的消息不会补发；想看持久会话与离线消息，跑 `cmd/device`（`CleanSession=false` + 固定 ClientID）。
