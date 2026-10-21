'use strict';

// SYNC: install-model — enforces the coupling between package.json (which cannot carry comments),
// tools/provision-all-users.ps1 and the README. Per-machine builds put the app in Program Files, so
// electron-updater needs admin and non-admin accounts can never update; per-user builds + the one-time
// Active Setup provisioning give every account the app AND silent, admin-free updates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const script = fs.readFileSync(path.join(root, 'tools', 'provision-all-users.ps1'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('installer is per-user so updates never need admin', () => {
  assert.equal(pkg.build.nsis.perMachine, false);
  assert.equal(pkg.build.nsis.oneClick, true);
});

test('provisioning script matches the package it installs', () => {
  // Per-user install dir is %LOCALAPPDATA%\Programs\<package name>; the Active Setup stub skips accounts
  // that already have it, so the name must match exactly.
  assert.ok(script.includes(`\\Programs\\${pkg.name}\\${pkg.build.productName}.exe`), 'per-user exe path');
  // The script downloads the release asset by artifactName prefix.
  assert.match(pkg.build.win.artifactName, /^FWW-Shipping-Setup-\$\{version\}\.\$\{ext\}$/);
  assert.ok(script.includes("'FWW-Shipping-Setup-*.exe'"), 'release asset pattern');
  assert.ok(script.includes(`'${pkg.build.publish.owner}/${pkg.build.publish.repo}'`), 'release repo');
});

test('provisioning refuses pre-per-user builds and this build qualifies', () => {
  const m = script.match(/\$MinVersion\s*=\s*\[version\]'([\d.]+)'/);
  assert.ok(m, 'MinVersion declared');
  const [a, b, c] = m[1].split('.').map(Number);
  const [x, y, z] = pkg.version.split('.').map(Number);
  assert.ok(x > a || (x === a && (y > b || (y === b && z >= c))), `package ${pkg.version} >= MinVersion ${m[1]}`);
});

test('README documents the per-user model, not the old machine-wide rule', () => {
  assert.match(readme, /Install for every Windows user/);
  assert.doesNotMatch(readme, /Every future build must keep `nsis\.perMachine: true`/);
});
