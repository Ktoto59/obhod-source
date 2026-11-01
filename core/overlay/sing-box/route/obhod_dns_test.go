// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package route

import (
	"context"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/sagernet/sing-box/adapter"
	"github.com/sagernet/sing/common/buf"
	"github.com/sagernet/sing/common/logger"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/common/udpnat2"
)

type obhodDNSRouter struct { adapter.DNSRouter }
func (*obhodDNSRouter) Exchange(_ context.Context,q *dns.Msg,_ adapter.DNSQueryOptions)(*dns.Msg,error) { a:=new(dns.Msg);a.SetReply(q);return a,nil }
type obhodDNSConn struct {
	udpnat.Conn
	handler N.UDPHandlerEx
	timeouts []time.Duration
	answers chan bool
}
func (c *obhodDNSConn) SetTimeout(d time.Duration) bool { c.timeouts=append(c.timeouts,d);return true }
func (c *obhodDNSConn) SetHandler(h N.UDPHandlerEx) { c.handler=h }
func (c *obhodDNSConn) WritePacket(b *buf.Buffer,_ M.Socksaddr)error {b.Release();c.answers<-true;return nil}

func TestObhodHijackedDNSRefreshesItsOwnTimeout(t *testing.T) {
	c:=&obhodDNSConn{answers:make(chan bool,2)}
	r:=&Router{dns:&obhodDNSRouter{},logger:logger.NOP()}
	if err:=r.hijackDNSPacket(context.Background(),c,nil,adapter.InboundContext{},nil);err!=nil {t.Fatal(err)}
	if c.handler==nil {t.Fatal("DNS handler not installed")}
	for i:=0;i<2;i++ {
		q:=new(dns.Msg);q.SetQuestion("example.org.",dns.TypeA);wire,err:=q.Pack();if err!=nil {t.Fatal(err)}
		b:=buf.NewSize(len(wire));b.Write(wire)
		c.handler.NewPacketEx(b,M.ParseSocksaddr("192.0.2.53:53"))
		select {case <-c.answers:case <-time.After(time.Second):t.Fatal("DNS response not written")}
	}
	if len(c.timeouts)!=3 {t.Fatal("DNS timeout was not refreshed per packet")}
	for _,timeout:=range c.timeouts {if timeout!=10*time.Second {t.Fatalf("DNS retained generic UDP timeout %s",timeout)}}
}
