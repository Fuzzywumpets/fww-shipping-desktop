'use strict';

// REGRESSION GUARD for a Windows-only packaging failure found on AlexLass:
//
//   spawnSync C:\...\build\msix\node_modules\.bin\winapp.cmd  ->  EINVAL
//
// Since the CVE-2024-27980 fix (Node 18.20 / 20.12 / 22+), Node refuses to spawn a .cmd/.bat
// without shell:true. These tests pin the launcher to "run the CLI's .js entry with
// process.execPath", which is platform-independent and needs no shell.
//
// The launcher choice is exercised here on ANY platform by injecting a Windows execPath and a
// filesystem that contains the npm .cmd shim: the bug is not reproducible on Linux, but the
// CHOICE that caused it is.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  resolveWinappLauncher,
  assertNotBatchScript,
  WinappNotInstalledError,
} = require('../tools/msix/winapp-launcher');

const REPO_ROOT = path.resolve(__dirname, '..');

// A fake fs for an install of the pinned CLI. Keys are normalised through path.resolve on
// both sides so lookups match however the launcher composes its paths.
//
// toolsDir stays host-shaped: what makes these the WINDOWS cases is the Windows execPath and
// the presence of the npm-generated .cmd shim, not the path separator. Hardcoding a
// "C:\..." toolsDir would only test path.resolve's drive-letter handling on POSIX.
function fakeFs(files) {
  const normalised = new Map(Object.entries(files).map(([k, v]) => [path.resolve(k), v]));
  return {
    existsSync: (p) => normalised.has(path.resolve(p)),
    readFileSync: (p) => {
      const key = path.resolve(p);
      if (!normalised.has(key)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return normalised.get(key);
    },
  };
}

function installedLayout(toolsDir) {
  const pkgDir = path.join(toolsDir, 'node_modules', '@microsoft', 'winappcli');
  return {
    pkgDir,
    files: {
      // The real @microsoft/winappcli@0.6.2 manifest declares exactly this bin mapping.
      [path.join(pkgDir, 'package.json')]: JSON.stringify({ bin: { winapp: './dist/cli.js' } }),
      [path.join(pkgDir, 'dist', 'cli.js')]: '#!/usr/bin/env node\n',
      // The .cmd shim npm would also create on Windows — present, and deliberately NOT chosen.
      [path.join(toolsDir, 'node_modules', '.bin', 'winapp.cmd')]: '@echo off\n',
    },
  };
}

test('on Windows the launcher runs node against cli.js, never the .cmd shim', () => {
  const toolsDir = path.join(REPO_ROOT, 'build', 'msix');
  const { pkgDir, files } = installedLayout(toolsDir);
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';

  const launcher = resolveWinappLauncher({ toolsDir, execPath, fs: fakeFs(files) });

  assert.strictEqual(launcher.command, execPath);
  assert.strictEqual(launcher.prefixArgs.length, 1);
  assert.strictEqual(launcher.prefixArgs[0], path.resolve(pkgDir, './dist/cli.js'));
  assert.strictEqual(launcher.entry, launcher.prefixArgs[0]);

  // The actual regression: nothing handed to spawn may be a batch script.
  for (const part of [launcher.command, ...launcher.prefixArgs]) {
    assert.ok(!/\.(cmd|bat)$/i.test(part), `${part} must not be a .cmd/.bat`);
  }
  assert.ok(!/\.bin/.test(launcher.entry), 'must not route through node_modules/.bin');
});

test('the entry point is read from the installed package, not hardcoded', () => {
  const toolsDir = path.join(REPO_ROOT, 'build', 'msix');
  const pkgDir = path.join(toolsDir, 'node_modules', '@microsoft', 'winappcli');
  const files = {
    [path.join(pkgDir, 'package.json')]: JSON.stringify({ bin: { winapp: 'lib/moved-cli.js' } }),
    [path.join(pkgDir, 'lib', 'moved-cli.js')]: '',
  };
  const launcher = resolveWinappLauncher({ toolsDir, execPath: 'node.exe', fs: fakeFs(files) });
  assert.strictEqual(launcher.entry, path.resolve(pkgDir, 'lib/moved-cli.js'));
});

test('a string "bin" field is supported too', () => {
  const toolsDir = path.join(REPO_ROOT, 'build', 'msix');
  const pkgDir = path.join(toolsDir, 'node_modules', '@microsoft', 'winappcli');
  const files = {
    [path.join(pkgDir, 'package.json')]: JSON.stringify({ bin: './dist/cli.js' }),
    [path.join(pkgDir, 'dist', 'cli.js')]: '',
  };
  const launcher = resolveWinappLauncher({ toolsDir, execPath: '/usr/bin/node', fs: fakeFs(files) });
  assert.strictEqual(launcher.entry, path.resolve(pkgDir, './dist/cli.js'));
});

test('a missing install fails with the install command, not a spawn error', () => {
  assert.throws(
    () => resolveWinappLauncher({ toolsDir: '/nowhere', fs: fakeFs({}) }),
    (err) => err instanceof WinappNotInstalledError && /npm run msix:tools/.test(err.message)
  );
});

test('an installed package with a missing entry point is reported as not installed', () => {
  const toolsDir = path.join(REPO_ROOT, 'build', 'msix');
  const pkgDir = path.join(toolsDir, 'node_modules', '@microsoft', 'winappcli');
  const files = {
    [path.join(pkgDir, 'package.json')]: JSON.stringify({ bin: { winapp: './dist/cli.js' } }),
  };
  assert.throws(
    () => resolveWinappLauncher({ toolsDir, fs: fakeFs(files) }),
    (err) => err instanceof WinappNotInstalledError && /entry point is missing/.test(err.message)
  );
});

test('assertNotBatchScript rejects any .cmd/.bat spawn target', () => {
  for (const bad of ['winapp.cmd', 'C:\\x\\winapp.CMD', 'run.bat']) {
    assert.throws(() => assertNotBatchScript(bad), /Refusing to spawn/, `expected reject: ${bad}`);
  }
  for (const ok of ['C:\\Program Files\\nodejs\\node.exe', '/usr/bin/node', 'dist/cli.js']) {
    assert.doesNotThrow(() => assertNotBatchScript(ok));
  }
});

test('pack.js never spawns through the .bin shim or a shell', () => {
  // Source-level guard: this is the shape of the original defect, and it cannot be caught by
  // running pack.js on Linux (it exits early on a non-Windows platform).
  const src = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'msix', 'pack.js'), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/['"`]\.bin['"`]|node_modules['"`]?\s*,\s*['"`]\.bin/.test(code),
    'pack.js must not resolve node_modules/.bin');
  assert.ok(!/winapp\.cmd/.test(code), 'pack.js must not reference winapp.cmd');
  assert.ok(!/shell:\s*true/.test(code),
    'pack.js must never use shell:true — it would re-parse identity strings through cmd.exe');
  assert.ok(/shell:\s*false/.test(code), 'pack.js must spawn with shell:false');
});

test('the launcher produces a command that actually spawns, with argv preserved', (t) => {
  // End-to-end on the host platform: prove the chosen invocation form works with shell:false
  // and that arguments containing spaces (e.g. "FWW Shipping.exe") survive verbatim — the
  // same mechanism used on Windows, minus the Windows-only .cmd hazard.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'winapp-launcher-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pkgDir = path.join(tmp, 'node_modules', '@microsoft', 'winappcli');
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ bin: { winapp: './dist/cli.js' } }));
  fs.writeFileSync(
    path.join(pkgDir, 'dist', 'cli.js'),
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n'
  );

  const launcher = resolveWinappLauncher({ toolsDir: tmp });
  const args = ['pack', 'dist/msix/layout', '--executable', 'FWW Shipping.exe'];
  const r = spawnSync(launcher.command, [...launcher.prefixArgs, ...args], {
    encoding: 'utf8',
    shell: false,
  });

  assert.strictEqual(r.error, undefined, `spawn failed: ${r.error && r.error.message}`);
  assert.strictEqual(r.status, 0, `exited ${r.status}: ${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout), args,
    'the argv array must reach the CLI verbatim, including the argument containing a space');
});
