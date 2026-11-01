// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package udpnat

import (
	"context"
	"testing"
	"time"

	"github.com/sagernet/sing/common/buf"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

type obhodSession struct {
	conn        N.PacketConn
	destination M.Socksaddr
}
type obhodHandler struct{ sessions chan obhodSession }

func (h *obhodHandler) NewPacketConnectionEx(_ context.Context, c N.PacketConn, _ M.Socksaddr, d M.Socksaddr, _ N.CloseHandlerFunc) {
	h.sessions <- obhodSession{c, d}
}

type obhodWriter struct{}

func (*obhodWriter) WritePacket(b *buf.Buffer, _ M.Socksaddr) error { b.Release(); return nil }

func TestObhodDNSIsolationPreservesEndpointIndependentUDP(t *testing.T) {
	for _, shared := range []bool{false, true} {
		h := &obhodHandler{make(chan obhodSession, 8)}
		s := NewDNSIsolated(h, func(_, _ M.Socksaddr, _ any) (bool, context.Context, N.PacketWriter, N.CloseHandlerFunc) {
			return true, context.Background(), &obhodWriter{}, nil
		}, time.Minute, shared)
		defer s.Purge()
		source := M.ParseSocksaddr("192.0.2.10:40000")
		first := M.ParseSocksaddr("192.0.2.53:53")
		second := M.ParseSocksaddr("198.51.100.53:53")
		stun := M.ParseSocksaddr("198.51.100.1:3478")
		peer := M.ParseSocksaddr("203.0.113.1:50000")
		dnsData := []byte{0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
		stunData := []byte{0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42}
		s.NewPacket([][]byte{dnsData}, source, first, nil)
		s.NewPacket([][]byte{stunData}, source, stun, nil)
		s.NewPacket([][]byte{stunData}, source, peer, nil)
		s.NewPacket([][]byte{dnsData}, source, second, nil)
		sessions := map[M.Socksaddr]N.PacketConn{}
		for i := 0; i < 3; i++ {
			select {
			case v := <-h.sessions:
				sessions[v.destination] = v.conn
			case <-time.After(time.Second):
				t.Fatal("distinct DNS session not created")
			}
		}
		if sessions[first] == nil || sessions[second] == nil || sessions[stun] == nil {
			t.Fatal("DNS and STUN shared a session")
		}
		select {
		case <-h.sessions:
			t.Fatal("P2P endpoint-independent mapping was split")
		default:
		}
		b := buf.New()
		defer b.Release()
		for _, destination := range []M.Socksaddr{stun, peer} {
			got, err := sessions[stun].ReadPacket(b)
			if err != nil || got != destination || string(b.Bytes()) != string(stunData) {
				t.Fatalf("STUN redirected into DNS: %v", err)
			}
			b.Reset()
		}
		for _, destination := range []M.Socksaddr{first, second} {
			got, err := sessions[destination].ReadPacket(b)
			if err != nil || got != destination || string(b.Bytes()) != string(dnsData) {
				t.Fatal("DNS packet lost")
			}
			b.Reset()
		}
		c := sessions[first].(Conn)
		if !c.SetTimeout(time.Second) || c.Timeout() > time.Second {
			t.Fatal("DNS timeout did not address its own cache key")
		}
	}
}
