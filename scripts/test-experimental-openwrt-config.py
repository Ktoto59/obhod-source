#!/usr/bin/env python3
"""Check the generated runtime graph with real cores and OpenWrt ucode."""
import argparse
import importlib.util
import json
from pathlib import Path
import shutil
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
  return { options, profile, config: generateRouterConfig(profile, options) };
})));
"""


def check(baseline, experimental, tools):
    fixtures = json.loads(run('node', '-e', GENERATE))
    legacy = ROOT / '.tmp/openwrt-legacy-settings.json'
    run('node', str(ROOT / 'scripts/check-openwrt-config.js'))
    fixtures.append(json.loads(legacy.read_text()))
    libexec = ROOT / 'openwrt/obhod/files/usr/libexec/obhod'
    for manager in packages.ROOTFS:
        with tempfile.TemporaryDirectory(prefix='obhod-config-check-') as temporary:
            lab = Path(temporary) / 'rootfs'
            packages.rootfs(manager, tools, lab)
            state = lab / 'etc/obhod/settings.json'
            state.parent.mkdir()
            runtime = lab / 'var/run/obhod'
            runtime.mkdir(parents=True)
            (runtime / 'controller-secret').write_text('00000000-0000-0000-0000-000000000000\n')
            steps = ('prepare.uc', 'kernel-route.uc', 'native-dns.uc', 'dns-filter-config.uc', 'dns-pool-config.uc')
            for step in steps:
                shutil.copyfile(libexec / step, lab / 'tmp' / step)
            for binary, name in ((baseline, 'baseline'), (experimental, 'experimental')):
                shutil.copyfile(binary, lab / 'tmp' / name)
                (lab / 'tmp' / name).chmod(0o755)
            for fixture in fixtures:
                saved = json.dumps(fixture, sort_keys=True)
                state.write_text(saved)
                variants = {}
                for name in ('baseline', 'experimental'):
                    for step in steps:
                        CLI = ['chroot', lab, '/usr/bin/ucode', '/tmp/' + step]
                        if step == 'kernel-route.uc':
                            CLI.append('/var/run/obhod/config.json')
                        if step == 'prepare.uc' and name == 'experimental':
                            CLI.append('experimental-1.15')
                        run(*CLI)
                    run('chroot', lab, '/tmp/' + name, 'check', '-c', '/var/run/obhod/config.json')
                    assert state.read_text() == saved
                    variants[name] = json.loads((runtime / 'config.json').read_text())
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
