// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
//go:build linux

package tun

import (
	"github.com/sagernet/nftables"
	"github.com/sagernet/nftables/binaryutil"
	"github.com/sagernet/nftables/expr"
	"go4.org/netipx"
)

type obhodAddressSet struct {
	id      uint32
	name    string
	family  nftables.TableFamily
	keyType nftables.SetDatatype
	invert  bool
}

var obhodAddressSets = []obhodAddressSet{
	{11, "obhod_selected_v4", nftables.TableFamilyIPv4, nftables.TypeIPAddr, true},
	{12, "obhod_selected_v6", nftables.TableFamilyIPv6, nftables.TypeIP6Addr, true},
	{13, "obhod_excluded_v4", nftables.TableFamilyIPv4, nftables.TypeIPAddr, false},
	{14, "obhod_excluded_v6", nftables.TableFamilyIPv6, nftables.TypeIP6Addr, false},
}

func (r *autoRedirect) obhodSelective() bool {
	return r.tunOptions.Name == "obhod-tun" && r.routeAddressSet != nil
}

// Write the complete snapshot in one nftables transaction. Individual
// NEWSETELEM messages are chunked to fit the netlink attribute size limit.
func (r *autoRedirect) writeObhodAddressSets(nft *nftables.Conn, table *nftables.Table, update bool) error {
	include, exclude, err := r.routeAddressSet()
	if err != nil {
		return err
	}
	if !update {
		r.obhodPositiveSet = len(include) > 0
	}
	for _, spec := range obhodAddressSets {
		prefixes := exclude
		if spec.invert {
			if !r.obhodPositiveSet {
				continue
			}
			prefixes = include
		}
		var builder netipx.IPSetBuilder
		for _, prefix := range prefixes {
			if prefix.Addr().Is4() == (spec.family == nftables.TableFamilyIPv4) {
				builder.AddPrefix(prefix)
			}
		}
		addresses, err := builder.IPSet()
		if err != nil {
			return err
		}
		set := &nftables.Set{Table: table, ID: spec.id, Name: spec.name, Interval: true, KeyType: spec.keyType}
		if update {
			nft.FlushSet(set)
		} else if err := nft.AddSet(set, nil); err != nil {
			return err
		}
		elements := obhodAddressElements(addresses)
		for len(elements) > 0 {
			count := min(1000, len(elements))
			if err := nft.SetAddElements(set, elements[:count]); err != nil {
				return err
			}
			elements = elements[count:]
		}
	}
	return nil
}

func obhodAddressElements(addresses *netipx.IPSet) []nftables.SetElement {
	ranges := addresses.Ranges()
	elements := make([]nftables.SetElement, 0, 2*len(ranges))
	for _, interval := range ranges {
		elements = append(elements, nftables.SetElement{Key: interval.From().AsSlice()})
		if end := interval.To().Next(); end.IsValid() {
			elements = append(elements, nftables.SetElement{Key: end.AsSlice(), IntervalEnd: true})
		}
	}
	return elements
}

func (r *autoRedirect) updateObhodAddressSets() error {
	r.obhodSetAccess.Lock()
	defer r.obhodSetAccess.Unlock()
	if !r.obhodSetsActive {
		return nil
	}
	return runInNetworkNamespace(r.tunOptions.NetNs, func() error {
		nft, err := nftables.New()
		if err != nil {
			return err
		}
		defer nft.CloseLasting()
		table, err := nft.ListTableOfFamily(r.tableName, nftables.TableFamilyINet)
		if err != nil {
			return err
		}
		if err = r.writeObhodAddressSets(nft, table, true); err != nil {
			return err
		}
		return nft.Flush()
	})
}

func (r *autoRedirect) nftablesObhodSelection(nft *nftables.Conn, table *nftables.Table, chain *nftables.Chain) {
	if !r.obhodSelective() {
		return
	}
	for _, spec := range obhodAddressSets {
		if spec.invert && !r.obhodPositiveSet {
			continue
		}
		nftablesCreateExcludeDestinationIPSet(nft, table, chain, spec.id, spec.name, spec.family, spec.invert)
	}
}

// Input-marked packets must never use the main table if the TUN device or
// its rule disappears before the nftables owner can clean up.
func (r *autoRedirect) nftablesObhodGuard(nft *nftables.Conn, table *nftables.Table) {
	chain := nft.AddChain(&nftables.Chain{
		Table: table, Name: "obhod_tun_guard", Hooknum: nftables.ChainHookPostrouting,
		Type: nftables.ChainTypeFilter, Priority: nftables.ChainPriorityFilter,
	})
	nft.AddRule(&nftables.Rule{Table: table, Chain: chain, Exprs: []expr.Any{
		&expr.Meta{Key: expr.MetaKeyMARK, Register: 1},
		&expr.Cmp{Op: expr.CmpOpEq, Register: 1, Data: binaryutil.NativeEndian.PutUint32(r.tunOptions.AutoRedirectInputMark)},
		&expr.Meta{Key: expr.MetaKeyOIFNAME, Register: 1},
		&expr.Cmp{Op: expr.CmpOpNeq, Register: 1, Data: nftablesIfname(r.tunOptions.Name)},
		&expr.Counter{},
		&expr.Verdict{Kind: expr.VerdictDrop},
	}})
}
