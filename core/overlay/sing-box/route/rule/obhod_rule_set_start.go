// SPDX-License-Identifier: GPL-3.0-or-later

package rule

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/sagernet/sing-box/adapter"
	C "github.com/sagernet/sing-box/constant"
	"github.com/sagernet/sing-box/option"
	"github.com/sagernet/sing/common"
	E "github.com/sagernet/sing/common/exceptions"
	N "github.com/sagernet/sing/common/network"
	"github.com/sagernet/sing/service"
)

const (
	ruleStartTimeout      = 16 * time.Second
	ruleMemberTimeout     = 5 * time.Second
	ruleMemberConcurrency = 3
)

// A URLTest group has no measurements until after the initial rules have loaded.
// For a cold download, the request to the actual list is the health check.
func (s *RemoteRuleSet) fetchInitial(ctx context.Context, startContext *adapter.HTTPStartContext) error {
	opts := s.options.RemoteOptions.HTTPClient
	if !s.options.RemoteOptions.ObhodTryGroup || opts == nil || opts.Detour == "" || opts.Tag != "" {
		return s.fetch(ctx, true)
	}
	outbound, _ := s.outbound.Outbound(opts.Detour)
	group, isURLTest := outbound.(adapter.URLTestGroup)
	if !isURLTest {
		return s.fetch(ctx, true)
	}
	var members []string
	for _, tag := range group.All() {
		member, found := s.outbound.Outbound(tag)
		if !found || member.Type() == C.TypeDirect || !common.Contains(member.Network(), N.NetworkTCP) {
			continue
		}
		if _, nested := member.(adapter.OutboundGroup); !nested {
			members = append(members, tag)
		}
	}

	ctx, cancel := context.WithDeadline(ctx, startContext.StartedAt.Add(ruleStartTimeout))
	results := make(chan *http.Response)
	var workers sync.WaitGroup
	concurrency := min(len(members), ruleMemberConcurrency)
	for worker := range concurrency {
		workers.Go(func() {
			for i := worker; i < len(members) && ctx.Err() == nil; i += concurrency {
				memberOpts := *opts
				memberOpts.Detour = members[i]
				s.tryRuleSource(ctx, memberOpts, results)
			}
		})
	}
	go func() {
		workers.Wait()
		close(results)
	}()
	defer func() {
		cancel()
		workers.Wait()
	}()
	for response := range results {
		content, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			continue
		}
		if err = s.loadBytes(content); err != nil {
			continue
		}
		s.saveFetched(content, response.Header.Get("ETag"))
		return nil
	}
	return E.New("no URLTest member returned a valid rule set")
}

func (s *RemoteRuleSet) tryRuleSource(ctx context.Context, opts option.HTTPClientOptions, results chan<- *http.Response) {
	manager := service.FromContext[adapter.HTTPClientManager](s.ctx)
	transport, err := manager.ResolveTransport(s.ctx, s.logger, opts)
	if err != nil {
		return
	}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: ruleMemberTimeout}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return
	}
	response, err := client.Do(request)
	if err != nil {
		return
	}
	if response.StatusCode == http.StatusOK {
		select {
		case results <- response:
			return
		case <-ctx.Done():
		}
	}
	response.Body.Close()
}
