#!/usr/bin/env python3
"""Required .4 migration after an old app updater: real OpenWrt ash/UCI/ucode."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    with tempfile.TemporaryDirectory(prefix='obhod-required-core-') as temporary:
        lab = Path(temporary)
        subprocess.run(['tar', '-xzf', ROOT/'.tmp/openwrt-tools/rootfs.tar.gz', '-C', lab], check=True)
        base = lab/'usr/libexec/obhod'
        shutil.copytree(ROOT/'openwrt/obhod/files/usr/libexec/obhod', base, dirs_exist_ok=True)
        for file in base.iterdir(): file.chmod(0o755)
        for name in ['var/lock', 'var/run/obhod', 'etc/obhod', 'usr/share/obhod', 'proc']:
            (lab/name).mkdir(parents=True, exist_ok=True)
        def stub(name, body):
            file = lab/name; file.unlink(missing_ok=True); file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('#!/bin/sh\n'+body+'\n'); file.chmod(0o755)
        def run(*args, ok=True):
            p = subprocess.run(['chroot', lab, *args], capture_output=True, text=True)
            assert (p.returncode == 0) == ok, (args, p.stdout, p.stderr)
            return p
        stub('usr/bin/sing-box', '''case "$1" in
version) echo "sing-box version $(cat /tmp/version)";;
obhod-capabilities) echo dns-pool-v1; echo redirect-table-31bit; [ "$(cat /tmp/version)" != 1.13.21-obhod.4 ] || echo kernel-route-set-v1;;
check) exit 0;;
esac''')
        stub('bin/ubus', "echo '{}'")
        stub('bin/df', "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nroot 1048576 0 %s 0%% /tmp\\n' \"$(cat /tmp/free)\"")
        stub('usr/bin/apk', '''echo "$*" >> /tmp/apk-calls
case "$*" in *--simulate*) exit 0;; *add*) echo 1.13.21-obhod.4 > /tmp/version;; esac''')
        stub('bin/uclient-fetch', 'while [ "$#" -gt 0 ]; do if [ "$1" = -O ]; then cp /tmp/core.apk "$2"; exit $?; fi; shift; done; exit 1')
        stub('usr/libexec/obhod/dns', 'echo "$1" >> /tmp/dns-calls')
        (lab/'proc/meminfo').write_text('MemTotal: 239024 kB\nMemAvailable: 98304 kB\n')
        (lab/'tmp/free').write_text('1048576')
        (lab/'etc/apk/arch').write_text('aarch64_cortex-a53')
        (lab/'etc/config/sing-box').write_text("config sing-box 'main'\n option enabled '0'\n")
        (lab/'etc/config/obhod').write_text("config obhod 'main'\n option enabled '1'\n")
        shutil.copyfile(ROOT/'openwrt/obhod/files/etc/init.d/obhod', lab/'etc/init.d/obhod')
        (lab/'var/run/obhod/controller-secret').write_text('11111111-2222-4333-8444-555555555555')
        state = lab/'etc/obhod/settings.json'
        state.write_bytes((ROOT/'.tmp/openwrt-legacy-settings.json').read_bytes())
        original = state.read_bytes()
        package = b'fixture APK content\n'*150
        catalog = {'schema': 1, 'version': '1.13.21-obhod.4', 'packages': [
            {'arch': 'aarch64_cortex-a53', 'manager': 'apk', 'profile': profile,
             'version': '1.13.21-r400', 'releases': ['25.12'], 'bytes': len(package),
             'installedBytes': 32000000, 'sha256': hashlib.sha256(package).hexdigest(),
             'url': 'https://api.github.com/repos/Ktoto59/obhod-releases/releases/assets/1'}
            for profile in ['lite', 'full']]}
        (lab/'usr/share/obhod/core-catalog.json').write_text(json.dumps(catalog))
        database = lab/'lib/apk/db/installed'; database.parent.mkdir(parents=True, exist_ok=True)
        calls = lab/'tmp/apk-calls'
        for flavor in ['sing-box', 'sing-box-tiny']:
            database.write_text('P:'+flavor+'\nV:1.13.21-r300\n\n')
            (lab/'tmp/version').write_text('1.13.21-obhod.3')
            (lab/'tmp/core.apk').write_bytes(package); calls.unlink(missing_ok=True)
            # prepare runs after an old updater preserves the previous core.
            run('/usr/libexec/obhod/control', 'prepare')
            assert (lab/'tmp/version').read_text().strip() == '1.13.21-obhod.4'
            assert state.read_bytes() == original
            assert '/tmp/obhod-required-core.' in calls.read_text()
            assert ('!sing-box-tiny' in calls.read_text()) == (flavor == 'sing-box')
            assert not (lab/'var/lock/obhod-core.lock').exists()
            assert (lab/'var/run/obhod/prepared.sha').exists()
            prior = calls.read_bytes()
            run('/usr/libexec/obhod/control', 'prepare')
            assert calls.read_bytes() == prior, 'A compatible installed core is never reinstalled'
        (lab/'tmp/version').write_text('1.13.21-obhod.3')
        (lab/'tmp/core.apk').write_bytes(package+b'tampered'); prior = calls.read_bytes()
        run('/usr/libexec/obhod/core-upgrade-required', ok=False)
        assert calls.read_bytes() == prior and state.read_bytes() == original
        assert (lab/'tmp/version').read_text().strip() == '1.13.21-obhod.3'
        (lab/'tmp/free').write_text('512')
        run('/usr/libexec/obhod/core-upgrade-required', ok=False)
        assert calls.read_bytes() == prior and not (lab/'var/lock/obhod-core.lock').exists()
        (lab/'tmp/free').write_text('1048576'); (lab/'etc/apk/arch').write_text('x86_64')
        run('/usr/libexec/obhod/core-upgrade-required', ok=False)
        assert calls.read_bytes() == prior and state.read_bytes() == original
    print('PASS: old updater -> required .4, preserved full/tiny/profile, no repeat install, tamper/space/platform refusal and cleanup')


if __name__ == '__main__': main()
