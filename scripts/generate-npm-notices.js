'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const queue = Object.keys(lock.packages[''].dependencies || {}).map((name) => `node_modules/${name}`);
const visited = new Set();
const packages = [];

while (queue.length) {
  const key = queue.shift();
  if (visited.has(key)) continue;
  visited.add(key);
  const pkg = lock.packages[key];
  if (!pkg) throw new Error(`Unable to resolve ${key}`);
  const packageDirectory = path.join(root, key);
  const licenseName = fs.readdirSync(packageDirectory).find((file) => /^(licen[cs]e|copying)(\..*)?$/i.test(file));
  const licenseText = licenseName
    ? fs.readFileSync(path.join(packageDirectory, licenseName), 'utf8').replace(/\r\n/g, '\n').trim()
    : `License expression: ${pkg.license || 'not declared'}`;
  packages.push({ name: key.split('node_modules/').pop(), version: pkg.version, license: pkg.license, licenseText });
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    let candidate = `${key}/node_modules/${dependency}`;
    if (!lock.packages[candidate]) candidate = `node_modules/${dependency}`;
    queue.push(candidate);
  }
}

packages.sort((a, b) => a.name.localeCompare(b.name));
const separator = '\n\n' + '='.repeat(78) + '\n\n';
const output = [
  'PRODUCTION NPM THIRD-PARTY LICENSES',
  'Generated from package-lock.json and installed package license files.',
  ...packages.map((pkg) => `${pkg.name}@${pkg.version} — ${pkg.license || 'UNKNOWN'}\n\n${pkg.licenseText}`)
].join(separator) + '\n';
const target = path.join(root, 'legal', 'NPM_THIRD_PARTY_LICENSES.txt');

if (process.argv.includes('--check')) {
  if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== output) {
    console.error('legal/NPM_THIRD_PARTY_LICENSES.txt is stale. Run npm run licenses:update.');
    process.exit(1);
  }
  console.log(`NPM notices are current (${packages.length} production packages).`);
} else {
  fs.writeFileSync(target, output, 'utf8');
  console.log(`Updated ${path.relative(root, target)} (${packages.length} production packages).`);
}
