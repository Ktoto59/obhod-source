#!/usr/bin/env python3
"""Build architecture-independent IPK and APK v3 packages from original sources.

APK 3's `mkpkg` must be installed on the Linux build host (or supplied via --apk).
No network downloads are performed by this script.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = '0.1.14'
DEPS = ['firewall4', 'kmod-tun', 'kmod-nft-tproxy', 'kmod-nft-queue',
        'uclient-fetch', 'ca-bundle', 'jshn', 'jsonfilter', 'rpcd', 'rpcd-mod-file', 'ucode', 'ucode-mod-fs']
POST = '''#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
/etc/init.d/obhod enable
if [ -d /var/lock/obhod-update.lock ]; then touch /var/run/obhod/rpcd-reload-needed
else /etc/init.d/rpcd reload >/dev/null 2>&1 || true; fi
exit 0
'''
PRE_REMOVE = '''#!/bin/sh
[ -n "$IPKG_INSTROOT" ] || /etc/init.d/obhod stop
exit 0
'''
LUCI_POST = '''#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.json
if [ -d /var/lock/obhod-update.lock ]; then touch /var/run/obhod/rpcd-reload-needed
else /etc/init.d/rpcd reload >/dev/null 2>&1 || true; fi
exit 0
'''


def source_files(package):
    mappings = [(ROOT / 'openwrt/obhod/files', '')] if package == 'obhod' else [
        (ROOT / 'openwrt/luci-app-obhod/root', ''),
        (ROOT / 'openwrt/luci-app-obhod/htdocs', 'www/')]
    result = {}
    for directory, prefix in mappings:
        for source in sorted(directory.rglob('*')):
            if source.is_file():
                name = prefix + source.relative_to(directory).as_posix()
                mode = 0o755 if name.startswith(('etc/init.d/', 'usr/libexec/')) else 0o644
                if name == 'etc/config/obhod':
                    mode = 0o600
                result[name] = (source.read_bytes().replace(b'\r\n', b'\n'), mode)
    result[f'usr/share/{package}/LICENSE'] = ((ROOT / 'LICENSE').read_bytes(), 0o644)
    return result


def tar_bytes(files, extra_dirs=()):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.GNU_FORMAT) as archive:
        directories = set(extra_dirs)
        for name in files:
            directories.update(str(parent) for parent in Path(name).parents if str(parent) != '.')
        for name in sorted(directories):
            info = tarfile.TarInfo('./' + name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o700 if name == 'etc/obhod' else 0o755
            archive.addfile(info)
        for name, (content, mode) in sorted(files.items()):
            info = tarfile.TarInfo('./' + name)
            info.size = len(content)
            info.mode = mode
            archive.addfile(info, io.BytesIO(content))
    return gzip.compress(output.getvalue(), mtime=0)


def build(package, destination, apk):
    files = source_files(package)
    deps = DEPS if package == 'obhod' else ['obhod', 'luci-base', 'rpcd-mod-file']
    description = 'Obhod selective routing service' if package == 'obhod' else 'LuCI interface for Obhod'
    post = POST if package == 'obhod' else LUCI_POST
    control = f'Package: {package}\nVersion: {VERSION}-1\nArchitecture: all\nMaintainer: Obhod contributors\nLicense: Apache-2.0\nSection: net\nDepends: {", ".join(deps)}\nDescription: {description}\n'
    controls = {'control': (control.encode(), 0o644), 'postinst': (post.encode(), 0o755)}
    if package == 'obhod':
        controls['prerm'] = (PRE_REMOVE.encode(), 0o755)
        controls['conffiles'] = (b'/etc/config/obhod\n', 0o644)
    ipk = destination / f'{package}_{VERSION}-1_all.ipk'
    # OpenWrt's opkg accepts a tar container with the three standard members.
    ipk.write_bytes(tar_bytes({'debian-binary': (b'2.0\n', 0o644),
                               'control.tar.gz': (tar_bytes(controls), 0o644),
                               'data.tar.gz': (tar_bytes(files, ['etc/obhod'] if package == 'obhod' else []), 0o644)}))
    with tempfile.TemporaryDirectory(prefix='obhod-package-') as temporary:
        stage = Path(temporary) / 'root'
        stage.mkdir(mode=0o755)
        for name, (content, mode) in files.items():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            target.chmod(mode)
        if package == 'obhod':
            (stage / 'etc/obhod').mkdir(mode=0o700)
        post_path = Path(temporary) / 'post'
        post_path.write_text(post)
        pre_path = Path(temporary) / 'pre-remove'
        pre_path.write_text(PRE_REMOVE)
        args = [apk, 'mkpkg', '--info', f'name:{package}', '--info', f'version:{VERSION}-r1',
                '--info', 'arch:noarch', '--info', 'license:Apache-2.0',
                '--info', f'description:{description}', '--info', 'depends:' + ' '.join(deps),
                '--files', str(stage), '--script', f'post-install:{post_path}',
                '--script', f'post-upgrade:{post_path}', '--output', str(destination / f'{package}-{VERSION}-r1.apk')]
        if package == 'obhod':
            args += ['--script', f'pre-deinstall:{pre_path}']
        subprocess.run(args, check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default=str(ROOT / 'release/openwrt'))
    parser.add_argument('--apk', default='apk')
    args = parser.parse_args()
    if (ROOT/'openwrt/obhod/files/usr/share/obhod/version').read_text().strip() != VERSION:
        raise ValueError('OpenWrt app version file does not match package version')
    destination = Path(args.output).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for package in ['obhod', 'luci-app-obhod']:
        build(package, destination, args.apk)
    for source, name in [(ROOT / 'openwrt/install.sh', 'install.sh'),
                         (ROOT / 'openwrt/obhod/files/usr/libexec/obhod/installer-plan.uc', 'installer-plan.uc'),
                         (ROOT / 'openwrt/obhod/files/usr/libexec/obhod/package-lib.sh', 'package-lib.sh'),
                         (ROOT / 'openwrt/obhod/files/usr/libexec/obhod/core-compat.sh', 'core-compat.sh'),
                         (ROOT / 'openwrt/obhod/files/usr/libexec/obhod/core-select.uc', 'core-select.uc'),
                         (ROOT / 'openwrt/obhod/files/usr/share/obhod/core-catalog.json', 'core-catalog.json'),
                         (ROOT / 'openwrt/presets.tsv', 'presets.tsv'), (ROOT / 'openwrt/README.md', 'README.md'),
                         (ROOT / 'LICENSE', 'LICENSE'), (ROOT / 'NOTICE', 'NOTICE')]:
        shutil.copyfile(source, destination / name)
    names = [f'obhod_{VERSION}-1_all.ipk', f'luci-app-obhod_{VERSION}-1_all.ipk',
             f'obhod-{VERSION}-r1.apk', f'luci-app-obhod-{VERSION}-r1.apk', 'install.sh', 'installer-plan.uc', 'package-lib.sh', 'core-compat.sh', 'core-select.uc', 'core-catalog.json', 'presets.tsv', 'README.md', 'LICENSE', 'NOTICE']
    (destination / 'SHA256SUMS').write_text(''.join(hashlib.sha256((destination / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in names))
    archive_files = {name: ((destination / name).read_bytes(), 0o755 if name == 'install.sh' else 0o644) for name in names + ['SHA256SUMS']}
    (destination / f'obhod-openwrt-{VERSION}.tar.gz').write_bytes(tar_bytes(archive_files))
    bundle = destination / f'obhod-openwrt-{VERSION}.tar.gz'
    bundle_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
    url = f'https://github.com/Ktoto59/obhod-releases/releases/download/openwrt-v{VERSION}/{bundle.name}'
    online = (destination / 'install.sh').read_text().replace("BUNDLE_URL=''", f"BUNDLE_URL='{url}'").replace("BUNDLE_SHA256=''", f"BUNDLE_SHA256='{bundle_hash}'")
    (destination / 'install-online.sh').write_text(online)
    print(json.dumps({'version': VERSION, 'formats': ['ipk', 'apk-v3'], 'architecture': 'all/noarch', 'output': str(destination)}))


if __name__ == '__main__':
    main()
