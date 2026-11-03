// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
//go:build linux

package tun

import (
	"github.com/sagernet/nftables"
	"github.com/sagernet/nftables/binaryutil"
	"github.com/sagernet/nftables/expr"
	"golang.org/x/sys/unix"
)

// Apply the same live destination sets as the redirect chains BEFORE NFQUEUE.
// No userspace pre-match is needed to decide that an address is unselected.
// Sets are updated atomically by the existing rule-set callbacks.
func (r *autoRedirect) nftablesPreMatchAddressFilter(nft *nftables.Conn, table *nftables.Table, chain *nftables.Chain, prerouting bool) error {
	if len(*r.routeAddressSet) == 0 {
		return nil // Preserve upstream behavior without a positive address set.
	}
	if prerouting && len(r.tunOptions.IncludeInterface) > 0 {
		interfaces := &nftables.Set{Table: table, Anonymous: true, Constant: true, KeyType: nftables.TypeIFName, KeyByteOrder: binaryutil.NativeEndian}
		var elements []nftables.SetElement
		for _, name := range r.tunOptions.IncludeInterface {
			elements = append(elements, nftables.SetElement{Key: nftablesIfname(name)})
		}
		if err := nft.AddSet(interfaces, elements); err != nil {
			return err
		}
		nft.AddRule(&nftables.Rule{Table: table, Chain: chain, Exprs: []expr.Any{
			&expr.Meta{Key: expr.MetaKeyIIFNAME, Register: 1},
			&expr.Lookup{SourceRegister: 1, SetID: interfaces.ID, SetName: interfaces.Name, Invert: true},
			&expr.Counter{}, &expr.Verdict{Kind: expr.VerdictReturn},
		}})
	}
	// DNS is handled by the native DNS hijack rules downstream, including DNS
	// addressed outside the selected set. It must not be classified by NFQUEUE.
	for _, protocol := range []byte{unix.IPPROTO_TCP, unix.IPPROTO_UDP} {
		nft.AddRule(&nftables.Rule{Table: table, Chain: chain, Exprs: []expr.Any{
			&expr.Meta{Key: expr.MetaKeyL4PROTO, Register: 1},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{protocol}},
			&expr.Payload{OperationType: expr.PayloadLoad, DestRegister: 1, Base: expr.PayloadBaseTransportHeader, Offset: 2, Len: 2},
			&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{0, 53}},
			&expr.Counter{}, &expr.Verdict{Kind: expr.VerdictReturn},
		}})
	}
	for _, family := range []struct {
		enabled bool
		nfproto byte
		setID   uint32
		name    string
	}{{r.enableIPv4, unix.NFPROTO_IPV4, 1, "inet4_route_address_set"},
		{r.enableIPv6, unix.NFPROTO_IPV6, 2, "inet6_route_address_set"}} {
		if !family.enabled {
			nft.AddRule(&nftables.Rule{Table: table, Chain: chain, Exprs: []expr.Any{
				&expr.Meta{Key: expr.MetaKeyNFPROTO, Register: 1},
				&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: []byte{family.nfproto}},
				&expr.Counter{}, &expr.Verdict{Kind: expr.VerdictReturn},
			}})
			continue
		}
		nftablesCreateExcludeDestinationIPSet(nft, table, chain, family.setID, family.name, nftables.TableFamily(family.nfproto), true)
	}
	return nil
}
