#!/usr/bin/env python3
"""Exercise the compatibility installer in isolated OpenWrt userspace."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / 'release/openwrt-core-mips/sing-box-tiny-1.13.21-r100.apk'
ARCHIVE = ROOT / '.tmp/openwrt-tools/rootfs.tar.gz'
ROUTES = ('default via 198.51.100.1 dev wan proto static src 198.51.100.24\n'
          '10.8.0.0/24 dev wg0 proto kernel scope link src 10.8.0.18\n'
          '203.0.113.181 via 198.51.100.1 dev wan proto static\n'
          'local 127.0.0.1 dev wan scope host\nlocal 127.0.0.1 dev br-lan scope host\n'
          'local 127.0.0.1 dev wg0 scope host\n192.0.2.0/24 dev br-lan proto kernel scope link src 192.0.2.7\n')


def main():
    assert hashlib.sha256(ARCHIVE.read_bytes()).hexdigest() == '55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4'
    with tempfile.TemporaryDirectory(prefix='obhod-mips-installer-') as d:
        lab = Path(d)
        subprocess.run(['tar', '-xzf', ARCHIVE, '-C', lab], check=True)
        for path in ['etc/obhod', 'var/run/obhod', 'var/lock']:(lab/path).mkdir(parents=True,exist_ok=True)
        original = b'{"profile":{"tunnels":[{"name":"Preserve","password":"fixture"}]}}'
        (lab/'etc/obhod/settings.json').write_bytes(original)
        (lab/'etc/config/network').write_text("config interface 'wg0'\n option proto 'wireguard'\n")
        network = (lab/'etc/config/network').read_bytes()
        (lab/'etc/config/sing-box').write_text("config sing-box 'main'\n option enabled '1'\n")
        (lab/'lib/apk/db/installed').write_text('P:sing-box-tiny\nV:1.13.21-r1\n\n')
        shutil.copyfile(PACKAGE, lab/'tmp/core.apk')
        script=(ROOT/'openwrt/core-mips/install.sh').read_text().replace("PACKAGE_URL=''", "PACKAGE_URL='https://api.github.com/repos/Ktoto59/obhod-releases/releases/assets/1'")
        (lab/'tmp/install.sh').write_text(script)
        def stub(relative, body):
            file=lab/relative;file.unlink(missing_ok=True);file.parent.mkdir(parents=True,exist_ok=True)
            file.write_text('#!/bin/sh\n'+body+'\n');file.chmod(0o755)
        stub('bin/ubus', '''if [ "$3" = 'board' ]; then echo '{"release":{"target":"ramips/mt7621"}}'; else echo '{}'; fi''')
        stub('bin/uclient-fetch', '''while [ "$#" -gt 0 ]; do if [ "$1" = -O ]; then cp /tmp/core.apk "$2"; exit $?; fi; shift; done
exit 1''')
        stub('usr/bin/apk', '''echo "$*" >> /tmp/apk-calls
[ ! -f /tmp/reject-install ] || exit 1
exit 0''')
        stub('usr/libexec/obhod/control', '''echo "$1" >> /tmp/control-calls
case "$1" in stop) rm -f /var/run/obhod/ready;; start) touch /var/run/obhod/ready;; *) exit 1;; esac''')
        stub('etc/init.d/sing-box', 'exit 0')
        stub('bin/df', "printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\ntmpfs 1048576 0 1048576 0%% /tmp\\n'")
        stub('sbin/ip', '''if [ "$*" = '-4 route show table main' ]; then cat /tmp/routes;exit 0;fi
echo "$*" >> /tmp/ip-calls
[ "$1 $2 $3 $4 $5 $6 $7 $8 $10 $11" = '-4 route del table main local 127.0.0.1/32 dev scope host' ] || exit 1
awk -v dev="$9" '!($1=="local" && $2=="127.0.0.1" && $3=="dev" && $4==dev)' /tmp/routes > /tmp/routes.new
mv /tmp/routes.new /tmp/routes''')
        # Use braces for positional parameters above 9 in POSIX shell.
        file=lab/'sbin/ip';file.write_text(file.read_text().replace('$10','${10}').replace('$11','${11}'));file.chmod(0o755)
        def run():return subprocess.run(['chroot',lab,'/bin/sh','/tmp/install.sh'],text=True,capture_output=True)
        (lab/'tmp/routes').write_text(ROUTES)
        (lab/'var/run/obhod/ready').touch()
        result=run();assert result.returncode==0,(result.stdout,result.stderr)
        expected=''.join(line+'\n' for line in ROUTES.splitlines() if not line.startswith('local 127.0.0.1 '))
        assert (lab/'tmp/routes').read_text()==expected
        assert (lab/'tmp/ip-calls').read_text().splitlines()==[
            '-4 route del table main local 127.0.0.1/32 dev '+dev+' scope host' for dev in ['wan','br-lan','wg0']]
        assert (lab/'etc/config/network').read_bytes()==network
        assert (lab/'etc/obhod/settings.json').read_bytes()==original
        assert (lab/'var/run/obhod/ready').exists()
        assert not (lab/'var/lock/obhod-apply.lock').exists()
        assert not (lab/'var/lock/obhod-core.lock').exists()
        assert list((lab/'root').glob('obhod-before-mips-fix-*.tar.gz'))
        before=(lab/'tmp/ip-calls').read_bytes()
        result=run();assert result.returncode==0,(result.stdout,result.stderr)
        assert (lab/'tmp/ip-calls').read_bytes()==before, 'Cleanup is idempotent'
        calls=(lab/'tmp/apk-calls').read_bytes()
        data=bytearray(PACKAGE.read_bytes());data[-1]^=1;(lab/'tmp/core.apk').write_bytes(data)
        result=run();assert result.returncode!=0 and 'сумма' in result.stderr,(result.stdout,result.stderr)
        assert (lab/'tmp/apk-calls').read_bytes()==calls
        assert (lab/'var/run/obhod/ready').exists() and not (lab/'var/lock/obhod-core.lock').exists()
        (lab/'tmp/core.apk').write_bytes(PACKAGE.read_bytes());(lab/'tmp/reject-install').touch()
        result=run();assert result.returncode!=0
        assert (lab/'var/run/obhod/ready').exists() and not (lab/'var/lock/obhod-apply.lock').exists()
        (lab/'lib/apk/db/installed').write_text('P:sing-box\nV:1.13.21-r1\n\n')
        before=(lab/'tmp/control-calls').read_bytes();result=run()
        assert result.returncode!=0 and (lab/'tmp/control-calls').read_bytes()==before
    print('PASS: scoped main-table cleanup, WireGuard/profile preservation, backups, idempotency, checksum rejection, failure recovery and full-core protection')


if __name__ == '__main__':main()
