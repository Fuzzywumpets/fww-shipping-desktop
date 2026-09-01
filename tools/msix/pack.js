#!/usr/bin/env node
'use strict';

// WHAT: drive `winapp pack` over the staged layout to produce the .msix.
//
// Usage: node tools/msix/pack.js --dev | --store
//
//   --dev    sideloadable package, signed with a LOCAL development certificate whose subject
//            is generated to equal the manifest's Publisher (Windows refuses to install an
//            MSIX whose signature subject differs from Identity/Publisher by even a space).
//   --store  the Microsoft Store artifact: UNSIGNED, by design. Microsoft re-signs every
//            Store package with its own certificate, and an already-signed package is
//            rejected. Our Authenticode certificate is not involved in Store submission at
//            all.
//
// WHY A WRAPPER: the dev/store split is one flag away from producing an unusable artifact
// (a signed "Store" package, or an unsigned "dev" package that will not install). Encoding
// the difference here — with the artifact names spelling out which is which — keeps that
// decision out of a README instruction somebody skims.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LAYOUT = path.join(REPO_ROOT, 'dist', 'msix', 'layout');
const MANIFEST = path.join(LAYOUT, 'Package.appxmanifest');
const OUT_DIR = path.join(REPO_ROOT, 'dist', 'msix');
const TOOLS_DIR = path.join(REPO_ROOT, 'build', 'msix');
const DEV_CERT = path.join(TOOLS_DIR, 'devcert.pfx');

// The winapp CLI ships a native winapp.exe and declares os=win32; there is no cross-platform
// fallback, and makeappx/signtool are Windows-only regardless.
function assertWindows() {
  if (process.platform !== 'win32') {
    console.error(
      '[msix:pack] MSIX packaging requires Windows.\n' +
      `           Current platform: ${process.platform}.\n` +
      '           @microsoft/winappcli is a Windows-only package (os=win32) and the\n' +
      '           underlying makeappx/signtool tooling has no Linux or macOS build.\n' +
      '           Use a Windows machine, or the "msix" job in .github/workflows/msix.yml.'
    );
    process.exit(3);
  }
}

function winappBin() {
  const bin = path.join(TOOLS_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'winapp.cmd' : 'winapp');
  if (!fs.existsSync(bin)) {
    console.error(
      '[msix:pack] winapp CLI not installed.\n' +
      '           Run: npm run msix:tools   (npm ci --prefix build/msix)\n' +
      `           Expected: ${path.relative(REPO_ROOT, bin)}`
    );
    process.exit(4);
  }
  return bin;
}

function run(bin, args) {
  console.log(`[msix:pack] $ winapp ${args.join(' ')}`);
  const r = spawnSync(bin, args, { stdio: 'inherit', cwd: REPO_ROOT, shell: false });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`winapp ${args[0]} exited with code ${r.status}`);
  }
}

function readManifestValue(xml, attr) {
  const m = new RegExp(`\\b${attr}="([^"]*)"`).exec(xml);
  return m ? m[1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  const store = argv.includes('--store');
  const dev = argv.includes('--dev');
  if (store === dev) {
    console.error('[msix:pack] specify exactly one of --dev or --store.');
    process.exit(2);
  }

  if (!fs.existsSync(MANIFEST)) {
    console.error(
      `[msix:pack] staged layout not found at ${path.relative(REPO_ROOT, LAYOUT)}. ` +
      'Run `npm run msix:stage` first.'
    );
    process.exit(1);
  }

  assertWindows();
  const bin = winappBin();

  const xml = fs.readFileSync(MANIFEST, 'utf8');
  const version = readManifestValue(xml, 'Version');
  const publisher = readManifestValue(xml, 'Publisher');
  const executable = readManifestValue(xml, 'Executable');
  if (!version || !publisher || !executable) {
    console.error('[msix:pack] generated manifest is missing Version, Publisher or Executable.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const suffix = store ? 'store' : 'dev';
  const output = path.join(OUT_DIR, `FWW-Shipping-${version}-x64-${suffix}.msix`);

  // --executable is passed explicitly rather than letting winapp auto-detect the single .exe
  // in the layout: auto-detection breaks the moment anything else drops an .exe into the
  // Electron output, and the failure would be "packaged the wrong entry point", not an error.
  const packArgs = [
    'pack', path.relative(REPO_ROOT, LAYOUT),
    '--manifest', path.relative(REPO_ROOT, MANIFEST),
    '--executable', executable,
    '--output', path.relative(REPO_ROOT, output),
  ];

  if (store) {
    console.log('[msix:pack] STORE build — producing an UNSIGNED package.');
    console.log('[msix:pack] Microsoft signs Store packages; do not sign this artifact.');
  } else {
    // The certificate subject must equal Identity/Publisher exactly, so it is generated FROM
    // the manifest rather than from a name typed twice.
    if (!fs.existsSync(DEV_CERT)) {
      console.log(`[msix:pack] generating development certificate for ${publisher}`);
      run(bin, [
        'cert', 'generate',
        '--manifest', path.relative(REPO_ROOT, MANIFEST),
        '--output', path.relative(REPO_ROOT, DEV_CERT),
        '--export-cer',
        '--if-exists', 'Skip',
      ]);
    } else {
      console.log(`[msix:pack] reusing ${path.relative(REPO_ROOT, DEV_CERT)}`);
    }
    packArgs.push('--cert', path.relative(REPO_ROOT, DEV_CERT));
  }

  run(bin, packArgs);

  if (!fs.existsSync(output)) {
    // winapp may apply its own <name>_<version>_<arch>.msix naming; report what actually
    // landed rather than claiming success for a file that is not there.
    const found = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.msix'));
    console.error(
      `[msix:pack] expected ${path.relative(REPO_ROOT, output)} but it was not created. ` +
      `.msix files in ${path.relative(REPO_ROOT, OUT_DIR)}: ${found.join(', ') || '(none)'}`
    );
    process.exit(1);
  }

  const bytes = fs.statSync(output).size;
  console.log(`[msix:pack] ${path.relative(REPO_ROOT, output)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  if (!store) {
    console.log('[msix:pack] To install locally (elevated, one time): ' +
      `winapp cert install ${path.relative(REPO_ROOT, DEV_CERT)}`);
    console.log(`[msix:pack] Then: Add-AppxPackage ${path.relative(REPO_ROOT, output)}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`[msix:pack] ${err.message}`);
  process.exit(1);
}
