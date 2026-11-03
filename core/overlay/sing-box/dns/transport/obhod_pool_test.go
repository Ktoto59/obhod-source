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
	nodata   bool
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
	if s.code == dns.RcodeSuccess && !s.nodata {
		rr, _ := dns.NewRR(query.Question[0].Name + " 60 IN A 203.0.113.42")
		answer.Answer = []dns.RR{rr}
	}
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

func TestObhodPoolNegativeAnswerWindow(t *testing.T) {
	for _, mode := range []string{"parallel", "balanced"} {
		for _, code := range []int{dns.RcodeNameError, dns.RcodeSuccess} {
			negative := &poolStub{wait: 15 * time.Millisecond, code: code, nodata: true}
			positive := &poolStub{wait: 45 * time.Millisecond}
			p := testPool(mode, negative, positive)
			a, err := p.Exchange(context.Background(), poolQuery())
			if err != nil || len(a.Answer) == 0 {
				t.Fatalf("mode=%s code=%d: negative masked address: %v %v", mode, code, a, err)
			}
		}
		for _, other := range []*poolStub{{code: dns.RcodeNameError}, {silent: true}} {
			p := testPool(mode, &poolStub{code: dns.RcodeNameError}, other)
			begin := time.Now()
			a, err := p.Exchange(context.Background(), poolQuery())
			if err != nil || a.Rcode != dns.RcodeNameError || time.Since(begin) > time.Second {
				t.Fatalf("mode=%s: negative timeout: %v", mode, err)
			}
		}
	}
}

func TestObhodPoolTimeoutAndResourceRecovery(t *testing.T) {
	p := testPool("parallel", &poolStub{silent: true}, &poolStub{silent: true})
	begin := time.Now()
	if _, err := p.Exchange(context.Background(), poolQuery()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("unavailable members: %v", err)
	}
	if time.Since(begin) > 5*time.Second {
		t.Fatal("pool exceeded its transport deadline")
	}
	for round := 0; round < 4; round++ {
		var workers sync.WaitGroup
		for i := 0; i < 96; i++ {
			workers.Add(1)
			go func() {
				defer workers.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
				defer cancel()
				if _, err := p.Exchange(ctx, poolQuery()); err == nil {
					t.Error("unavailable members returned success")
				}
			}()
		}
		workers.Wait()
		deadline := time.Now().Add(time.Second)
		for len(p.limit) != 0 {
			if time.Now().After(deadline) {
				t.Fatal("canceled exchanges leaked admission tokens")
			}
			time.Sleep(time.Millisecond)
		}
	}
}

func TestObhodPoolQuestionIdentity(t *testing.T) {
	q := poolQuery()
	for _, change := range []func(*dns.Msg){
		func(a *dns.Msg) { a.Response = false },
		func(a *dns.Msg) { a.Opcode = dns.OpcodeStatus },
		func(a *dns.Msg) { a.Question[0].Name = "other.example." },
		func(a *dns.Msg) { a.Question[0].Qtype = dns.TypeAAAA },
		func(a *dns.Msg) { a.Question[0].Qclass = dns.ClassCHAOS },
	} {
		a := new(dns.Msg)
		a.SetReply(q)
		change(a)
		if validPoolAnswer(q, a) {
			t.Fatalf("accepted mismatched answer: %v", a)
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
