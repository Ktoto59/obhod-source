#!/usr/bin/env python3
"""Package the patched core using the exact signed-index OpenWrt support files."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tempfile
import textwrap

ROOT=Path(__file__).resolve().parent.parent
VERSION='1.13.21-obhod.2'
STOCK_HASHES={
    ('mipsel_24kc','sing-box'):'9df59a6073a5e49a11894d1f837d3dcc1debe1c396434b55416bdf32929e69f4',
    ('mipsel_24kc','sing-box-tiny'):'6323a0aa122f0b9556a256c9b4f85176ec42ce947bda7c9fa4294711023edd39',
    ('aarch64_cortex-a53','sing-box'):'dea7599eeb61d3817a557d2e24cb19ee4180192c191b7f3e9eb08892ef731025',
    ('aarch64_cortex-a53','sing-box-tiny'):'6d81d056af3852adcf92f9f176cda39411dac9cf845822794a81d3b1e9a43db5',
}


def build(binaries,stocks,apk,output,support=None):
    spec=importlib.util.spec_from_file_location('builder',ROOT/'scripts/build-openwrt-packages.py')
    builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
    output.mkdir(parents=True,exist_ok=True);records=[]
    for arch,goarch in [('mipsel_24kc','mipsle'),('aarch64_cortex-a53','arm64')]:
        for profile,package in [('lite','sing-box-tiny'),('full','sing-box')]:
            stock=stocks/arch/(package+'-1.13.21-r1.apk') if stocks else None
            if stock:assert hashlib.sha256(stock.read_bytes()).hexdigest()==STOCK_HASHES[(arch,package)]
            binary=binaries/f'sing-box-linux-{goarch}-{profile}'
            header=binary.read_bytes()[:20]
            assert header[:4]==b'\x7fELF' and header[5]==1
            assert struct.unpack_from('<H',header,18)[0]==(8 if goarch=='mipsle' else 183)
            metadata=subprocess.check_output([apk,'adbdump',stock],text=True) if stock else (support/arch/(package+'-metadata.txt')).read_text()
            assert '\n  name: '+package+'\n' in metadata and '\n  arch: '+arch+'\n' in metadata
            scripts={name:textwrap.dedent(body) for name,body in re.findall(r'^  (post-install|pre-deinstall|post-upgrade): \|\n((?:    .*\n)+)',metadata,re.M)}
            assert set(scripts)=={'post-install','pre-deinstall','post-upgrade'}
            with tempfile.TemporaryDirectory(prefix='obhod-core-package-') as temporary:
                work=Path(temporary);stage=work/'root';stage.mkdir()
                if stock:subprocess.run([apk,'--allow-untrusted','extract','--destination',stage,stock],check=True,stdout=subprocess.DEVNULL)
                else:shutil.copytree(support/arch/package,stage,dirs_exist_ok=True)
                shutil.copyfile(binary,stage/'usr/bin/sing-box');(stage/'usr/bin/sing-box').chmod(0o755)
                notice=stage/'usr/share/sing-box/obhod-core';notice.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(ROOT/'LICENSES/GPL-3.0-only.txt',notice/'COPYING')
                (notice/'NOTICE').write_text('sing-box '+VERSION+' (GPL-3.0-or-later)\n'
                    'Based on sing-box 628cb31ffa79cffffd34c2f9cde6cae044e4fc12 and sing-tun f3b42b8b8e061ef849213a776d9fcf3d5f6ea239.\n'
                    'Patches: 31-bit redirect table IDs, bounded DNS pools, ICMP timeout logging.\n'
                    'Corresponding source and build instructions accompany this release.\n',encoding='utf-8')
                args=[apk,'mkpkg','--info','name:'+package,'--info','version:1.13.21-r200',
                    '--info','arch:'+arch,'--info','license:GPL-3.0-or-later',
                    '--info','maintainer:Obhod contributors','--info','description:Sing-box with Obhod compatibility patches',
                    '--info','url:https://github.com/Ktoto59/obhod-source',
                    '--info','depends:ca-bundle kmod-inet-diag kmod-tun libc']
                if profile=='lite':args+=['--info','provides:sing-box=1.13.21-r200 sing-box-tiny-any']
                for name,body in scripts.items():
                    file=work/name;file.write_text(body);args+=['--script',name+':'+str(file)]
                artifact=output/f'{package}-1.13.21-r200_{arch}.apk'
                subprocess.run(args+['--files',stage,'--output',artifact],check=True)
                files={f.relative_to(stage).as_posix():(f.read_bytes(),f.stat().st_mode&0o777) for f in stage.rglob('*') if f.is_file() and not f.relative_to(stage).as_posix().startswith('lib/apk/')}
                control=f'Package: {package}\nVersion: 1.13.21-200\nArchitecture: {arch}\nMaintainer: Obhod contributors\nLicense: GPL-3.0-or-later\nSection: net\nDepends: libc, ca-bundle, kmod-inet-diag, kmod-tun\n'
                if profile=='lite':control+='Provides: sing-box, sing-box-tiny-any\nConflicts: sing-box\n'
                else:control+='Conflicts: sing-box-tiny\n'
                control+='Require-User: sing-box=5566:sing-box=5566\nDescription: Sing-box with Obhod compatibility patches\n'
                conffiles=(stage/f'lib/apk/packages/{package}.conffiles').read_bytes()
                controls={'control':(control.encode(),0o644),'postinst':(scripts['post-install'].encode(),0o755),'prerm':(scripts['pre-deinstall'].encode(),0o755),'conffiles':(conffiles,0o644)}
                ipk=output/f'{package}_1.13.21-200_{arch}.ipk'
                ipk.write_bytes(builder.tar_bytes({'debian-binary':(b'2.0\n',0o644),'control.tar.gz':(builder.tar_bytes(controls),0o644),'data.tar.gz':(builder.tar_bytes(files),0o644)}))
                # Preserve original service files and packaging scripts for offline rebuilds.
                support=output/'stock-support'/arch/package
                shutil.copytree(stage,support,dirs_exist_ok=True)
                (support/'usr/bin/sing-box').unlink()
                (support.parent/(package+'-metadata.txt')).write_text(metadata)
                for manager,file in [('apk',artifact),('opkg',ipk)]:
                    records.append({'arch':arch,'manager':manager,'profile':profile,'name':file.name,
                        'version':'1.13.21-r200' if manager=='apk' else '1.13.21-200',
                        'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'bytes':file.stat().st_size,
                        'installedBytes':sum(len(content) for content,_ in files.values()),
                        'releases':['25.12'] if manager=='apk' else ['24.10']})
    (output/'packages.json').write_text(json.dumps({'schema':1,'version':VERSION,'packages':records},indent=2)+'\n')
    print('Built',len(records),'packages')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binaries',type=Path,required=True)
    inputs=parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--stocks',type=Path);inputs.add_argument('--support',type=Path)
    parser.add_argument('--apk',required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();build(args.binaries.resolve(),args.stocks.resolve() if args.stocks else None,args.apk,args.output.resolve(),args.support.resolve() if args.support else None)
