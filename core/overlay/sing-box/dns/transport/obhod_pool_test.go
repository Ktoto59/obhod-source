// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package transport

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
	"github.com/sagernet/sing-box/adapter"
	boxDNS "github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/option"
)

type poolStub struct {
	boxDNS.TransportAdapter
	wait     time.Duration
	code     int
	wrong    bool
	silent   bool
	count    atomic.Int32
	canceled atomic.Int32
}

func (s *poolStub) Start(adapter.StartStage) error { return nil }
func (s *poolStub) Close() error                   { return nil }
func (s *poolStub) Reset()                         {}
func (s *poolStub) Exchange(ctx context.Context, query *dns.Msg) (*dns.Msg, error) {
	s.count.Add(1)
	if s.silent {
		<-ctx.Done()
		s.canceled.Add(1)
		return nil, ctx.Err()
	}
	select {
	case <-ctx.Done():
		s.canceled.Add(1)
		return nil, ctx.Err()
	case <-time.After(s.wait):
	}
	answer := new(dns.Msg)
	answer.SetRcode(query, s.code)
	if s.wrong {
		answer.Question = []dns.Question{{Name: "wrong.example.", Qtype: dns.TypeA, Qclass: dns.ClassINET}}
	}
	return answer, nil
}
func testPool(mode string, members ...*poolStub) *obhodPool {
	p := &obhodPool{mode: mode, limit: make(chan struct{}, 64), health: make([]poolHealth, len(members))}
	for _, member := range members {
		p.servers = append(p.servers, member)
	}
	return p
}
func poolQuery() *dns.Msg { q := new(dns.Msg); q.SetQuestion("test.example.", dns.TypeA); return q }

func TestObhodPoolParallelAndCancellation(t *testing.T) {
	slow, fast := &poolStub{silent: true}, &poolStub{wait: 10 * time.Millisecond}
	p := testPool("parallel", slow, fast)
	begin := time.Now()
	q := poolQuery()
	answer, err := p.Exchange(context.Background(), q)
	if err != nil || answer.Id != q.Id || time.Since(begin) > time.Second {
		t.Fatalf("answer=%v err=%v", answer, err)
	}
	deadline := time.Now().Add(time.Second)
	for slow.canceled.Load() == 0 || len(p.limit) != 0 {
		if time.Now().After(deadline) {
			t.Fatal("loser did not cancel or token leaked")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestObhodPoolRejectsBadAnswers(t *testing.T) {
	for _, bad := range []*poolStub{{code: dns.RcodeServerFailure}, {code: dns.RcodeRefused}, {wrong: true}} {
		p := testPool("parallel", bad, &poolStub{wait: 15 * time.Millisecond, code: dns.RcodeNameError})
		a, err := p.Exchange(context.Background(), poolQuery())
		if err != nil || a.Rcode != dns.RcodeNameError {
			t.Fatalf("bad answer masked NXDOMAIN: %v", err)
		}
	}
}
func TestObhodPoolBalancedHedge(t *testing.T) {
	silent, fast := &poolStub{silent: true}, &poolStub{}
	p := testPool("balanced", silent, fast)
	begin := time.Now()
	if _, err := p.Exchange(context.Background(), poolQuery()); err != nil {
		t.Fatal(err)
	}
	if time.Since(begin) < 300*time.Millisecond || time.Since(begin) > time.Second {
		t.Fatal("hedge timing")
	}
	before := silent.count.Load()
	if _, err := p.Exchange(context.Background(), poolQuery()); err != nil {
		t.Fatal(err)
	}
	if silent.count.Load() != before {
		t.Fatal("healthy resolver was not preferred")
	}
}
func TestObhodPoolCancellationLimitsAndFailure(t *testing.T) {
	p := testPool("parallel", &poolStub{silent: true}, &poolStub{silent: true})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Exchange(ctx, poolQuery()); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	full := testPool("parallel", &poolStub{}, &poolStub{})
	for i := 0; i < cap(full.limit); i++ {
		full.limit <- struct{}{}
	}
	if _, err := full.Exchange(context.Background(), poolQuery()); err == nil {
		t.Fatal("unbounded admission")
	}
	failed := testPool("parallel", &poolStub{code: dns.RcodeRefused}, &poolStub{code: dns.RcodeServerFailure})
	if answer, err := failed.Exchange(context.Background(), poolQuery()); err != nil || answer.Rcode != dns.RcodeRefused {
		t.Fatalf("filter refusal was lost: %v", err)
	}
}

func TestObhodPoolPreservesProviderRcodes(t *testing.T) {
	for _, mode := range []string{"parallel", "balanced"} {
		for _, code := range []int{dns.RcodeRefused, dns.RcodeServerFailure, dns.RcodeFormatError, dns.RcodeNotImplemented} {
			p := testPool(mode, &poolStub{code: code}, &poolStub{code: code})
			q := poolQuery()
			a, err := p.Exchange(context.Background(), q)
			if err != nil || a.Rcode != code || a.Id != q.Id {
				t.Fatalf("mode=%s code=%d: %v", mode, code, err)
			}
		}
	}
}

func TestObhodPoolSuccessfulAnswerWinsOverRefused(t *testing.T) {
	for _, mode := range []string{"parallel", "balanced"} {
		p := testPool(mode, &poolStub{code: dns.RcodeRefused}, &poolStub{wait: 15 * time.Millisecond})
		a, err := p.Exchange(context.Background(), poolQuery())
		if err != nil || a.Rcode != dns.RcodeSuccess {
			t.Fatalf("mode=%s: %v", mode, err)
		}
	}
}

func TestObhodPoolTransportFailuresRemainErrors(t *testing.T) {
	p := testPool("parallel", &poolStub{wrong: true}, &poolStub{wrong: true})
	if _, err := p.Exchange(context.Background(), poolQuery()); err == nil {
		t.Fatal("invalid wire answers were accepted")
	}
}
func TestObhodPoolValidatesOptions(t *testing.T) {
	for _, options := range []option.ObhodDNSPoolOptions{
		{Servers: []string{"a"}}, {Servers: []string{"a", "a"}}, {Servers: []string{"a", "pool"}},
		{Servers: []string{"a", "b"}, Mode: "unknown"}, {Servers: []string{"a", "b", "c", "d", "e"}},
	} {
		if _, err := newObhodPool(context.Background(), nil, "pool", options); err == nil {
			t.Fatalf("accepted %+v", options)
		}
	}
}

func TestObhodPoolConcurrentClientIDs(t *testing.T) {
	p := testPool("parallel", &poolStub{wait: time.Millisecond}, &poolStub{silent: true})
	var workers sync.WaitGroup
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func(id int) {
			defer workers.Done()
			q := poolQuery()
			q.Id = uint16(id % 4)
			a, err := p.Exchange(context.Background(), q)
			if err != nil || a.Id != q.Id {
				t.Errorf("client ID changed: %v", err)
			}
		}(i)
	}
	workers.Wait()
}
