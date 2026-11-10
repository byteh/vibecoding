# mqtt-lab 手动调试与测试手册

面向"想搞懂 MQTT 到底发生了什么"的手工实验手册。每个实验都写清：怎么操作、看到什么、为什么、对应哪段代码。

---

## 0. 环境与工具

### broker

本机 broker 是 Docker 容器 `mosquitto`，监听 `127.0.0.1:1883`，启动参数已带 `-v`，并且配置里有：

```
log_dest file /mosquitto/log/mosquitto.log
```

所以 **`docker logs mosquitto` 几乎是空的**，报文日志在宿主机上：

```bash
tail -f /Users/byteh/docker-data/mosquitto/log/mosquitto.log
```

配置里还有 `persistence false` —— broker 重启后 retained 消息和持久会话都会丢，这一点在 E8 里会被用到。

### 三种客户端

| 来源 | 用途 | 示例 |
| --- | --- | --- |
| 本项目的 `cmd/*` | 学习主体，代码可改 | `go run ./cmd/device` |
| 容器自带的 `mosquitto_pub/sub` | 扮演"另一台设备/云端"，不用写代码 | `docker exec mosquitto mosquitto_pub ...` |
| MQTTX / mqttx CLI（可选） | GUI 观察、手动发消息 | 连接 `127.0.0.1:1883` |

### 两个环境变量

| 变量 | 作用 |
| --- | --- |
| `MQTT_ADDR=tcp://127.0.0.1:1884` | 指向另一个 broker（比如临时开的调试实例） |
| `MQTT_DEBUG=1` | 打开 paho 内部日志：CONNECT/SUBSCRIBE/PINGREQ/重连全过程 |

```bash
MQTT_DEBUG=1 go run ./cmd/device
```

输出形如：

```
[mqtt] DEBUG 14:28:12.638995 [client]   about to write new connect msg
[mqtt] DEBUG 14:28:12.639373 [client]   Using MQTT 3.1.1 protocol
[mqtt] DEBUG 14:28:12.643115 [net]      received connack
[mqtt] DEBUG 14:28:12.643188 [pinger]   keepalive starting
```

---

## 1. 五分钟冒烟测试

先确认环境是通的，再往下做实验。

```bash
cd mqtt-lab

# 终端 0：盯着 broker 报文
tail -f /Users/byteh/docker-data/mosquitto/log/mosquitto.log

# 终端 1：订阅读取端
go run ./cmd/subscriber

# 终端 2：发布端
go run ./cmd/publisher
```

预期：

- 终端 1：`[esp32_001_sub] connected ... (clean session)` → `subscribed topic="device/esp32_001/telemetry" qos=1`
- 终端 2：每 2s 一条 `-> publish {...}`，紧接着 `PUBACK received`
- 终端 1：几乎同时对每条消息打印 `<- topic=... qos=1 retained=false dup=false payload=...`
- 终端 0：成对的 `Received PUBLISH from esp32_001_pub` / `Sending PUBLISH to esp32_001_sub` / `Sending PUBACK`

任何一环不符合预期，先看第 4 节的故障速查表。

---

## 2. 实验矩阵

| # | 目标 | 用到的代码 | 需要改代码 |
| --- | --- | --- | --- |
| E1 | QoS 0/1/2 与投递降级 | `cmd/subscriber` + `mosquitto_pub` | 否 |
| E2 | retained 消息与清除 | `cmd/device` 状态主题 | 否 |
| E3 | 遗嘱 + keepalive 超时 | `cmd/device` | 否 |
| E4 | 持久会话与离线队列 | `cmd/device` | 否（对比实验需改一行） |
| E5 | ClientID 冲突 | `cmd/device` + `mosquitto_sub` | 否 |
| E6 | 通配符 `+` / `#` 与 `$SYS` | 客户端工具 | 否 |
| E7 | 端到端闭环（设备 + 服务） | `cmd/device` + `cmd/server` | 否 |
| E8 | 故障注入：broker 重启 / 网络黑洞 | 全部 | 否 |
| E9 | 报文级观察 | — | 否 |

建议按顺序做，E1–E6 都是单点特性，E7 之后是组合场景。

---

## 3. 实验

### E1 QoS：至少一次到底意味着什么

预算：5 分钟

**观察 A：发布侧 QoS 对 ack 的影响**

订阅端保持 `qos=1`（`cmd/subscriber` 默认）。用容器客户端发布三种 QoS：

```bash
for q in 0 1 2; do
  docker exec mosquitto mosquitto_pub -h 127.0.0.1 \
    -t 'device/esp32_001/telemetry' -q $q -m "{\"from\":\"qos$q\"}"
done
```

订阅端：

```
qos=0 ... payload={"from":"qos0"}
qos=1 ... payload={"from":"qos1"}
qos=1 ... payload={"from":"qos2"}     # 2 被降级成 1
```

结论：**实际投递 QoS = min(发布 QoS, 订阅 QoS)**。QoS 2 并没有"更可靠"，它只是多了一次四步握手（PUBREC/PUBREL），而订阅端只要了 QoS 1，broker 就只跑 QoS 1。

想亲手改：把 `cmd/subscriber/main.go` 里 `Subscribe(config.Topic, byte(config.QoS), ...)` 的 QoS 临时写成 0，再发一遍，报文里就只剩 `qos=0`。

**观察 B：QoS 1 的 ack 语义**

发布端日志先打 `-> publish`，等 token 完成才打 `PUBACK received`。对比 broker 日志：`Sending PUBACK to esp32_001_pub` 出现在 `Sending PUBLISH to esp32_001_sub` **之后**，但两者都发生在订阅端 ack 之前。

结论：`PUBACK` 只代表 **broker 收到了**，不代表对端消费了。

**观察 C：dup 从哪来**

在设备离线时用 QoS 1 发消息（见 E4），重连后观察订阅端是否打印 `dup=true`。重复投递是 QoS 1 的合法行为，不是 bug。

---

### E2 retained：为什么"一订阅就有数据"

预算：5 分钟

```bash
# 1. 发一条 retained 消息
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -t lab/test/retained -r -m 'hello-retained'

# 2. 新订阅者立刻能收到（注意没有新的发布者）
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t lab/test/retained -C 1 -v

# 3. 清除 retained：发送 payload 为空 + retain 标志
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -t lab/test/retained -r -n

# 4. 再订阅应该收不到（-W 超时退出，退出码 27）
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t lab/test/retained -W 2 -v
```

项目里的对应关系：

- `cmd/device` 的 status 用 `retained=true` → 服务端一启动就能拿到每台设备的当前状态（`retained=true` 的那条是快照，不是新事件）。
- telemetry 用 `retained=false` → 遥测只在设备活着时有意义，设备离线后保留一堆过期温度没有价值。

**思考题**：如果指令也用 retained 会怎样？——设备每次重连/重启都会收到最后一条指令并重放一遍（比如重启后灯自己亮了）。这就是 `cmd/server` 里 `publishCmd` 用 `retain=false` 的原因，离线补发交给持久会话的队列。

---

### E3 遗嘱与 keepalive：什么算"异常掉线"

预算：10 分钟（含 95s 等待）

前提：起一台设备，另开一个观察者：

```bash
go run ./cmd/device                                                       # 终端 A

# 终端 B：先看到 retained 的 online
docker exec mosquitto mosquitto_sub -h 127.0.0.1 \
  -t 'warehouse/shelf/esp32_001/status' -v
```

**场景 1：正常退出（Ctrl+C）**

设备日志：`-> status "offline" (retained)`。
原因：正常 `DISCONNECT` **不会**触发遗嘱，这是协议规定（遗嘱只用于非正常断开）。所以代码里在退出前主动补了一条 offline。

**场景 2：`kill -9`（进程被杀）**

```bash
pkill -9 -f '/exe/device'    # go run 启动的临时二进制
```

现象：终端 B 几乎立刻收到 `offline`，broker 日志出现：

```
Client esp32_001 [...] disconnected.
Sending PUBLISH to ... (r1, 'warehouse/shelf/esp32_001/status', ...)
```

原因：socket 被内核关闭，broker 立刻感知断连 → 代发遗嘱。

**场景 3：`SIGSTOP`（进程冻结，socket 不关）**

```bash
PID=$(pgrep -f '/exe/device'); kill -STOP "$PID"
```

这时 TCP 连接还在，但设备不再发 PINGREQ。broker 只能靠 keepalive 判断：**1.5 × keepalive** 后断开。设备 `KeepAlive=60s`，实测约 90s 后：

```
1794292205: Client esp32_001 [172.17.0.1:62398] disconnected: exceeded timeout.
```

随后遗嘱被发布，观察者收到 `status: offline`。恢复：`kill -CONT "$PID"`，设备会自动重连并重新上报 online。

**注意**：遗嘱的 payload 是**连接时**就交给 broker 固定的（见 `cmd/device/main.go` 里 `willPayload` 的注释），所以里面 `timestamp` 是连接时间，不是掉线时间。想让 broker 知道"死亡时刻"，只能靠自己另发一条消息。

---

### E4 持久会话与离线队列

预算：10 分钟

**验证队列确实存在**

```bash
# 1. 起设备，确认在线
go run ./cmd/device                       # 终端 A

# 2. 停掉设备（Ctrl+C 或 pkill）
# 3. 在设备离线期间下发两条指令
docker exec mosquitto mosquitto_pub -h 127.0.0.1 \
  -t 'warehouse/shelf/esp32_001/down/led_ctrl' -q 1 -m '{"cmd":"led_on"}'
docker exec mosquitto mosquitto_pub -h 127.0.0.1 \
  -t 'warehouse/shelf/esp32_001/down/led_ctrl' -q 1 -m '{"cmd":"led_off"}'

# 4. 重新起设备
go run ./cmd/device
```

预期日志（重点看顺序）：

```
[esp32_001] connected ... (persistent session)
<- cmd led_on, led=on          # 订阅完成之前就到达了
<- cmd led_off, led=off
-> status "online" (retained)
subscribed "warehouse/.../down/led_ctrl"
```

这些离线消息是 broker 在 CONNACK 之后**紧接着**补发的，比 `OnConnect` 里的订阅还早。本地路由表此时是空的，所以 paho 会把它们丢掉——这就是 `mqttx.Options.DefaultHandler` 存在的原因（`cmd/device` 用它兜底，回调里按主题过滤）。

**对照实验：把持久会话关掉会怎样**

把 `cmd/device/main.go` 的 `CleanSession: false` 改成 `true`，重复上面步骤：设备重启后**收不到**这两条指令。因为 clean session 让 broker 在断开时就删掉了会话和队列。

改完记得改回去，并清掉测试残留的会话：

```bash
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -i esp32_001 -t '$SYS/broker/version' -C 1
```

---

### E5 ClientID 冲突：同一时刻只能有一个

预算：3 分钟

设备跑着的时候，用同一个 ClientID 抢占：

```bash
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -i esp32_001 \
  -t 'warehouse/shelf/+/status' -W 5 -v
```

现象：

1. 设备日志立刻打印 `connection lost: ... session taken over`（paho 的错误信息取决于 broker 返回码），随后自动重连；
2. 设备重连时又把抢占了 ID 的那个客户端踢掉 —— 两边来回抢；
3. broker 日志：

```
Client esp32_001 [172.17.0.1:62398] disconnected: session taken over.
New client connected from 172.17.0.1:62044 as esp32_001 (p4, c0, k60).
```

结论：ClientID 是会话的钥匙。基础脚本用 `esp32_001_pub` / `esp32_001_sub` 后缀，就是为了避免和自己打架；`cmd/device` 用裸 ID 是因为它要复用自己的持久会话。

顺带看 `(p4, c0, k60)`：`p4` = MQTT 3.1.1，`c0` = clean session false，`k60` = keepalive 60s，正好对应 `Options` 的三个字段。

---

### E6 通配符与 `$SYS`

预算：5 分钟

```bash
# 单层：只匹配 warehouse/shelf/<一台设备>/status
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t 'warehouse/shelf/+/status' -v

# 多层：匹配 warehouse/shelf 下的一切
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t 'warehouse/shelf/#' -v

# broker 自身指标
docker exec mosquitto mosquitto_sub -h 127.0.0.1 -t '$SYS/broker/#' -v -W 3
```

配合发消息：

```bash
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -t lab/a/status -m '{"status":"online"}'
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -t lab/a/up/telemetry -m '{"t":1}'
```

验证点：

- `+` 只吃一层：`warehouse/shelf/+/status` 收不到 `warehouse/shelf/a/b/status`；`#` 可以。
- `$SYS` 开头的主题**不会**被 `#` 匹配到（协议规定），必须显式订阅 `$SYS/#`。
- 通配符只能出现在订阅端，发布端必须用完整主题。

---

### E7 端到端：设备 + 后端服务

预算：10 分钟

```bash
go run ./cmd/device     # 终端 A
go run ./cmd/server     # 终端 B
```

在终端 B 输入：

```
led_on                  # 默认发给 config.ClientID
led_off esp32_001
```

预期：

```
# 终端 B
<- status esp32_001 = online (retained=true)     # 启动即拿到状态快照
<- telemetry esp32_001: 29.7C 56.6% led=off
-> cmd led_on to esp32_001
<- telemetry esp32_001: 24.3C 66.7% led=on       # 指令生效
```

然后 `kill -9` 设备，终端 B 应立刻打印 `<- status esp32_001 = offline (retained=false)`。

**多设备实验**（不写代码也能做，用容器客户端伪造第二台设备）：

```bash
# 终端 C：盯住 esp32_002 的指令主题
docker exec mosquitto mosquitto_sub -h 127.0.0.1 \
  -t 'warehouse/shelf/esp32_002/down/led_ctrl' -v

# 伪造 esp32_002 上线（retained）
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -r \
  -t 'warehouse/shelf/esp32_002/status' \
  -m '{"device_id":"esp32_002","status":"online","timestamp":0}'
```

此时终端 B 应看到 `esp32_002 = online`；在 B 里输入 `led_on esp32_002`，只有终端 C 收到指令，`esp32_001` 不动。做完清理：

```bash
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -r -n -t 'warehouse/shelf/esp32_002/status'
```

---

### E8 故障注入

预算：10 分钟

**A. 重启 broker（会话/保留消息全丢）**

```bash
docker restart mosquitto
```

观察：

- 设备/服务日志：`connection lost: EOF, reconnecting...` → 数秒后 `connected ...`，随后重新上报 online、重新订阅（靠 `OnConnect`）。
- 订阅端（clean session）什么都没发生；设备（持久会话）发现 broker 已经没有自己的会话了，只能靠 `OnConnect` 里补的订阅恢复——这正是"重连后一定要重订阅"的实战理由。
- 所有 retained 消息消失（`persistence false`），服务的状态快照要等设备重新上报。

**B. 网络黑洞（`docker pause`）**

```bash
docker pause mosquitto      # 所有客户端都卡住（TCP 不断开，也不会立刻报错）
docker unpause mosquitto
```

预期：paho 不会马上感知，最多等到 keepalive 超时才重连；恢复后设备会重新上线。这个实验会影响同时连着的所有客户端，做完记得 unpause。

**C. 观察重连退避**

把 broker 停掉（`docker stop mosquitto`），开着 `MQTT_DEBUG=1` 跑设备，能看到 paho 的退避：1s → 2s → 4s → ... → 10s（上限由 `SetMaxReconnectInterval(10s)` 决定）。再 `docker start mosquitto`，观察恢复。

---

### E9 报文级观察

预算：10 分钟

三个层次，由粗到细：

1. **业务日志**（本项目）：语义层，看"做了什么事"。
2. **paho DEBUG**（`MQTT_DEBUG=1`）：客户端协议层，看 CONNECT/PINGREQ/重连状态机。
3. **broker `-v` 日志**：报文层，看每个控制包的字段（`d0/q1/r0/m1`、`p4/c0/k60`）。README 里有逐行对照表。
4. **抓包**（可选）：真正看字节。宿主机流量走 127.0.0.1，可试：

```bash
sudo tcpdump -i lo0 -nn -X 'tcp port 1883'
```

注意 MQTT 报文是二进制：固定头 + 剩余长度（变长整数）+ 可变头 + payload，字符串带 2 字节长度前缀，所以 `-X` 里看不到完整 JSON。用 Wireshark 打开抓包文件、过滤器填 `mqtt` 会自动解码，更适合逐字段看。

---

## 4. 调试技巧与故障速查

### 三方日志对照

| 想知道 | 看哪里 |
| --- | --- |
| 业务上谁发了什么 | 项目日志（`cmd/*` 的 `<-` / `->`） |
| 客户端状态机、重连、订阅是否发出 | `MQTT_DEBUG=1` |
| broker 收到/转发/ack 了哪些包 | `/Users/byteh/docker-data/mosquitto/log/mosquitto.log` |

排查顺序建议：业务日志 → paho DEBUG → broker 报文日志。多数问题停在第一层就能定位（比如主题写错、ClientID 撞车）。

### 故障速查

| 症状 | 常见原因 | 验证命令 |
| --- | --- | --- |
| `connect failed: connection refused` | broker 没起 / 端口不对 | `docker ps --filter name=mosquitto`、`nc -z 127.0.0.1 1883` |
| 订阅端收不到消息 | 主题不一致（拼写、`+`/`#` 层级）、发布端 Topic 写错 | broker 日志搜 `Received PUBLISH` 和 `Sending PUBLISH` |
| 一端反复重连、另一端收不到 | 两端 ClientID 相同，互相踢 | broker 日志搜 `session taken over` |
| `PUBACK received` 但没有订阅者 | 发布正常，问题在订阅（QoS/主题/未订阅成功） | 订阅端日志里有没有 `subscribed ...` |
| 设备重启后灯自己亮了 | 指令用了 retained | 搜 broker 日志里 `r1` 的指令 PUBLISH |
| 离线期间的消息收不到 | 用了 clean session；或没设 `DefaultHandler` | 看连接日志是 `(clean session)` 还是 `(persistent session)` |
| 遗嘱不触发 | 是正常 DISCONNECT 退出；或还在 1.5×keepalive 内 | 看 broker 日志有没有 `disconnected: exceeded timeout` |
| 老收到一条"过期"数据 | 主题上有 retained 消息 | `mosquitto_sub -t <topic> -v` 看 `r1`；用 `-r -n` 清除 |
| 订阅上的 `$SYS` 没数据 | `#` 不匹配 `$SYS`，要显式订阅 | `-t '$SYS/#'` |

### 复位清单

实验做完，把环境恢复到干净状态：

```bash
# 1. 停掉所有测试进程
pkill -f '/exe/device'; pkill -f '/exe/server'
pkill -f '/exe/subscriber'; pkill -f '/exe/publisher'

# 2. 清 retained（示例主题）
docker exec mosquitto mosquitto_pub -h 127.0.0.1 -r -n -t 'warehouse/shelf/esp32_001/status'

# 3. 清持久会话
for id in esp32_001 backend_server_001; do
  docker exec mosquitto mosquitto_sub -h 127.0.0.1 -i $id -t '$SYS/broker/version' -C 1
done

# 4. 确认 broker 只有一个、端口正常
docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
```

---

## 5. 建议的进阶练习

想再往前一步，可以按这个顺序改代码（每次只改一处，改完跑一遍 E7 验证）：

1. **指令回执**：设备执行完指令后在 `.../down/led_ctrl` 的同级 `.../up/cmd_ack` 回一条 ack，服务端记录"已执行"。体会请求-响应类交互为什么要自己造。
2. **指令幂等**：给 `CmdData` 加 `id`，设备记住最近处理过的 id，避免 QoS 1 重投导致重复执行。
3. **多设备**：把 `config.ClientID` 改成从环境变量读取（`MQTT_CLIENT_ID`），让同一份代码跑两台"设备"，验证通配订阅与定向下发。
4. **LWT + 保留状态的组合**：故意让设备崩溃，验证服务端状态从 online 变 offline；再重启设备，验证 retained 覆盖顺序。
5. **MQTT 5 对比**：把 paho 换成 MQTT 5 客户端，观察 CONNACK 里的属性（会话过期时间 `Session Expiry Interval` 正好替代 clean session 的粗粒度语义）。
