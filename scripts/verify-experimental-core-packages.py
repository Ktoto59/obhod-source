#!/usr/bin/env python3
"""Verify side-by-side install and removal using disposable OpenWrt rootfs archives."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
ROOTFS = {
    'apk': ('rootfs.tar.gz', '55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4'),
    'opkg': ('rootfs-24.10.4.tar.gz', 'e7f8ab84eef55c7eb23492de7b0517dbc23fbedaa4abbb680fe64720c309dc03'),
}
spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build-openwrt-packages.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def run(*args):
    process = subprocess.run(list(map(str, args)), capture_output=True, text=True)
    if process.returncode:
        raise RuntimeError(f'{args}: {process.stderr or process.stdout}')
    return process.stdout


def rootfs(manager, tools, target):
    archive, digest = ROOTFS[manager]
    source = tools / archive
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest, source
    target.mkdir()
    run('tar', '-xzf', source, '-C', target)


def verify(packages, previous, tools, report):
    catalog = json.loads((packages / 'experimental-packages.json').read_text())
    baseline = json.loads((previous / 'packages.json').read_text())
    assert catalog['channel'] == 'experimental'
    assert len(catalog['packages']) == 8
    stable_catalog = (ROOT / 'openwrt/obhod/files/usr/share/obhod/core-catalog.json').read_text()
    results = []
    for row in catalog['packages']:
        file = packages / row['name']
        assert file.stat().st_size == row['bytes']
        assert hashlib.sha256(file.read_bytes()).hexdigest() == row['sha256']
        assert row['name'] not in stable_catalog
        manager, arch = row['manager'], row['arch']
        stable = next(p for p in baseline['packages']
                      if (p['manager'], p['arch'], p['profile']) == (manager, arch, row['profile']))
        source = previous / stable['name']
        assert hashlib.sha256(source.read_bytes()).hexdigest() == stable['sha256']
        with tempfile.TemporaryDirectory(prefix='obhod-experimental-verify-') as directory:
            work = Path(directory)
            lab = work / 'lab'
            rootfs(manager, tools, lab)
            for package in (file, source):
                shutil.copyfile(package, lab / 'tmp' / package.name)
            if manager == 'apk':
                (lab / 'etc/apk/arch').write_text(f'x86_64\n{arch}\n')
                fixture = work / 'deps'
                fixture.mkdir()
                run(tools / 'sbin/apk.static', 'mkpkg', '--info', 'name:obhod-test-deps', '--info',
                    'version:1-r1', '--info', 'arch:noarch', '--info',
                    'provides:ca-bundle kmod-tun kmod-inet-diag', '--files', fixture,
                    '--output', lab / 'tmp/deps.apk')
                apk = ('chroot', lab, '/usr/bin/apk', '--arch', arch, '--no-network')
                def install(name):
                    run(*apk, 'add', '--no-scripts', '--allow-untrusted', '/tmp/deps.apk', f'/tmp/{name}')
                def remove(name):
                    run(*apk, 'del', '--no-scripts', name)
                def status(name):
                    return run(*apk, 'info', '-a', name)
            else:
                with (lab / 'etc/opkg.conf').open('a') as config:
                    config.write(f'\narch all 1\narch noarch 1\narch x86_64 10\narch {arch} 100\n')
                (lab / 'var/lock').mkdir(parents=True, exist_ok=True)
                control = (b'Package: obhod-test-deps\nVersion: 1\nArchitecture: all\n'
                           b'Provides: kmod-tun, kmod-inet-diag\nDescription: Test dependencies\n')
                tar = builder.tar_bytes
                (lab / 'tmp/deps.ipk').write_bytes(tar({
                    'debian-binary': (b'2.0\n', 0o644),
                    'control.tar.gz': (tar({'control': (control, 0o644)}), 0o644),
                    'data.tar.gz': (tar({}), 0o644),
                }))
                opkg = ('chroot', lab, '/bin/opkg', '--conf', '/etc/opkg.conf', '--offline-root', '/')
                run(*opkg, 'install', '/tmp/deps.ipk')
                def install(name):
                    run(*opkg, 'install', f'/tmp/{name}')
                def remove(name):
                    run(*opkg, 'remove', name)
                def status(name):
                    return run(*opkg, 'status', name)
            install(source.name)
            state = lab / 'etc/obhod/settings.json'
            state.parent.mkdir()
            state.write_text('{"fixture":"preserved"}\n')
            state.chmod(0o600)
            protected = [state, lab / 'etc/config/sing-box', lab / 'etc/sing-box/config.json', lab / 'usr/bin/sing-box']

            def snapshot():
                return [(hashlib.sha256(p.read_bytes()).digest(), p.stat().st_mode,
                         p.stat().st_uid, p.stat().st_gid) for p in protected]

            original = snapshot()
            install(file.name)
            assert row['version'] in status(row['package'])
            assert snapshot() == original
            binary = lab / row['binary'].lstrip('/')
            assert hashlib.sha256(binary.read_bytes()).hexdigest() == row['binarySha256']
            qemu = 'qemu-mipsel-static' if arch == 'mipsel_24kc' else 'qemu-aarch64-static'
            assert catalog['version'] in run(qemu, binary, 'version')
            assert 'obhod-experimental-1.15' in run(qemu, binary, 'obhod-capabilities').splitlines()
            conf = work / 'check.json'
            conf.write_text('{"outbounds":[{"type":"direct"}]}')
            run(qemu, binary, 'check', '-c', conf)
            remove(row['package'])
            assert not binary.exists() and snapshot() == original
            results.append({'artifact': file.name, 'install': 'passed', 'qemu': 'passed', 'remove': 'passed'})
            print(f'PASS {file.name}: side-by-side install, QEMU, remove', flush=True)
    report.write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('packages', 'previous', 'tools', 'report'):
        parser.add_argument('--' + arg, type=Path, required=True)
    args = parser.parse_args()
    verify(args.packages.resolve(), args.previous.resolve(), args.tools.resolve(), args.report.resolve())
