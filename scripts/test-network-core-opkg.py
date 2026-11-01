#!/usr/bin/env python3
"""Check compatibility-core switching and rollback with the real OpenWrt opkg."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parent.parent


def main():
    archive=ROOT/'.tmp/openwrt-tools/rootfs-24.10.4.tar.gz'
    assert hashlib.sha256(archive.read_bytes()).hexdigest()=='e7f8ab84eef55c7eb23492de7b0517dbc23fbedaa4abbb680fe64720c309dc03'
    spec=importlib.util.spec_from_file_location('builder',ROOT/'scripts/build-openwrt-packages.py')
    builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
    with tempfile.TemporaryDirectory(prefix='obhod-compat-opkg-') as temporary:
        lab=Path(temporary);subprocess.run(['tar','-xzf',archive,'-C',lab],check=True)
        def inside(*args,ok=True):
            r=subprocess.run(['chroot',lab,*args],capture_output=True,text=True)
            assert (r.returncode==0)==ok,(r.stdout,r.stderr)
            return r.stdout
        inside('/bin/mkdir','-p','/usr/libexec/obhod','/tmp/repo','/tmp/work','/etc/obhod','/var/opkg-lists','/var/lock','/proc')
        for name in ['core-compat.sh','core-select.uc','package-lib.sh']:
            shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/obhod'/name,lab/'usr/libexec/obhod'/name)
        settings=b'{"preserve":"profile"}';(lab/'etc/obhod/settings.json').write_bytes(settings)
        native=lab/'bin/opkg';native.rename(lab/'bin/opkg-real')
        native.write_text('''#!/bin/sh
case "$1" in
 print-architecture) echo 'arch mipsel_24kc 100';exit 0;;
 download) cp "/tmp/repo/$2.ipk" .;exit $?;;
 install) case "$2" in /tmp/compat-test.*/sing-box.ipk) [ ! -f /tmp/reject-core ] || exit 1;; esac;;
esac
exec /bin/opkg-real --conf /etc/opkg.conf --offline-root / "$@"
''');native.chmod(0o755)
        config=lab/'etc/opkg.conf';config.write_text(config.read_text().replace('option check_signature','# offline fixture')+'\nsrc fixture file:///tmp/repo\n')
        def package(name,version):
            binary=f'#!/bin/sh\nif [ "$1" = version ]; then echo "sing-box version {"1.13.21-obhod.2" if version.endswith("200") else "1.13.21"}"; else echo dns-pool-v1; echo redirect-table-31bit; fi\n'
            control=f'Package: {name}\nVersion: {version}\nArchitecture: all\nInstalled-Size: 10000\nDescription: Isolated fixture\n'
            if name.endswith('tiny'):control+='Provides: sing-box\nConflicts: sing-box\n'
            data=builder.tar_bytes({'debian-binary':(b'2.0\n',0o644),'control.tar.gz':(builder.tar_bytes({'control':(control.encode(),0o644)}),0o644),
                'data.tar.gz':(builder.tar_bytes({'usr/bin/sing-box':(binary.encode(),0o755),
                    'usr/share/core-fixture':(b''.join(hashlib.sha256(str(i).encode()).digest() for i in range(128)),0o644)}),0o644)})
            return data,control
        old,control=package('sing-box-tiny','1.13.21-1')
        (lab/'tmp/repo/sing-box-tiny.ipk').write_bytes(old)
        (lab/'var/opkg-lists/fixture').write_text(control+f'Size: {len(old)}\nSHA256sum: {hashlib.sha256(old).hexdigest()}\nFilename: sing-box-tiny.ipk\n')
        inside('/bin/opkg','install','/tmp/repo/sing-box-tiny.ipk')
        new,_=package('sing-box','1.13.21-200');(lab/'tmp/new.ipk').write_bytes(new)
        catalog={'schema':1,'packages':[{'arch':'mipsel_24kc','manager':'opkg','profile':'full','releases':['24.10'],
            'url':'https://api.github.com/repos/Ktoto59/obhod-releases/releases/assets/1','sha256':hashlib.sha256(new).hexdigest(),
            'bytes':len(new),'installedBytes':10000,'version':'1.13.21-200'}]}
        (lab/'tmp/catalog.json').write_text(json.dumps(catalog))
        def stub(path,text):
            f=lab/path;f.unlink(missing_ok=True);f.write_text('#!/bin/sh\n'+text+'\n');f.chmod(0o755)
        stub('bin/ubus',"echo '{}'")
        stub('sbin/ip','exit 0')
        stub('bin/df',"printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nroot 1048576 0 1048576 0%% /tmp\\n'")
        stub('bin/uclient-fetch','''while [ "$#" -gt 0 ]; do if [ "$1" = -O ]; then cp /tmp/new.ipk "$2";exit $?;fi;shift;done;exit 1''')
        (lab/'proc/meminfo').write_text('MemTotal: 262144 kB\nMemAvailable: 196608 kB\n')
        (lab/'tmp/test.sh').write_text('''#!/bin/sh
set -eu
die() { echo "$*" >&2;exit 1; }
work=$(mktemp -d /tmp/compat-test.XXXXXX);core=sing-box;manager=opkg
compat_catalog=/tmp/catalog.json;compat_selector=/usr/libexec/obhod/core-select.uc
. /usr/libexec/obhod/package-lib.sh
. /usr/libexec/obhod/core-compat.sh
select_compat_core
[ "$compat" = 1 ]
install_compat_core
''')
        (lab/'tmp/reject-core').touch();inside('/bin/sh','/tmp/test.sh',ok=False)
        assert '1.13.21-1' in inside('/bin/opkg','status','sing-box-tiny')
        assert '1.13.21-obhod.2' not in inside('/usr/bin/sing-box','version')
        (lab/'tmp/reject-core').unlink()
        inside('/bin/sh','/tmp/test.sh')
        assert '1.13.21-obhod.2' in inside('/usr/bin/sing-box','version')
        assert '1.13.21-200' in inside('/bin/opkg','status','sing-box')
        inside('/bin/sh','/tmp/test.sh')
        assert (lab/'etc/obhod/settings.json').read_bytes()==settings
    print('PASS: real opkg verified rollback, tiny-to-full compatibility switch, exact old-version guard, repeat installation and profile preservation')


if __name__=='__main__':main()
