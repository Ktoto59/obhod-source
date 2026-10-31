const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeInstalledApplications, normalizeRunningApplications } = require('../windows/src/main/application-catalog');

test('normalizes installed desktop and packaged applications', () => {
  const result = normalizeInstalledApplications([
    { name: 'XBOX', path: 'C:\\Program Files\\WindowsApps\\Microsoft.GamingApp\\XboxPcApp.exe' },
    { name: 'XboxPcApp', path: 'c:\\program files\\windowsapps\\microsoft.gamingapp\\XBOXPCAPP.EXE' },
    { name: 'Browser', path: 'D:\\Apps\\browser.exe' },
    { name: 'Obhod', path: 'D:\\Apps\\Obhod.exe' },
    { name: 'Broken', path: 'shell:AppsFolder\\broken' }
  ], 'D:\\Apps\\Obhod.exe');

  assert.deepEqual(result.map((item) => item.name), ['Browser', 'XBOX']);
  assert.equal(result[1].path, 'C:\\Program Files\\WindowsApps\\Microsoft.GamingApp\\XboxPcApp.exe');
  assert.equal(result[1].source, 'installed');
});

test('normalizes, deduplicates and filters running Windows applications', () => {
  const result = normalizeRunningApplications([
    { name: 'Game', path: 'D:\\Games\\game.exe' },
    { name: 'Game helper', path: 'd:\\games\\GAME.EXE' },
    { name: 'Store App', path: 'C:\\Program Files\\WindowsApps\\Vendor.App\\app.exe' },
    { name: 'Explorer', path: 'C:\\Windows\\explorer.exe' },
    { name: 'Obhod', path: 'D:\\Apps\\Obhod.exe' },
    { name: 'Document', path: 'D:\\Files\\readme.txt' },
    { name: 'Relative', path: 'relative.exe' }
  ], 'C:\\Windows', 'D:\\Apps\\Obhod.exe');

  assert.deepEqual(result.map((item) => item.name), ['Game', 'Store App']);
  assert.equal(result[0].path, 'D:\\Games\\game.exe');
  assert.equal(result[0].processCount, 2);
  assert.equal(result[1].processCount, 1);
});

test('accepts a single PowerShell object as a process list', () => {
  const result = normalizeRunningApplications(
    { name: 'Browser', path: 'C:\\Apps\\browser.exe' },
    'C:\\Windows', 'D:\\Apps\\Obhod.exe'
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Browser');
});
