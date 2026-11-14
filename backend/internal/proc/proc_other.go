//go:build !unix

package proc

import "os/exec"

func own(*exec.Cmd) {}

// KillMatching is a no-op where processes cannot be matched this way.
func KillMatching(string) {}
