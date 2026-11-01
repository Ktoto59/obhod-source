// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package transport

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/miekg/dns"
	"github.com/sagernet/sing-box/adapter"
	boxDNS "github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/log"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/service"
)

const obhodPoolType = "obhod-pool"

func RegisterObhodPool(registry *boxDNS.TransportRegistry) {
	boxDNS.RegisterTransport[option.ObhodDNSPoolOptions](registry, obhodPoolType, newObhodPool)
}

type poolHealth struct {
	delay    time.Duration
	failures uint16
}

type obhodPool struct {
	boxDNS.TransportAdapter
	manager adapter.DNSTransportManager
	servers []adapter.DNSTransport
	mode    string
	limit   chan struct{}
	mu      sync.Mutex
	health  []poolHealth
	queries atomic.Uint64
}

func newObhodPool(ctx context.Context, _ log.ContextLogger, tag string, options option.ObhodDNSPoolOptions) (adapter.DNSTransport, error) {
	if options.Mode == "" {
		options.Mode = "parallel"
	}
	if options.Mode != "parallel" && options.Mode != "balanced" {
		return nil, fmt.Errorf("DNS pool mode must be parallel or balanced")
	}
	if len(options.Servers) < 2 || len(options.Servers) > 4 {
		return nil, fmt.Errorf("DNS pool requires 2 to 4 transports")
	}
	seen := make(map[string]bool)
	for _, member := range options.Servers {
		if member == "" || member == tag || seen[member] {
			return nil, fmt.Errorf("DNS pool members must be unique and cannot reference themselves")
		}
		seen[member] = true
	}
	return &obhodPool{
		TransportAdapter: boxDNS.NewTransportAdapter(obhodPoolType, tag, append([]string(nil), options.Servers...)),
		manager:          service.FromContext[adapter.DNSTransportManager](ctx),
		mode:             options.Mode, limit: make(chan struct{}, 64), health: make([]poolHealth, len(options.Servers)),
	}, nil
}

func (p *obhodPool) Start(stage adapter.StartStage) error {
	if stage != adapter.StartStateStart {
		return nil
	}
	for _, tag := range p.Dependencies() {
		member, found := p.manager.Transport(tag)
		if !found {
			return fmt.Errorf("DNS pool member %q not found", tag)
		}
		if member.Type() == "fakeip" || member.Type() == obhodPoolType {
			return fmt.Errorf("DNS pool members must be real, non-pool transports")
		}
		p.servers = append(p.servers, member)
	}
	return nil
}

// The transport manager owns member lifetimes and connection resets.
func (p *obhodPool) Close() error { return nil }
func (p *obhodPool) Reset() {
	p.mu.Lock()
	clear(p.health)
	p.mu.Unlock()
}

type poolAnswer struct {
	index   int
	message *dns.Msg
	err     error
	elapsed time.Duration
}

func (p *obhodPool) preferred(sent []bool) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	best, score := -1, time.Duration(1<<63-1)
	for i, h := range p.health {
		if sent[i] {
			continue
		}
		delay := h.delay
		if delay == 0 {
			delay = 250 * time.Millisecond
		}
		value := delay + time.Duration(h.failures)*time.Second
		if value < score {
			best, score = i, value
		}
	}
	return best
}

func validPoolAnswer(request, answer *dns.Msg) bool {
	// Native TCP/DoH transports may use ID zero on their dedicated exchange.
	// UDP validates its wire ID internally. The DNS client restores the caller ID.
	if answer == nil || !answer.Response || answer.Opcode != request.Opcode || len(answer.Question) != len(request.Question) {
		return false
	}
	for i, q := range request.Question {
		a := answer.Question[i]
		if !strings.EqualFold(q.Name, a.Name) || q.Qtype != a.Qtype || q.Qclass != a.Qclass {
			return false
		}
	}
	return true
}

func (p *obhodPool) Exchange(parent context.Context, request *dns.Msg) (*dns.Msg, error) {
	if err := parent.Err(); err != nil {
		return nil, err
	}
	if len(p.servers) < 2 {
		return nil, fmt.Errorf("DNS pool has not started")
	}
	select {
	case p.limit <- struct{}{}:
	default:
		return nil, fmt.Errorf("DNS pool concurrency limit reached")
	}
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	answers := make(chan poolAnswer, len(p.servers))
	sent := make([]bool, len(p.servers))
	active, started := 0, 0
	var fallback *dns.Msg
	finishFallback := func() (*dns.Msg, error) {
		if fallback != nil {
			fallback.Id = request.Id
			return fallback, nil
		}
		return nil, fmt.Errorf("all DNS pool members failed")
	}
	launch := func(index int) {
		if index < 0 || sent[index] {
			return
		}
		sent[index] = true
		active++
		started++
		// The token remains held until every losing exchange exits. This bounds
		// goroutines even if a member takes time to react to cancellation.
		packet := request.Copy()
		go func() {
			begin := time.Now()
			message, err := p.servers[index].Exchange(ctx, packet)
			answers <- poolAnswer{index, message, err, time.Since(begin)}
		}()
	}
	// Members in sing-box obey context cancellation. Drain them before releasing
	// the concurrency token without delaying the winning response to the client.
	defer func() {
		cancel()
		remaining := active
		if remaining == 0 {
			<-p.limit
			return
		}
		go func() {
			for i := 0; i < remaining; i++ {
				<-answers
			}
			<-p.limit
		}()
	}()
	if p.mode == "parallel" {
		for i := range p.servers {
			launch(i)
		}
	} else if sequence := p.queries.Add(1); sequence%16 == 0 {
		launch(int(sequence/16) % len(p.servers))
	} else {
		launch(p.preferred(sent))
	}
	timer := time.NewTimer(350 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			if parent.Err() == nil && fallback != nil {
				return finishFallback()
			}
			return nil, ctx.Err()
		case result := <-answers:
			active--
			valid := result.err == nil && validPoolAnswer(request, result.message)
			success := valid && (result.message.Rcode == dns.RcodeSuccess || result.message.Rcode == dns.RcodeNameError)
			if valid && !success && (fallback == nil || result.message.Rcode == dns.RcodeRefused) {
				fallback = result.message
			}
			p.mu.Lock()
			h := &p.health[result.index]
			if valid && result.message.Rcode != dns.RcodeServerFailure {
				if h.delay == 0 {
					h.delay = result.elapsed
				} else {
					h.delay = (h.delay*7 + result.elapsed*3) / 10
				}
				h.failures = 0
			} else if h.failures < 60 {
				h.failures++
			}
			p.mu.Unlock()
			if success {
				result.message.Id = request.Id
				return result.message, nil
			}
			if started == len(p.servers) && active == 0 {
				return finishFallback()
			}
			if p.mode == "balanced" {
				launch(p.preferred(sent))
			}
		case <-timer.C:
			if p.mode == "balanced" {
				launch(p.preferred(sent))
			}
			timer.Reset(350 * time.Millisecond)
		}
	}
}
