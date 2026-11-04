#!/usr/bin/env python3
"""Persistent core configuration recovery using actual OpenWrt 24.10 ucode."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('audit',Path(__file__).with_name('test-openwrt-audit.py'))
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)


class Recovery(audit.Audit):
    manager='opkg'

    def fixture(self):
        self.path=self.lab/'etc/sing-box/config.json';self.path.parent.mkdir(exist_ok=True)
        self.path.write_text('package-default\n');self.path.chmod(0o644)
        self.original='original-user-secret\n'
        self.backup=self.lab/'etc/obhod/core-package-backup.json'
        self.state={'schema':1,'files':[{'path':'/etc/sing-box/config.json','before':self.original,
            'incoming':'package-default\n','mode':0o640,'uid':123,'gid':456}]}
        self.backup.write_text(json.dumps(self.state));self.backup.chmod(0o600)

    def recover(self):return self.run_in('ucode','/usr/libexec/obhod/core-opkg.uc','recover')

    def test_persistent_recovery_restores_bytes_modes_owner_and_is_idempotent(self):
        self.fixture()
        self.assertEqual(self.recover().returncode,0)
        self.assertEqual(self.path.read_text(),self.original)
        info=self.path.stat();self.assertEqual((info.st_mode&0o777,info.st_uid,info.st_gid),(0o640,123,456))
        self.assertFalse(self.backup.exists())
        self.assertEqual(self.recover().returncode,0)

    def test_external_edit_is_preserved_and_backup_retained(self):
        self.fixture();self.path.write_text('newer external user edit\n')
        before=self.backup.read_bytes()
        self.assertNotEqual(self.recover().returncode,0)
        self.assertEqual(self.path.read_text(),'newer external user edit\n')
        self.assertEqual(self.backup.read_bytes(),before)

    def test_unknown_path_is_rejected_without_any_restore(self):
        self.fixture();self.state['files'][0]['path']='/etc/config/dhcp'
        self.backup.write_text(json.dumps(self.state));before=(self.lab/'etc/config/dhcp').read_bytes()
        self.assertNotEqual(self.recover().returncode,0)
        self.assertEqual((self.lab/'etc/config/dhcp').read_bytes(),before)
        self.assertTrue(self.backup.exists())

    def test_live_guard_excludes_recovery(self):
        self.fixture()
        with (self.lab/'var/lock/obhod-core-config.guard').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertNotEqual(self.recover().returncode,0)
            self.assertEqual(self.path.read_text(),'package-default\n')
        self.assertEqual(self.recover().returncode,0)

    def test_missing_file_and_directory_restore_without_deleting_extra_files(self):
        self.fixture();self.path.unlink();self.path.parent.rmdir()
        self.assertEqual(self.recover().returncode,0)
        self.assertEqual(self.path.read_text(),self.original)


if __name__=='__main__':
    # Inherited audit cases are run by test-openwrt-residual.py on both userspaces.
    names=[name for name in Recovery.__dict__ if name.startswith('test_')]
    result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(Recovery(name) for name in names))
    raise SystemExit(not result.wasSuccessful())
