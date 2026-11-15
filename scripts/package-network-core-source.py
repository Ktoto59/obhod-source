#!/usr/bin/env python3
"""Archive the pinned experimental source and dependency cache for offline builds."""
import argparse
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def escape_module_path(path):
    return ''.join('!' + char.lower() if 'A' <= char <= 'Z' else char for char in path)


def copy_modules(prepared, cache, target):
    modules = subprocess.check_output(
        ['go', 'list', '-m', '-mod=readonly', 'all'], cwd=prepared / 'source', text=True,
        env={**os.environ, 'GOMODCACHE': str(cache), 'GOTOOLCHAIN': 'local'},
    )
    for entry in modules.splitlines():
        parts = entry.split()
        if len(parts) < 2 or '=>' in parts:
            continue
        path, version = parts[:2]
        escaped = escape_module_path(path)
        module = cache / f'{escaped}@{version}'
        download = Path('cache/download') / escaped / '@v'
        (target / download).mkdir(parents=True, exist_ok=True)
        for suffix in ('mod', 'info', 'ziphash'):
            relative = download / f'{version}.{suffix}'
            if (cache / relative).is_file():
                shutil.copyfile(cache / relative, target / relative)
        if module.is_dir():
            shutil.copytree(module, target / f'{escaped}@{version}')


def reproducible_metadata(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ''
    return info


def package(prepared, cache, packages, output):
    manifest = json.loads((prepared / 'build-manifest.json').read_text())
    version = manifest['version']
    with tempfile.TemporaryDirectory(prefix='obhod-experimental-source-') as temporary:
        stage = Path(temporary)
        for name in ('source', 'sing-tun', 'sing'):
            shutil.copytree(prepared / name, stage / name, symlinks=True)
        copy_modules(prepared, cache, stage / 'modules')
        shutil.copyfile(prepared / 'build-manifest.json', stage / 'build-manifest.json')
        shutil.copytree(ROOT / 'core', stage / 'core')
        (stage / 'scripts').mkdir()
        for name in ('prepare-network-core.py', 'build-network-core-packages.py',
                     'build-openwrt-packages.py', 'package-network-core-source.py'):
            shutil.copyfile(ROOT / 'scripts' / name, stage / 'scripts' / name)
        shutil.copytree(ROOT / 'LICENSES', stage / 'LICENSES')
        shutil.copyfile(packages / 'experimental-packages.json', stage / 'experimental-packages.json')
        (stage / 'BUILD.sh').write_text('''#!/bin/sh
set -eu
cd "$(dirname "$0")"
export GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off
export GOMODCACHE="$PWD/modules"
exec sh core/build.sh "$PWD" "$PWD/binaries" "${1:-mipsle}" "${2:-lite}" "${3:-linux}"
''', encoding='utf-8')
        (stage / 'BUILD.sh').chmod(0o755)
        (stage / 'README.txt').write_text(
            f'sing-box {version}. GPL-3.0-or-later.\n'
            f'Use Go {manifest["go"]}. Run sh BUILD.sh GOARCH lite|full.\n'
            'The archive includes pinned source, patches, module source and instructions in core/README.md.\n',
            encoding='utf-8',
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open('wb') as stream, gzip.GzipFile(filename='', fileobj=stream, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|') as archive:
                archive.add(stage, arcname=f'sing-box-{version}-source', filter=reproducible_metadata)
    print(f'Offline source archive {output} ({output.stat().st_size} bytes)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('prepared', 'cache', 'packages', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    package(args.prepared.resolve(), args.cache.resolve(), args.packages.resolve(), args.output.resolve())
