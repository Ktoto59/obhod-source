// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package dns

import (
	"context"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing/common/buf"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

type blockingDNSRouter struct {
	adapter.DNSRouter
	exchange chan context.Context
}

func (r *blockingDNSRouter) ExchangeAsync(ctx context.Context, _ *dns.Msg, _ adapter.DNSQueryOptions, _ func(*dns.Msg, error)) {
	r.exchange <- ctx
}

type closingPacketConn struct {
	N.PacketConn
	once sync.Once
	done chan struct{}
}

func (c *closingPacketConn) ReadPacket(*buf.Buffer) (M.Socksaddr, error) {
	<-c.done
	return M.Socksaddr{}, io.EOF
}

func (c *closingPacketConn) Close() error {
	c.once.Do(func() { close(c.done) })
	return nil
}

func TestObhodDNSPacketExchangeCanceledOnClose(t *testing.T) {
	router := &blockingDNSRouter{exchange: make(chan context.Context, 1)}
	conn := &closingPacketConn{done: make(chan struct{})}
	defer conn.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := new(dns.Msg).SetQuestion("selected.example.", dns.TypeA)
	packet, err := request.Pack()
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_ = NewDNSPacketConnection(ctx, router, conn, []*N.PacketBuffer{{Buffer: buf.As(packet)}}, adapter.InboundContext{})
	}()
	var exchange context.Context
	select {
	case exchange = <-router.exchange:
	case <-time.After(time.Second):
		t.Fatal("DNS exchange did not start")
	}
	conn.Close()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("DNS packet handler did not exit")
	}
	select {
	case <-exchange.Done():
	case <-time.After(time.Second):
		t.Fatal("The pending DNS exchange survived its connection")
	}
}
