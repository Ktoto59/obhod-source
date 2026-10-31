'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const requireRuntime = process.argv.includes('--require-runtime');
const failures = [];
function fail(message) { failures.push(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); }

for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'legal/runtime-components.json']) {
  if (!fs.existsSync(path.join(root, file))) fail(`Missing required legal file: ${file}`);
}

const manifest = readJson('legal/runtime-components.json');
for (const component of manifest.components) {
  for (const licenseFile of component.licenseFiles || []) {
    if (!fs.existsSync(path.join(root, licenseFile))) fail(`${component.id}: missing license file ${licenseFile}`);
  }
  if (!component.sourceUrl || !component.sourceUrl.includes(component.revision)) {
    fail(`${component.id}: sourceUrl must contain the pinned revision`);
  }
  if (/GPL/.test(component.licenseExpression)) {
    if (component.kind !== 'external-process') fail(`${component.id}: GPL runtime must remain an external process`);
    if (component.sourceStatus !== 'verified') fail(`${component.id}: corresponding source is not verified`);
    for (const field of ['sourceArchiveUrl', 'releaseSourceName', 'buildInstructions']) {
      if (!component[field]) fail(`${component.id}: missing ${field}`);
    }
  }
  if (!component.binaryPath) continue;
  const binary = path.join(root, component.binaryPath);
  if (!fs.existsSync(binary)) {
    if (requireRuntime) fail(`${component.id}: binary not found at ${component.binaryPath}`);
    else console.log(`${component.id}: source-only checkout; binary checks skipped`);
    continue;
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (hash !== component.sha256) fail(`${component.id}: SHA-256 mismatch (${hash})`);
  const version = spawnSync(binary, ['version'], { encoding: 'utf8' });
  const output = `${version.stdout || ''}\n${version.stderr || ''}`;
  if (version.status !== 0) fail(`${component.id}: unable to read binary version`);
  if (!output.includes(component.version)) fail(`${component.id}: binary version does not match manifest`);
  if (!output.includes(component.revision)) fail(`${component.id}: binary revision does not match manifest`);
}

const lock = readJson('package-lock.json');
const allowed = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Python-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense']);
const queue = Object.keys(lock.packages[''].dependencies || {}).map((name) => `node_modules/${name}`);
const visited = new Set();
while (queue.length) {
  const key = queue.shift();
  if (visited.has(key)) continue;
  visited.add(key);
  const pkg = lock.packages[key];
  if (!pkg) { fail(`package-lock: unable to resolve ${key}`); continue; }
  const licenses = String(pkg.license || '').split(/\s+(?:OR|AND)\s+|[()]/).filter(Boolean);
  if (!licenses.length || licenses.some((license) => !allowed.has(license))) {
    fail(`${key.replace('node_modules/', '')}@${pkg.version}: review license ${pkg.license || '<missing>'}`);
  }
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    let candidate = `${key}/node_modules/${dependency}`;
    if (!lock.packages[candidate]) candidate = `node_modules/${dependency}`;
    queue.push(candidate);
  }
}

if (failures.length) {
  console.error(`Compliance check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`Compliance check passed: ${manifest.components.length} runtime components, ${visited.size} production npm packages.`);
