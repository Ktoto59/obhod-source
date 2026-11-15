#!/usr/bin/env python3
"""Check the generated runtime graph with real cores and OpenWrt ucode."""
import argparse
from copy import deepcopy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('packages', ROOT / 'scripts/verify-experimental-core-packages.py')
packages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packages)
run = packages.run

GENERATE = r"""
const { defaultRouterProfile, generateRouterConfig } = require('./openwrt/lib/config.js');
const { parseProxyUri, parseWireGuardConfig } = require('./shared/profile.js');
const profile = defaultRouterProfile();
profile.tunnels = [
  parseProxyUri('vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?security=tls&sni=example.test'),
  parseProxyUri('socks5://192.0.2.20:1080#SOCKS'),
  parseProxyUri('http://192.0.2.30:3128#HTTP'),
  parseWireGuardConfig('[Interface]\nPrivateKey = AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\nAddress = 10.8.0.2/32\n[Peer]\nPublicKey = AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 0.0.0.0/0'),
];
profile.routing.activeTunnelId = profile.tunnels[0].id;
profile.routing.failoverEnabled = true;
profile.routing.failoverTunnelIds = profile.tunnels.map(tunnel => tunnel.id);
profile.routing.localLists = [{ id: 'test', name: 'Selected', enabled: true, domains: ['selected.test'], cidrs: ['203.0.113.0/24'] }];
profile.routing.remoteLists = [
  { id: 'json', name: 'JSON', enabled: true, url: 'https://example.test/selected.json' },
  { id: 'srs', name: 'SRS', enabled: true, url: 'https://example.test/selected.srs' },
];
console.log(JSON.stringify([false, true].map(ipv6 => {
  const options = { ipv6, downloadListsViaProxy: ipv6 };
  return { version: 1, options, profile, config: generateRouterConfig(profile, options) };
})));
"""


def config_diagnostic(lab):
    token = run('chroot', lab, '/usr/bin/ucode', '/usr/libexec/obhod/operation.uc',
                'acquire', 'job', '', os.getpid()).strip()
    run('chroot', lab, '/usr/libexec/obhod/job', 'worker', 'diagnostics', token)
    report = json.loads((lab / 'var/run/obhod/diagnostics.json').read_text())
    return next(check for check in report['checks'] if check['name'] == 'Конфигурация')


def check(baseline, experimental, tools):
    fixtures = json.loads(run('node', '-e', GENERATE))
    legacy = ROOT / '.tmp/openwrt-legacy-settings.json'
    run('node', str(ROOT / 'scripts/check-openwrt-config.js'))
    fixtures.append(json.loads(legacy.read_text()))
    app = ROOT / 'openwrt/obhod/files'
    for manager in packages.ROOTFS:
        with tempfile.TemporaryDirectory(prefix='obhod-config-check-') as temporary:
            lab = Path(temporary) / 'rootfs'
            packages.rootfs(manager, tools, lab)
            shutil.copytree(app, lab, dirs_exist_ok=True)
            for script in (lab / 'usr/libexec').rglob('*'):
                if script.is_file():
                    script.chmod(0o755)
            for directory in ('etc/obhod', 'var/lock', 'var/run/obhod', 'tmp/prepared'):
                (lab / directory).mkdir(parents=True, exist_ok=True)
            device = lab / 'dev/null'
            device.unlink(missing_ok=True)
            os.mknod(device, stat.S_IFCHR | 0o666, os.makedev(1, 3))
            state = lab / 'etc/obhod/settings.json'
            runtime = lab / 'var/run/obhod'
            secret = '11111111-1111-1111-1111-111111111111'
            (lab / 'tmp/prepared/controller-secret').write_text(secret + '\n')
            (runtime / 'controller-secret').write_text(secret + '\n')
            (runtime / 'ready').touch()
            (runtime / 'run-pid').write_text(str(os.getpid()))
            (runtime / 'config.json').write_text('active config sentinel')
            control = lab / 'usr/libexec/obhod/control'
            control.write_text('#!/bin/sh\ntouch /tmp/service-touched\nexit 1\n')
            core = lab / 'usr/bin/sing-box'
            core.unlink(missing_ok=True)
            prepare = ('chroot', lab, '/usr/libexec/obhod/prepare-config')
            for index, fixture in enumerate(fixtures):
                if index == 0:
                    fixture['options']['bootstrapDoH'] = [
                        '76.76.2.2', 'https://dns.quad9.net:8443/alternate @ 2620:fe::fe',
                        '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4']
                saved = json.dumps(fixture, sort_keys=True)
                state.write_text(saved)
                variants = {}
                for binary, name in ((baseline, 'baseline'), (experimental, 'experimental')):
                    staged_core = core.with_name('sing-box.staged')
                    shutil.copyfile(binary, staged_core)
                    staged_core.chmod(0o755)
                    staged_core.replace(core)
                    run(*prepare, 'prepare', '/etc/obhod/settings.json', '/tmp/prepared')
                    run(*prepare, 'validate', '/etc/obhod/settings.json')
                    assert state.read_text() == saved
                    variants[name] = json.loads((lab / 'tmp/prepared/config.json').read_text())
                    if index == 0:
                        sidecar = json.loads((lab / 'tmp/prepared/bootstrap.json').read_text())
                        first, second, *_ = sidecar['dns']['servers']
                        assert [leaf['listen_port'] for leaf in sidecar['inbounds']] == [12061, 12062, 12063, 12064, 12067, 12068]
                        assert (first['server'], first['path'], first['tls']['server_name']) == (
                            '76.76.2.11', '/p2', 'freedns.controld.com')
                        assert (second['server'], second['server_port'], second['path'], second['headers']['Host']) == (
                            '2620:fe::fe', 8443, '/alternate', 'dns.quad9.net:8443')

                    broken = deepcopy(fixture)
                    # Older fixtures are loadable on startup but LuCI sends the
                    # current envelope when a candidate is saved.
                    broken['version'] = 1
                    broken['profile']['version'] = 6
                    broken['config']['outbounds'][-1]['type'] = 'secret-fixture-invalid-type'
                    broken_json = json.dumps(broken)
                    candidate = lab / 'tmp/candidate.json'
                    candidate.write_text(broken_json)
                    rejected = subprocess.run([*map(str, prepare), 'validate', '/tmp/candidate.json'],
                                              text=True, capture_output=True)
                    assert rejected.returncode != 0 and (
                        'Ядро отклонило' in rejected.stdout or 'Ядро не поддерживает' in rejected.stdout
                    ), rejected
                    assert 'secret-fixture' not in rejected.stdout + rejected.stderr
                    rpc = subprocess.run(
                        ['chroot', str(lab), '/usr/libexec/rpcd/obhod', 'call', 'apply'],
                        input=json.dumps({'settings': broken_json, 'start': True}),
                        text=True, capture_output=True, check=True)
                    response = json.loads(rpc.stdout)
                    assert not response['ok'] and 'Прежние настройки сохранены' in response['error'], response
                    assert 'secret-fixture' not in rpc.stdout + rpc.stderr
                    assert state.read_text() == saved
                    assert (runtime / 'config.json').read_text() == 'active config sentinel'
                    assert (runtime / 'controller-secret').read_text().strip() == secret
                    assert (runtime / 'ready').exists() and (runtime / 'run-pid').read_text() == str(os.getpid())
                    assert not (lab / 'tmp/service-touched').exists()
                    assert not list((lab / 'tmp').glob('obhod-config.*'))

                    if index == 0:
                        # Exercise the real diagnostic worker without network probes.
                        (runtime / 'ready').unlink()
                        try:
                            assert config_diagnostic(lab)['ok']
                            state.write_text(broken_json)
                            failed = config_diagnostic(lab)
                            assert not failed['ok'] and 'secret-fixture' not in failed['message'], failed
                        finally:
                            state.write_text(saved)
                            (runtime / 'ready').touch()
                old, new = variants.values()
                for config in (old, new):
                    route = config['route']
                    tun = next(i for i in config['inbounds'] if i['type'] == 'tun')
                    assert tun['auto_route'] and tun['auto_redirect'] and tun['route_address_set']
                    assert route['final'] == 'direct' and route['rules'][0]['action'] == 'hijack-dns'
                    assert not any(server.get('tag') == 'proxy-dns' and server.get('detour') == 'direct'
                                   for server in config['dns']['servers'])
                assert old['route']['rules'] == new['route']['rules']
                assert old['dns']['rules'] == new['dns']['rules']
                assert old['dns']['servers'] == new['dns']['servers']
                assert 'independent_cache' not in new['dns']
                assert all('stack' not in i for i in new['inbounds'])
                for old_set, new_set in zip(old['route']['rule_set'], new['route']['rule_set']):
                    if old_set['type'] == 'remote':
                        assert 'download_detour' not in new_set and new_set['http_client']
                        if old_set.get('download_detour'):
                            assert new_set['http_client']['detour'] == old_set['download_detour']
                print(f"PASS {manager}: IPv6={fixture['options']['ipv6']}, "
                      f"remote={'downloadListsViaProxy' in fixture['options']}, both cores", flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('baseline', 'experimental', 'tools'):
        parser.add_argument('--' + arg, type=Path, required=True)
    args = parser.parse_args()
    check(args.baseline.resolve(), args.experimental.resolve(), args.tools.resolve())
