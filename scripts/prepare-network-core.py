#!/usr/bin/env python3
"""Apply the small, version-pinned Obhod patch set to clean upstream sources.

The source directories must be exact checkouts of the revisions below. Generated
sources remain GPL-3.0-or-later; this Apache-2.0 build script does not relicense them.
"""
import argparse
import difflib
import hashlib
import json
import io
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
REVISIONS = {'sing-box': '628cb31ffa79cffffd34c2f9cde6cae044e4fc12',
             'sing-tun': 'f3b42b8b8e061ef849213a776d9fcf3d5f6ea239',
             'sing': '87773cc9c5b2a4e4fc05cbd2db304ba23ca13515'}
VERSION = '1.13.21-obhod.3'


def prepare(box, tun, sing, destination):
    destination.mkdir(parents=True, exist_ok=True)
    changes = []
    for project, original in [('sing-box', box), ('sing-tun', tun), ('sing', sing)]:
        revision = subprocess.check_output(['git', '-C', original, 'rev-parse', 'HEAD'], text=True).strip()
        assert revision == REVISIONS[project], f'Unexpected {project} revision'
        # Read committed blobs, not the developer's working tree or prior patches.
        target = destination / ('source' if project == 'sing-box' else project)
        assert not target.exists(), f'Destination already exists: {target}'
        target.mkdir()
        committed = subprocess.check_output(['git', '-C', original, 'archive', 'HEAD'])
        with tarfile.open(fileobj=io.BytesIO(committed)) as archive:
            archive.extractall(target, filter='data')
        def replace(name, old, new, count=1):
            file=target/name;before=file.read_text(encoding='utf-8')
            assert before.count(old)==count, f'Upstream context mismatch: {name}'
            after=before.replace(old,new);file.write_text(after,encoding='utf-8',newline='\n')
            changes.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile=project+'/'+name,tofile=project+'/'+name))
        if project == 'sing-box':
            replace('include/registry.go', '\ttransport.RegisterHTTPS(registry)', '\ttransport.RegisterHTTPS(registry)\n\ttransport.RegisterObhodPool(registry)')
            with (target/'go.mod').open('a',encoding='utf-8') as f:f.write('\nreplace github.com/sagernet/sing-tun => ../sing-tun\nreplace github.com/sagernet/sing => ../sing\n')
            replace('route/dns.go', '\t\tmetadata.Destination = M.Socksaddr{}\n', '\t\tmetadata.Destination = M.Socksaddr{}\n\t\tnatConn.SetTimeout(C.ProtocolTimeouts[C.ProtocolDNS])\n')
            replace('route/dns.go', 'func (h *dnsHijacker) NewPacketEx(buffer *buf.Buffer, destination M.Socksaddr) {',
                'func (h *dnsHijacker) NewPacketEx(buffer *buf.Buffer, destination M.Socksaddr) {\n\tif natConn, ok := h.conn.(udpnat.Conn); ok { natConn.SetTimeout(C.ProtocolTimeouts[C.ProtocolDNS]) }')
        elif project == 'sing-tun':
            with (target/'go.mod').open('a',encoding='utf-8') as f:f.write('\nreplace github.com/sagernet/sing => ../sing\n')
            replace('redirect_route_linux.go', 'int(rand.Uint32())', 'int(rand.Uint32() & 0x7fffffff)')
            replace('stack_system.go', 'udpnat.New(s.handler, s.preparePacketConnection, s.udpTimeout, false)', 'udpnat.NewDNSIsolated(s.handler, s.preparePacketConnection, s.udpTimeout, false)')
            replace('stack_gvisor_udp.go', 'udpnat.New(handler, forwarder.PreparePacketConnection, timeout, false)', 'udpnat.NewDNSIsolated(handler, forwarder.PreparePacketConnection, timeout, false)')
            for name in ['ping/destination.go','ping/destination_gvisor.go']:
                replace(name, '\tdefer d.Close()\n' if name.endswith('destination.go') else '\tdefer d.endpoint.Close()\n',
                    ('\tdefer d.Close()\n' if name.endswith('destination.go') else '\tdefer d.endpoint.Close()\n')+'\treceived := false\n')
                replace(name, '\t\t\tif !E.IsClosed(err) {\n\t\t\t\td.logger.ErrorContext(d.ctx, E.Cause(err, "receive ICMP echo reply"))\n\t\t\t}',
                    '\t\t\tlogICMPReadError(d.ctx, d.logger, err, received)')
                # Only classify a session as idle after a reply was written back.
                marker='\t\tbuffer.Release()\n\t}\n}'
                replace(name, marker, '\t\treceived = true\n'+marker)
        else:
            # Default users keep endpoint-independent UDP NAT. Only TUN callers
            # opt into a separate destination-keyed cache entry for DNS (:53).
            for name in ['common/udpnat2/service.go','common/udpnat2/conn.go']:
                replace(name,'freelru.Cache[netip.AddrPort, *natConn]','freelru.Cache[natKey, *natConn]',2 if name.endswith('service.go') else 1)
                if name.endswith('conn.go'):
                    replace(name,'\t"net/netip"\n','')
                    replace(name,'\tlocalAddr       M.Socksaddr','\tcacheKey        natKey\n\tlocalAddr       M.Socksaddr')
                    replace(name,'c.cache.PeekWithLifetime(c.localAddr.AddrPort())','c.cache.PeekWithLifetime(c.cacheKey)')
                    replace(name,'c.cache.UpdateLifetime(c.localAddr.AddrPort(), c, timeout)','c.cache.UpdateLifetime(c.cacheKey, c, timeout)')
                else:
                    replace(name,'freelru.NewSynced[netip.AddrPort, *natConn](1024, maphash.NewHasher[netip.AddrPort]().Hash32)','freelru.NewSynced[natKey, *natConn](1024, maphash.NewHasher[natKey]().Hash32)')
                    replace(name,'freelru.NewSharded[netip.AddrPort, *natConn](1024, maphash.NewHasher[netip.AddrPort]().Hash32)','freelru.NewSharded[natKey, *natConn](1024, maphash.NewHasher[natKey]().Hash32)')
                    replace(name,'func(port netip.AddrPort, conn *natConn)','func(port natKey, conn *natConn)')
                    replace(name,'func(_ netip.AddrPort, conn *natConn)','func(_ natKey, conn *natConn)')
                    replace(name,'type Service struct {','type natKey struct { source, destination netip.AddrPort }\n\ntype Service struct {\n\tdnsIsolated bool')
                    replace(name,'func New(handler N.UDPConnectionHandlerEx, prepare PrepareFunc, timeout time.Duration, shared bool) *Service {',
                        'func New(handler N.UDPConnectionHandlerEx, prepare PrepareFunc, timeout time.Duration, shared bool) *Service { return newService(handler, prepare, timeout, shared, false) }\n\nfunc NewDNSIsolated(handler N.UDPConnectionHandlerEx, prepare PrepareFunc, timeout time.Duration, shared bool) *Service { return newService(handler, prepare, timeout, shared, true) }\n\nfunc newService(handler N.UDPConnectionHandlerEx, prepare PrepareFunc, timeout time.Duration, shared, dnsIsolated bool) *Service {')
                    replace(name,'\t\tcache:   cache,','\t\tdnsIsolated: dnsIsolated,\n\t\tcache:   cache,')
                    replace(name,'conn, _, ok := s.cache.GetAndRefreshOrAdd(source.AddrPort(),',
                        'key := natKey{source: source.AddrPort()}\n\tif s.dnsIsolated && destination.Port == 53 { key.destination = destination.AddrPort() }\n\tconn, _, ok := s.cache.GetAndRefreshOrAdd(key,')
                    replace(name,'\t\t\tcache:        s.cache,','\t\t\tcache:        s.cache,\n\t\t\tcacheKey:     key,')
        overlay=ROOT/'core/overlay'/project
        if overlay.exists():shutil.copytree(overlay,target,dirs_exist_ok=True)
    (destination/'upstream-changes.patch').write_text(''.join(changes),encoding='utf-8')
    manifest={'version':VERSION,'upstream':REVISIONS,'overlay':{}}
    for file in sorted((ROOT/'core/overlay').rglob('*.go')):
        manifest['overlay'][file.relative_to(ROOT/'core/overlay').as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
    (destination/'build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print('Prepared',VERSION,'in',destination)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sing-box',type=Path,required=True)
    parser.add_argument('--sing-tun',type=Path,required=True)
    parser.add_argument('--sing',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();prepare(args.sing_box.resolve(),args.sing_tun.resolve(),args.sing.resolve(),args.output.resolve())
