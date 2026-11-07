#!/usr/bin/env python3
"""DNS policy migration and real FakeIP integration in a disposable OpenWrt rootfs.

Run on Linux as root in its own network namespace. No router or WAN is used.
"""
import argparse
import copy
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import shutil
import socket
import socketserver
import stat
import struct
import subprocess
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('audit_fixture', ROOT / 'scripts/test-openwrt-audit.py')
audit_fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_fixture)
CORE = ROOT / '.tmp/release-019/binaries/sing-box-linux-amd64-full'


def generated():
    source = """const {defaultRouterProfile,generateRouterConfig}=require('./openwrt/lib/config');
const {parseProxyUri}=require('./shared/profile');
const profile=defaultRouterProfile();profile.tunnels=[parseProxyUri('socks5://192.0.2.10:1080#Fixture')];
Object.assign(profile.routing,{activeTunnelId:profile.tunnels[0].id,dnsResolverEnabled:true,dnsProtocol:'udp',dnsServer:'192.0.2.53',
localLists:[{id:'test',name:'Selected',enabled:true,domains:['example.com'],cidrs:[]}]});
console.log(JSON.stringify({profile,options:{},config:generateRouterConfig(profile)}));"""
    return json.loads(subprocess.check_output(['node', '-e', source], cwd=ROOT))


class DNSFilterTests(unittest.TestCase):
    def setUp(self):
        self.fixture = audit_fixture.Audit('runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.lab = self.fixture.lab
        self.settings = generated()

    def write_graph(self, config=None):
        self.fixture.write('etc/obhod/settings.json', json.dumps(self.settings))
        self.fixture.write('var/run/obhod/config.json', json.dumps(config or self.settings['config']))

    def prepare_filter(self, success=True):
        result = self.fixture.run_in('/usr/bin/ucode', '/usr/libexec/obhod/dns-filter-config.uc')
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def test_migrate_old_saved_graph_and_prepare_idempotently(self):
        expected = self.settings['config']
        old = copy.deepcopy(expected)
        tags = ['dns-filter-real-in', 'dns-filter-fake-in']
        old['inbounds'] = [i for i in old['inbounds'] if i['tag'] not in tags]
        old['dns']['servers'] = [s for s in old['dns']['servers'] if s['tag'] != 'filtered-fake-dns']
        old['dns']['rules'] = [r for r in old['dns']['rules'] if not any(t in r.get('inbound', []) for t in tags)]
        old['route']['rules'] = [r for r in old['route']['rules'] if not any(t in r.get('inbound', []) for t in tags)]
        for rule in old['dns']['rules']:
            if rule.get('server') == 'filtered-fake-dns':
                rule['server'] = 'fake-dns'
                rule.pop('disable_cache', None)
        self.settings['config'] = old
        self.write_graph(old)
        saved = (self.lab / 'etc/obhod/settings.json').read_bytes()
        for _ in range(2):
            self.prepare_filter()
            self.assertEqual(json.loads((self.lab / 'var/run/obhod/config.json').read_text()), expected)
            self.assertEqual(json.loads((self.lab / 'var/run/obhod/dns-pool-filter.json').read_text()),
                             {'mode': 'filtered-fakeip', 'port': 1156, 'servers': [12065, 12066]})
            self.assertEqual((self.lab / 'etc/obhod/settings.json').read_bytes(), saved)

    def test_disabled_filter_removes_stale_helper_config(self):
        self.settings['profile']['routing']['dnsResolverEnabled'] = False
        self.write_graph()
        self.fixture.write('var/run/obhod/dns-pool-filter.json', '{}')
        before = (self.lab / 'var/run/obhod/config.json').read_bytes()
        self.prepare_filter()
        self.assertFalse((self.lab / 'var/run/obhod/dns-pool-filter.json').exists())
        self.assertEqual((self.lab / 'var/run/obhod/config.json').read_bytes(), before)

    def test_migration_rejects_conflicting_loopback_listener(self):
        config = self.settings['config']
        config['inbounds'].append({'type': 'mixed', 'tag': 'conflict', 'listen': '127.0.0.1', 'listen_port': 12065})
        # An existing correctly tagged listener must not hide another owner.
        config['inbounds'] = [i for i in config['inbounds'] if i['tag'] != 'dns-filter-real-in']
        self.write_graph()
        before = (self.lab / 'var/run/obhod/config.json').read_bytes()
        self.prepare_filter(success=False)
        self.assertEqual((self.lab / 'var/run/obhod/config.json').read_bytes(), before)
        self.assertFalse((self.lab / 'var/run/obhod/dns-pool-filter.json').exists())

    def prepare_fixture(self):
        self.write_graph()
        self.fixture.write('var/run/obhod/controller-secret', '11111111-2222-4333-8444-555555555555\n')
        self.fixture.write('usr/bin/sing-box', '#!/bin/sh\ncase "$1" in version) echo "sing-box version 1.12.22";; check) exit 0;; *) exit 1;; esac\n')
        self.fixture.write('bin/ubus', '#!/bin/sh\necho "{}"\n')
        module = ROOT / '.tmp/dns-policy-tools/usr/lib/ucode/socket.so'
        self.assertTrue(module.is_file(), str(module))
        shutil.copyfile(module, self.lab / 'tmp/socket.so')
        (self.lab / 'usr/lib/ucode/socket.so').unlink(missing_ok=True)

    def test_legacy_offline_upgrade_prepares_missing_socket_before_dns_validation(self):
        self.prepare_fixture()
        self.fixture.write('usr/libexec/obhod/dns-pool-install', '#!/bin/sh\necho install >> /tmp/socket-installs\ncp /tmp/socket.so /usr/lib/ucode/socket.so\n')
        before = (self.lab / 'etc/obhod/settings.json').read_bytes()
        for _ in range(2):
            result = self.fixture.run_in('/usr/libexec/obhod/control', 'prepare')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((self.lab / 'var/run/obhod/dns-pool-filter.json').is_file())
        self.assertEqual((self.lab / 'tmp/socket-installs').read_text(), 'install\n')
        self.assertEqual((self.lab / 'etc/obhod/settings.json').read_bytes(), before)

    def test_missing_socket_install_failure_does_not_skip_filtering(self):
        self.prepare_fixture()
        self.fixture.write('usr/libexec/obhod/dns-pool-install', '#!/bin/sh\nexit 1\n')
        result = self.fixture.run_in('/usr/libexec/obhod/control', 'prepare')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('компонент DNS', (self.lab / 'var/run/obhod/error').read_text())
        self.assertFalse((self.lab / 'var/run/obhod/ready').exists())

    def test_real_core_filters_dns_before_native_fakeip_and_preserves_mapping(self):
        calls = []
        policy = {'blocked': False}

        class Upstream(socketserver.BaseRequestHandler):
            def handle(handler):
                packet, sock = handler.request
                end = 12
                while packet[end]:
                    end += packet[end] + 1
                end += 5
                question = packet[12:end]
                calls.append(question)
                mutable = b'mutable' in question
                blocked = b'blocked' in question or (mutable and policy['blocked'])
                refused = b'refused' in question
                address = socket.inet_aton('0.0.0.0' if blocked else '203.0.113.42')
                response = packet[:2] + struct.pack('!HHHHH', 0x8185 if refused else 0x8180, 1, 0 if refused else 1, 0, 0) + question
                if not refused:
                    response += b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 0 if mutable else 60, 4) + address
                sock.sendto(response, handler.client_address)

        server = socketserver.ThreadingUDPServer(('127.0.0.1', 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        config = self.settings['config']
        config['inbounds'] = [i for i in config['inbounds'] if i['type'] == 'direct']
        config['outbounds'] = [{'type': 'direct', 'tag': 'direct'}, {'type': 'direct', 'tag': 'proxy'}]
        config['route']['auto_detect_interface'] = False
        config.pop('experimental', None)
        config['experimental'] = {'cache_file': {'enabled': True, 'path': '/tmp/filter-fakeip.db', 'store_fakeip': True}}
        # Rebuild real resolvers explicitly; no proxy connection or WAN is needed.
        config['dns']['servers'] = [s for s in config['dns']['servers'] if s['tag'] not in ['direct-dns', 'proxy-dns', 'bootstrap-dns']]
        for tag in ['direct-dns', 'proxy-dns', 'bootstrap-dns']:
            config['dns']['servers'].append({'type': 'udp', 'tag': tag, 'server': '127.0.0.1', 'server_port': server.server_address[1]})
        self.write_graph()
        self.prepare_filter()
        self.assertTrue(CORE.is_file(), str(CORE))
        shutil.copyfile(CORE, self.lab / 'usr/bin/sing-box')
        (self.lab / 'usr/bin/sing-box').chmod(0o755)
        # The standard rootfs omits the optional socket module.
        module = ROOT / '.tmp/dns-policy-tools/usr/lib/ucode/socket.so'
        if module.is_file():
            shutil.copyfile(module, self.lab / 'usr/lib/ucode/socket.so')
        for name, minor in [('random', 8), ('urandom', 9)]:
            device = self.lab / 'dev' / name
            device.unlink(missing_ok=True)
            os.mknod(device, stat.S_IFCHR | 0o666, os.makedev(1, minor))
        logs = (self.lab / 'tmp/filter-test.log').open('w+')
        self.addCleanup(logs.close)
        processes = []

        def start(command):
            child = subprocess.Popen(['chroot', str(self.lab), *command], stdout=logs, stderr=logs)
            processes.append(child)
            return child

        def stop():
            for child in reversed(processes):
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=8)

        self.addCleanup(stop)
        core = start(['/usr/bin/sing-box', 'run', '-c', '/var/run/obhod/config.json'])
        helper = start(['/usr/bin/ucode', '/usr/libexec/obhod/dns-pool.uc', '/var/run/obhod/dns-pool-filter.json'])

        def query(name, port=1053):
            wire = struct.pack('!HHHHHH', 4242, 256, 1, 0, 0, 0)
            wire += b''.join(bytes([len(label)]) + label.encode() for label in name.split('.')) + b'\0\0\1\0\1'
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.settimeout(2)
                sock.sendto(wire, ('127.0.0.1', port))
                return sock.recv(4096)

        for _ in range(40):
            if core.poll() is not None or helper.poll() is not None:
                logs.seek(0)
                self.fail(logs.read())
            try:
                query('ready.example.com')
                break
            except (socket.timeout, ConnectionRefusedError):
                time.sleep(.1)
        allowed = query('allowed.example.com')
        self.assertEqual(allowed[3] & 15, 0)
        address = ipaddress.ip_address(allowed[-4:])
        self.assertIn(address, ipaddress.ip_network('198.18.0.0/15'))
        self.assertEqual(query('allowed.example.com')[-4:], allowed[-4:], 'native mapping must remain stable')
        self.assertEqual(query('blocked.example.com')[-4:], b'\0' * 4)
        self.assertEqual(query('refused.example.com')[3] & 15, 5)
        mutable = query('mutable.example.com')
        self.assertIn(ipaddress.ip_address(mutable[-4:]), ipaddress.ip_network('198.18.0.0/15'))
        policy['blocked'] = True
        self.assertEqual(query('mutable.example.com')[-4:], b'\0' * 4, 'a previously allowed name must not bypass changed DNS policy through an outer FakeIP cache')
        policy['blocked'] = False
        self.assertEqual(query('mutable.example.com')[-4:], mutable[-4:], 'reallowed name must reuse the native mapping')
        count = len(calls)
        probe = query('fakeip-check.obhod.example.com')
        self.assertIn(ipaddress.ip_address(probe[-4:]), ipaddress.ip_network('198.18.0.0/15'))
        self.assertEqual(len(calls), count, 'synthetic probe must never reach filtering upstream')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--core', type=Path, default=CORE)
    args, rest = parser.parse_known_args()
    CORE = args.core.resolve()
    unittest.main(argv=[__file__, *rest])
