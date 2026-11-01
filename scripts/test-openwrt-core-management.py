#!/usr/bin/env python3
"""Exercise core removal with native APK/opkg, and platform-filtered version RPC."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parent.parent
BASE=ROOT/'openwrt/obhod/files/usr/libexec/obhod'
spec=importlib.util.spec_from_file_location('builder',ROOT/'scripts/build-openwrt-packages.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)


def check(manager):
    archive=ROOT/'.tmp/openwrt-tools'/('rootfs.tar.gz' if manager=='apk' else 'rootfs-24.10.4.tar.gz')
    expected='55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4' if manager=='apk' else 'e7f8ab84eef55c7eb23492de7b0517dbc23fbedaa4abbb680fe64720c309dc03'
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==expected
    with tempfile.TemporaryDirectory(prefix='obhod-core-management-') as temp:
        lab=Path(temp);subprocess.run(['tar','-xzf',archive,'-C',lab],check=True)
        def run(*args,ok=True,input=None):
            r=subprocess.run(['chroot',lab,*args],text=True,capture_output=True,input=input)
            assert (r.returncode==0)==ok,(r.stdout,r.stderr)
            return r.stdout
        def write(name,text):
            p=lab/name;p.parent.mkdir(parents=True,exist_ok=True);p.unlink(missing_ok=True);p.write_text(text);p.chmod(0o755)
        (lab/'usr/libexec/obhod').mkdir(parents=True)
        for name in ['core-remove.sh','package-lib.sh','core-select.uc']:
            shutil.copyfile(BASE/name,lab/'usr/libexec/obhod'/name)
        shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/rpcd/obhod',lab/'usr/libexec/obhod-rpc');(lab/'usr/libexec/obhod-rpc').chmod(0o755)
        write('usr/libexec/obhod/control','#!/bin/sh\necho "$1" >> /tmp/control-calls\n')
        (lab/'etc/obhod').mkdir();profile=b'{"profile":{"tunnels":[{"password":"preserved"}]}}'
        (lab/'etc/obhod/settings.json').write_bytes(profile)
        (lab/'usr/share/obhod').mkdir(parents=True)
        shutil.copyfile(ROOT/'openwrt/obhod/files/usr/share/obhod/core-catalog.json',lab/'usr/share/obhod/core-catalog.json')
        (lab/'var/run/obhod').mkdir(parents=True,exist_ok=True)
        (lab/'var/lock').mkdir(parents=True,exist_ok=True)
        write('tmp/remove.sh',"""#!/bin/sh
set -eu
umask 077
RUN=/var/run/obhod
work=
trap 'case "$work" in /tmp/obhod-core.*) rm -rf "$work";; esac' EXIT
die() { echo "$*" >&2; exit 1; }
. /usr/libexec/obhod/package-lib.sh
. /usr/libexec/obhod/core-remove.sh
remove_core
""")
        (lab/'etc/openwrt_release').write_text("DISTRIB_RELEASE='"+('25.12.6' if manager=='apk' else '24.10.4')+"'\n")
        if manager=='apk':
            (lab/'etc/apk/arch').write_text('mipsel_24kc\n')
        else:
            native=lab/'bin/opkg';native.rename(lab/'bin/opkg-real')
            write('bin/opkg',"""#!/bin/sh
[ "$1" != print-architecture ] || { echo 'arch mipsel_24kc 100'; exit 0; }
exec /bin/opkg-real --conf /etc/opkg.conf --offline-root / "$@"
""")
        versions=json.loads(run('/usr/libexec/obhod-rpc','call','coreVersions',input='{}'))['versions']
        assert len(versions)==4 and {v['profile'] for v in versions}=={'full','lite'}
        assert {v['value'] for v in versions}=={'1.13.21-obhod.2','1.13.21-obhod.3'}
        assert all(v['recommended']==(v['value']=='1.13.21-obhod.3') for v in versions)
        if manager=='apk': (lab/'etc/apk/arch').write_text('x86_64\n')
        run('/bin/sh','/tmp/remove.sh',ok=False)
        assert not (lab/'tmp/control-calls').exists()
        def package(name,depends=''):
            files={'usr/bin/sing-box':(b'#!/bin/sh\necho fixture\n',0o755)} if name.startswith('sing-box') else {'usr/share/consumer':(b'fixture',0o644)}
            if manager=='apk':
                stage=lab/'tmp/stage';stage.mkdir(exist_ok=True)
                # Clear only the isolated fixture directory.
                for child in stage.iterdir():
                    if child.is_dir():shutil.rmtree(child)
                    else:child.unlink()
                for n,(data,mode) in files.items():
                    f=stage/n;f.parent.mkdir(parents=True,exist_ok=True);f.write_bytes(data);f.chmod(mode)
                output=lab/'tmp'/(name+'.apk')
                args=[ROOT/'.tmp/openwrt-tools/sbin/apk.static','mkpkg','--info','name:'+name,'--info','version:1-r1','--info','arch:noarch','--files',stage,'--output',output]
                if name.endswith('tiny'):args+=['--info','provides:sing-box','--info','depends:!sing-box']
                if depends:args+=['--info','depends:'+depends]
                subprocess.run(args,check=True,capture_output=True)
                run('/usr/bin/apk','--no-network','--no-scripts','add','--allow-untrusted','/tmp/'+name+'.apk')
            else:
                control='Package: '+name+'\nVersion: 1\nArchitecture: all\nDescription: isolated fixture\n'
                if depends:control+='Depends: '+depends+'\n'
                if name.endswith('tiny'):control+='Provides: sing-box\nConflicts: sing-box\n'
                payload=builder.tar_bytes({'debian-binary':(b'2.0\n',0o644),'control.tar.gz':(builder.tar_bytes({'control':(control.encode(),0o644)}),0o644),'data.tar.gz':(builder.tar_bytes(files),0o644)})
                (lab/'tmp'/(name+'.ipk')).write_bytes(payload)
                run('/bin/opkg','install','/tmp/'+name+'.ipk')
        for name in ['sing-box','sing-box-tiny']:
            package(name)
            if manager=='apk' and name.endswith('tiny'):
                run('/usr/bin/apk','--no-network','add','sing-box')
            run('/bin/sh','/tmp/remove.sh')
            assert not (lab/'usr/bin/sing-box').exists()
            assert (lab/'etc/obhod/settings.json').read_bytes()==profile
        package('sing-box');package('core-consumer','sing-box')
        calls=(lab/'tmp/control-calls').read_bytes()
        world=(lab/'etc/apk/world').read_bytes() if manager=='apk' else None
        run('/bin/sh','/tmp/remove.sh',ok=False)
        assert (lab/'usr/bin/sing-box').exists() and (lab/'usr/share/consumer').exists()
        assert (lab/'tmp/control-calls').read_bytes()==calls
        if manager=='apk':assert (lab/'etc/apk/world').read_bytes()==world
        assert (lab/'etc/obhod/settings.json').read_bytes()==profile
    print('PASS:',manager,'full/tiny removal, dependency refusal, private-profile preservation and version RPC')


if __name__=='__main__':
    check('apk');check('opkg')
