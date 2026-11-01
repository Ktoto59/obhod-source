#!/usr/bin/env python3
"""Publish corresponding patched sources, dependency sources and offline recipes."""
import argparse
import json
from pathlib import Path
import shutil
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parent.parent


def package(prepared,cache,packages,output):
    with tempfile.TemporaryDirectory(prefix='obhod-core-source-') as temporary:
        stage=Path(temporary)
        for name in ['source','sing-tun']:shutil.copytree(prepared/name,stage/name,ignore=shutil.ignore_patterns('.git'))
        shutil.copytree(cache,stage/'modules',ignore=shutil.ignore_patterns('*.zip','*.lock','toolchain@*'))
        shutil.copyfile(prepared/'upstream-changes.patch',stage/'upstream-changes.patch')
        shutil.copyfile(prepared/'build-manifest.json',stage/'build-manifest.json')
        shutil.copytree(ROOT/'core',stage/'core')
        (stage/'scripts').mkdir()
        for name in ['build-network-core-packages.py','build-openwrt-packages.py']:
            shutil.copyfile(ROOT/'scripts'/name,stage/'scripts'/name)
        (stage/'LICENSES').mkdir()
        shutil.copyfile(ROOT/'LICENSES/GPL-3.0-only.txt',stage/'LICENSES/GPL-3.0-only.txt')
        shutil.copytree(packages/'stock-support',stage/'packaging/stock-support')
        shutil.copyfile(packages/'packages.json',stage/'packaging/packages.json')
        (stage/'BUILD.sh').write_text('''#!/bin/sh
set -eu
cd "$(dirname "$0")"
export GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off
export GOMODCACHE="$PWD/modules"
exec sh core/build.sh "$PWD" "$PWD/binaries" "${1:-mipsle}" "${2:-lite}" "${3:-linux}"
''',encoding='utf-8')
        (stage/'BUILD.sh').chmod(0o755)
        (stage/'README.txt').write_text('sing-box 1.13.21-obhod.2. GPL-3.0-or-later.\n'
            'Exact patched sing-box and sing-tun sources, module sources, licenses and build recipes are included.\n'
            'Install Go 1.26.10. Run sh BUILD.sh mipsle lite (or mipsle full, arm64 lite, arm64 full).\n'
            'The build uses no module network access. See core/README.md for upstream revisions and changes.\n'
            'Go itself is a build prerequisite, not part of this archive.\n',encoding='utf-8')
        output.parent.mkdir(parents=True,exist_ok=True)
        with tarfile.open(output,'w:gz',compresslevel=6) as archive:archive.add(stage,arcname='sing-box-1.13.21-obhod.2-source')
        print('Corresponding source archive:',output.stat().st_size,'bytes')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    for name in ['prepared','cache','packages','output']:p.add_argument('--'+name,type=Path,required=True)
    a=p.parse_args();package(a.prepared.resolve(),a.cache.resolve(),a.packages.resolve(),a.output.resolve())
