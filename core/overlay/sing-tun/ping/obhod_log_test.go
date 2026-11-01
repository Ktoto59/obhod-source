// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package ping

import (
	"fmt"
	"net"
	"os"
	"testing"
)

func TestObhodICMPReadErrorLevel(t *testing.T) {
	deadline := &net.OpError{Op: "read", Net: "ip", Err: os.ErrDeadlineExceeded}
	for _, test := range []struct {
		err      error
		received bool
		level    string
	}{
		{deadline, true, "debug"}, {deadline, false, "warn"},
		{fmt.Errorf("wrapped: %w", deadline), true, "debug"},
		{net.ErrClosed, false, "closed"}, {fmt.Errorf("socket failure"), true, "error"},
	} {
		if level := icmpReadErrorLevel(test.err, test.received); level != test.level {
			t.Fatalf("got %s want %s", level, test.level)
		}
	}
}
