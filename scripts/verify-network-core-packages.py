#!/usr/bin/env python3
"""Verify real core APK/IPK payloads and install/rollback in disposable userspaces.

Requires Linux root, cached verified OpenWrt x86 rootfs archives, apk-tools 3
and qemu-user-static. Dependencies are virtual fixtures; procd hooks are not
executed. This verifies package-manager transactions and foreign ELF execution,
not physical router networking, kernel modules or service integration.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tmp/openwrt-tools'
spec = importlib.util.spec_from_file_location('builder', ROOT/'scripts/build-openwrt-packages.py')
builder = importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)


def run(*args):
    result = subprocess.run(list(map(str, args)), text=True, capture_output=True)
    assert result.returncode == 0, (args, result.stdout, result.stderr)
    return result.stdout


def unpack(file, manager, stage):
    if manager == 'apk':
        run(TOOLS/'sbin/apk.static', '--allow-untrusted', 'extract', '--destination', stage, file)
        return run(TOOLS/'sbin/apk.static', 'adbdump', file)
    with tarfile.open(file) as outer:
        with tarfile.open(fileobj=io.BytesIO(outer.extractfile('./data.tar.gz').read())) as data:
            data.extractall(stage, filter='data')
        with tarfile.open(fileobj=io.BytesIO(outer.extractfile('./control.tar.gz').read())) as control:
            return control.extractfile('./control').read().decode()


def opkg_faults(lab, target, repair, preserved):
    """Trace the actual opkg write to its ELF payload; no package is patched."""
    native=lab/'bin/opkg'
    native.write_text('''#!/bin/sh
if [ -f /tmp/trace-core ]; then
    echo $$ > /tmp/core-opkg-pid
    kill -STOP $$
fi
exec /bin/opkg-real --conf /etc/opkg.conf --offline-root / "$@"
''');native.chmod(0o755)
    def invoke(name):
        return ['chroot',str(lab),'ucode','/usr/libexec/obhod/core-opkg.uc','/tmp/'+name]
    def wait_until(condition, message):
        deadline=time.monotonic()+15
        while not condition():
            assert time.monotonic()<deadline,message
            time.sleep(.01)
    def traced(options, interrupt=None):
        pidfile=lab/'tmp/core-opkg-pid';pidfile.unlink(missing_ok=True)
        (lab/'tmp/trace-core').touch()
        worker=subprocess.Popen(invoke(target),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
        tracer=None
        try:
            wait_until(pidfile.exists,'Native opkg wrapper did not stop')
            pid=int(pidfile.read_text())
            trace=lab/'tmp/opkg-write.trace'
            tracer=subprocess.Popen(['strace','-qq','-yy','-e','trace=write,writev,pwrite64',*options,'-o',str(trace),'-p',str(pid)],
                stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
            wait_until(lambda: re.search(r'^TracerPid:\s+[1-9]',Path(f'/proc/{pid}/status').read_text(),re.M),'strace did not attach')
            os.kill(pid,signal.SIGCONT)
            if interrupt:
                wait_until(lambda: trace.exists() and '/usr/bin/sing-box>' in trace.read_text() and
                    trace.read_text().count('SIGSTOP')>=2,'No injected SIGSTOP at ELF write')
                # Killing just the parent must not permit concurrent recovery
                # while native opkg still owns the inherited transaction guard.
                os.kill(worker.pid,interrupt)
                busy=subprocess.run(['chroot',lab,'ucode','/usr/libexec/obhod/core-opkg.uc','recover'],capture_output=True,text=True)
                assert busy.returncode!=0, 'A live native opkg child must retain the transaction lease'
                os.kill(pid,interrupt)
                if interrupt==signal.SIGTERM:os.kill(pid,signal.SIGCONT)
                # The shell started by ucode system() can also retain the lease.
                try:os.killpg(worker.pid,interrupt)
                except ProcessLookupError:pass
            out,err=worker.communicate(timeout=15)
            tracer.communicate(timeout=15)
            return worker.returncode,trace.read_text(),out+err
        finally:
            (lab/'tmp/trace-core').unlink(missing_ok=True)
            if worker.poll() is None:os.killpg(worker.pid,signal.SIGKILL);worker.communicate(timeout=5)
            if tracer and tracer.poll() is None:tracer.kill();tracer.communicate(timeout=5)
    code,trace,output=traced([])
    assert code==0,output
    (ROOT/'.tmp/release-019-resume/opkg-trace.log').write_text(trace)
    counters={};syscall=None;index=None
    for line in trace.splitlines():
        match=re.match(r'^(write|writev|pwrite64)\(',line)
        if not match:continue
        call=match[1];counters[call]=counters.get(call,0)+1
        if '/usr/bin/sing-box>' in line:syscall=call;index=counters[call];break
    assert syscall, 'No ELF write in actual opkg syscall trace'
    preserved();run(*invoke(repair));preserved()
    code,trace,output=traced(['-e',f'inject={syscall}:error=ENOSPC:when={index}'])
    assert code!=0 and 'ENOSPC' in trace and '(INJECTED)' in trace,output
    preserved();run(*invoke(repair));preserved()
    for interrupt in [signal.SIGKILL,signal.SIGTERM]:
        code,trace,output=traced(['-e',f'inject={syscall}:signal=SIGSTOP:when={index}'],interrupt=interrupt)
        assert code!=0 and '/usr/bin/sing-box>' in trace
        assert (lab/'etc/obhod/core-package-backup.json').exists()
        run('chroot',lab,'ucode','/usr/libexec/obhod/core-opkg.uc','recover');preserved()
        run('chroot',lab,'ucode','/usr/libexec/obhod/core-opkg.uc','recover');preserved()
        run(*invoke(repair));preserved()
    print('PASS: native opkg ENOSPC at ELF write, SIGKILL/SIGTERM, inherited lease, persistent configuration recovery and idempotent retry',flush=True)


def main(packages, previous, rollback_packages=None, faults=False):
    catalog = json.loads((packages/'packages.json').read_text())
    old = json.loads((previous/'packages.json').read_text())
    rollback_rows=json.loads((rollback_packages/'rollback-packages.json').read_text())['packages'] if rollback_packages else []
    assert catalog['version'] == '1.13.21-obhod.5'
    assert len(catalog['packages']) == 8
    records = []; failures = []
    for p in catalog['packages']:
        file = packages/p['name']
        assert file.stat().st_size == p['bytes']
        assert hashlib.sha256(file.read_bytes()).hexdigest() == p['sha256']
        with tempfile.TemporaryDirectory(prefix='obhod-core-verify-') as tmp:
            work = Path(tmp); stage = work/'stage'; stage.mkdir()
            metadata = unpack(file, p['manager'], stage)
            assert p['version'] in metadata and p['arch'] in metadata
            assert 'GPL-3.0-or-later' in metadata
            for dep in ['libc', 'ca-bundle', 'kmod-tun', 'kmod-inet-diag']: assert dep in metadata
            files = [f for f in stage.rglob('*') if f.is_file() and not f.relative_to(stage).as_posix().startswith('lib/apk/')]
            assert sum(f.stat().st_size for f in files) == p['installedBytes']
            assert (stage/'usr/share/sing-box/obhod-core/COPYING').stat().st_size > 30000
            assert 'obhod.5' in (stage/'usr/share/sing-box/obhod-core/NOTICE').read_text()
            qemu = 'qemu-mipsel-static' if p['arch'] == 'mipsel_24kc' else 'qemu-aarch64-static'
            binary = stage/'usr/bin/sing-box'
            assert '1.13.21-obhod.5' in run(qemu, binary, 'version')
            caps = run(qemu, binary, 'obhod-capabilities').splitlines()
            assert {'dns-pool-v1', 'kernel-route-set-v1', 'redirect-table-31bit', 'dns-udp-isolation-v1'} <= set(caps)
            config = work/'check.json';config.write_text('{"outbounds":[{"type":"direct"}]}')
            run(qemu, binary, 'check', '-c', config)
            manager = p['manager']; lab = work/'lab';lab.mkdir()
            archive = TOOLS/('rootfs.tar.gz' if manager == 'apk' else 'rootfs-24.10.4.tar.gz')
            expected = '55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4' if manager == 'apk' else 'e7f8ab84eef55c7eb23492de7b0517dbc23fbedaa4abbb680fe64720c309dc03'
            assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
            run('tar', '-xzf', archive, '-C', lab)
            older = next(o for o in old['packages'] if (o['arch'],o['manager'],o['profile']) == (p['arch'],manager,p['profile']))
            oldfile = previous/older['name']
            assert hashlib.sha256(oldfile.read_bytes()).hexdigest() == older['sha256']
            for source in [file, oldfile]: shutil.copyfile(source, lab/'tmp'/source.name)
            rollback_package=older;rollback_file=oldfile
            if manager=='opkg' and rollback_packages:
                rollback_package=next(o for o in rollback_rows if (o['arch'],o['profile'])==(p['arch'],p['profile']))
                rollback_file=rollback_packages/rollback_package['name']
                assert rollback_package['sourceSha256']==older['sha256']
                assert hashlib.sha256(rollback_file.read_bytes()).hexdigest()==rollback_package['sha256']
                with tarfile.open(oldfile) as a,tarfile.open(rollback_file) as b:
                    assert a.extractfile('./data.tar.gz').read()==b.extractfile('./data.tar.gz').read()
                shutil.copyfile(rollback_file,lab/'tmp'/rollback_file.name)
            (lab/'etc/obhod').mkdir();state = lab/'etc/obhod/settings.json';state.write_text('{"fixture":"preserved"}')
            package = 'sing-box-tiny' if p['profile'] == 'lite' else 'sing-box'
            if manager == 'apk':
                (lab/'etc/apk/arch').write_text('x86_64\n'+p['arch']+'\n')
                fixture = work/'fixture';fixture.mkdir()
                run(TOOLS/'sbin/apk.static','mkpkg','--info','name:obhod-test-core-deps','--info','version:1-r1',
                    '--info','arch:noarch','--info','provides:ca-bundle kmod-tun kmod-inet-diag','--files',fixture,'--output',lab/'tmp/deps.apk')
                def install(name, reinstall=False):
                    run('chroot',lab,'/usr/bin/apk','--arch',p['arch'],'--no-network','--no-scripts','add','--allow-untrusted','/tmp/deps.apk','/tmp/'+name)
                assert run(TOOLS/'sbin/apk.static','version','-t',p['version'],older['version']).strip() == '>'
            else:
                with (lab/'etc/opkg.conf').open('a') as out:out.write('\narch all 1\narch noarch 1\narch x86_64 10\narch '+p['arch']+' 100\n')
                (lab/'var/lock').mkdir(parents=True,exist_ok=True)
                control = b'Package: obhod-test-core-deps\nVersion: 1\nArchitecture: all\nProvides: kmod-tun, kmod-inet-diag\nDescription: Isolated test dependencies\n'
                (lab/'tmp/deps.ipk').write_bytes(builder.tar_bytes({'debian-binary':(b'2.0\n',0o644),
                    'control.tar.gz':(builder.tar_bytes({'control':(control,0o644)}),0o644),
                    'data.tar.gz':(builder.tar_bytes({}),0o644)}))
                run('chroot',lab,'/bin/opkg','--conf','/etc/opkg.conf','--offline-root','/','install','/tmp/deps.ipk')
                native=lab/'bin/opkg';native.rename(lab/'bin/opkg-real')
                native.write_text('#!/bin/sh\nexec /bin/opkg-real --conf /etc/opkg.conf --offline-root / "$@"\n');native.chmod(0o755)
                helper=lab/'usr/libexec/obhod/core-opkg.uc';helper.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/obhod/core-opkg.uc',helper)
                def install(name, reinstall=False):
                    run('chroot',lab,'ucode','/usr/libexec/obhod/core-opkg.uc','/tmp/'+name)
                run('chroot',lab,'/bin/opkg','compare-versions',p['version'],'>',older['version'])
            install(older['name'])
            # Exercise actual modified conffiles, extra user files, unrelated
            # UCI and the private Obhod profile, including their permissions.
            for name,content in [('etc/config/sing-box',"config sing-box 'main'\n option enabled '0'\n # keep-user-config\n"),
                    ('etc/sing-box/config.json','{"user":"preserve-secret-fixture"}\n'),
                    ('etc/sing-box/custom/user.json','{"private":"extra-user-file"}\n')]:
                path=lab/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content);path.chmod(0o600)
            if manager=='opkg':os.chown(lab/'etc/sing-box/config.json',123,456)
            protected=['etc/config/sing-box','etc/sing-box/config.json','etc/sing-box/custom/user.json',
                'etc/obhod/settings.json','etc/config/dhcp']
            def identity(name):
                info=(lab/name).stat()
                return ((lab/name).read_bytes(),info.st_mode&0o777,info.st_uid,info.st_gid)
            snapshot={name:identity(name) for name in protected}
            def preserved():
                for name,expected in snapshot.items():
                    assert identity(name)==expected,name
            install(file.name);preserved()
            assert hashlib.sha256((lab/'usr/bin/sing-box').read_bytes()).digest() == hashlib.sha256(binary.read_bytes()).digest()
            assert p['version'] in run('chroot',lab,'/usr/bin/apk' if manager=='apk' else '/bin/opkg',*(['info','-a',package] if manager=='apk' else ['status',package]))
            rollback = 'passed'
            try:
                install(rollback_file.name);preserved()
                assert '1.13.21-obhod.4' in run(qemu,lab/'usr/bin/sing-box','version')
                install(rollback_file.name,reinstall=True);preserved()
                install(file.name);preserved()
                install(file.name,reinstall=True);preserved()
                if manager=='opkg' and faults:opkg_faults(lab,rollback_file.name,file.name,preserved)
            except AssertionError as error:
                rollback = 'failed'
                failures.append({'package':p['name'],'error':str(error)})
                print('FAIL:',p['name'],str(error),flush=True)
            assert state.read_text() == '{"fixture":"preserved"}'
            records.append({**p,'payload':'passed','qemuVersionCheckCapabilities':'passed','installUpgrade':'passed','rollback':rollback,
                'rollbackPackageVersion':rollback_package['version'],'modifiedConfigurationsAndReinstall':rollback})
            print('PASS:',p['name'],'metadata, payload, QEMU version/check/capabilities, .4 -> .5; ROLLBACK:',rollback,
                rollback_package['version'],'modified config and reinstall',flush=True)
    (packages/'verification.json').write_text(json.dumps({'environment':'WSL x86 OpenWrt chroot; virtual dependencies; no procd hooks; target ELF via QEMU','packages':records,'failures':failures},indent=2)+'\n')
    assert not failures, f'{len(failures)} package rollback gates failed; see verification.json'


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packages',type=Path,required=True);parser.add_argument('--previous',type=Path,required=True)
    parser.add_argument('--rollback-packages',type=Path)
    parser.add_argument('--faults',action='store_true')
    args=parser.parse_args();main(args.packages.resolve(),args.previous.resolve(),args.rollback_packages.resolve() if args.rollback_packages else None,args.faults)
