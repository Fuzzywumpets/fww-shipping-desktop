'use strict';

// WHAT: work out how to *execute* the pinned winapp CLI, as an argv array.
//
// WHY THIS EXISTS — a real Windows-only failure, found on AlexLass:
//
//   spawnSync C:\...\build\msix\node_modules\.bin\winapp.cmd
//   Error: spawnSync ... EINVAL
//
// npm installs a Windows console script as a `.cmd` shim in node_modules/.bin. Since the fix
// for CVE-2024-27980 (Node 18.20 / 20.12 / 22+), Node REFUSES to spawn a `.cmd` or `.bat`
// unless `shell: true` — it throws EINVAL rather than silently handing the string to cmd.exe.
// So the shim is unusable from spawn() the safe way, and the "obvious" workaround
// (`shell: true`) is exactly the injection hazard that CVE was about: every argument would
// then be re-parsed by cmd.exe, and this build passes operator-supplied identity strings and
// a path containing a space ("FWW Shipping.exe") straight through.
//
// THE FIX: skip the shim entirely. Run the CLI's JavaScript entry point with the Node binary
// we are already running under — `process.execPath dist/cli.js <args...>` — keeping a real
// argv array and `shell: false`. That is platform-independent (no `.cmd` on any OS), needs no
// quoting, and cannot be injected into.
//
// DEPENDS: build/msix/package.json pins @microsoft/winappcli, and `npm run msix:tools`
// installs it into build/msix/node_modules. The entry path is read from the INSTALLED
// package's own "bin" field rather than hardcoded, so a future version that moves cli.js
// keeps working.
//
// NOTE: the README still tells a human to type `build\msix\node_modules\.bin\winapp cert
// install …` in an elevated shell. That is correct and must not be "fixed" to match this
// file — a shell resolving the `.cmd` shim itself is fine; it is only Node's spawn() that
// cannot. The two are different invocation paths, not an inconsistency.

const path = require('path');
const realFs = require('fs');

const PACKAGE_NAME = '@microsoft/winappcli';

class WinappNotInstalledError extends Error {}

// GUARD: nothing may ever be spawned as a batch script. If a future edit reintroduces the
// shim, this throws with the reason instead of producing an EINVAL a long way from the cause.
function assertNotBatchScript(command) {
  if (/\.(cmd|bat)$/i.test(String(command))) {
    throw new Error(
      `Refusing to spawn "${command}": Node cannot spawn a .cmd/.bat without shell:true, and ` +
      'shell:true would re-parse every argument through cmd.exe. Run the CLI\'s .js entry ' +
      'point with process.execPath instead (see tools/msix/winapp-launcher.js).'
    );
  }
}

// @param {object}   opts
// @param {string}   opts.toolsDir  directory holding build/msix/package.json (its node_modules
//                                  is where the CLI is installed)
// @param {string}   [opts.execPath] the Node binary to run the CLI with
// @param {object}   [opts.fs]       injectable for tests
// @returns {{command: string, prefixArgs: string[], entry: string, packageDir: string}}
function resolveWinappLauncher({ toolsDir, execPath = process.execPath, fs = realFs } = {}) {
  if (!toolsDir) throw new Error('resolveWinappLauncher requires toolsDir.');

  const packageDir = path.join(toolsDir, 'node_modules', '@microsoft', 'winappcli');
  const manifest = path.join(packageDir, 'package.json');

  if (!fs.existsSync(manifest)) {
    throw new WinappNotInstalledError(
      `${PACKAGE_NAME} is not installed.\n` +
      '           Run: npm run msix:tools   (npm ci --prefix build/msix)\n' +
      `           Expected: ${manifest}`
    );
  }

  let bin;
  try {
    bin = JSON.parse(fs.readFileSync(manifest, 'utf8')).bin;
  } catch (err) {
    throw new Error(`Could not parse ${manifest}: ${err.message}`);
  }

  // "bin" is either a string (single binary named after the package) or a map.
  const relative = typeof bin === 'string' ? bin : (bin && bin.winapp);
  if (!relative) {
    throw new Error(
      `${manifest} declares no "winapp" bin entry, so there is no CLI entry point to run.`
    );
  }

  const entry = path.resolve(packageDir, relative);
  if (!fs.existsSync(entry)) {
    throw new WinappNotInstalledError(
      `${PACKAGE_NAME} is installed but its entry point is missing: ${entry}\n` +
      '           Re-run: npm run msix:tools'
    );
  }

  assertNotBatchScript(execPath);
  assertNotBatchScript(entry);

  return { command: execPath, prefixArgs: [entry], entry, packageDir };
}

module.exports = {
  PACKAGE_NAME,
  WinappNotInstalledError,
  resolveWinappLauncher,
  assertNotBatchScript,
};
