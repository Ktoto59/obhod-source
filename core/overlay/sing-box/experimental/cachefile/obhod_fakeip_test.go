// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package cachefile

import (
	"net/netip"
	"path/filepath"
	"testing"

	"github.com/sagernet/bbolt"
	"github.com/sagernet/sing-box/adapter"
)

func TestObhodFakeIPMetadataSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.db")
	db, err := bbolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	cache := &CacheFile{DB: db}
	address := netip.MustParseAddr("198.18.0.2")
	metadata := &adapter.FakeIPMetadata{Inet4Range: netip.MustParsePrefix("198.18.0.0/15"), Inet4Current: address}
	if err = cache.FakeIPStoreWithMetadata(address, "selected.example", metadata); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		saved := cache.FakeIPMetadata()
		if saved == nil || saved.Inet4Current != address {
			t.Fatal("Reading metadata consumed the crash-recovery cursor")
		}
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	// A failed write must not advance the persisted allocation cursor or insert
	// half of the next mapping. This also checks that write errors propagate.
	next := address.Next()
	if err = cache.FakeIPStoreWithMetadata(next, "next.example", &adapter.FakeIPMetadata{Inet4Range: metadata.Inet4Range, Inet4Current: next}); err == nil {
		t.Fatal("Closed database accepted an allocation")
	}
	db, err = bbolt.Open(path, 0600, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	cache = &CacheFile{DB: db}
	if saved := cache.FakeIPMetadata(); saved == nil || saved.Inet4Current != address {
		t.Fatal("Cursor not recovered after reopen")
	}
	if domain, ok := cache.FakeIPLoad(address); !ok || domain != "selected.example" {
		t.Fatal("Mapping not recovered with cursor")
	}
	if _, ok := cache.FakeIPLoad(next); ok {
		t.Fatal("Failed allocation partially committed")
	}
}
