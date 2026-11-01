#!/usr/bin/env python3
"""Exercise architecture selection and pinned core installation in OpenWrt userspace."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parent.parent


def main():
    archive=ROOT/'.tmp/openwrt-tools/rootfs.tar.gz'
    assert hashlib.sha256(archive.read_bytes()).hexdigest()=='55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4'
    with tempfile.TemporaryDirectory(prefix='obhod-core-installer-') as temporary:
        lab=Path(temporary);subprocess.run(['tar','-xzf',archive,'-C',lab],check=True)
        base=lab/'usr/libexec/obhod';base.mkdir(parents=True)
        for name in ['core-compat.sh','core-select.uc','package-lib.sh']:
            shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/obhod'/name,base/name)
        (lab/'etc/obhod').mkdir();original=b'{"profile":{"tunnels":[{"name":"Fixture","password":"preserve"}]}}'
        (lab/'etc/obhod/settings.json').write_bytes(original)
        (lab/'etc/config/sing-box').write_text("config sing-box 'main'\n option enabled '0'\n")
        (lab/'tmp/work').mkdir();(lab/'proc').mkdir(exist_ok=True)
        (lab/'proc/meminfo').write_text('MemTotal: 117760 kB\nMemAvailable: 39936 kB\n')
        artifact=b'fixture-only-core-package\n'*100
        (lab/'tmp/core.apk').write_bytes(artifact)
        def stub(name,text):
            f=lab/name;f.unlink(missing_ok=True);f.parent.mkdir(parents=True,exist_ok=True)
            f.write_text('#!/bin/sh\n'+text+'\n');f.chmod(0o755)
        stub('usr/bin/sing-box','if [ "$1" = version ]; then echo "sing-box version $(cat /tmp/version)"; else echo dns-pool-v1; echo redirect-table-31bit; fi')
        (lab/'tmp/version').write_text('1.13.21')
        (lab/'etc/apk/arch').write_text('mipsel_24kc')
        stub('usr/bin/apk','''echo "$*" >> /tmp/apk-calls
if [ "$1" = --print-arch ]; then echo mipsel; exit 0; fi
[ ! -f /tmp/reject-apk ] || exit 1
exit 0''')
        stub('bin/ubus', '''if [ -f /tmp/other-service ]; then echo '{"other":{"instances":{"x":{"running":true}}}}'; else echo '{}'; fi''')
        stub('bin/uclient-fetch','''while [ "$#" -gt 0 ]; do if [ "$1" = -O ]; then cp /tmp/core.apk "$2"; exit $?; fi; shift; done
exit 1''')
        stub('bin/df',"printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\nroot 1048576 0 1048576 0%% /tmp\\n'")
        stub('sbin/ip','''if [ "$*" = '-4 route show table main' ]; then cat /tmp/routes; else echo "$*" >> /tmp/ip-calls; fi''')
        (lab/'tmp/routes').write_text('default via 198.51.100.1 dev wan\nlocal 127.0.0.1 dev wan scope host\n10.8.0.0/24 dev wg0\n')
        catalog={'schema':1,'packages':[]}
        for arch in ['mipsel_24kc','aarch64_cortex-a53']:
            for profile in ['lite','full']:
                catalog['packages'].append({'arch':arch,'manager':'apk','profile':profile,'releases':['25.12'],
                    'url':'https://api.github.com/repos/Ktoto59/obhod-releases/releases/assets/1',
                    'sha256':hashlib.sha256(artifact).hexdigest(),'bytes':len(artifact),'installedBytes':10000,'version':'1.13.21-r200'})
        catalog_path=lab/'tmp/catalog.json';catalog_path.write_text(json.dumps(catalog))
        (lab/'tmp/test.sh').write_text('''#!/bin/sh
set -eu
die() { echo "$*" >&2; exit 1; }
work=/tmp/work
core=${1:-sing-box-tiny}
manager=apk
compat_catalog=/tmp/catalog.json
compat_selector=/usr/libexec/obhod/core-select.uc
. /usr/libexec/obhod/package-lib.sh
. /usr/libexec/obhod/core-compat.sh
select_compat_core
echo "SELECTED=$compat"
[ "${2:-}" != install ] || { [ "$compat" = 1 ] && install_compat_core; }
''')
        def run(*args,ok=True):
            p=subprocess.run(['chroot',lab,'/bin/sh','/tmp/test.sh',*args],capture_output=True,text=True)
            assert (p.returncode==0)==ok,(p.stdout,p.stderr)
            return p.stdout
        assert 'SELECTED=1' in run('sing-box-tiny','install')
        assert (lab/'etc/obhod/settings.json').read_bytes()==original
        assert list((lab/'root').glob('obhod-before-core-*.tar.gz'))
        assert (lab/'tmp/ip-calls').read_text().strip()=='-4 route del table main local 127.0.0.1/32 dev wan scope host'
        assert '!sing-box-tiny' in run('sing-box','install') or '!sing-box-tiny' in (lab/'tmp/apk-calls').read_text()
        calls=(lab/'tmp/apk-calls').read_bytes()
        (lab/'tmp/core.apk').write_bytes(artifact+b'bad');run('sing-box-tiny','install',ok=False)
        # Architecture query is permitted, actual package mutation is not.
        assert (lab/'tmp/apk-calls').read_bytes()==calls
        (lab/'tmp/core.apk').write_bytes(artifact)
        (lab/'tmp/other-service').touch();run('sing-box-tiny','install',ok=False);(lab/'tmp/other-service').unlink()
        (lab/'tmp/version').write_text('1.13.21-obhod.2')
        (lab/'lib/apk/db/installed').write_text('P:sing-box-tiny\nV:1.13.21-r200\n\n')
        (lab/'tmp/core.apk').write_bytes(b'not needed for an installed compatible core')
        calls=(lab/'tmp/apk-calls').read_bytes();run('sing-box-tiny','install')
        assert (lab/'tmp/apk-calls').read_bytes()==calls, 'Installed core must not be downloaded or replaced'
        (lab/'tmp/version').write_text('1.14.0');assert 'SELECTED=0' in run()
        (lab/'tmp/version').write_text('1.13.21-obhod.3');assert 'SELECTED=0' in run()
        (lab/'tmp/version').write_text('1.12.22');assert 'SELECTED=1' in run()
        (lab/'etc/apk/arch').write_text('x86_64');assert 'SELECTED=0' in run()
        (lab/'etc/apk/arch').write_text('aarch64_cortex-a53');assert 'SELECTED=1' in run('sing-box')
        (lab/'etc/openwrt_release').write_text("DISTRIB_RELEASE='SNAPSHOT'\n");assert 'SELECTED=0' in run()
        (lab/'etc/openwrt_release').write_text("DISTRIB_RELEASE='25.12.6'\n")
        catalog['packages'][2]['url']='https://example.org/untrusted.apk';catalog_path.write_text(json.dumps(catalog))
        run('sing-box-tiny',ok=False)
    print('PASS: MIPS/ARM64 and profile selection, no downgrade, SNAPSHOT/unsupported fallback, pinned hashes, conflict refusal, scoped route cleanup and profile preservation')


if __name__=='__main__':main()
