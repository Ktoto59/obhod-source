// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Obhod contributors
package tun

import (
	"bytes"
	"net/netip"
	"testing"

	"github.com/sagernet/sing-tun/gtcpip/header"
	M "github.com/sagernet/sing/common/metadata"
	N "github.com/sagernet/sing/common/network"
)

type dnsPayloadRecorder struct {
	Handler
	payload []byte
	calls   int
}

func (r *dnsPayloadRecorder) NewDNSPacket(payload []byte, _, _ M.Socksaddr, _ N.PacketWriter) {
	r.payload = bytes.Clone(payload)
	r.calls++
}

func TestObhodDNSDispatcherUsesUDPDatagramLength(t *testing.T) {
	dnsQuery := []byte{0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 'a', 0, 0, 1, 0, 1}
	for _, tt := range []struct {
		name   string
		length int
		padded bool
		valid  bool
	}{
		{"exact", header.UDPMinimumSize + len(dnsQuery), false, true},
		{"padded", header.UDPMinimumSize + len(dnsQuery), true, true},
		{"short length", header.UDPMinimumSize - 1, false, false},
		{"truncated", header.UDPMinimumSize + len(dnsQuery) + 1, false, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			udp := make(header.UDP, header.UDPMinimumSize+len(dnsQuery))
			udp.Encode(&header.UDPFields{SrcPort: 45000, DstPort: 53, Length: uint16(tt.length)})
			copy(udp.Payload(), dnsQuery)
			if tt.padded {
				udp = append(udp, 0xff, 0xff)
			}
			recorder := new(dnsPayloadRecorder)
			dispatcher := &ForwardDispatcher{handler: recorder}
			dispatcher.hijackDNSPacket(&forwardPacket{
				transport:   udp,
				source:      netip.MustParseAddrPort("192.0.2.10:45000"),
				destination: netip.MustParseAddrPort("172.19.0.2:53"),
			})
			if tt.valid {
				if recorder.calls != 1 || !bytes.Equal(recorder.payload, dnsQuery) {
					t.Fatalf("intercepted %d packets, payload %x", recorder.calls, recorder.payload)
				}
			} else if recorder.calls != 0 {
				t.Fatalf("malformed UDP reached the DNS decoder (%d calls)", recorder.calls)
			}
		})
	}
}
