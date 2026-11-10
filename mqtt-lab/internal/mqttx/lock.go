package mqttx

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"mqtt-lab/config"
)

// AcquireLock 保证同一个 ClientID 在"本机 + 同一个 broker"上只有一个进程实例。
//
// MQTT 里 ClientID 是会话的钥匙：两个进程用同一个 ID 连同一个 broker，后连上的会接管会话，
// 先连上的被踢下线；而 paho 会自动重连，再把对方踢掉——结果两边反复互踢，日志刷屏。
// 在启动阶段用 flock 拦住第二个实例，比事后在断线回调里猜原因可靠得多。
//
// 锁文件放在系统临时目录，进程退出（包括 kill -9）时内核自动释放，不会残留死锁。
// 键里带上 broker 地址，所以"同一设备连不同 broker"（比如 MQTT_ADDR 指向 1884 的调试实例）不受影响。
func AcquireLock(clientID string) (release func(), err error) {
	key := clientID + "@" + config.Addr()
	path := filepath.Join(os.TempDir(), "mqtt-lab-"+safeName(key)+".lock")

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file %s: %w", path, err)
	}

	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		owner := readPID(f)
		f.Close()
		if owner != "" {
			return nil, fmt.Errorf("ClientID %q 在 %s 上已被本机另一个进程占用（pid %s），先停掉它再启动", clientID, config.Addr(), owner)
		}
		return nil, fmt.Errorf("ClientID %q 在 %s 上已被本机另一个进程占用，先停掉它再启动", clientID, config.Addr())
	}

	// 记下 pid，第二个实例报错时能直接告诉用户是谁占着。
	if _, err := f.WriteString(fmt.Sprintf("%d\n", os.Getpid())); err != nil {
		f.Close()
		return nil, fmt.Errorf("write lock file %s: %w", path, err)
	}

	return func() {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}, nil
}

func readPID(f *os.File) string {
	buf := make([]byte, 32)
	n, _ := f.ReadAt(buf, 0)
	return strings.TrimSpace(string(buf[:n]))
}

// safeName 把 ClientID 和 broker 地址转成安全的文件名片段。
func safeName(s string) string {
	return strings.NewReplacer("/", "_", "\\", "_", ":", "_", " ", "_").Replace(s)
}
