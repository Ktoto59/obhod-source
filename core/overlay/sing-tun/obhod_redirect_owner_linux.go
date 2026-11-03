// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
//go:build linux

package tun

import (
	"errors"
	"fmt"

	"github.com/sagernet/netlink"
	"golang.org/x/sys/unix"
)

// Site-local protocol owner tag, restricted to Obhod's fixed TUN name. Never
// infer ownership from priority or the shape of an untagged legacy route.
const obhodRedirectProtocol = 253

func obhodRedirectRuleCandidate(rule netlink.Rule) bool {
	return rule.Priority == redirectRouteRulePriority &&
		rule.Table >= 256 && rule.Table <= 0x7fffffff && !rule.Src.IsValid() && !rule.Dst.IsValid() &&
		rule.Mark == 0 && rule.IifName == "" && rule.OifName == "" && !rule.Invert
}

func obhodRedirectTableOwned(routes []netlink.Route) (bool, error) {
	tagged := 0
	for _, route := range routes {
		if obhodOwnedRedirectRoute(route) {
			tagged++
		}
	}
	if tagged == 0 {
		return false, nil
	}
	if tagged != len(routes) {
		for _, route := range routes {
			if !obhodOwnedRedirectRoute(route) {
				return false, fmt.Errorf("foreign route in tagged Obhod table: %v (protocol=%d scope=%d)", route, route.Protocol, route.Scope)
			}
		}
	}
	return true, nil
}

func obhodOwnedRedirectRoute(route netlink.Route) bool {
	key, redirect := redirectRouteKeyFromRoute(route)
	// IPv6 reports local /128 routes with universe scope even when the add
	// request used host scope. IPv4 keeps host scope.
	scope := route.Scope == netlink.SCOPE_HOST || (key.family == unix.AF_INET6 && route.Scope == netlink.SCOPE_UNIVERSE)
	return redirect && route.Protocol == obhodRedirectProtocol && route.Type == unix.RTN_LOCAL && scope
}

func (r *autoRedirect) cleanupObhodRedirectRoutes() error {
	if r.tunOptions.Name != "obhod-tun" {
		return nil
	}
	rules, err := netlink.RuleList(netlink.FAMILY_ALL)
	if err != nil {
		return err
	}
	tables := make(map[int][]netlink.Route)
	var owned []netlink.Rule
	for _, rule := range rules {
		if !obhodRedirectRuleCandidate(rule) {
			continue
		}
		if _, checked := tables[rule.Table]; !checked {
			routes, err := netlink.RouteListFiltered(netlink.FAMILY_ALL, &netlink.Route{Table: rule.Table}, netlink.RT_FILTER_TABLE)
			if err != nil {
				return err
			}
			ours, err := obhodRedirectTableOwned(routes)
			if err != nil {
				return fmt.Errorf("table %d: %w", rule.Table, err)
			}
			if !ours {
				continue
			}
			tables[rule.Table] = routes
		}
		owned = append(owned, rule)
	}
	// Validate every candidate before changing any table. Package/app locks
	// serialize Obhod instances; no other service's untagged rules are touched.
	for _, routes := range tables {
		for _, route := range routes {
			if err := netlink.RouteDel(&route); err != nil && !errors.Is(err, unix.ESRCH) && !errors.Is(err, unix.ENOENT) {
				return err
			}
		}
	}
	for _, rule := range owned {
		if err := netlink.RuleDel(&rule); err != nil && !errors.Is(err, unix.ESRCH) && !errors.Is(err, unix.ENOENT) {
			return err
		}
	}
	return nil
}
