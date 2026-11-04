#!/usr/bin/env python3
"""Create separately versioned IPK rollback packages from immutable .4 payloads.

Revision 401 changes packaging metadata only. The data.tar.gz member is copied
byte-for-byte from the pinned, published revision 400; no installed opkg metadata
or user configuration is edited. Existing .4 artifacts must never be overwritten.
"""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('builder', ROOT/'scripts/build-openwrt-packages.py')
builder = importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)


def build(previous, output, catalog_file=None):
    assert previous.resolve() != output.resolve()
    catalog = json.loads((catalog_file or ROOT/'openwrt/obhod/files/usr/share/obhod/core-catalog.json').read_text())
    output.mkdir(parents=True,exist_ok=True);records=[];pins=[]
    for row in json.loads((previous/'packages.json').read_text())['packages']:
        if row['manager'] != 'opkg':continue
        assert row['version'] == '1.13.21-400'
        original = previous/row['name']
        expected = next(p for p in catalog['packages']+catalog.get('legacyPackages',[]) if p['name']==row['name'])
        pins.append(expected)
        digest = hashlib.sha256(original.read_bytes()).hexdigest()
        assert digest == row['sha256'] == expected['sha256']
        with tarfile.open(original) as archive:
            data = archive.extractfile('./data.tar.gz').read()
            controls = archive.extractfile('./control.tar.gz').read()
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            files={p.name.removeprefix('./'):p for p in archive if p.isfile()}
        with tarfile.open(fileobj=io.BytesIO(controls)) as archive:
            control={p.name.removeprefix('./'):(archive.extractfile(p).read(),p.mode) for p in archive if p.isfile()}
        content=control['control'][0].decode()
        assert content.count('Version: 1.13.21-400\n')==1
        control['control']=(content.replace('Version: 1.13.21-400\n','Version: 1.13.21-401\n').encode(),0o644)
        config=set()
        for entry in control['conffiles'][0].decode().splitlines():
            path=entry.lstrip('/')
            matches=[name for name in files if name==path or name.startswith(path.rstrip('/')+'/')]
            assert matches,entry
            config.update('/'+name for name in matches)
        control['conffiles']=(('\n'.join(sorted(config))+'\n').encode(),0o644)
        name=row['name'].replace('1.13.21-400','1.13.21-401')
        artifact=output/name
        artifact.write_bytes(builder.tar_bytes({'debian-binary':(b'2.0\n',0o644),
            'control.tar.gz':(builder.tar_bytes(control),0o644),'data.tar.gz':(data,0o644)}))
        records.append({**row,'name':name,'version':'1.13.21-401','coreVersion':'1.13.21-obhod.4',
            'bytes':artifact.stat().st_size,'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),
            'sourcePackage':original.name,'sourceSha256':digest,'payloadSha256':hashlib.sha256(data).hexdigest()})
    assert len(records)==4
    (output/'rollback-packages.json').write_text(json.dumps({'schema':1,'version':'1.13.21-obhod.4','packages':records},indent=2)+'\n')
    (output/'rollback-base.json').write_text(json.dumps({'schema':1,'version':'1.13.21-obhod.4','packages':pins},indent=2)+'\n')
    print('Built four revision 401 rollback IPK packages with identical published .4 payloads')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--catalog',type=Path)
    args=parser.parse_args();build(args.previous.resolve(),args.output.resolve(),args.catalog.resolve() if args.catalog else None)
