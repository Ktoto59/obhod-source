const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

function normalizeRunningApplications(rows, windowsDirectory = process.env.WINDIR || 'C:\\Windows', currentExecutable = process.execPath) {
  const systemRoot = path.win32.normalize(windowsDirectory).toLowerCase().replace(/\\?$/, '\\');
  const currentPath = path.win32.normalize(currentExecutable || '').toLowerCase();
  const applications = new Map();
  for (const input of Array.isArray(rows) ? rows : (rows ? [rows] : [])) {
    const applicationPath = path.win32.normalize(String(input.path || '').trim());
    const lowerPath = applicationPath.toLowerCase();
    if (!path.win32.isAbsolute(applicationPath) || !lowerPath.endsWith('.exe')) continue;
    if (lowerPath.startsWith(systemRoot) || lowerPath === currentPath) continue;
    const existing = applications.get(lowerPath);
    if (existing) {
      existing.processCount += 1;
      continue;
    }
    applications.set(lowerPath, {
      name: String(input.name || path.win32.basename(applicationPath, '.exe')).trim().slice(0, 80),
      path: applicationPath,
      processCount: 1,
      source: 'running'
    });
  }
  return [...applications.values()].sort((left, right) => left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' }));
}

function normalizeInstalledApplications(rows, currentExecutable = process.execPath) {
  const currentPath = path.win32.normalize(currentExecutable || '').toLowerCase();
  const applications = new Map();
  for (const input of Array.isArray(rows) ? rows : (rows ? [rows] : [])) {
    const applicationPath = path.win32.normalize(String(input.path || '').trim());
    const lowerPath = applicationPath.toLowerCase();
    if (!path.win32.isAbsolute(applicationPath) || !lowerPath.endsWith('.exe') || lowerPath === currentPath) continue;
    const fallbackName = path.win32.basename(applicationPath, '.exe');
    const name = String(input.name || fallbackName).trim().slice(0, 80) || fallbackName;
    const existing = applications.get(lowerPath);
    if (existing) {
      if (existing.name.toLowerCase() === fallbackName.toLowerCase() && name.toLowerCase() !== fallbackName.toLowerCase()) {
        existing.name = name;
      }
      continue;
    }
    applications.set(lowerPath, { name, path: applicationPath, source: 'installed' });
  }
  return [...applications.values()].sort((left, right) => left.name.localeCompare(right.name, 'ru', { sensitivity: 'base' }));
}

async function listRunningApplications(options = {}) {
  if (process.platform !== 'win32') return [];
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Get-Process | ForEach-Object {',
    '  $processPath = $_.Path',
    '  if ($processPath) { [PSCustomObject]@{ name = $_.ProcessName; path = $processPath; pid = $_.Id } }',
    '} | ConvertTo-Json -Compress'
  ].join('\n');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: options.timeout || 8000, maxBuffer: 1024 * 1024
  });
  const text = String(stdout || '').trim();
  if (!text) return [];
  return normalizeRunningApplications(JSON.parse(text), options.windowsDirectory, options.currentExecutable);
}

async function listInstalledApplications(options = {}) {
  if (process.platform !== 'win32') return [];
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$results = [System.Collections.Generic.List[object]]::new()',
    '$packages = @{}',
    'Get-AppxPackage | ForEach-Object { $packages[$_.PackageFamilyName] = $_ }',
    '$shell = New-Object -ComObject Shell.Application',
    "$folder = $shell.Namespace('shell:AppsFolder')",
    'foreach ($item in @($folder.Items())) {',
    '  $itemPath = [string]$item.Path',
    "  if ($itemPath -match '(?i)\\.exe$' -and (Test-Path -LiteralPath $itemPath)) {",
    "    $results.Add([PSCustomObject]@{ name = [string]$item.Name; path = $itemPath; kind = 'desktop' })",
    "  } elseif ($itemPath -like '*!*') {",
    "    $parts = $itemPath.Split('!', 2)",
    '    $package = $packages[$parts[0]]',
    '    if ($package) {',
    '      $manifest = Get-AppxPackageManifest -Package $package',
    '      $application = @($manifest.Package.Applications.Application) | Where-Object { $_.Id -eq $parts[1] } | Select-Object -First 1',
    '      $executable = [string]$application.Executable',
    '      if ($executable) {',
    '        $resolved = Join-Path ([string]$package.InstallLocation) $executable',
    "        if ($resolved -match '(?i)\\.exe$') {",
    "          $results.Add([PSCustomObject]@{ name = [string]$item.Name; path = $resolved; kind = 'packaged' })",
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
    "$appPathRoots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\*')",
    'Get-ItemProperty -Path $appPathRoots | ForEach-Object {',
    "  $resolved = [string]$_.\"(default)\"",
    "  if ($resolved -and (Test-Path -LiteralPath $resolved) -and $resolved -match '(?i)\\.exe$') {",
    "    $results.Add([PSCustomObject]@{ name = [IO.Path]::GetFileNameWithoutExtension($resolved); path = $resolved; kind = 'desktop' })",
    '  }',
    '}',
    '$results | ConvertTo-Json -Compress'
  ].join('\n');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, encoding: 'utf8', timeout: options.timeout || 15000, maxBuffer: 4 * 1024 * 1024
  });
  const text = String(stdout || '').trim();
  if (!text) return [];
  return normalizeInstalledApplications(JSON.parse(text), options.currentExecutable);
}

module.exports = {
  listInstalledApplications,
  listRunningApplications,
  normalizeInstalledApplications,
  normalizeRunningApplications
};
