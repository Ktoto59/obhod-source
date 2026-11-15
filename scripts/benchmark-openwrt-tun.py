#!/usr/bin/env python3
"""Compare the TUN stacks using a fixed SOCKS relay in private Linux namespaces."""
import argparse
import base64
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time

TARGET = '198.51.100.2'
DNS = '198.51.100.53'
PROXY = '192.0.2.2'
UUID = '11111111-1111-4111-8111-111111111111'
SCRIPT = str(Path(__file__).resolve())


def run(*args, timeout=15):
    command = [str(arg) for arg in args]
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{command}: {result.stderr or result.stdout}')
    return result.stdout


def namespace(name, *args):
    return ['ip', 'netns', 'exec', name, *map(str, args)]


@contextlib.contextmanager
def process(args, log):
    with log.open('w+') as stream:
        child = subprocess.Popen(list(map(str, args)), stdout=stream, stderr=stream)
        try:
            yield child
        except Exception:
            stream.seek(0)
            print(stream.read(), file=sys.stderr)
            raise
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def dns_server():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.bind((PROXY, 5300))
        while True:
            request, source = sock.recvfrom(2048)
            answer = b'\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x3c\x00\x04' + socket.inet_aton(TARGET)
            sock.sendto(request[:2] + b'\x81\x80\x00\x01\x00\x01' + bytes(4) + request[12:] + answer, source)


def dns_probe(count):
    samples = []
    failures = 0
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(1)
        sock.connect((DNS, 53))
        for sequence in range(count):
            # Unique names avoid comparing the in-process cache instead of DNS I/O.
            label = str(sequence).encode()
            request = struct.pack('!HHHHHH', sequence, 0x100, 1, 0, 0, 0)
            request += bytes([len(label)]) + label + b'\x07fixture\x04test\x00\x00\x01\x00\x01'
            start = time.perf_counter()
            try:
                sock.send(request)
                answer = sock.recv(2048)
                assert answer[:2] == request[:2] and answer[3] & 15 == 0 and answer[-4:] == socket.inet_aton(TARGET)
            except (OSError, AssertionError):
                failures += 1
            else:
                samples.append((time.perf_counter() - start) * 1000)
    samples.sort()
    def percentile(value):
        return samples[math.ceil(value * len(samples)) - 1] if samples else None
    print(json.dumps({'queries': count, 'errors': failures,
                      'meanMs': sum(samples) / len(samples) if samples else None,
                      'p95Ms': percentile(.95), 'p99Ms': percentile(.99)}))


def topology(client, server):
    run('ip', 'link', 'set', 'lo', 'up')
    for name, link, host, peer in [(client, 'lan', '10.19.0.1/24', '10.19.0.2/24'),
                                    (server, 'wan', '192.0.2.1/24', '192.0.2.2/24')]:
        run('ip', 'netns', 'add', name)
        run('ip', 'link', 'add', link, 'type', 'veth', 'peer', 'name', 'peer')
        run('ip', 'link', 'set', 'peer', 'netns', name)
        run('ip', 'addr', 'add', host, 'dev', link)
        run('ip', 'link', 'set', link, 'up')
        run('ip', '-n', name, 'addr', 'add', peer, 'dev', 'peer')
        run('ip', '-n', name, 'link', 'set', 'peer', 'up')
        run('ip', '-n', name, 'link', 'set', 'lo', 'up')
    run('ip', '-n', client, 'route', 'add', 'default', 'via', '10.19.0.1')
    run('ip', '-n', server, 'addr', 'add', f'{TARGET}/32', 'dev', 'lo')
    run('ip', '-n', server, 'route', 'add', '10.19.0.0/24', 'via', '192.0.2.1')
    run('ip', 'route', 'add', f'{TARGET}/32', 'via', PROXY)
    run('ip', 'route', 'add', 'default', 'via', PROXY)
    run('ip', '-n', server, 'route', 'add', 'default', 'via', '192.0.2.1')
    run('sysctl', '-qw', 'net.ipv4.ip_forward=1')
    # A forwarded client packet cannot receive a successful benchmark response.
    # Only the tunnel relay in the target namespace may access this server.
    run(*namespace(server, 'nft', 'add', 'table', 'inet', 'bench'))
    run(*namespace(server, 'nft', 'add', 'chain', 'inet', 'bench', 'input',
                   '{ type filter hook input priority 0; policy accept; }'))
    run(*namespace(server, 'nft', 'add', 'rule', 'inet', 'bench', 'input',
                   'iifname', 'peer', 'ip', 'daddr', TARGET, 'counter', 'drop'))


def wait_started(child, log):
    for _ in range(500):
        if child.poll() is not None:
            raise RuntimeError(f'sing-box exited with {child.returncode}')
        if 'sing-box started' in log.read_text():
            return
        time.sleep(.01)
    raise TimeoutError('sing-box startup')


def sample(pid):
    proc = Path('/proc') / str(pid)
    status = {name: value.strip() for name, value in
              (line.split(':', 1) for line in (proc / 'status').read_text().splitlines())}
    stat = (proc / 'stat').read_text().rsplit(')', 1)[1].split()
    hz = os.sysconf('SC_CLK_TCK')
    user, kernel = int(stat[11]) / hz, int(stat[12]) / hz
    return {'cpuSeconds': user + kernel, 'kernelCpuSeconds': kernel,
            'rssKiB': int(status['VmRSS'].split()[0]),
            'peakRssKiB': int(status['VmHWM'].split()[0]),
            'fd': len(list((proc / 'fd').iterdir()))}


def tun_packets():
    device, = json.loads(run('ip', '-s', '-j', 'link', 'show', 'dev', 'obhod-tun'))
    return device.get('stats64', device.get('stats'))['tx']['packets']


@contextlib.contextmanager
def iperf_server(args, server, directory):
    command = namespace(server, args.iperf3, '-s', '-1', '-B', TARGET)
    with process(command, directory / 'iperf.log') as child:
        for _ in range(50):
            if child.poll() is not None:
                raise RuntimeError(f'iperf3 server exited with {child.returncode}')
            if run(*namespace(server, 'ss', '-H', '-ltn', 'sport', '=', ':5201')):
                break
            time.sleep(.01)
        else:
            raise TimeoutError('iperf3 server readiness')
        yield


def wireguard_keys():
    private = subprocess.check_output(['openssl', 'genpkey', '-algorithm', 'X25519', '-outform', 'DER'])
    public = subprocess.check_output(
        ['openssl', 'pkey', '-inform', 'DER', '-pubout', '-outform', 'DER'], input=private,
    )
    return [base64.b64encode(key[-32:]).decode() for key in (private, public)]


def tunnel_configs(protocol):
    relay = {
        'inbounds': [{'type': 'mixed', 'listen': PROXY, 'listen_port': 1080}],
        'outbounds': [{'type': 'direct', 'tag': 'direct'}],
    }
    outbound = {'type': protocol, 'tag': 'proxy', 'server': PROXY, 'server_port': 1080}
    if protocol == 'vless':
        relay['inbounds'][0].update(type='vless', users=[{'uuid': UUID}])
        outbound.update(uuid=UUID, packet_encoding='xudp')
    if protocol == 'wireguard':
        private, public = wireguard_keys()
        peer_private, peer_public = wireguard_keys()
        relay.pop('inbounds')
        relay['endpoints'] = [{
            'type': 'wireguard', 'tag': 'relay', 'address': ['10.66.0.1/30'],
            'private_key': peer_private, 'listen_port': 51820,
            'peers': [{'public_key': public, 'allowed_ips': ['10.66.0.2/32']}],
        }]
        return relay, {'endpoints': [{
            'type': 'wireguard', 'tag': 'proxy', 'address': ['10.66.0.2/30'], 'private_key': private,
            'peers': [{'address': PROXY, 'port': 51820, 'public_key': peer_public, 'allowed_ips': [f'{TARGET}/32']}],
        }]}
    return relay, {'outbounds': [outbound]}


def config(args, client, server, directory):
    relay, tunnel = tunnel_configs(args.tunnel)
    relay_config = directory / 'relay.json'
    relay_config.write_text(json.dumps(relay))
    with contextlib.ExitStack() as stack:
        relay_log = directory / 'relay.log'
        relay_process = stack.enter_context(process(namespace(server, args.baseline, 'run', '-c', relay_config), relay_log))
        wait_started(relay_process, relay_log)
        stack.enter_context(process(namespace(server, sys.executable, SCRIPT, '--dns-server'), directory / 'dns.log'))
        results = []
        for repeat in range(args.repeats):
            variants = [('baseline', args.baseline), ('experimental', args.experimental)]
            if repeat % 2:
                variants.reverse()
            for name, binary in variants:
                result = benchmark(args, name, binary, client, server, directory, tunnel)
                results.append({'repeat': repeat + 1, **result})
                print(f'{name} round {repeat + 1}: ' + ', '.join(
                    f'{protocol} {result[protocol]["mbps"]:.1f} Mbit/s' for protocol in ('TCP', 'UDP') if protocol in result),
                      file=sys.stderr, flush=True)
        return results


def benchmark(args, name, binary, client, server, directory, tunnel):
    selected = [f'{TARGET}/32', f'{DNS}/32']
    inbound = {'type': 'tun', 'tag': 'tun-in', 'interface_name': 'obhod-tun',
               'address': ['172.19.0.1/30'], 'auto_route': True, 'strict_route': False, 'mtu': 1500}
    route = {'rules': [{'port': 53, 'action': 'hijack-dns'},
                       {'ip_cidr': [f'{TARGET}/32'], 'outbound': 'proxy', 'action': 'route'}],
             'final': 'direct'}
    if args.rule_set_selection:
        inlet_set = 'selected'
        inbound['route_address_set'] = [inlet_set]
        route['rule_set'] = [{'tag': inlet_set, 'type': 'inline', 'rules': [{'ip_cidr': selected}]}]
    else:
        inbound['route_address'] = selected
    if name == 'baseline':
        inbound['stack'] = 'system'
    conf = directory / f'{name}.json'
    conf.write_text(json.dumps({
        'log': {'level': 'info'},
        'inbounds': [inbound], **tunnel,
        'outbounds': [{'type': 'direct', 'tag': 'direct'}, *tunnel.get('outbounds', [])],
        'dns': {'servers': [{'tag': 'fixture', 'type': 'udp', 'server': PROXY, 'server_port': 5300}],
                'final': 'fixture'},
        'route': route,
    }))
    log = directory / f'{name}.log'
    started = time.perf_counter()
    with process([binary, 'run', '-c', conf], log) as core:
        wait_started(core, log)
        result = {'variant': name, 'version': run(binary, 'version').splitlines()[0],
                  'startupMs': (time.perf_counter() - started) * 1000, 'idle': sample(core.pid)}
        flows = [('TCP', [])]
        if args.tunnel != 'http':
            flows.append(('UDP', ['-u', '-b', args.udp_rate, '-l', '1200']))
        for protocol, options in flows:
            with iperf_server(args, server, directory):
                before = sample(core.pid)
                packets_before = tun_packets()
                wall = time.perf_counter()
                command = namespace(client, args.iperf3, '-c', TARGET, '-J', '-t', args.seconds, *options)
                iperf = json.loads(run(*command, timeout=args.seconds + 10))
                elapsed = time.perf_counter() - wall
                assert 'error' not in iperf, iperf
                assert tun_packets() > packets_before, 'The benchmark missed the TUN interface'
                after = sample(core.pid)
            end = iperf['end']
            metrics = end.get('sum_received', end.get('sum'))
            result[protocol] = {'mbps': metrics['bits_per_second'] / 1e6,
                                'cpuSeconds': after['cpuSeconds'] - before['cpuSeconds'],
                                'kernelCpuSeconds': after['kernelCpuSeconds'] - before['kernelCpuSeconds'],
                                'cpuPercentOneCore': (after['cpuSeconds'] - before['cpuSeconds']) / elapsed * 100,
                                'rssKiB': after['rssKiB'], 'peakRssKiB': after['peakRssKiB'], 'fd': after['fd']}
            for metric in ('lost_percent', 'jitter_ms', 'retransmits'):
                if metric in metrics:
                    result[protocol][metric] = metrics[metric]
        result['DNS'] = json.loads(run(
            *namespace(client, sys.executable, SCRIPT, '--dns-probe', args.dns_queries),
            timeout=args.dns_queries + 5,
        ))
        assert result['DNS']['errors'] == 0, result['DNS']
        if args.soak_seconds:
            for protocol, options in flows:
                with iperf_server(args, server, directory):
                    result[f'{protocol}Soak'] = json.loads(run(
                        *namespace(client, args.iperf3, '-c', TARGET, '-J', '-t', args.soak_seconds, *options),
                        timeout=args.soak_seconds + 10,
                    ))['end']
        result['after'] = sample(core.pid)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('baseline', 'experimental', 'output'):
        parser.add_argument('--' + arg, type=Path, required=True)
    parser.add_argument('--iperf3', default='iperf3')
    parser.add_argument('--tunnel', choices=('socks', 'http', 'vless', 'wireguard'), default='socks')
    parser.add_argument('--rule-set-selection', action='store_true', help='Use a static inline route_address_set without auto_redirect')
    parser.add_argument('--seconds', type=int, default=5)
    parser.add_argument('--udp-rate', default='50M')
    parser.add_argument('--dns-queries', type=int, default=150)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--soak-seconds', type=int, default=0)
    args = parser.parse_args()
    args.baseline = args.baseline.resolve()
    args.experimental = args.experimental.resolve()
    assert os.geteuid() == 0 and os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net'), 'Run under unshare -nm'
    client, server = (f'obhod-bench-{os.getpid()}-{name}' for name in ('client', 'server'))
    try:
        topology(client, server)
        with tempfile.TemporaryDirectory(prefix='obhod-bench-') as temporary:
            results = config(args, client, server, Path(temporary))
        args.output.write_text(json.dumps({
            'environment': run('uname', '-srmo').strip(),
            'topology': 'selective route_address_set, MTU 1500' if args.rule_set_selection else 'selective route_address, MTU 1500',
            'tunnel': args.tunnel,
            'sha256': {name: hashlib.sha256(binary.read_bytes()).hexdigest() for name, binary in
                       [('baseline', args.baseline), ('experimental', args.experimental)]},
            'seconds': args.seconds, 'udpRate': args.udp_rate, 'soakSeconds': args.soak_seconds, 'results': results,
        }, indent=2) + '\n')
    finally:
        for name in (client, server):
            subprocess.run(['ip', 'netns', 'del', name], check=False, capture_output=True)


if __name__ == '__main__':
    if sys.argv[1:2] == ['--dns-server']:
        dns_server()
    elif sys.argv[1:2] == ['--dns-probe']:
        dns_probe(int(sys.argv[2]))
    else:
        main()
