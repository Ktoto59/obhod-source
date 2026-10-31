#!/usr/bin/env python3
"""Archive the exact core sources and used module sources for an offline rebuild."""
import argparse
import json
from pathlib import Path
import tarfile
import tempfile
import shutil


def package(work, cache, output):
    text = (work / 'deps.json').read_text(encoding='utf-8-sig')
    decoder = json.JSONDecoder(); offset = 0; modules = {}
    while offset < len(text):
        if text[offset].isspace(): offset += 1; continue
        row, offset = decoder.raw_decode(text, offset)
        module = row.get('Module')
        if not module or module.get('Main') or module.get('Replace'): continue
        directory = Path(module['Dir']).resolve()
        assert directory.is_relative_to(cache)
        modules[str(directory)] = directory
    assert len(modules) > 20
    with tempfile.TemporaryDirectory(prefix='obhod-core-source-') as d:
        stage = Path(d)
        ignore = shutil.ignore_patterns('.git', 'vendor')
        shutil.copytree(work / 'source', stage / 'source', ignore=ignore)
        shutil.copytree(work / 'sing-tun', stage / 'sing-tun', ignore=ignore)
        for directory in modules.values():
            shutil.copytree(directory, stage / 'modules' / directory.relative_to(cache), ignore=ignore)
        # Module graph metadata is needed by Go's lazy module loader even for
        # dependencies not linked into this build. Exclude zip files and locks.
        for file in (cache / 'cache/download').rglob('*'):
            if file.is_file() and file.suffix in {'.mod', '.info', '.ziphash'}:
                target = stage / 'modules' / file.relative_to(cache)
                target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(file, target)
        (stage / 'BUILD.sh').write_text('''#!/bin/sh
set -eu
cd "$(dirname "$0")"
export GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off CGO_ENABLED=0
export GOOS=linux GOARCH=mipsle GOMIPS=softfloat
export GOMODCACHE="$PWD/modules"
cd source
go build -mod=readonly -trimpath -buildvcs=false -tags with_gvisor,with_quic,with_utls,with_clash_api -ldflags '-s -w -checklinkname=0 -X github.com/sagernet/sing-box/constant.Version=1.13.21-obhod.1' -o ../sing-box-tiny-mipsle ./cmd/sing-box
''', encoding='utf-8')
        (stage / 'BUILD.sh').chmod(0o755)
        (stage / 'README.txt').write_text(
            'Use Go 1.26.8 and run sh BUILD.sh. Module sources are included; no module network access is needed.\n'
            'sing-box: https://github.com/SagerNet/sing-box/tree/628cb31ffa79cffffd34c2f9cde6cae044e4fc12\n'
            'sing-tun: https://github.com/SagerNet/sing-tun/tree/f3b42b8b8e061ef849213a776d9fcf3d5f6ea239\n'
            'Only functional change: int(rand.Uint32()) -> int(rand.Uint32() & 0x7fffffff) in redirect_route_linux.go.\n'
            'License: GPL-3.0-or-later. See source/LICENSE and sing-tun/LICENSE.\n'
            'Offline package recipe (apk-tools v3 required):\n'
            'python3 scripts/build-openwrt-mips-core.py --binary sing-box-tiny-mipsle --support packaging/stock-support --apk /path/to/apk --output packages\n', encoding='utf-8')
        recipe = stage / 'packaging'; recipe.mkdir()
        scripts = stage / 'scripts'; scripts.mkdir()
        root = Path(__file__).resolve().parent.parent
        for name in ['build-openwrt-mips-core.py', 'build-openwrt-packages.py']:
            shutil.copyfile(root / 'scripts' / name, scripts / name)
        (stage / 'LICENSES').mkdir()
        shutil.copyfile(root / 'LICENSES/GPL-3.0-only.txt', stage / 'LICENSES/GPL-3.0-only.txt')
        shutil.copytree(root / 'release/openwrt-core-mips/stock-support', recipe / 'stock-support')
        shutil.copyfile(root / 'release/openwrt-core-mips/stock-metadata.txt', recipe / 'stock-metadata.txt')
        output.parent.mkdir(parents=True, exist_ok=True)
        with tarfile.open(output, 'w:gz', compresslevel=6) as archive:
            archive.add(stage, arcname='sing-box-1.13.21-obhod.1-source')
        print('Module sources:', len(modules), 'archive bytes:', output.stat().st_size)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); package(args.work.resolve(), args.cache.resolve(), args.output.resolve())
