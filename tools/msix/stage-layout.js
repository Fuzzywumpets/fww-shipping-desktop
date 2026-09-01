#!/usr/bin/env node
'use strict';

// WHAT: assemble the exact directory that `winapp pack` turns into an .msix.
//
//   dist/win-unpacked/            (produced by `electron-builder --win --dir`)
//     + build/msix/assets/*       -> dist/msix/layout/Assets/
//     + generated manifest        -> dist/msix/layout/Package.appxmanifest
//   = dist/msix/layout/
//
// Usage: node tools/msix/stage-layout.js [--manifest <path>] [--source <dir>] [--out <dir>]
//
// WHY STAGE EXPLICITLY: `winapp pack` will opportunistically pull missing files referenced by
// the manifest out of the manifest's own directory. Relying on that leaves "did the tile
// actually make it into the package?" as something you only discover from a Store
// certification failure. Copying the tree ourselves makes the package contents an artifact
// you can list, diff and check into a CI log — and it keeps dist/win-unpacked pristine so the
// NSIS installer built from the same layout is byte-for-byte unaffected by the MSIX path.
//
// DEPENDS: dist/win-unpacked is electron-builder's output directory for build.win with
// --dir. It is derived from build.productName; if productName changes, the .exe inside
// changes name too — which is why the manifest's Executable is generated from the same field
// rather than hardcoded (see tools/msix/msix-identity.js).

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SOURCE = path.join(REPO_ROOT, 'dist', 'win-unpacked');
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'dist', 'msix', 'Package.appxmanifest');
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist', 'msix', 'layout');
const ASSETS_SRC = path.join(REPO_ROOT, 'build', 'msix', 'assets');

function parseArgs(argv) {
  const args = { manifest: DEFAULT_MANIFEST, source: DEFAULT_SOURCE, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '');
    if (!Object.prototype.hasOwnProperty.call(args, key)) {
      throw new Error(`Unknown argument "${argv[i]}".`);
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`--${key} requires a path argument.`);
    args[key] = path.resolve(REPO_ROOT, value);
    i += 1;
  }
  return args;
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) count += copyTree(from, to);
    else if (entry.isSymbolicLink()) {
      // MSIX packages cannot contain symlinks; a Windows electron-builder layout never has
      // any, so one appearing means something upstream changed and should be looked at.
      throw new Error(`Refusing to stage symlink ${from} — MSIX packages cannot contain symlinks.`);
    } else {
      fs.copyFileSync(from, to);
      count += 1;
    }
  }
  return count;
}

// Pull every Assets\... path the manifest actually references, so we can prove each one is
// present in the staged layout instead of discovering it during Store certification.
function manifestAssetRefs(manifestXml) {
  const refs = new Set();
  const attrRe = /"(Assets\\[^"]+)"/g;
  const textRe = />\s*(Assets\\[^<]+?)\s*</g;
  let m;
  while ((m = attrRe.exec(manifestXml)) !== null) refs.add(m[1]);
  while ((m = textRe.exec(manifestXml)) !== null) refs.add(m[1]);
  return [...refs];
}

function readExecutableAttr(manifestXml) {
  const m = /\bExecutable="([^"]+)"/.exec(manifestXml);
  return m ? m[1] : null;
}

function stage({ manifest, source, out }) {
  if (!fs.existsSync(source)) {
    throw new Error(
      `Production layout not found at ${path.relative(REPO_ROOT, source)}. ` +
      'Run `npm run dist:dir` first.'
    );
  }
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `Manifest not found at ${path.relative(REPO_ROOT, manifest)}. ` +
      'Run `npm run msix:manifest` first.'
    );
  }
  if (!fs.existsSync(ASSETS_SRC)) {
    throw new Error(
      `MSIX assets not found at ${path.relative(REPO_ROOT, ASSETS_SRC)}. ` +
      'Run `npm run msix:assets` (they are normally committed).'
    );
  }

  const manifestXml = fs.readFileSync(manifest, 'utf8');

  // Start clean: a stale file left over from a previous version would be silently packaged.
  fs.rmSync(out, { recursive: true, force: true });

  const appFiles = copyTree(source, out);
  const assetFiles = copyTree(ASSETS_SRC, path.join(out, 'Assets'));
  fs.copyFileSync(manifest, path.join(out, 'Package.appxmanifest'));

  // ── Validation ────────────────────────────────────────────────────────────
  const problems = [];

  const exe = readExecutableAttr(manifestXml);
  if (!exe) {
    problems.push('manifest has no Executable attribute.');
  } else if (!fs.existsSync(path.join(out, exe))) {
    problems.push(
      `manifest Executable="${exe}" but no such file in the staged layout. ` +
      'package.json build.productName and the manifest have drifted.'
    );
  }

  for (const ref of manifestAssetRefs(manifestXml)) {
    const rel = ref.split('\\').join(path.sep);
    if (!fs.existsSync(path.join(out, rel))) {
      problems.push(`manifest references ${ref} but it is not in the staged layout.`);
    }
  }

  // The Store rejects packages containing an .appinstaller or a nested manifest; also guard
  // against accidentally packaging the electron-updater metadata, which is meaningless in a
  // Store build (Windows owns updates there).
  const updateYml = path.join(out, 'resources', 'app-update.yml');
  const strayUpdateMetadata = fs.existsSync(updateYml);

  if (problems.length) {
    throw new Error(`Staged layout failed validation:\n  - ${problems.join('\n  - ')}`);
  }

  return { out, appFiles, assetFiles, exe, strayUpdateMetadata };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[msix:stage] ${err.message}`);
    process.exit(2);
  }
  try {
    const r = stage(args);
    console.log(`[msix:stage] app files     ${r.appFiles}`);
    console.log(`[msix:stage] asset files   ${r.assetFiles}`);
    console.log(`[msix:stage] executable    ${r.exe}`);
    if (r.strayUpdateMetadata) {
      // Not fatal: it is inert because update-channel.js never arms electron-updater in a
      // Store build. Surfaced so it is a known quantity rather than a surprise in a package
      // content listing during certification.
      console.log('[msix:stage] note          resources/app-update.yml is present and inert ' +
        '(the Store channel never arms electron-updater).');
    }
    console.log(`[msix:stage] layout        ${path.relative(REPO_ROOT, r.out)}`);
  } catch (err) {
    console.error(`[msix:stage] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { stage, manifestAssetRefs, readExecutableAttr };
