#!/usr/bin/env python3
"""Package the patched tiny core while preserving the stock OpenWrt payload.

Run on Linux. The stock APK must first be fetched through the signed OpenWrt
25.12 repository. No network access or device changes are performed here.
"""
import argparse
import hashlib
import importlib.util
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import textwrap

ROOT = Path(__file__).resolve().parent.parent
VERSION = '1.13.21-r100'
STOCK_SHA256 = '6323a0aa122f0b9556a256c9b4f85176ec42ce947bda7c9fa4294711023edd39'


def build(binary, stock, apk, output, support=None):
    if stock: assert hashlib.sha256(stock.read_bytes()).hexdigest() == STOCK_SHA256, 'Unexpected stock APK'
    header = binary.read_bytes()[:20]
    assert header[:6] == b'\x7fELF\x01\x01' and struct.unpack_from('<H', header, 18)[0] == 8, 'Expected 32-bit little-endian MIPS ELF'
    metadata = subprocess.check_output([apk, 'adbdump', stock], text=True) if stock else (support.parent / 'stock-metadata.txt').read_text(encoding='utf-8')
    scripts = {name: textwrap.dedent(body) for name, body in re.findall(
        r'^  (post-install|pre-deinstall|post-upgrade): \|\n((?:    .*\n)+)', metadata, re.M)}
    assert set(scripts) == {'post-install', 'pre-deinstall', 'post-upgrade'}
    assert 'arch: mipsel_24kc' in metadata and 'name: sing-box-tiny' in metadata
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='obhod-mips-package-') as temporary:
        work = Path(temporary); stage = work / 'root'; stage.mkdir()
        # OpenWrt signs repository indexes, not individual APKs. The exact archive
        # hash above pins the package already authenticated through that index.
        if stock:
            subprocess.run([apk, '--allow-untrusted', 'extract', '--destination', stage, stock], check=True)
        else:
            shutil.copytree(support, stage, dirs_exist_ok=True)
            stage.chmod(0o755)
            for file in stage.rglob('*'):
                file.chmod(0o755 if file.is_dir() or file.relative_to(stage).as_posix() == 'etc/init.d/sing-box'
                           else 0o600 if file.relative_to(stage).as_posix() == 'etc/config/sing-box' else 0o644)
        (stage / 'usr/bin').mkdir(parents=True, exist_ok=True)
        shutil.copyfile(binary, stage / 'usr/bin/sing-box'); (stage / 'usr/bin/sing-box').chmod(0o755)
        notice = stage / 'usr/share/sing-box/obhod-mips-fix'; notice.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / 'LICENSES/GPL-3.0-only.txt', notice / 'COPYING')
        (notice / 'NOTICE').write_text(
            'sing-box 1.13.21, upstream revision 628cb31ffa79cffffd34c2f9cde6cae044e4fc12\n'
            'sing-tun v0.8.15, revision f3b42b8b8e061ef849213a776d9fcf3d5f6ea239\n'
            'Obhod compatibility patch: mask random redirect route tables to 31 bits.\n'
            'GPL-3.0-or-later. Corresponding source and build instructions accompany this release.\n', encoding='utf-8')
        args = [apk, 'mkpkg', '--info', 'name:sing-box-tiny', '--info', 'version:' + VERSION,
                '--info', 'arch:mipsel_24kc', '--info', 'license:GPL-3.0-or-later',
                '--info', 'description:Sing-box tiny with Obhod 32-bit redirect route fix',
                '--info', 'maintainer:Obhod contributors (compatibility build)',
                '--info', 'url:https://github.com/Ktoto59/obhod-releases',
                '--info', 'depends:ca-bundle kmod-inet-diag kmod-tun libc',
                '--info', 'provides:sing-box=' + VERSION + ' sing-box-tiny-any',
                '--files', stage, '--output', output / ('sing-box-tiny-' + VERSION + '.apk')]
        for name, text in scripts.items():
            file = work / name; file.write_text(text, encoding='utf-8'); args += ['--script', name + ':' + str(file)]
        subprocess.run([str(arg) for arg in args], check=True)
        # Preserve the unmodified package support files in the source archive.
        support_out = output / 'stock-support'; support_out.mkdir(exist_ok=True)
        for file in stage.rglob('*'):
            if not file.is_file() or file.relative_to(stage).as_posix() == 'usr/bin/sing-box': continue
            target = support_out / file.relative_to(stage); target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(file, target)
        (output / 'stock-metadata.txt').write_text(metadata, encoding='utf-8')
        spec = importlib.util.spec_from_file_location('openwrt_builder', ROOT / 'scripts/build-openwrt-packages.py')
        builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
        files = {file.relative_to(stage).as_posix(): (file.read_bytes(), file.stat().st_mode & 0o777)
                 for file in stage.rglob('*') if file.is_file() and not file.relative_to(stage).as_posix().startswith('lib/apk/')}
        control = ('Package: sing-box-tiny\nVersion: 1.13.21-100\nArchitecture: mipsel_24kc\n'
                   'Maintainer: Obhod contributors (compatibility build)\nLicense: GPL-3.0-or-later\n'
                   'Section: net\nDepends: libc, ca-bundle, kmod-inet-diag, kmod-tun\n'
                   'Provides: sing-box, sing-box-tiny-any\nConflicts: sing-box\n'
                   'Require-User: sing-box=5566:sing-box=5566\n'
                   'Description: Sing-box tiny with Obhod 32-bit redirect route fix\n')
        controls = {'control': (control.encode(), 0o644), 'postinst': (scripts['post-install'].encode(), 0o755),
                    'prerm': (scripts['pre-deinstall'].encode(), 0o755),
                    'conffiles': ((stage / 'lib/apk/packages/sing-box-tiny.conffiles').read_bytes(), 0o644)}
        (output / 'sing-box-tiny_1.13.21-100_mipsel_24kc.ipk').write_bytes(builder.tar_bytes({
            'debian-binary': (b'2.0\n', 0o644), 'control.tar.gz': (builder.tar_bytes(controls), 0o644),
            'data.tar.gz': (builder.tar_bytes(files), 0o644)}))
    for file in sorted(output.glob('*')):
        if file.suffix in {'.apk', '.ipk'}: print(hashlib.sha256(file.read_bytes()).hexdigest(), file.name, file.stat().st_size)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--stock', type=Path)
    inputs.add_argument('--support', type=Path, help='Preserved source-archive packaging files (offline)')
    parser.add_argument('--apk', required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'release/openwrt-core-mips')
    args = parser.parse_args(); build(args.binary.resolve(), args.stock.resolve() if args.stock else None, args.apk, args.output.resolve(), args.support.resolve() if args.support else None)
