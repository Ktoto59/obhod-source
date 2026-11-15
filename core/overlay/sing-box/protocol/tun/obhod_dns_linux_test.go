// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package tun

import (
	"net/netip"
	"testing"

	tun "github.com/sagernet/sing-tun"
	"github.com/sagernet/sing-tun/gtcpip/header"
	M "github.com/sagernet/sing/common/metadata"
	"go4.org/netipx"
)

func TestObhodDNSClassificationUsesDestinationPort(t *testing.T) {
	service4 := netip.MustParseAddr("172.19.0.2")
	service6 := netip.MustParseAddr("fdfe:dcba:9876::2")
	inbound := &Inbound{
		tunOptions:       tun.Options{Name: "obhod-tun"},
		dnsHijackAddress: []netip.Addr{service4, service6},
		dnsHijackByPort:  true,
		routeAddressSet:  []*netipx.IPSet{new(netipx.IPSet)},
	}
	source := netip.MustParseAddrPort("192.0.2.10:45000")
	for _, tc := range []struct {
		destination netip.AddrPort
		dns         bool
	}{
		{netip.AddrPortFrom(service4, 53), true},
		{netip.AddrPortFrom(service6, 53), true},
		{netip.AddrPortFrom(service4, 443), false},
		{netip.AddrPortFrom(service6, 5353), false},
		{netip.MustParseAddrPort("192.0.2.53:53"), true},
		{netip.MustParseAddrPort("192.0.2.53:443"), false},
	} {
		t.Run(tc.destination.String(), func(t *testing.T) {
			verdict := inbound.JudgeFlow(uint8(header.UDPProtocolNumber), source, tc.destination, nil)
			if (verdict.Action == tun.ActionHijackDNS) != tc.dns {
				t.Fatalf("UDP verdict = %v, want DNS hijack %v", verdict.Action, tc.dns)
			}
			if got := inbound.isDNSHijackDestination(M.SocksaddrFromNetIP(tc.destination)); got != tc.dns {
				t.Fatalf("DNS route classification = %v, want %v", got, tc.dns)
			}
			if tc.dns {
				tcp := inbound.JudgeFlow(uint8(header.TCPProtocolNumber), source, tc.destination, nil)
				if tcp.Action != tun.ActionAccept {
					t.Fatalf("TCP DNS should reach the stream router, verdict = %v", tcp.Action)
				}
			}
		})
	}
}
