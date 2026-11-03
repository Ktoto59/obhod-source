#!/usr/bin/env python3
"""Residual audit regressions, real UCI/ucode in the existing disposable lab."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('test-openwrt-audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
audit.BASE = Path(os.environ.get('OBHOD_TEST_BASE', audit.BASE))


class Residual(audit.Audit):
    # Run inherited regressions too, on both supported userspaces.
    def dns_fixture(self):
        self.write('etc/config/dhcp', "config dnsmasq 'main'\n option noresolv '0'\n list server '9.9.9.9'\n option cachesize '150'\n")
        self.write('etc/init.d/dnsmasq', '#!/bin/sh\necho restart >> /tmp/dns-restarts\n[ ! -f /tmp/fail-restart ]\n')

    def dns(self, action, ok=True):
        r = self.run_in('/usr/libexec/obhod/dns', action)
        self.assertEqual(r.returncode == 0, ok, (r.stdout, r.stderr))
        return r

    def uci_commit(self, *commands):
        for args in commands:
            r = self.run_in('/sbin/uci', *args)
            self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.run_in('/sbin/uci', 'commit', 'dhcp').returncode, 0)

    def barrier(self, path, prefix, body):
        os.mkfifo(self.lab/f'tmp/{prefix}-gate')
        fd = os.open(self.lab/f'tmp/{prefix}-gate', os.O_RDWR)
        self.addCleanup(os.close, fd)
        guard = 'case "$*" in *obhod-update.residual*) ;; *) exec /bin/busybox rm "$@";; esac\n' if path == 'bin/rm' else ''
        self.write(path, f'#!/bin/sh\n{guard}echo ready > /tmp/{prefix}-ready\nread go < /tmp/{prefix}-gate\n' + body)
        return fd

    def wait_ready(self, prefix, process):
        deadline = time.monotonic() + 5
        while not (self.lab/f'tmp/{prefix}-ready').exists():
            self.assertIsNone(process.poll(), 'Worker exited before synchronization point')
            self.assertLess(time.monotonic(), deadline, 'Barrier was not reached')
            time.sleep(.005)  # Only await publication; the FIFO controls the race.

    def dns_barrier(self):
        real = self.lab/'usr/libexec/obhod/dns-commit.uc'
        real.rename(real.with_name('dns-commit-real.uc'))
        # ucode invokes this shim, which blocks before the real commit helper.
        fd = self.barrier('tmp/commit-runner', 'commit', 'exec ucode /usr/libexec/obhod/dns-commit-real.uc "$@"\n')
        self.write('usr/libexec/obhod/dns-commit.uc', "exit(system(['/tmp/commit-runner', ...ARGV]) == 0 ? 0 : 1);\n")
        return fd

    def test_rejected_dns_server_commit_allows_retry(self):
        for field in ['server', 'noresolv']:
            with self.subTest(field=field):
                self.dns_fixture()
                fd = self.dns_barrier()
                p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'apply'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.wait_ready('commit', p)
                    args = ('add_list', 'dhcp.main.server=8.8.8.8') if field == 'server' else ('set', 'dhcp.main.noresolv=1')
                    self.uci_commit(args)
                    os.write(fd, b'go\n')
                    out, err = p.communicate(timeout=5)
                    self.assertNotEqual(p.returncode, 0, (out, err))
                finally:
                    if p.poll() is None: p.kill(); p.communicate()
                (self.lab/'usr/libexec/obhod/dns-commit-real.uc').replace(self.lab/'usr/libexec/obhod/dns-commit.uc')
                (self.lab/'tmp/commit-ready').unlink()
                (self.lab/'tmp/commit-gate').unlink()
                original = (self.lab/'etc/config/dhcp').read_bytes()
                self.dns('restore')
                self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(), original)
                self.dns('apply'); self.dns('apply'); self.dns('restore'); self.dns('restore')
                self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '9.9.9.9 8.8.8.8' if field == 'server' else '9.9.9.9')

    def test_rejected_commit_allows_direct_apply_without_restore(self):
        self.dns_fixture()
        fd = self.dns_barrier()
        p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'apply'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.wait_ready('commit', p)
            self.uci_commit(('add_list', 'dhcp.main.server=8.8.8.8'))
            os.write(fd, b'go\n'); p.communicate(timeout=5)
            self.assertNotEqual(p.returncode, 0)
        finally:
            if p.poll() is None: p.kill(); p.communicate()
        (self.lab/'usr/libexec/obhod/dns-commit-real.uc').replace(self.lab/'usr/libexec/obhod/dns-commit.uc')
        self.dns('apply'); self.dns('restore')
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '9.9.9.9 8.8.8.8')

    def test_prepared_backup_cannot_claim_foreign_listener_upstream(self):
        self.dns_fixture(); fd = self.dns_barrier()
        p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'apply'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.wait_ready('commit', p)
            self.uci_commit(('set','dhcp.main.server=127.0.0.1#1053'),
                            ('set','dhcp.main.noresolv=1'), ('set','dhcp.main.cachesize=0'))
            os.write(fd,b'go\n'); p.communicate(timeout=5)
            self.assertNotEqual(p.returncode, 0)
        finally:
            if p.poll() is None: p.kill(); p.communicate()
        before = (self.lab/'etc/config/dhcp').read_bytes()
        backup = (self.lab/'etc/obhod/dns-backup.json').read_bytes()
        self.dns('apply', False); self.dns('restore', False)
        self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(), before)
        self.assertEqual((self.lab/'etc/obhod/dns-backup.json').read_bytes(), backup)

    def test_kill_before_commit_and_dns_lock_recovery(self):
        self.dns_fixture(); self.dns_barrier()
        p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'apply'], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.wait_ready('commit', p)
            # The whole abandoned transaction dies. Real inherited flock FDs,
            # rather than a timing assumption, determine when the retry can run.
            os.killpg(p.pid, signal.SIGKILL); p.communicate(timeout=5)
        finally:
            if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.communicate()
        (self.lab/'usr/libexec/obhod/dns-commit-real.uc').replace(self.lab/'usr/libexec/obhod/dns-commit.uc')
        self.uci_commit(('set', 'dhcp.main.server=8.8.8.8'))
        self.dns('apply'); self.dns('restore')
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '8.8.8.8')

    def test_kill_after_journal_before_or_after_dns_rename(self):
        for after in [False, True]:
            with self.subTest(after_rename=after):
                self.dns_fixture()
                helper = self.lab/'usr/libexec/obhod/dns-commit.uc'
                original = helper.read_text()
                needle = "if (!rename(temporary, path)) {"
                if after:
                    instrumented = original + "\nsystem('/tmp/intent-runner');\n"
                else:
                    self.assertIn(needle, original)
                    instrumented = original.replace(needle, "system('/tmp/intent-runner');\n" + needle)
                self.barrier('tmp/intent-runner', 'intent', 'exit 0\n')
                helper.write_text(instrumented)
                p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'apply'], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.wait_ready('intent', p)
                    os.killpg(p.pid, signal.SIGKILL); p.communicate(timeout=5)
                finally:
                    if p.poll() is None: os.killpg(p.pid, signal.SIGKILL); p.communicate()
                    helper.write_text(original)
                self.dns('restore'); self.dns('restore'); self.dns('apply'); self.dns('restore')
                self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '9.9.9.9')
                (self.lab/'tmp/intent-ready').unlink(); (self.lab/'tmp/intent-gate').unlink()

    def test_ambiguous_and_legacy_backups_preserve_foreign_dns(self):
        self.dns_fixture(); self.dns('apply')
        self.uci_commit(('set', 'dhcp.main.server=8.8.8.8'))
        backup = self.lab/'etc/obhod/dns-backup.json'
        for phase in ['applied', 'applying', 'legacy']:
            with self.subTest(phase=phase):
                state = json.loads(backup.read_text())
                if phase == 'legacy': state.pop('phase', None)
                else: state['phase'] = phase
                backup.write_text(json.dumps(state))
                before = (self.lab/'etc/config/dhcp').read_bytes()
                saved = backup.read_bytes()
                self.dns('restore', False); self.dns('apply', False)
                self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(), before)
                self.assertEqual(backup.read_bytes(), saved)

    def test_dns_file_and_restart_failures_keep_original_settings(self):
        for failure in ['backup', 'staging', 'journal', 'rename', 'restart', 'remove']:
            with self.subTest(failure=failure):
                self.dns_fixture()
                helper = self.lab/'usr/libexec/obhod/dns-commit.uc'
                original = helper.read_text()
                if failure == 'backup':
                    (self.lab/'etc/obhod/dns-backup.json.tmp').mkdir()
                elif failure == 'staging':
                    self.write('bin/mktemp', '#!/bin/sh\ncase "$1" in /etc/config/*) exit 1;; esac\nexec /bin/busybox mktemp "$@"\n')
                elif failure == 'journal':
                    helper.write_text(original.replace("let journal =", "die('Injected journal failure');\nlet journal ="))
                elif failure == 'rename':
                    helper.write_text(original.replace('if (!rename(temporary, path))', 'if (true)'))
                elif failure == 'restart': self.write('tmp/fail-restart', '')
                if failure != 'remove': self.dns('apply', False)
                else:
                    self.dns('apply')
                    self.write('bin/rm', '#!/bin/sh\nfor arg in "$@"; do [ "$arg" != /etc/obhod/dns-backup.json ] || exit 1; done\nexec /bin/busybox rm "$@"\n')
                    self.dns('restore', False)
                helper.write_text(original)
                for name in ['mktemp', 'rm']:
                    path = self.lab/'bin'/name
                    path.unlink(missing_ok=True); path.symlink_to('busybox')
                (self.lab/'tmp/fail-restart').unlink(missing_ok=True)
                pending = self.lab/'etc/obhod/dns-backup.json.tmp'
                if pending.is_dir(): pending.rmdir()
                self.dns('restore'); self.dns('apply'); self.dns('restore')
                self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '9.9.9.9')
                self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.cachesize').stdout.strip(), '150')

    def test_partial_restore_with_foreign_upstream_can_retry(self):
        self.dns_fixture(); self.dns('apply')
        self.uci_commit(('add_list', 'dhcp.main.server=8.8.8.8'))
        self.write('tmp/fail-restart', '')
        self.dns('restore', False)
        restored = (self.lab/'etc/config/dhcp').read_bytes()
        self.assertIn(b'8.8.8.8', restored)
        (self.lab/'tmp/fail-restart').unlink()
        self.dns('restore'); self.dns('restore')
        self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(), restored)
        self.assertFalse((self.lab/'etc/obhod/dns-backup.json').exists())

    def test_restore_commit_conflict_keeps_new_upstreams_and_can_retry(self):
        self.dns_fixture(); self.dns('apply')
        fd = self.dns_barrier()
        p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/dns', 'restore'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.wait_ready('commit', p)
            self.uci_commit(('add_list','dhcp.main.server=8.8.8.8'), ('set','dhcp.main.cachesize=250'))
            changed = (self.lab/'etc/config/dhcp').read_bytes()
            os.write(fd, b'go\n'); p.communicate(timeout=5)
            self.assertNotEqual(p.returncode, 0)
            self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(), changed)
        finally:
            if p.poll() is None: p.kill(); p.communicate()
        (self.lab/'usr/libexec/obhod/dns-commit-real.uc').replace(self.lab/'usr/libexec/obhod/dns-commit.uc')
        self.dns('restore'); self.dns('restore')
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '9.9.9.9 8.8.8.8')
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.cachesize').stdout.strip(), '250')

    def update_worker(self, reload=False):
        token = self.acquire('update')
        work = 'tmp/obhod-update.residual'
        for name in ['update', 'operation.uc', 'package-lib.sh']:
            content = (audit.BASE/'usr/libexec/obhod'/name).read_text()
            if name == 'update' and reload:
                content = content.replace('reload=0', 'reload=1')  # Reach finalization without modifying packages.
            self.write(work + '/' + ('worker' if name == 'update' else name), content)
        self.write(work+'/update-metadata.uc', 'print(\'{"available":false,"version":"0.1.18"}\');\n')
        self.write('bin/uclient-fetch', '#!/bin/sh\nexit 0\n')
        (self.lab/'var/lock/obhod-update.lock/work').write_text('/'+work+'\n')
        p = subprocess.Popen(['chroot', str(self.lab), '/'+work+'/worker', 'worker', 'check', token], start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def cleanup():
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.communicate(timeout=5)
        self.addCleanup(cleanup)
        return p, token

    def test_update_cleanup_excludes_new_update_and_apply(self):
        fd = self.barrier('bin/rm', 'cleanup', 'exec /bin/busybox rm "$@"\n')
        p, token = self.update_worker()
        self.wait_ready('cleanup', p)
        for kind in ['update', 'apply']:
            self.assertNotEqual(self.op('acquire', kind, '', os.getpid()).returncode, 0, kind+' overlapped cleanup')
        os.write(fd, b'go\n'); p.communicate(timeout=5)
        self.assertEqual(p.returncode, 0)
        (self.lab/'bin/rm').unlink()
        new = self.acquire('apply')
        self.assertNotEqual(self.op('release', 'update', token, os.getpid()).returncode, 0)
        self.assertEqual(self.op('release', 'apply', new, os.getpid()).returncode, 0)

    def test_update_rpcd_reload_excludes_operations_and_can_read_status(self):
        fd = self.barrier('etc/init.d/rpcd', 'reload', 'ucode /usr/libexec/obhod/operation.uc recover\nexit 1\n')
        p, _ = self.update_worker(reload=True)
        self.wait_ready('reload', p)
        self.assertFalse((self.lab/'tmp/obhod-update.residual').exists())
        for kind in ['update', 'apply']:
            self.assertNotEqual(self.op('acquire', kind, '', os.getpid()).returncode, 0, kind+' overlapped rpcd reload')
        self.assertTrue(self.rpc('status')['updateBusy'])
        os.write(fd, b'go\n'); p.communicate(timeout=5)
        self.assertFalse((self.lab/'var/lock/obhod-update.lock').exists())
        self.assertTrue((self.lab/'var/run/obhod/rpcd-reload-needed').exists())

    def test_update_cleanup_failure_still_releases_own_operation(self):
        self.write('bin/rm', '#!/bin/sh\nexit 1\n')
        p, token = self.update_worker()
        p.communicate(timeout=5)
        self.assertFalse((self.lab/'var/lock/obhod-update.lock').exists())
        self.assertEqual((self.lab/'var/run/obhod/update-state').read_text().strip(), 'error')
        self.assertTrue((self.lab/'tmp/obhod-update.residual').exists())
        new = self.acquire('apply')
        self.assertNotEqual(self.op('release', 'update', token, os.getpid()).returncode, 0)
        self.assertEqual(self.op('release', 'apply', new, os.getpid()).returncode, 0)

    def test_killed_update_keeps_live_cleanup_child_lease(self):
        fd = self.barrier('bin/rm', 'cleanup', '/bin/busybox rm "$@"\necho done > /tmp/cleanup-done\n')
        p, token = self.update_worker()
        self.wait_ready('cleanup', p)
        try:
            p.kill(); p.communicate(timeout=5)
            self.assertTrue(self.rpc('status')['updateBusy'])
            self.assertNotEqual(self.op('acquire', 'apply', '', os.getpid()).returncode, 0)
        finally:
            os.write(fd, b'go\n')
        deadline = time.monotonic()+5
        while not (self.lab/'tmp/cleanup-done').exists():
            self.assertLess(time.monotonic(), deadline); time.sleep(.005)
        path = self.lab/'bin/rm'; path.unlink(); path.symlink_to('busybox')
        while self.rpc('status')['updateBusy']:
            self.assertLess(time.monotonic(), deadline); time.sleep(.005)
        self.assertEqual((self.lab/'var/run/obhod/update-state').read_text().strip(), 'error')
        new = self.acquire('apply')
        self.assertNotEqual(self.op('release', 'update', token, os.getpid()).returncode, 0)
        self.assertEqual(self.op('release', 'apply', new, os.getpid()).returncode, 0)

    def test_history_timestamp_is_measurement_time(self):
        self.write('etc/obhod/settings.json', json.dumps({'profile': {'routing': {'failoverEnabled': True}, 'tunnels': [{'id':'b','name':'B'}]}}))
        stamp = int(time.time()) - 601
        self.write('tmp/proxies', json.dumps({'proxies': {'proxy': {'now':'tunnel-b'}, 'tunnel-b': {'history':[{'time':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(stamp)), 'delay':83}]}}}))
        self.write('tmp/delay', '{"delay":42}')
        def inspect(mode):
            r = self.run_in('ucode', '/usr/libexec/obhod/inspect.uc', 'result', '/tmp/proxies', '/tmp/delay', mode)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout)
        for _ in range(2):
            result = inspect('passive')
            self.assertEqual(result['checkedAt'], stamp)
            self.assertGreater(result['receivedAt'], stamp)
            self.assertIsNone(result['diagnosedAt'])
        result = inspect('diagnose')
        self.assertGreater(result['checkedAt'], stamp)
        self.assertEqual(result['diagnosedAt'], result['checkedAt'])

    def test_history_fresh_stale_absent_offsets_and_server_switch(self):
        settings = {'profile': {'routing': {'failoverEnabled':True, 'failoverInterval':'5m'},
                    'tunnels':[{'id':'a','name':'A'}, {'id':'b','name':'B'}]}}
        self.write('etc/obhod/settings.json', json.dumps(settings))
        self.write('tmp/delay', '{}')
        stamp = int(time.time())
        for age, date, delay in [(10, None, 83), (301, None, 83), (0, 'missing', None),
                                  (10, 'offset', 83), (10, 'invalid', 83), (10, None, 0)]:
            with self.subTest(age=age, date=date, delay=delay):
                value = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(stamp-age+(18000 if date == 'offset' else 0)))
                value += '.123456789+05:00' if date == 'offset' else 'Z'
                if date == 'invalid': value = 'invalid'
                history = [] if date == 'missing' else [{'time':value,'delay':delay}]
                self.write('tmp/proxies', json.dumps({'proxies':{'proxy':{'now':'tunnel-a'}, 'tunnel-a':{'history':history},
                    'tunnel-b':{'history':[{'time':'2026-01-01T00:00:00Z','delay':12}]}}}))
                r = self.run_in('ucode', '/usr/libexec/obhod/inspect.uc', 'result', '/tmp/proxies', '/tmp/delay', 'passive')
                self.assertEqual(r.returncode, 0, r.stderr)
                result = json.loads(r.stdout)
                self.assertEqual(result['name'], 'A')
                self.assertEqual(result['maxAge'], 300)
                self.assertEqual(result['known'], date not in ['missing','invalid'])
                self.assertEqual(result['checkedAt'], None if date in ['missing','invalid'] else stamp-age)
                if date == 'missing': self.assertTrue(result['ok'])
                if delay == 0: self.assertFalse(result['ok'])
                self.write('var/run/obhod/telemetry.json', json.dumps(result))
                status = self.rpc('status')
                self.assertEqual(status['routeKnown'], result['known'])
                self.assertEqual(status['routeMaxAge'], '300')
        data = json.loads((self.lab/'tmp/proxies').read_text()); data['proxies']['proxy']['now'] = 'tunnel-b'
        self.write('tmp/proxies', json.dumps(data))
        r = self.run_in('ucode', '/usr/libexec/obhod/inspect.uc', 'result', '/tmp/proxies', '/tmp/delay', 'passive')
        result = json.loads(r.stdout)
        self.assertEqual((result['name'], result['delay']), ('B',12))
        self.assertLess(result['checkedAt'], stamp-300)

    def test_failed_service_stop_restores_running_dns_and_enabled_intent(self):
        self.dns_fixture(); self.dns('apply')
        self.write('etc/obhod/settings.json', '{"options":{"manageDns":true}}')
        self.write('var/run/obhod/ready', '')
        self.write('var/run/obhod/run-pid', str(os.getpid()))
        self.run_in('/sbin/uci', 'set', 'obhod.main.enabled=1')
        self.run_in('/sbin/uci', 'commit', 'obhod')
        self.write('etc/init.d/obhod', '#!/bin/sh\nexit 1\n')
        result = self.run_in('/usr/libexec/obhod/control', 'stop')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'obhod.main.enabled').stdout.strip(), '1')
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip(), '127.0.0.1#1053')
        self.assertTrue((self.lab/'etc/obhod/dns-backup.json').exists())

    def test_failed_stop_does_not_enable_unmanaged_dns(self):
        self.dns_fixture()
        self.write('etc/obhod/settings.json', '{"options":{"manageDns":false}}')
        self.write('var/run/obhod/ready', '')
        self.write('var/run/obhod/run-pid', str(os.getpid()))
        self.write('etc/init.d/obhod', '#!/bin/sh\nexit 1\n')
        before = (self.lab/'etc/config/dhcp').read_bytes()
        self.assertNotEqual(self.run_in('/usr/libexec/obhod/control','stop').returncode, 0)
        self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(), before)
        self.assertFalse((self.lab/'etc/obhod/dns-backup.json').exists())

    def test_stop_rollback_racing_worker_cleanup_does_not_leave_dead_dns(self):
        self.dns_fixture(); self.dns('apply')
        self.write('etc/obhod/settings.json', '{"options":{"manageDns":true}}')
        self.write('var/run/obhod/ready', '')
        self.write('var/run/obhod/run-pid', str(os.getpid()))
        self.write('etc/init.d/obhod', '#!/bin/sh\nexit 1\n')
        path = self.lab/'usr/libexec/obhod/dns'; path.rename(path.with_name('dns-real'))
        self.write('usr/libexec/obhod/dns', '''#!/bin/sh
if [ "$1" = apply ]; then
 rm -f /var/run/obhod/ready
 /usr/libexec/obhod/dns-real restore || exit 1
fi
exec /usr/libexec/obhod/dns-real "$@"
''')
        self.assertNotEqual(self.run_in('/usr/libexec/obhod/control','stop').returncode, 0)
        self.assertEqual(self.run_in('/sbin/uci','get','dhcp.main.server').stdout.strip(), '9.9.9.9')
        self.assertFalse((self.lab/'etc/obhod/dns-backup.json').exists())

    def test_failed_start_cleanup_does_not_clear_enabled_when_stop_fails(self):
        self.dns_fixture()
        self.write('etc/obhod/settings.json', '{"options":{"manageDns":true}}')
        self.write('etc/init.d/obhod', f'''#!/bin/sh
case "$1" in
 start)
  echo {os.getpid()} > /var/run/obhod/run-pid
  touch /var/run/obhod/ready /tmp/started
  /usr/libexec/obhod/dns apply
  exit 1;;
 stop) [ ! -f /tmp/started ];;
esac
''')
        self.assertNotEqual(self.run_in('/usr/libexec/obhod/control','start').returncode, 0)
        self.assertEqual(self.run_in('/sbin/uci','get','obhod.main.enabled').stdout.strip(), '1')
        self.assertEqual(self.run_in('/sbin/uci','get','dhcp.main.server').stdout.strip(), '127.0.0.1#1053')

    def test_shell_and_ucode_syntax(self):
        for path in (audit.BASE/'usr/libexec').rglob('*'):
            if not path.is_file(): continue
            script = '/' + str(path.relative_to(audit.BASE))
            if path.read_bytes().startswith(b'#!/bin/sh'):
                r = self.run_in('/bin/sh','-n',script)
            elif path.suffix == '.uc' and path.name != 'dns-pool.uc':
                # The optional socket module is installed and exercised by the
                # real pool integration/resource tests, outside this base lab.
                r = self.run_in('ucode','-c','-o','/tmp/syntax.ucb',script)
            else: continue
            self.assertEqual(r.returncode, 0, (script,r.stderr))


if __name__ == '__main__':
    if '--opkg' in __import__('sys').argv:
        __import__('sys').argv.remove('--opkg')
        Residual.manager = 'opkg'
    unittest.main(verbosity=2)
