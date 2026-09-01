'use strict';

// Covers the version mapping and every identity rejection path, plus an end-to-end render of
// the real checked-in manifest template. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  MsixIdentityError,
  DEV_PLACEHOLDER_PUBLISHER,
  mapVersionToPackageVersion,
  validatePackageVersion,
  resolveIdentity,
} = require('../tools/msix/msix-identity');
const { generate, assertXmlCommentsValid } = require('../tools/msix/generate-manifest');

const REPO_ROOT = path.resolve(__dirname, '..');
const REAL_PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const DEV_DEFAULTS = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'build', 'msix', 'identity.json'), 'utf8'));

const STORE_ENV = {
  MSIX_IDENTITY_NAME: 'Fuzzywumpets.FWWShipping',
  MSIX_PUBLISHER: 'CN=A1B2C3D4-1234-5678-9ABC-DEF012345678',
  MSIX_PUBLISHER_DISPLAY_NAME: 'Fuzzywumpets',
  MSIX_DISPLAY_NAME: 'FWW Shipping',
};

// ─── version mapping ─────────────────────────────────────────────────────────

test('semver maps to a four-part version with a zero revision', () => {
  assert.strictEqual(mapVersionToPackageVersion('1.0.19'), '1.0.19.0');
  assert.strictEqual(mapVersionToPackageVersion('0.0.0'), '0.0.0.0');
  assert.strictEqual(mapVersionToPackageVersion('65535.65535.65535'), '65535.65535.65535.0');
});

test('the repo current version maps cleanly', () => {
  assert.strictEqual(mapVersionToPackageVersion(REAL_PKG.version), `${REAL_PKG.version}.0`);
});

test('prerelease and build metadata are rejected loudly, never silently dropped', () => {
  for (const bad of ['1.0.19-beta.1', '1.0.19+abc123', '1.0.19-rc1+sha']) {
    assert.throws(() => mapVersionToPackageVersion(bad), MsixIdentityError, `expected reject: ${bad}`);
  }
});

test('malformed versions are rejected', () => {
  for (const bad of ['1.0', '1.0.19.0', '1.0.x', '1.0.01', '', '   ', 'v1.0.19']) {
    assert.throws(() => mapVersionToPackageVersion(bad), MsixIdentityError, `expected reject: ${bad}`);
  }
  assert.throws(() => mapVersionToPackageVersion(undefined), MsixIdentityError);
});

test('a version part above the MSIX 16-bit ceiling is rejected', () => {
  assert.throws(() => mapVersionToPackageVersion('1.0.65536'), MsixIdentityError);
});

test('MSIX_PACKAGE_VERSION override must be four numeric parts', () => {
  assert.strictEqual(validatePackageVersion('1.2.3.4', { requireZeroRevision: false }), '1.2.3.4');
  assert.throws(() => validatePackageVersion('1.2.3', { requireZeroRevision: false }), MsixIdentityError);
  assert.throws(() => validatePackageVersion('1.2.3.70000', { requireZeroRevision: false }), MsixIdentityError);
});

test('a Store build refuses a non-zero revision, a dev build allows it', () => {
  assert.throws(() => validatePackageVersion('1.0.19.5', { requireZeroRevision: true }), MsixIdentityError);
  assert.strictEqual(validatePackageVersion('1.0.19.5', { requireZeroRevision: false }), '1.0.19.5');
});

// ─── identity resolution ─────────────────────────────────────────────────────

test('development defaults resolve without any environment input', () => {
  const t = resolveIdentity({ mode: 'dev', pkg: REAL_PKG, env: {}, defaults: DEV_DEFAULTS });
  assert.strictEqual(t.IDENTITY_NAME, DEV_DEFAULTS.identityName);
  assert.strictEqual(t.PUBLISHER, DEV_PLACEHOLDER_PUBLISHER);
  assert.strictEqual(t.PACKAGE_VERSION, `${REAL_PKG.version}.0`);
});

test('the executable name is derived from build.productName, never hardcoded', () => {
  const t = resolveIdentity({ mode: 'dev', pkg: REAL_PKG, env: {}, defaults: DEV_DEFAULTS });
  assert.strictEqual(t.EXECUTABLE, `${REAL_PKG.build.productName}.exe`);
  assert.strictEqual(t.EXECUTABLE, 'FWW Shipping.exe');

  const renamed = { ...REAL_PKG, build: { ...REAL_PKG.build, productName: 'Renamed App' } };
  const t2 = resolveIdentity({ mode: 'dev', pkg: renamed, env: {}, defaults: DEV_DEFAULTS });
  assert.strictEqual(t2.EXECUTABLE, 'Renamed App.exe');
});

test('environment variables win over identity.json', () => {
  const t = resolveIdentity({ mode: 'store', pkg: REAL_PKG, env: STORE_ENV, defaults: DEV_DEFAULTS });
  assert.strictEqual(t.IDENTITY_NAME, STORE_ENV.MSIX_IDENTITY_NAME);
  assert.strictEqual(t.PUBLISHER, STORE_ENV.MSIX_PUBLISHER);
  assert.strictEqual(t.PUBLISHER_DISPLAY_NAME, STORE_ENV.MSIX_PUBLISHER_DISPLAY_NAME);
  assert.strictEqual(t.DISPLAY_NAME, STORE_ENV.MSIX_DISPLAY_NAME);
});

test('a Store build refuses the development placeholder publisher', () => {
  assert.throws(
    () => resolveIdentity({ mode: 'store', pkg: REAL_PKG, env: {}, defaults: DEV_DEFAULTS }),
    /development placeholder publisher/
  );
});

test('a Store build refuses the development placeholder identity name', () => {
  assert.throws(
    () => resolveIdentity({
      mode: 'store',
      pkg: REAL_PKG,
      env: { ...STORE_ENV, MSIX_IDENTITY_NAME: DEV_DEFAULTS.identityName },
      defaults: DEV_DEFAULTS,
    }),
    /development placeholder identity name/
  );
});

test('a missing identity value names itself instead of rendering as empty', () => {
  assert.throws(
    () => resolveIdentity({ mode: 'dev', pkg: REAL_PKG, env: {}, defaults: {} }),
    /MSIX_IDENTITY_NAME/
  );
});

test('a publisher that is not an X.500 DN is rejected', () => {
  assert.throws(
    () => resolveIdentity({
      mode: 'store', pkg: REAL_PKG, defaults: {},
      env: { ...STORE_ENV, MSIX_PUBLISHER: 'Fuzzywumpets' },
    }),
    /distinguished name/
  );
});

test('an identity name outside the manifest schema character set is rejected', () => {
  for (const bad of ['has space', 'has_underscore', 'ab', '.leadingDot']) {
    assert.throws(
      () => resolveIdentity({
        mode: 'store', pkg: REAL_PKG, defaults: {},
        env: { ...STORE_ENV, MSIX_IDENTITY_NAME: bad },
      }),
      /Identity Name/,
      `expected reject: ${bad}`
    );
  }
});

// ─── manifest rendering ──────────────────────────────────────────────────────

test('the real template renders with no placeholders left and is well-formed enough to pack', (t) => {
  const out = path.join(REPO_ROOT, 'dist', 'msix', 'test-manifest.xml');
  t.after(() => fs.rmSync(out, { force: true }));

  generate({ store: false, out });
  const xml = fs.readFileSync(out, 'utf8');

  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(xml), 'no unresolved {{TOKEN}} may remain');
  assert.match(xml, /EntryPoint="Windows\.FullTrustApplication"/);
  assert.match(xml, /<rescap:Capability Name="runFullTrust" \/>/);
  assert.match(xml, /ProcessorArchitecture="x64"/);
  assert.match(xml, /Executable="FWW Shipping\.exe"/);
  assert.match(xml, new RegExp(`Version="${REAL_PKG.version.replace(/\./g, '\\.')}\\.0"`));

  // The AppContainer prohibition is load-bearing for printer enumeration and silent printing.
  // Comments are stripped first: the template explains at length WHY appContainer is banned,
  // and that prose must not be mistaken for a declaration.
  const declarations = xml.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(
    !/appContainer/.test(declarations),
    'the manifest must never place the app in an AppContainer'
  );
  assert.ok(!/TrustLevel/.test(declarations), 'no uap10:TrustLevel attribute is expected');
});

test('a double dash inside an XML comment is caught before makeappx sees it', () => {
  // Regression: the first draft of the template spelled out an "electron-builder" command
  // line with its flags inside a comment, which made the manifest non-well-formed.
  assert.throws(
    () => assertXmlCommentsValid('<Package><!-- run foo --bar --></Package>'),
    /illegal inside an XML comment/
  );
  assert.doesNotThrow(() => assertXmlCommentsValid('<Package><!-- run foo, bar --></Package>'));
  // A double dash outside a comment is perfectly legal and must not trip the check.
  assert.doesNotThrow(() => assertXmlCommentsValid('<Package Note="a--b" />'));
});

test('identity values containing XML metacharacters are escaped', () => {
  const out = path.join(REPO_ROOT, 'dist', 'msix', 'test-manifest-escape.xml');
  const prev = process.env.MSIX_PUBLISHER_DISPLAY_NAME;
  process.env.MSIX_PUBLISHER_DISPLAY_NAME = 'Fuzzy & Wumpets <Ltd>';
  try {
    generate({ store: false, out });
    const xml = fs.readFileSync(out, 'utf8');
    assert.match(xml, /Fuzzy &amp; Wumpets &lt;Ltd&gt;/);
    assert.ok(!/Fuzzy & Wumpets <Ltd>/.test(xml));
  } finally {
    if (prev === undefined) delete process.env.MSIX_PUBLISHER_DISPLAY_NAME;
    else process.env.MSIX_PUBLISHER_DISPLAY_NAME = prev;
    fs.rmSync(out, { force: true });
  }
});

// ─── assets referenced by the manifest actually exist ────────────────────────

test('every Assets\\ path the manifest references is a committed file', () => {
  const out = path.join(REPO_ROOT, 'dist', 'msix', 'test-manifest-assets.xml');
  try {
    generate({ store: false, out });
    const xml = fs.readFileSync(out, 'utf8');
    const { manifestAssetRefs } = require('../tools/msix/stage-layout');
    const refs = manifestAssetRefs(xml);
    assert.ok(refs.length >= 4, `expected several asset references, got ${refs.length}`);
    for (const ref of refs) {
      // Assets\Foo.png in the package maps to build/msix/assets/Foo.png in the repo — that is
      // exactly the copy stage-layout.js performs.
      const relative = ref.split('\\').slice(1).join(path.sep);
      const file = path.join(REPO_ROOT, 'build', 'msix', 'assets', relative);
      assert.ok(fs.existsSync(file), `manifest references ${ref} but ${path.relative(REPO_ROOT, file)} is missing`);
    }
  } finally {
    fs.rmSync(out, { force: true });
  }
});
