#!/usr/bin/env python3
"""Build side-by-side OpenWrt packages for the experimental core."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PIN = json.loads((ROOT / 'core/upstream.json').read_text())
VERSION = PIN['version']
ARCHITECTURES = {'mipsel_24kc': ('mipsle', 8, 1), 'aarch64_cortex-a53': ('arm64', 183, 2)}
PROFILES = ('lite', 'full')
DEPENDENCIES = ('libc', 'ca-bundle', 'kmod-inet-diag', 'kmod-tun')

spec = importlib.util.spec_from_file_location('openwrt_packages', ROOT / 'scripts/build-openwrt-packages.py')
openwrt_packages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(openwrt_packages)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(binaries, prepared, apk, output):
    manifest_path = prepared / 'build-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    if any(manifest.get(key) != value for key, value in PIN.items()):
        raise ValueError('Build manifest does not match the experimental source pins')
    upstream_version, revision = VERSION.split('-obhod.')
    release, alpha = upstream_version.split('-alpha.')
    versions = {'apk': f'{release}_alpha{alpha}-r{revision}', 'opkg': f'{release}~alpha{alpha}-{revision}'}
    # GitHub normalizes tildes in uploaded asset names. Keep opkg's version
    # ordering in the control file and use the public asset name in the catalog.
    ipk_asset_version = versions['opkg'].replace('~', '.')
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for arch, (goarch, machine, elf_class) in ARCHITECTURES.items():
        for profile in PROFILES:
            binary = binaries / f'sing-box-linux-{goarch}-{profile}'
            with binary.open('rb') as stream:
                header = stream.read(20)
            if header[:6] != b'\x7fELF' + bytes((elf_class, 1)) or struct.unpack_from('<H', header, 18)[0] != machine:
                raise ValueError(f'Unexpected ELF architecture: {binary}')
            name = f'obhod-experimental-core-{profile}'
            location = Path(f'usr/lib/obhod-experimental/{profile}')
            binary_path = (location / 'sing-box').as_posix()
            description = 'Experimental Obhod sing-box core'
            with tempfile.TemporaryDirectory(prefix='obhod-experimental-package-') as temporary:
                stage = Path(temporary)
                slot = stage / location
                slot.mkdir(parents=True)
                shutil.copyfile(binary, slot / 'sing-box')
                (slot / 'sing-box').chmod(0o755)
                licenses = slot / 'LICENSES'
                licenses.mkdir()
                for project, subdir in [('sing-box', 'source'), ('sing-tun', 'sing-tun'), ('sing', 'sing')]:
                    shutil.copyfile(prepared / subdir / 'LICENSE', licenses / f'{project}.txt')
                shutil.copyfile(ROOT / 'LICENSES/GPL-3.0-only.txt', licenses / 'GPL-3.0.txt')
                shutil.copyfile(manifest_path, slot / 'build-manifest.json')
                (slot / 'NOTICE').write_text(
                    f'{VERSION}, GPL-3.0-or-later. See build-manifest.json for pinned sources.\n',
                    encoding='utf-8',
                )
                apk_file = output / f'{name}-{versions["apk"]}_{arch}.apk'
                metadata = [f'name:{name}', f'version:{versions["apk"]}', f'arch:{arch}',
                            'license:GPL-3.0-or-later', 'maintainer:Obhod contributors',
                            f'description:{description}', 'depends:' + ' '.join(DEPENDENCIES),
                            'url:https://github.com/Ktoto59/obhod-source']
                args = [apk, 'mkpkg', '--files', stage, '--output', apk_file]
                for value in metadata:
                    args.extend(['--info', value])
                subprocess.run(args, env={**os.environ, 'SOURCE_DATE_EPOCH': '0'}, check=True)

                control = f"""Package: {name}
Version: {versions["opkg"]}
Architecture: {arch}
Maintainer: Obhod contributors
License: GPL-3.0-or-later
Section: net
Depends: {', '.join(DEPENDENCIES)}
Description: {description}
"""
                files = {p.relative_to(stage).as_posix(): (p.read_bytes(), p.stat().st_mode & 0o777)
                         for p in stage.rglob('*') if p.is_file()}
                tar = openwrt_packages.tar_bytes
                ipk_file = output / f'{name}_{ipk_asset_version}_{arch}.ipk'
                ipk_file.write_bytes(tar({
                    'debian-binary': (b'2.0\n', 0o644),
                    'control.tar.gz': (tar({'control': (control.encode(), 0o644)}), 0o644),
                    'data.tar.gz': (tar(files), 0o644),
                }))
                for manager, artifact in [('apk', apk_file), ('opkg', ipk_file)]:
                    records.append({
                        'name': artifact.name, 'package': name, 'version': versions[manager],
                        'profile': profile, 'arch': arch, 'manager': manager, 'binary': '/' + binary_path,
                        'sha256': sha256(artifact), 'binarySha256': sha256(binary),
                        'bytes': artifact.stat().st_size, 'release': '25.12' if manager == 'apk' else '24.10',
                    })
    shutil.copyfile(manifest_path, output / manifest_path.name)
    catalog = {'schema': 1, 'channel': 'experimental', 'version': VERSION, 'packages': records}
    (output / 'experimental-packages.json').write_text(json.dumps(catalog, indent=2) + '\n', encoding='utf-8')
    print(f'Built {len(records)} packages in {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('binaries', 'prepared', 'apk', 'output'):
        parser.add_argument('--' + argument, required=True, type=Path)
    args = parser.parse_args()
    build(args.binaries.resolve(), args.prepared.resolve(), args.apk.resolve(), args.output.resolve())
