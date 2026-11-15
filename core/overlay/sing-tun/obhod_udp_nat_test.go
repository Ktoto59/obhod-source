// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package tun

import (
	"net/netip"
	"testing"

	M "github.com/sagernet/sing/common/metadata"
)

func TestObhodUDPNATDestinationIsolation(t *testing.T) {
	service := &UDPNat{mapping: NATMappingEndpointIndependent}
	source := M.SocksaddrFromNetIP(netip.MustParseAddrPort("10.0.0.2:53000"))
	key := func(destination string) udpNatSessionKey {
		return service.sessionKey(source, M.SocksaddrFromNetIP(netip.MustParseAddrPort(destination)))
	}
	dns := key("192.0.2.1:53")
	if dns == key("192.0.2.2:53") || dns == key("192.0.2.1:3478") {
		t.Fatal("DNS shared a NAT session with another resolver or UDP service")
	}
	if key("192.0.2.1:3478") != key("192.0.2.2:3478") {
		t.Fatal("Other UDP flows lost endpoint-independent NAT")
	}
}
