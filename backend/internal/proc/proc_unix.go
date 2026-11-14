//go:build unix

package proc

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

func own(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// KillMatching ends every process whose command line contains marker, with its process group:
// what a child left running when it died (a browser started detached). The marker must be unique
// to that child, such as a temporary directory only it used.
func KillMatching(marker string) {
	if len(marker) < 8 {
		return
	}
	out, _ := exec.Command("pgrep", "-f", "--", regexp.QuoteMeta(marker)).Output()
	for _, field := range strings.Fields(string(out)) {
		pid, err := strconv.Atoi(field)
		if err != nil || pid <= 1 || pid == os.Getpid() {
			continue
		}
		if group, err := syscall.Getpgid(pid); err == nil && group == pid {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
		}
		_ = syscall.Kill(pid, syscall.SIGKILL)
	}
}
