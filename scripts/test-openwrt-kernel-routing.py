#!/usr/bin/env python3
"""Real nftables/TUN regression. Run as root under `unshare -n` on Linux.

Only disposable namespaces are used; no physical router or host routes change.
Pass a Linux sing-box with kernel-route-set-v1 as the first argument.
"""
import ipaddress
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time


def run(*args, check=True):
    p = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if check:
        assert p.returncode == 0, (args, p.stdout, p.stderr)
    return p.stdout.strip()


def dns_answer(query):
    end = 12
    while query[end]:
        end += query[end] + 1
    end += 1
    kind = struct.unpack('!H', query[end:end+2])[0]
    address = ipaddress.ip_address('2001:db8:113::2' if kind == 28 else '203.0.113.2').packed
    return query[:2] + b'\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00' + query[12:end+4] + b'\xc0\x0c' + struct.pack('!HHIH', kind, 1, 1, len(address)) + address


def serve():
    class TCP(socketserver.BaseRequestHandler):
        def handle(self):
            data = self.request.recv(4096)
            if self.server.server_address[1] == 53:
                answer = dns_answer(data[2:])
                self.request.sendall(struct.pack('!H', len(answer)) + answer)
            else:
                self.request.sendall(self.client_address[0].encode())
    class UDP(socketserver.BaseRequestHandler):
        def handle(self):
            data, connection = self.request
            connection.sendto(dns_answer(data) if self.server.server_address[1] == 53 else self.client_address[0].encode(), self.client_address)
    for family, address in [(socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')]:
        for base, handler in [(socketserver.ThreadingTCPServer, TCP), (socketserver.ThreadingUDPServer, UDP)]:
            addresses = [address] if base == socketserver.ThreadingTCPServer else (
                ['192.0.2.2', '203.0.113.2', '198.51.100.2', '198.51.100.130', '198.51.100.200', '198.18.255.254'] if family == socket.AF_INET else
                ['fd00:20::2', '2001:db8:113::2', '2001:db8:100::2'])
            for address, port in [(a, p) for a in addresses for p in [29000, 53]]:
                def bind_server(self):
                    if self.address_family == socket.AF_INET6:
                        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    base.server_bind(self)
                cls = type('Server', (base,), {'address_family': family, 'allow_reuse_address': True, 'daemon_threads': True, 'server_bind': bind_server})
                server = cls((address, port), handler)
                threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Event().wait()


def probe(protocol, address, name=None, kind='A'):
    family = socket.AF_INET6 if ':' in address else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM if protocol == 'tcp' else socket.SOCK_DGRAM) as client:
        client.settimeout(5)
        if name:
            query = b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00' + b''.join(bytes([len(p)]) + p.encode() for p in name.split('.')) + b'\x00' + struct.pack('!HH', 28 if kind == 'AAAA' else 1, 1)
            client.connect((address, 53))
            client.sendall(struct.pack('!H', len(query)) + query if protocol == 'tcp' else query)
            result = client.recv(4096)
            if protocol == 'tcp': result = result[2:]
            assert result[:2] == query[:2] and result[3] & 15 == 0, result.hex()
            assert struct.unpack('!H', result[6:8])[0] > 0, result.hex()
            return str(ipaddress.ip_address(result[-(16 if kind == 'AAAA' else 4):]))
        client.connect((address, 29000)); client.sendall(b'test')
        return client.recv(4096).decode()


def main(binary):
    assert os.geteuid() == 0
    # Fail before any mutation unless the caller has isolated the router netns.
    assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'Run under unshare -n'
    binary = str(Path(binary).resolve())
    assert 'kernel-route-set-v1' in run(binary, 'obhod-capabilities').splitlines()
    names = [f'obhod-kr-{os.getpid()}-{part}' for part in ['client', 'server']]
    client, server = names
    children = []
    script = str(Path(__file__).resolve())
    try:
        run('ip', 'link', 'set', 'lo', 'up')
        for name in names:
            run('ip', 'netns', 'add', name); run('ip', '-n', name, 'link', 'set', 'lo', 'up')
        for local, peer, namespace, a, b, a6, b6 in [
            ('lan', 'client0', client, '10.10.0.1/24', '10.10.0.2/24', 'fd00:10::1/64', 'fd00:10::2/64'),
            ('wan', 'server0', server, '192.0.2.1/24', '192.0.2.2/24', 'fd00:20::1/64', 'fd00:20::2/64')]:
            run('ip', 'link', 'add', local, 'type', 'veth', 'peer', 'name', peer)
            run('ip', 'link', 'set', peer, 'netns', namespace)
            for address in [a, a6]: run('ip', 'addr', 'add', address, 'dev', local, 'nodad')
            for address in [b, b6]: run('ip', '-n', namespace, 'addr', 'add', address, 'dev', peer, 'nodad')
            run('ip', 'link', 'set', local, 'up'); run('ip', '-n', namespace, 'link', 'set', peer, 'up')
        run('sysctl', '-qw', 'net.ipv4.ip_forward=1', 'net.ipv6.conf.all.forwarding=1')
        for family, gateway in [('-4', '10.10.0.1'), ('-6', 'fd00:10::1')]:
            run('ip', '-n', client, family, 'route', 'add', 'default', 'via', gateway)
        for cidr in ['203.0.113.0/24', '198.51.100.0/24', '198.18.0.0/15']: run('ip', 'route', 'add', cidr, 'via', '192.0.2.2')
        for cidr in ['2001:db8:113::/64', '2001:db8:100::/64']: run('ip', '-6', 'route', 'add', cidr, 'via', 'fd00:20::2')
        run('ip', 'route', 'add', 'default', 'via', '192.0.2.2')
        run('ip', '-6', 'route', 'add', 'default', 'via', 'fd00:20::2')
        run('ip', '-n', server, 'route', 'add', '10.10.0.0/24', 'via', '192.0.2.1')
        run('ip', '-n', server, '-6', 'route', 'add', 'fd00:10::/64', 'via', 'fd00:20::1')
        for address in ['203.0.113.2/32', '198.51.100.2/32', '198.51.100.130/32', '198.51.100.200/32', '198.18.255.254/32', '2001:db8:113::2/128', '2001:db8:100::2/128']:
            run('ip', '-n', server, 'addr', 'add', address, 'dev', 'lo', 'nodad')
        children.append(subprocess.Popen(['ip', 'netns', 'exec', server, sys.executable, script, '--serve']))
        def request(protocol, address, name=None, kind='A'):
            return run('ip', 'netns', 'exec', client, sys.executable, script, '--probe', protocol, address, name or '', kind)
        def queued(chain='prerouting_prematch'):
            rules = json.loads(run('nft', '-j', 'list', 'chain', 'inet', 'sing-box', chain))['nftables']
            return sum(e['counter']['packets'] for r in rules if 'rule' in r for e in r['rule']['expr'] if 'counter' in e and any('queue' in item for item in r['rule']['expr']))
        def wait_core(core, log, offset=0):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if core.poll() is not None: log.seek(0); raise AssertionError(log.read())
                # After SIGKILL an old table can still exist. Require the new
                # process's startup record, using an independent reader so we
                # do not move the child's shared output file offset.
                with open(log.name) as reader:
                    reader.seek(offset); started = 'sing-box started' in reader.read()
                if started and run('nft', 'list', 'chain', 'inet', 'sing-box', 'prerouting_prematch', check=False): return
                time.sleep(.1)
            raise AssertionError('Core did not become ready')
        with tempfile.TemporaryDirectory(prefix='obhod-kernel-route-') as temp:
            temp = Path(temp)
            remote = temp/'selected.json'
            remote.write_text(json.dumps({'version': 3, 'rules': [{'ip_cidr': ['198.51.100.130/32']}]}))
            (temp/'binary.json').write_text(json.dumps({'version': 3, 'rules': [{'ip_cidr': ['198.51.100.200/32']}]}))
            run(binary, 'rule-set', 'compile', '--output', temp/'selected.srs', temp/'binary.json')
            lists_server = subprocess.Popen(['ip', 'netns', 'exec', server, sys.executable, '-m', 'http.server', '18080', '--directory', str(temp)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            children.append(lists_server)
            deadline = time.monotonic() + 5
            while True:
                try:
                    with socket.create_connection(('192.0.2.2', 18080), timeout=.2): break
                except OSError:
                    assert time.monotonic() < deadline, 'List server did not start'
                    time.sleep(.05)
            for ipv6 in [False, True]:
                local = ['198.18.0.0/15', '203.0.113.0/24'] + (['2001:2::/48', '2001:db8:113::/64'] if ipv6 else [])
                config = {'log': {'level': 'debug'}, 'inbounds': [{'type': 'tun', 'tag': 'tun-in', 'interface_name': 'obhod-tun',
                    'address': ['172.19.0.1/30'] + (['fdfe:dcba:9876::1/126'] if ipv6 else []), 'stack': 'system', 'auto_route': True, 'auto_redirect': True,
                    'strict_route': False, 'include_interface': ['lan', 'lo'], 'route_address_set': ['selected', 'remote', 'binary']}],
                    'outbounds': [{'type': 'direct', 'tag': 'direct'}, {'type': 'direct', 'tag': 'proxy'}],
                    'dns': {'servers': [{'type': 'udp', 'tag': 'real', 'server': '192.0.2.2'}, {'type': 'fakeip', 'tag': 'fake', 'inet4_range': '198.18.0.0/15', **({'inet6_range': '2001:2::/48'} if ipv6 else {})}],
                        'rules': [{'domain': ['selected.example'], 'query_type': ['A', 'AAAA'] if ipv6 else ['A'], 'server': 'fake'}], 'final': 'real'},
                    'route': {'auto_detect_interface': True, 'default_domain_resolver': 'real', 'rules': [
                        {'port': 53, 'action': 'hijack-dns'}, {'domain': ['selected.example'], 'action': 'route', 'outbound': 'proxy'},
                        {'rule_set': ['selected', 'remote', 'binary'], 'action': 'route', 'outbound': 'proxy'}], 'final': 'direct',
                        'rule_set': [{'type': 'inline', 'tag': 'selected', 'rules': [{'ip_cidr': local}]},
                            {'type': 'remote', 'tag': 'remote', 'format': 'source', 'url': 'http://192.0.2.2:18080/selected.json', 'update_interval': '1s'},
                            {'type': 'remote', 'tag': 'binary', 'format': 'binary', 'url': 'http://192.0.2.2:18080/selected.srs'}]}}
                config['experimental'] = {'cache_file': {'enabled': True, 'path': str(temp/f'cache-{ipv6}.db'), 'store_fakeip': True}}
                file = temp/'config.json'; file.write_text(json.dumps(config))
                log = open(temp/'core.log', 'w+')
                core = subprocess.Popen([binary, 'run', '-c', str(file)], stdout=log, stderr=log); children.append(core)
                wait_core(core, log)
                output = queued('output_prematch')
                for protocol in ['tcp', 'udp']:
                    assert probe(protocol, '198.51.100.2') == '192.0.2.1'
                assert queued('output_prematch') == output, 'Ordinary router output never enters NFQUEUE'
                for protocol in ['tcp', 'udp']:
                    router_fake = probe(protocol, '8.8.8.8', 'selected.example')
                    assert ipaddress.ip_address(router_fake) in ipaddress.ip_network('198.18.0.0/15')
                    assert probe(protocol, router_fake) == '192.0.2.1'
                assert queued('output_prematch') > output, 'Router tools can use selected FakeIP through the native output chain'
                before = queued()
                for protocol in ['tcp', 'udp']:
                    assert request(protocol, '198.51.100.2') == '10.10.0.2'
                    assert request(protocol, '2001:db8:100::2') == 'fd00:10::2'
                assert queued() == before, 'Direct first packets must never reach NFQUEUE'
                for protocol in ['tcp', 'udp']:
                    assert request(protocol, '203.0.113.2') == '192.0.2.1'
                    assert request(protocol, '198.51.100.130') == '192.0.2.1'
                    assert request(protocol, '198.51.100.200') == '192.0.2.1'
                    fake = request(protocol, '8.8.8.8', 'selected.example')
                    assert ipaddress.ip_address(fake) in ipaddress.ip_network('198.18.0.0/15')
                    assert request(protocol, fake) == '192.0.2.1'
                    assert request(protocol, '8.8.8.8', 'plain.example') == '203.0.113.2'
                    if ipv6:
                        assert request(protocol, '2001:db8:113::2') == 'fd00:20::1'
                        fake6 = request(protocol, '2001:4860:4860::8888', 'selected.example', 'AAAA')
                        assert ipaddress.ip_address(fake6) in ipaddress.ip_network('2001:2::/48')
                        # A restored domain may resolve to IPv4 or IPv6 upstream.
                        assert request(protocol, fake6) in ['fd00:20::1', '192.0.2.1']
                assert queued() > before, 'Selected traffic exercises the actual queue path'
                # Even a routable stale FakeIP must fail instead of leaking to
                # the direct outbound. The server owns it to catch that error.
                for protocol in ['tcp', 'udp']:
                    stale = subprocess.run(['ip', 'netns', 'exec', client, sys.executable, script, '--probe', protocol, '198.18.255.254', '', 'A'], capture_output=True)
                    assert stale.returncode != 0, 'Unknown FakeIP reached the real network'
                # New connections must follow a changed remote list without restart.
                remote.write_text(json.dumps({'version': 3, 'rules': [{'ip_cidr': ['198.51.100.2/32']}]}))
                time.sleep(2.5)
                before = queued()
                for protocol in ['tcp', 'udp']:
                    assert request(protocol, '198.51.100.130') == '10.10.0.2'
                assert queued() == before
                for protocol in ['tcp', 'udp']:
                    assert request(protocol, '198.51.100.2') == '192.0.2.1'
                # Reject broken list updates, retaining the last working set.
                remote.write_text('{broken JSON')
                time.sleep(2.5)
                assert request('tcp', '198.51.100.2') == '192.0.2.1'
                assert request('udp', '198.51.100.130') == '10.10.0.2'
                core.terminate(); core.wait(timeout=10); log.close()
                assert not run('nft', 'list', 'table', 'inet', 'sing-box', check=False)
                assert 'obhod-tun' not in run('ip', 'link')
                assert 'lookup 2022' not in run('ip', 'rule')
                assert 'lookup 2022' not in run('ip', '-6', 'rule')
                assert request('udp', '198.51.100.2') == '10.10.0.2'
                if ipv6:
                    # A RAM cache survives a service restart, even when the
                    # source is unavailable and its last response was invalid.
                    lists_server.terminate(); lists_server.wait(timeout=5)
                    log = open(temp/'core.log', 'a+')
                    offset = os.fstat(log.fileno()).st_size
                    core = subprocess.Popen([binary, 'run', '-c', str(file)], stdout=log, stderr=log); children.append(core)
                    wait_core(core, log, offset)
                    assert request('tcp', '198.51.100.2') == '192.0.2.1'
                    assert request('udp', '198.51.100.130') == '10.10.0.2'
                    assert request('udp', '8.8.8.8', 'selected.example') == fake
                    # SIGKILL cannot run sing-box's nftables cleanup. The next
                    # instance must replace its stale table and restore sets,
                    # TUN routing and cached FakeIP without broad interception.
                    core.kill(); core.wait(timeout=5)
                    offset = os.fstat(log.fileno()).st_size
                    core = subprocess.Popen([binary, 'run', '-c', str(file)], stdout=log, stderr=log); children.append(core)
                    wait_core(core, log, offset)
                    before = queued()
                    assert request('udp', '198.51.100.130') == '10.10.0.2'
                    assert queued() == before, 'Direct traffic stays outside NFQUEUE after SIGKILL recovery'
                    assert request('tcp', '198.51.100.2') == '192.0.2.1'
                    assert request('udp', fake) in ['192.0.2.1', 'fd00:20::1']
                    core.terminate(); core.wait(timeout=10); log.close()
                    assert not run('nft', 'list', 'table', 'inet', 'sing-box', check=False)
                    assert 'obhod-tun' not in run('ip', 'link')
                    assert not any(rule.get('priority') == 1 for rule in json.loads(run('ip', '-j', 'rule'))), 'SIGKILL must not leak per-instance redirect policy rules after the next stop'
                    assert not any(rule.get('priority') == 1 for rule in json.loads(run('ip', '-6', '-j', 'rule'))), 'IPv6 redirect policy rules must also be recovered and cleaned'
                    print('PASS: SIGKILL recovery replaces stale nftables, restores cached selected routes and keeps direct traffic out of NFQUEUE', flush=True)
                    print('PASS: invalid update retains last good rules; cached JSON/SRS and FakeIP restore without the list server', flush=True)
                remote.write_text(json.dumps({'version': 3, 'rules': [{'ip_cidr': ['198.51.100.130/32']}]}))
                print(f'PASS IPv6={ipv6}: LAN/router output first-packet kernel bypass, TCP/UDP, FakeIP/DNS, JSON/SRS, live update and stop cleanup', flush=True)
    except Exception:
        if 'log' in locals() and not log.closed:
            log.seek(0); print(log.read(), flush=True)
        print(run('nft', 'list', 'ruleset', check=False), flush=True)
        print(run('ip', 'rule', check=False), run('ip', 'route', 'show', 'table', 'all', check=False), flush=True)
        raise
    finally:
        for child in reversed(children):
            if child.poll() is None: child.terminate(); child.wait(timeout=10)
        for name in names: run('ip', 'netns', 'del', name, check=False)


if __name__ == '__main__':
    if sys.argv[1] == '--serve': serve()
    elif sys.argv[1] == '--probe': print(probe(*sys.argv[2:]))
    else: main(sys.argv[1])
