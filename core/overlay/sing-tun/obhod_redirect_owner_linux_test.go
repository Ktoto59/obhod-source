// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
//go:build linux

package tun

import (
	"net"
	"testing"

	"github.com/sagernet/netlink"
	"golang.org/x/sys/unix"
)

func TestObhodRedirectOwnershipDoesNotClaimForeignRules(t *testing.T) {
	own := netlink.NewRule()
	own.Priority = 1
	own.Table = 100000
	if !obhodRedirectRuleCandidate(*own) {
		t.Fatal("Own rule not recognized")
	}
	foreign := *own
	foreign.Mark = 123
	if obhodRedirectRuleCandidate(foreign) {
		t.Fatal("Foreign marked rule claimed")
	}
	foreign = *own
	foreign.Table = 254
	if obhodRedirectRuleCandidate(foreign) {
		t.Fatal("Main table claimed")
	}
	route := netlink.Route{Dst: netlink.NewIPNet(net.IPv4(127, 0, 0, 1)), Type: unix.RTN_LOCAL, Scope: netlink.SCOPE_HOST, Protocol: obhodRedirectProtocol}
	if !obhodOwnedRedirectRoute(route) {
		t.Fatal("Own loopback route not recognized")
	}
	route.Protocol = 4
	if obhodOwnedRedirectRoute(route) {
		t.Fatal("Foreign loopback route claimed")
	}
	if ours, err := obhodRedirectTableOwned([]netlink.Route{route}); ours || err != nil {
		t.Fatal("Untagged table claimed")
	}
	tagged := route
	tagged.Protocol = obhodRedirectProtocol
	if ours, err := obhodRedirectTableOwned([]netlink.Route{tagged}); !ours || err != nil {
		t.Fatal("Tagged table not recognized")
	}
	if _, err := obhodRedirectTableOwned([]netlink.Route{tagged, route}); err == nil {
		t.Fatal("Mixed ownership accepted")
	}
	v6 := tagged
	v6.Dst = netlink.NewIPNet(net.IPv6loopback)
	v6.Scope = netlink.SCOPE_UNIVERSE
	if !obhodOwnedRedirectRoute(v6) {
		t.Fatal("Kernel-normalized IPv6 local route rejected")
	}
	route.Protocol = obhodRedirectProtocol
	route.Dst = netlink.NewIPNet(net.IPv4(192, 0, 2, 1))
	if obhodOwnedRedirectRoute(route) {
		t.Fatal("Foreign destination claimed")
	}
}
