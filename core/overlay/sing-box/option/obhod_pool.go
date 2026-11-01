// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package option

// ObhodDNSPoolOptions references existing DNS transports. Each member retains
// its own TLS, bootstrap and outbound settings; a pool never adds a fallback.
type ObhodDNSPoolOptions struct {
	Servers []string `json:"servers"`
	Mode    string   `json:"mode,omitempty"`
}
