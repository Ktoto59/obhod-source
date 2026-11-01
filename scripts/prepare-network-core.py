#!/usr/bin/env python3
"""Apply the small, version-pinned Obhod patch set to clean upstream sources.

The source directories must be exact checkouts of the revisions below. Generated
sources remain GPL-3.0-or-later; this Apache-2.0 build script does not relicense them.
"""
import argparse
import difflib
import hashlib
import json
import io
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
REVISIONS = {'sing-box': '628cb31ffa79cffffd34c2f9cde6cae044e4fc12',
             'sing-tun': 'f3b42b8b8e061ef849213a776d9fcf3d5f6ea239'}
VERSION = '1.13.21-obhod.2'


def prepare(box, tun, destination):
    destination.mkdir(parents=True, exist_ok=True)
    changes = []
    for project, original in [('sing-box', box), ('sing-tun', tun)]:
        revision = subprocess.check_output(['git', '-C', original, 'rev-parse', 'HEAD'], text=True).strip()
        assert revision == REVISIONS[project], f'Unexpected {project} revision'
        # Read committed blobs, not the developer's working tree or prior patches.
        target = destination / ('source' if project == 'sing-box' else 'sing-tun')
        assert not target.exists(), f'Destination already exists: {target}'
        target.mkdir()
        committed = subprocess.check_output(['git', '-C', original, 'archive', 'HEAD'])
        with tarfile.open(fileobj=io.BytesIO(committed)) as archive:
            archive.extractall(target, filter='data')
        def replace(name, old, new):
            file=target/name;before=file.read_text(encoding='utf-8')
            assert before.count(old)==1, f'Upstream context mismatch: {name}'
            after=before.replace(old,new);file.write_text(after,encoding='utf-8',newline='\n')
            changes.extend(difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile=project+'/'+name,tofile=project+'/'+name))
        if project == 'sing-box':
            replace('include/registry.go', '\ttransport.RegisterHTTPS(registry)', '\ttransport.RegisterHTTPS(registry)\n\ttransport.RegisterObhodPool(registry)')
            with (target/'go.mod').open('a',encoding='utf-8') as f:f.write('\nreplace github.com/sagernet/sing-tun => ../sing-tun\n')
        else:
            replace('redirect_route_linux.go', 'int(rand.Uint32())', 'int(rand.Uint32() & 0x7fffffff)')
            for name in ['ping/destination.go','ping/destination_gvisor.go']:
                replace(name, '\tdefer d.Close()\n' if name.endswith('destination.go') else '\tdefer d.endpoint.Close()\n',
                    ('\tdefer d.Close()\n' if name.endswith('destination.go') else '\tdefer d.endpoint.Close()\n')+'\treceived := false\n')
                replace(name, '\t\t\tif !E.IsClosed(err) {\n\t\t\t\td.logger.ErrorContext(d.ctx, E.Cause(err, "receive ICMP echo reply"))\n\t\t\t}',
                    '\t\t\tlogICMPReadError(d.ctx, d.logger, err, received)')
                # Only classify a session as idle after a reply was written back.
                marker='\t\tbuffer.Release()\n\t}\n}'
                replace(name, marker, '\t\treceived = true\n'+marker)
        overlay=ROOT/'core/overlay'/project
        shutil.copytree(overlay,target,dirs_exist_ok=True)
    (destination/'upstream-changes.patch').write_text(''.join(changes),encoding='utf-8')
    manifest={'version':VERSION,'upstream':REVISIONS,'overlay':{}}
    for file in sorted((ROOT/'core/overlay').rglob('*.go')):
        manifest['overlay'][file.relative_to(ROOT/'core/overlay').as_posix()]=hashlib.sha256(file.read_bytes()).hexdigest()
    (destination/'build-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print('Prepared',VERSION,'in',destination)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sing-box',type=Path,required=True)
    parser.add_argument('--sing-tun',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();prepare(args.sing_box.resolve(),args.sing_tun.resolve(),args.output.resolve())
