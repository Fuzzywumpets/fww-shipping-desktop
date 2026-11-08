'use strict';

// Enforces the SYNC note above installMain() in main.js: every error-sink `repo` label must
// equal package.json build.publish owner/repo. The publish block is also what electron-builder
// compiles into installed clients' app-update.yml, so it has to name the repo's real owner,
// not the fuzzyalex84 transfer redirect.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

test('build.publish targets the Fuzzywumpets org repo', () => {
  const pub = pkg.build.publish;
  assert.equal(pub.provider, 'github');
  assert.equal(pub.owner, 'Fuzzywumpets');
  assert.equal(pub.repo, 'fww-shipping-desktop');
});

test("main.js error-sink repo labels match build.publish (SYNC)", () => {
  const expected = `${pkg.build.publish.owner}/${pkg.build.publish.repo}`;
  const labels = [...mainJs.matchAll(/\brepo:\s*'([^']+)'/g)].map(m => m[1]);
  assert.ok(labels.length >= 2, `expected the installMain and reportEvent labels, found ${labels.length}`);
  for (const l of labels) assert.equal(l, expected);
});
