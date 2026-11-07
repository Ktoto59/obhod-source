#!/usr/bin/env python3
"""DNS handoff regressions using real OpenWrt UCI/ucode in disposable chroots."""
import importlib.util
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('test-openwrt-audit.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class Restart(unittest.TestCase):
    manager = 'apk'
    setUp = audit.Audit.setUp
    run_in = audit.Audit.run_in
    write = audit.Audit.write

    def fixture(self):
        self.write('etc/config/dhcp', "config dnsmasq 'main'\n option noresolv '0'\n list server '192.0.2.53'\n option cachesize '150'\n")
        self.write('etc/config/obhod', "config obhod 'main'\n option enabled '1'\n")
        self.write('etc/obhod/settings.json', '{"options":{"manageDns":true}}')
        self.write('etc/init.d/dnsmasq', '#!/bin/sh\necho restart >> /tmp/dns-restarts\n[ ! -f /tmp/fail-restart ]\n')
        self.addCleanup(self.kill_watcher)

    def kill_watcher(self):
        marker = self.lab/'var/run/obhod/dns-watch'
        if marker.exists():
            try: os.kill(int(marker.read_text().split()[1]), signal.SIGKILL)
            except ProcessLookupError: pass

    def dns(self, *args, code=0):
        r = self.run_in('/usr/libexec/obhod/dns', *args)
        self.assertEqual(r.returncode, code, (args, r.stdout, r.stderr))
        return r

    def server(self):
        return self.run_in('/sbin/uci', 'get', 'dhcp.main.server').stdout.strip()

    def wait(self, condition, seconds=8):
        deadline = time.monotonic() + seconds
        while not condition():
            self.assertLess(time.monotonic(), deadline, 'Timed out waiting for transition')
            time.sleep(.01)

    def spawn_run(self):
        p = subprocess.Popen(['chroot', str(self.lab), '/usr/libexec/obhod/run'],
                             start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def cleanup():
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.communicate(timeout=5)
        self.addCleanup(cleanup)
        self.wait(lambda: (self.lab/'var/run/obhod/ready').exists() or p.poll() is not None)
        self.assertIsNone(p.poll(), p.communicate() if p.poll() is not None else '')
        return p

    def test_control_replacement_keeps_original_backup_and_never_restarts_dnsmasq(self):
        self.fixture(); self.dns('apply')
        backup = (self.lab/'etc/obhod/dns-backup.json').read_bytes()
        self.write('etc/init.d/obhod', '''#!/bin/sh
case "$1" in
 stop)
  [ "$OBHOD_DNS_HANDOFF" = 1 ] || exit 1
  /usr/libexec/obhod/dns restore-unless-held || exit 1
  uci get dhcp.main.server >> /tmp/transitions
  rm -f /var/run/obhod/ready /var/run/obhod/run-pid;;
 start)
  echo $$ > /var/run/obhod/run-pid
  /usr/libexec/obhod/dns ready $$ || exit 1
  uci get dhcp.main.server >> /tmp/transitions;;
esac
''')
        r = self.run_in('/usr/libexec/obhod/control', 'start')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.lab/'tmp/transitions').read_text().splitlines(), ['127.0.0.1#1053'] * 2)
        self.assertEqual((self.lab/'etc/obhod/dns-backup.json').read_bytes(), backup)
        self.assertEqual((self.lab/'tmp/dns-restarts').read_text().splitlines(), ['restart'])
        self.dns('restore')
        self.assertEqual(self.server(), '192.0.2.53')

    def test_failed_restart_retains_enabled_intent_but_initial_start_rolls_back(self):
        self.fixture()
        self.write('etc/init.d/obhod', '#!/bin/sh\n[ "$1" != start ]\n')
        for initial in ['1', '0']:
            self.run_in('/sbin/uci', 'set', 'obhod.main.enabled=' + initial)
            self.run_in('/sbin/uci', 'commit', 'obhod')
            r = self.run_in('/usr/libexec/obhod/control', 'start')
            self.assertNotEqual(r.returncode, 0)
            self.assertEqual(self.run_in('/sbin/uci', 'get', 'obhod.main.enabled').stdout.strip(), initial)
        self.dns('restore')

    def test_worker_exit_and_respawn_keep_dns_then_explicit_stop_restores(self):
        self.fixture()
        self.write('proc/net/tcp', ' 0: 0100007F:041D 00000000:0000 0A \n')
        self.write('usr/bin/sing-box', '#!/bin/sh\nexec sleep 60\n')
        self.write('usr/libexec/obhod/monitor', '#!/bin/sh\nexec sleep 60\n')
        first = self.spawn_run()
        backup = (self.lab/'etc/obhod/dns-backup.json').read_bytes()
        first.terminate(); first.communicate(timeout=5)
        self.assertEqual(self.server(), '127.0.0.1#1053')
        second = self.spawn_run()
        self.assertEqual((self.lab/'etc/obhod/dns-backup.json').read_bytes(), backup)
        self.assertEqual((self.lab/'tmp/dns-restarts').read_text().splitlines(), ['restart'])
        # Explicit init stop restores before terminating the dependent listener.
        self.dns('restore')
        second.terminate(); second.communicate(timeout=5)
        self.assertEqual(self.server(), '192.0.2.53')
        self.assertFalse((self.lab/'etc/obhod/dns-watch').exists())

    def test_killed_worker_stays_closed_while_enabled_and_restores_after_failed_start(self):
        self.fixture(); self.dns('apply')
        # Shorten only the production watchdog's grace in this fixture.
        control = self.lab/'usr/libexec/obhod/control'
        control.write_text(control.read_text().replace('"$missing" -ge 45', '"$missing" -ge 2'))
        self.write('var/run/obhod/ready', '')
        dead = subprocess.Popen(['sleep', '60'])
        self.addCleanup(lambda: dead.poll() is not None or dead.kill())
        self.write('var/run/obhod/run-pid', str(dead.pid))
        self.dns('hold')
        dead.kill(); dead.wait()
        self.wait(lambda: (self.lab/'var/run/obhod/error').exists())
        self.assertEqual(self.server(), '127.0.0.1#1053')
        self.assertTrue((self.lab/'etc/obhod/dns-backup.json').exists())
        self.run_in('/sbin/uci', 'set', 'obhod.main.enabled=0')
        self.run_in('/sbin/uci', 'commit', 'obhod')
        self.wait(lambda: not (self.lab/'etc/obhod/dns-backup.json').exists())
        self.assertEqual(self.server(), '192.0.2.53')
        self.assertFalse((self.lab/'var/run/obhod/dns-watch').exists())

    def test_failed_start_grace_expires_and_retries_failed_dns_reload(self):
        self.fixture(); self.dns('apply'); self.dns('hold')
        token = (self.lab/'var/run/obhod/dns-watch').read_text().split()[0]
        self.dns('restore-unless-held')
        self.assertEqual(self.server(), '127.0.0.1#1053')
        self.run_in('/sbin/uci', 'set', 'obhod.main.enabled=0')
        self.run_in('/sbin/uci', 'commit', 'obhod')
        self.write('tmp/fail-restart', '')
        self.dns('watch-expire', token, code=1)
        self.assertTrue((self.lab/'etc/obhod/dns-backup.json').exists())
        self.assertTrue((self.lab/'var/run/obhod/dns-watch').exists())
        (self.lab/'tmp/fail-restart').unlink()
        self.dns('watch-expire', token)
        self.assertEqual(self.server(), '192.0.2.53')
        self.assertFalse((self.lab/'etc/obhod/dns-backup.json').exists())

    def test_expiry_checks_current_ready_and_rejects_replaced_token(self):
        self.fixture(); self.dns('hold')
        token = (self.lab/'var/run/obhod/dns-watch').read_text().split()[0]
        self.dns('watch-expire', token, code=5)
        self.assertTrue((self.lab/'var/run/obhod/error').exists())
        self.write('var/run/obhod/run-pid', str(os.getpid()))
        self.dns('ready', str(os.getpid()))
        self.assertFalse((self.lab/'var/run/obhod/error').exists())
        self.dns('watch-expire', token)
        self.assertEqual(self.server(), '127.0.0.1#1053')
        self.dns('watch-expire', 'dns-watch.stale', code=4)
        self.assertTrue((self.lab/'etc/obhod/dns-backup.json').exists())
        self.dns('restore')

    def test_dead_watchdog_marker_is_replaced_without_public_fallback(self):
        self.fixture(); self.dns('apply')
        self.write('var/run/obhod/dns-watch', 'dns-watch.stale 2147483647\n')
        self.dns('restore-unless-held')
        self.assertEqual(self.server(), '127.0.0.1#1053')
        self.assertNotIn('dns-watch.stale', (self.lab/'var/run/obhod/dns-watch').read_text())
        self.dns('restore')
        self.assertEqual(self.server(), '192.0.2.53')
        self.assertFalse((self.lab/'var/run/obhod/dns-watch').exists())

    def test_watchdog_drops_all_inherited_operation_and_procd_leases(self):
        self.fixture()
        r = self.run_in('/bin/sh', '-c', '''
exec 9>/var/lock/test-apply 1000>/var/lock/test-procd
flock 9; flock 1000
/usr/libexec/obhod/dns hold
''')
        self.assertEqual(r.returncode, 0, r.stderr)
        for name in ['test-apply', 'test-procd', 'obhod-dns.guard']:
            with (self.lab/'var/lock'/name).open('a') as lease:
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.dns('restore')

    def test_real_rc_common_intercepts_before_procd_lock_and_serializes_restart(self):
        self.fixture()
        # Sourcing production procd.sh would require ubus/PID 1. This fixture
        # records exactly whether rc.common reached that source boundary.
        self.write('lib/functions/procd.sh', 'echo loaded > /tmp/procd-loaded\n')
        (self.lab/'etc/init.d/obhod').chmod(0o755)
        r = self.run_in('/usr/bin/ucode', '/usr/libexec/obhod/operation.uc', 'acquire', 'apply', '', str(os.getpid()))
        self.assertEqual(r.returncode, 0, r.stderr)
        for action in ['start', 'stop', 'restart', 'reload', 'boot', 'shutdown']:
            r = self.run_in('/etc/init.d/obhod', action)
            self.assertNotEqual(r.returncode, 0, action)
            self.assertFalse((self.lab/'tmp/procd-loaded').exists(), action)

    def test_real_rc_common_stop_drains_late_starting_apply_and_watchdog(self):
        self.fixture()
        self.write('proc/net/tcp', ' 0: 0100007F:041D 00000000:0000 0A \n')
        self.write('usr/bin/sing-box', '#!/bin/sh\nexec sleep 60\n')
        self.write('usr/libexec/obhod/monitor', '#!/bin/sh\nexec sleep 60\n')
        first = self.spawn_run()
        (self.lab/'etc/init.d/obhod').chmod(0o755)
        # Exercise actual rc.common stop order. Inject a late ready/apply at
        # the native kill boundary, after stop_service's first restore.
        self.write('lib/functions/procd.sh', '''
procd_lock() { exec 1000>/var/lock/procd_obhod.lock; flock 1000; }
procd_kill() {
 pid=$(cat /var/run/obhod/run-pid)
 /usr/libexec/obhod/dns ready "$pid" || return 1
 kill "$pid"
}
''')
        reaper = threading.Thread(target=first.wait)
        reaper.start()
        r = self.run_in('/etc/init.d/obhod', 'stop')
        reaper.join(timeout=5)
        self.assertEqual(r.returncode, 0, r.stderr)
        first.communicate(timeout=5)
        self.assertEqual(self.server(), '192.0.2.53')
        self.assertFalse((self.lab/'var/run/obhod/dns-watch').exists())
        self.assertFalse((self.lab/'etc/obhod/dns-backup.json').exists())
        self.assertEqual(self.run_in('/sbin/uci', 'get', 'obhod.main.enabled').stdout.strip(), '0')


class RestartOpkg(Restart):
    manager = 'opkg'


if __name__ == '__main__':
    unittest.main(verbosity=2)
