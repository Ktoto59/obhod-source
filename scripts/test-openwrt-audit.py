#!/usr/bin/env python3
"""Focused audit regressions against real OpenWrt tools in disposable chroots."""
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / 'openwrt/obhod/files'


class Audit(unittest.TestCase):
    manager = 'apk'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='obhod-audit-')
        self.addCleanup(self.temp.cleanup)
        self.lab = Path(self.temp.name)
        archive = ROOT / '.tmp/openwrt-tools' / ('rootfs.tar.gz' if self.manager == 'apk' else 'rootfs-24.10.4.tar.gz')
        expected = '55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4' if self.manager == 'apk' else 'e7f8ab84eef55c7eb23492de7b0517dbc23fbedaa4abbb680fe64720c309dc03'
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), expected)
        subprocess.run(['tar', '-xzf', archive, '-C', self.lab], check=True)
        shutil.copytree(BASE, self.lab, dirs_exist_ok=True)
        for p in (self.lab / 'usr/libexec').rglob('*'):
            if p.is_file(): p.chmod(0o755)
        for d in ['var/run/obhod', 'var/lock', 'etc/obhod', 'proc']:
            (self.lab / d).mkdir(parents=True, exist_ok=True)
        device = self.lab/'dev/null'
        device.unlink(missing_ok=True)
        os.mknod(device, stat.S_IFCHR | 0o666, os.makedev(1, 3))

    def run_in(self, *args, input=None):
        return subprocess.run(['chroot', str(self.lab), *args], input=input, text=True, capture_output=True)

    def write(self, path, text):
        p = self.lab / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.unlink(missing_ok=True)
        p.write_text(text)
        p.chmod(0o755)
        return p

    def rpc(self, method, body=None):
        r = self.run_in('/usr/libexec/rpcd/obhod', 'call', method, input=json.dumps(body or {}))
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def op(self, *args):
        if args and args[0] in ['claim', 'hold']:
            kind = args[1]
            lock = '/var/lock/obhod-apply.lock' if kind == 'apply' else f'/var/lock/obhod-{kind}.lock'
            return self.run_in('/bin/sh', '-c', 'exec 9>"$1/lease" || exit 1; shift; ucode /usr/libexec/obhod/operation.uc "$@"', 'operation-test', lock, *map(str, args))
        return self.run_in('/usr/bin/ucode', '/usr/libexec/obhod/operation.uc', *map(str, args))

    def acquire(self, kind, pid=None):
        r = self.op('acquire', kind, '', os.getpid() if pid is None else pid)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_operation_claim_once_and_old_token_cannot_touch_replacement(self):
        for kind in ['core', 'job', 'update', 'apply']:
            token = self.acquire(kind)
            if kind != 'apply':
                with concurrent.futures.ThreadPoolExecutor(2) as pool:
                    results = list(pool.map(lambda _: self.op('claim', kind, token, os.getpid()).returncode, range(2)))
                self.assertEqual(sorted(results), [0, 1])
            self.assertNotEqual(self.op('acquire', kind, '', os.getpid()).returncode, 0)
            self.assertEqual(self.op('release', kind, token, os.getpid(), 'done', 'Completed').returncode, 0)
            new = self.acquire(kind)
            self.assertNotEqual(token, new)
            self.assertNotEqual(self.op('claim', kind, token, os.getpid()).returncode, 0)
            self.assertNotEqual(self.op('release', kind, token, os.getpid(), 'error', 'Old worker').returncode, 0)
            self.assertTrue((self.lab/'var/lock/obhod-apply.lock').exists())
            self.assertEqual(self.op('release', kind, new, os.getpid(), 'done', 'Completed').returncode, 0)

    def test_late_worker_after_grace_and_status_claim_race(self):
        for _ in range(12):
            token = self.acquire('job', 2147483647)
            lock = self.lab/'var/lock/obhod-job.lock'
            self.assertTrue(self.rpc('status')['jobBusy'], 'New pending job needs a startup grace')
            (lock/'started').write_text('1\n')
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                worker = pool.submit(self.op, 'claim', 'job', token, os.getpid())
                status = pool.submit(self.rpc, 'status')
                claimed, value = worker.result().returncode == 0, status.result()
            if claimed:
                self.assertTrue(value['jobBusy'], 'Recovery removed a claimed live job')
                self.assertEqual(self.op('release', 'job', token, os.getpid(), 'done', 'Completed').returncode, 0)
            else:
                self.assertFalse(value['jobBusy'])
                self.assertNotEqual(self.op('claim', 'job', token, os.getpid()).returncode, 0)

    def test_zombie_pid_reuse_and_orphan_apply_recovery(self):
        for kind in ['core', 'update', 'job', 'apply']:
            for zombie in [True, False]:
                token = self.acquire(kind)
                if kind != 'apply': self.assertEqual(self.op('claim', kind, token, os.getpid()).returncode, 0)
                lock = self.lab / ('var/lock/obhod-apply.lock' if kind == 'apply' else f'var/lock/obhod-{kind}.lock')
                (lock/'birth').write_text('123\n')
                self.write(f'proc/{os.getpid()}/stat', str(os.getpid()) + ' (odd) worker name) ' + ('Z' if zombie else 'S') + ' ' + '0 '*18 + '456\n')
                self.assertEqual(self.op('recover').returncode, 0)
                self.assertFalse(lock.exists())
                self.assertFalse((self.lab/'var/lock/obhod-apply.lock').exists())
                (self.lab/f'proc/{os.getpid()}/stat').unlink()

    def test_sigkill_and_package_child_protection(self):
        child = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: child.poll() is None and (child.kill(), child.wait()))
        token = self.acquire('update')
        self.assertEqual(self.op('claim', 'update', token, child.pid).returncode, 0)
        child.kill(); child.wait()
        # A package manager outliving its killed worker must finish undisturbed.
        self.write('bin/pidof', f'#!/bin/sh\necho {os.getpid()}\n')
        self.assertTrue(self.rpc('status')['updateBusy'])
        self.write('bin/pidof', '#!/bin/sh\nexit 1\n')
        status = self.rpc('status')
        self.assertFalse(status['updateBusy'])
        self.assertEqual(status['updateState'], 'error')
        self.assertIn('прервана', status['updateMessage'])
        self.assertNotEqual(self.op('claim', 'update', token, os.getpid()).returncode, 0)

    def test_sigkill_does_not_release_a_running_control_child(self):
        token = self.acquire('job')
        self.write('usr/libexec/obhod/control', '#!/bin/sh\necho $$ > /tmp/control-pid\nsleep 60 & child=$!\necho "$child" > /tmp/control-child-pid\nwait "$child"\n')
        p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/job', 'worker', 'start', token], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 3
            while not (self.lab/'tmp/control-child-pid').exists() and time.monotonic() < deadline: time.sleep(.01)
            self.assertTrue((self.lab/'tmp/control-child-pid').exists())
            p.kill(); p.wait()
            self.assertTrue(self.rpc('status')['jobBusy'], 'A surviving control child still owns the operation')
        finally:
            if p.poll() is None: p.kill(); p.wait()
            for name in ['control-pid', 'control-child-pid']:
                f = self.lab/'tmp'/name
                if f.exists():
                    try: os.kill(int(f.read_text()), 9)
                    except ProcessLookupError: pass
        deadline = time.monotonic() + 3
        while self.rpc('status')['jobBusy'] and time.monotonic() < deadline: time.sleep(.01)
        self.assertFalse(self.rpc('status')['jobBusy'])

    def test_explicit_catalog_version_reaches_installer(self):
        self.write('usr/libexec/obhod/core-install', '#!/bin/sh\nprintf "%s\\n" "$*" > /tmp/install-args\n')
        for profile in ['lite', 'full']:
            for version in ['auto', '1.13.21-obhod.2', '1.13.21-obhod.3', '1.13.21-obhod.4']:
                self.assertTrue(self.rpc('installCore', dict(profile=profile, version=version))['ok'])
                self.assertIn(version, (self.lab/'tmp/install-args').read_text())
        for version in ['1.13.21-obhod.999', 'x;reboot']:
            self.assertFalse(self.rpc('installCore', dict(profile='full', version=version))['ok'])

    def test_sdk_recipe_stages_version_catalog(self):
        recipe = (ROOT/'openwrt/obhod/Makefile').read_text().split('define Package/obhod/install\n', 1)[1].split('endef', 1)[0]
        stage = self.lab/'sdk-package'
        makefile = self.lab/'sdk.mk'
        makefile.write_text('INSTALL_DIR=install -d\nINSTALL_BIN=install -m755\nINSTALL_CONF=install -m600\nINSTALL_DATA=install -m644\nall:\n'+recipe.replace('$(1)', str(stage)))
        r = subprocess.run(['make', '-f', str(makefile), '-C', str(ROOT/'openwrt/obhod')], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((stage/'usr/share/obhod/core-catalog.json').read_bytes(), (BASE/'usr/share/obhod/core-catalog.json').read_bytes())

    def test_update_job_missing_pid_recovery(self):
        for kind in ['update', 'job']:
            lock = self.lab / f'var/lock/obhod-{kind}.lock'
            lock.mkdir()
            (self.lab/'var/lock/obhod-apply.lock').mkdir()
            (lock/'started').write_text('1\n')
            self.assertFalse(self.rpc('status')[kind+'Busy'])
            self.assertEqual((self.lab/f'var/run/obhod/{kind}-state').read_text().strip(), 'error')
            self.assertFalse((self.lab/'var/lock/obhod-apply.lock').exists())

    def test_procd_rejection_and_missing_launch_for_job_and_update(self):
        self.write('bin/ubus', '#!/bin/sh\n[ ! -f /tmp/reject-procd ] || exit 1\nprintf "%s" "$4" > /tmp/procd-command.json\necho "{}"\n')
        for kind, action in [('job','diagnostics'), ('update','check')]:
            self.write('tmp/reject-procd', '')
            r = self.run_in('/usr/libexec/obhod/'+kind, 'start', action)
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse((self.lab/'var/lock/obhod-apply.lock').exists())
            self.assertEqual((self.lab/f'var/run/obhod/{kind}-state').read_text().strip(), 'error')
            (self.lab/'tmp/reject-procd').unlink()
            r = self.run_in('/usr/libexec/obhod/'+kind, 'start', action)
            self.assertEqual(r.returncode, 0, r.stderr)
            launch = json.loads((self.lab/'tmp/procd-command.json').read_text())
            command = next(iter(launch['instances'].values()))['command']
            self.assertTrue(self.rpc('status')[kind+'Busy'])
            lock = self.lab/f'var/lock/obhod-{kind}.lock'
            (lock/'started').write_text('1\n')
            self.assertFalse(self.rpc('status')[kind+'Busy'])
            self.assertFalse((self.lab/'var/lock/obhod-apply.lock').exists())
            self.assertNotEqual(self.run_in(*command).returncode, 0, 'Late procd command must not resurrect a recovered task')
            if kind == 'update': self.assertFalse((self.lab/command[0].lstrip('/')).exists(), 'Orphan snapshot must be cleaned up')

    def test_legacy_failover_dns_is_migrated_only_in_ram(self):
        for failover, custom, expected in [(True, False, '8.8.8.8'), (False, False, '10.8.0.1'), (True, True, '10.8.0.1')]:
            state = {'profile': {'routing': {'failoverEnabled':failover, 'dnsResolverEnabled':custom}, 'tunnels':[]},
                     'config': {'dns':{'servers':[{'tag':'proxy-dns','type':'udp','server':'10.8.0.1','detour':'proxy'},
                                                 {'tag':'fake-dns','type':'fakeip'}]}, 'route':{'rules':[]}}}
            saved = self.write('etc/obhod/settings.json', json.dumps(state)).read_bytes()
            self.write('var/run/obhod/controller-secret', '11111111-2222-4333-8444-555555555555')
            r = self.run_in('/usr/bin/ucode', '/usr/libexec/obhod/prepare.uc')
            self.assertEqual(r.returncode, 0, r.stderr)
            prepared = json.loads((self.lab/'var/run/obhod/config.json').read_text())
            self.assertEqual(prepared['dns']['servers'][0]['server'], expected)
            self.assertEqual(prepared['dns']['servers'][0]['type'], 'tcp' if failover and not custom else 'udp')
            self.assertEqual((self.lab/'etc/obhod/settings.json').read_bytes(), saved)

    def test_identical_apply_skips_core_check(self):
        state = {'version':1, 'profile':{'version':6}, 'config':{'route':{'final':'direct'}}}
        self.write('etc/obhod/settings.json', json.dumps(state))
        self.write('var/run/obhod/ready', '')
        self.write('var/run/obhod/run-pid', str(os.getpid()))
        self.run_in('/sbin/uci', 'set', 'obhod.main.enabled=1')
        self.run_in('/sbin/uci', 'commit', 'obhod')
        self.write('usr/bin/sing-box', '#!/bin/sh\necho check >> /tmp/check-calls\nexit 1\n')
        self.write('usr/libexec/obhod/control', '#!/bin/sh\necho control >> /tmp/control-calls\nexit 1\n')
        self.write('bin/mktemp', '#!/bin/sh\ncase "$1" in /etc/*) echo flash >> /tmp/flash-staging;; esac\nexec /bin/busybox mktemp "$@"\n')
        r = self.run_in('/bin/sh', '-c', 'sha256sum /etc/obhod/settings.json /usr/bin/sing-box /usr/libexec/obhod/* /usr/share/obhod/version /etc/init.d/obhod > /var/run/obhod/prepared.sha')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(self.rpc('apply', {'settings':json.dumps(state, indent=2), 'start':True})['ok'])
        self.assertFalse((self.lab/'tmp/check-calls').exists())
        self.assertFalse((self.lab/'tmp/control-calls').exists())
        self.assertFalse((self.lab/'tmp/flash-staging').exists(), 'Unchanged saves must not even stage a temporary profile on flash')
        original = (self.lab/'etc/obhod/settings.json').stat().st_mtime_ns
        state['profile']['name'] = 'changed'
        self.assertFalse(self.rpc('apply', {'settings':json.dumps(state), 'start':True})['ok'])
        self.assertEqual((self.lab/'tmp/check-calls').read_text().count('check'), 1)
        self.assertEqual((self.lab/'etc/obhod/settings.json').stat().st_mtime_ns, original)
        del state['profile']['name']
        for path in ['usr/libexec/obhod/prepare.uc', 'usr/bin/sing-box', 'usr/share/obhod/version']:
            source = self.lab/path; saved = source.read_bytes()
            source.write_bytes(saved + b'\n# changed app/core source\n')
            self.assertFalse(self.rpc('apply', {'settings':json.dumps(state), 'start':True})['ok'])
            source.write_bytes(saved)
        self.assertEqual((self.lab/'tmp/check-calls').read_text().count('check'), 4)

    def test_dns_commit_cooperates_with_uci_lock(self):
        initial = "config dnsmasq 'main'\n option noresolv '0'\n list server '9.9.9.9'\n option domain 'lan'\n"
        dhcp = self.write('etc/config/dhcp', initial)
        self.write('etc/init.d/dnsmasq', '#!/bin/sh\necho restart >> /tmp/dns-restarts\n')
        with dhcp.open('r+') as foreign:
            fcntl.flock(foreign, fcntl.LOCK_EX)
            p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'apply'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                # Wait until the transaction actually reaches its commit step.
                deadline = time.monotonic() + 2
                while not (self.lab/'etc/obhod/dns-backup.json').exists() and p.poll() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertIsNone(p.poll(), 'DNS transaction ignored libuci file lock')
                try:
                    p.communicate(timeout=.1)
                    self.fail('DNS replacement completed while a UCI writer held the file lock')
                except subprocess.TimeoutExpired:
                    pass
                foreign.seek(0)
                foreign.write(initial.replace("'lan'", "'foreign.example'"))
                foreign.truncate(); foreign.flush()
                fcntl.flock(foreign, fcntl.LOCK_UN)
                out, err = p.communicate(timeout=3)
                self.assertNotEqual(p.returncode, 0, (out, err))
                self.assertIn('foreign.example', dhcp.read_text())
                self.assertNotIn('127.0.0.1#1053', dhcp.read_text())
            finally:
                if p.poll() is None: p.kill(); p.communicate()

    def test_concurrent_native_uci_commits_keep_foreign_changes(self):
        initial = "config dnsmasq 'main'\n option noresolv '0'\n list server '9.9.9.9'\n option domain 'lan'\n"
        dhcp = self.write('etc/config/dhcp', initial)
        self.write('etc/init.d/dnsmasq', '#!/bin/sh\nexit 0\n')
        for i in range(24):
            dhcp.write_text(initial)
            writer = subprocess.Popen(['chroot', str(self.lab), '/bin/sh', '-c', f'uci set dhcp.main.domain=foreign{i}.example && uci commit dhcp'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            operation = self.run_in('/usr/libexec/obhod/dns', 'apply')
            out, err = writer.communicate(timeout=3)
            self.assertEqual(writer.returncode, 0, (out, err))
            self.assertIn(f'foreign{i}.example', dhcp.read_text(), operation.stderr)
            restored = self.run_in('/usr/libexec/obhod/dns', 'restore')
            self.assertEqual(restored.returncode, 0, restored.stderr)
            self.assertIn(f'foreign{i}.example', dhcp.read_text())
            self.assertNotIn('127.0.0.1#1053', dhcp.read_text())

    def test_dns_restore_preserves_foreign_cache_setting(self):
        dhcp = self.write('etc/config/dhcp', "config dnsmasq 'main'\n option noresolv '0'\n list server '9.9.9.9'\n option cachesize '150'\n")
        dhcp.chmod(0o640); os.chown(dhcp, 1234, 1234)
        self.write('etc/init.d/dnsmasq', '#!/bin/sh\necho restart >> /tmp/dns-restarts\n')
        r = self.run_in('/usr/libexec/obhod/dns', 'apply')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((dhcp.stat().st_uid, dhcp.stat().st_gid, dhcp.stat().st_mode & 0o777), (1234, 1234, 0o640))
        self.assertEqual(self.run_in('/usr/libexec/obhod/dns', 'apply').returncode, 0)
        self.assertEqual((self.lab/'tmp/dns-restarts').read_text().count('restart'), 1)
        self.run_in('/sbin/uci', 'set', 'dhcp.main.cachesize=250')
        self.run_in('/sbin/uci', 'commit', 'dhcp')
        r = self.run_in('/usr/libexec/obhod/dns', 'restore')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('127.0.0.1#1053', dhcp.read_text())
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.cachesize').stdout.strip(), '250')

    def test_dns_restore_preserves_added_server_and_changed_noresolv(self):
        self.write('etc/config/dhcp', "config dnsmasq 'main'\n option noresolv '0'\n list server '9.9.9.9'\n")
        self.write('etc/init.d/dnsmasq', '#!/bin/sh\nexit 0\n')
        self.assertEqual(self.run_in('/usr/libexec/obhod/dns', 'apply').returncode, 0)
        self.run_in('/sbin/uci', 'add_list', 'dhcp.main.server=8.8.8.8')
        self.run_in('/sbin/uci', 'set', 'dhcp.main.noresolv=0')
        self.run_in('/sbin/uci', 'commit', 'dhcp')
        r = self.run_in('/usr/libexec/obhod/dns', 'restore')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '9.9.9.9 8.8.8.8')
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.noresolv').stdout.strip(), '0')

    def test_failed_dns_restore_does_not_stop_live_listener(self):
        self.write('usr/libexec/obhod/dns', '#!/bin/sh\nexit 1\n')
        self.write('etc/init.d/obhod', '#!/bin/sh\necho stop >> /tmp/stopped-core\nrm -f /var/run/obhod/ready\n')
        self.write('var/run/obhod/ready', '')
        self.run_in('/sbin/uci', 'set', 'obhod.main.enabled=1')
        self.run_in('/sbin/uci', 'commit', 'obhod')
        r = self.run_in('/usr/libexec/obhod/control', 'stop')
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.lab/'tmp/stopped-core').exists(), 'Keep the listener alive if DNS could not be restored')
        self.assertTrue((self.lab/'var/run/obhod/ready').exists())
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'obhod.main.enabled').stdout.strip(), '1')

    def test_passive_monitor_and_explicit_diagnosis(self):
        self.write('var/run/obhod/ready', '')
        self.write('var/run/obhod/controller-secret', '11111111-2222-4333-8444-555555555555')
        self.write('etc/obhod/settings.json', json.dumps({'profile': {'routing': {'activeTunnelId': 'a', 'failoverEnabled': True}, 'tunnels': [{'id': 'b', 'name': 'B'}]}}))
        self.write('tmp/proxies', json.dumps({'proxies': {'proxy': {'now': 'tunnel-b'}, 'tunnel-b': {'history': [{'time':'2026-01-01T00:00:00Z', 'delay': 83}]}}}))
        self.write('bin/uclient-fetch', '''#!/bin/sh
while [ "$#" -gt 0 ]; do
 case "$1" in -O) output=$2; shift;; http:*) url=$1;; esac
 shift
done
echo "$url" >> /tmp/http-calls
case "$url" in */delay\?*) echo '{"delay":42}' > "$output";; *) cp /tmp/proxies "$output";; esac
''')
        for _ in range(4):
            r = self.run_in('/usr/libexec/obhod/monitor', 'once')
            self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('/delay?', (self.lab/'tmp/http-calls').read_text())
        telemetry = json.loads((self.lab/'var/run/obhod/telemetry.json').read_text())
        self.assertEqual(telemetry['delay'], 83)
        self.assertTrue(telemetry['ok'])
        self.assertEqual(telemetry['name'], 'B')
        self.assertEqual(self.run_in('/usr/libexec/obhod/monitor', 'diagnose').returncode, 0)
        self.assertEqual((self.lab/'tmp/http-calls').read_text().count('/delay?'), 1)
        self.write('tmp/proxies', json.dumps({'proxies': {'proxy': {'now':'tunnel-b'}, 'tunnel-b': {'history':[]}}}))
        self.run_in('/usr/libexec/obhod/monitor', 'once')
        telemetry = json.loads((self.lab/'var/run/obhod/telemetry.json').read_text())
        self.assertIsNone(telemetry['delay'])
        self.assertTrue(telemetry['ok'], 'No latency sample is not a failed connection')
        # Fixed mode has no built-in urltest. Preserve the previous single
        # periodic probe rather than silently losing failure detection there.
        self.write('etc/obhod/settings.json', json.dumps({'profile': {'routing': {'activeTunnelId':'b', 'failoverEnabled':False}, 'tunnels':[{'id':'b','name':'B'}]}}))
        self.run_in('/usr/libexec/obhod/monitor', 'once')
        self.assertEqual((self.lab/'tmp/http-calls').read_text().count('/delay?'), 2)


if __name__ == '__main__':
    if '--opkg' in __import__('sys').argv:
        __import__('sys').argv.remove('--opkg')
        Audit.manager = 'opkg'
    unittest.main(verbosity=2)
