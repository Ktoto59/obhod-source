// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package ping

import (
	"context"
	"errors"
	"net"

	E "github.com/sagernet/sing/common/exceptions"
	"github.com/sagernet/sing/common/logger"
)

func icmpReadErrorLevel(err error, received bool) string {
	if E.IsClosed(err) {
		return "closed"
	}
	var timeout net.Error
	if errors.As(err, &timeout) && timeout.Timeout() {
		if received {
			return "debug"
		}
		return "warn"
	}
	return "error"
}

func logICMPReadError(ctx context.Context, log logger.ContextLogger, err error, received bool) {
	switch icmpReadErrorLevel(err, received) {
	case "debug":
		log.DebugContext(ctx, "ICMP session idle timeout")
	case "warn":
		log.WarnContext(ctx, E.Cause(err, "ICMP reply timeout"))
	case "error":
		log.ErrorContext(ctx, E.Cause(err, "receive ICMP echo reply"))
	}
}
