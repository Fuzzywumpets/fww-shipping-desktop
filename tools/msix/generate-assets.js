'use strict';

// WHAT: derive the MSIX logo/tile asset set from the ONE approved FWW Shipping icon
// (assets/icon.png, 512x512 RGBA) and write it to build/msix/assets/.
//
// Run with:  npm run msix:assets      (i.e. `electron tools/msix/generate-assets.js`)
//
// The output is COMMITTED. This script exists so the assets are reproducible and provably
// derived from the approved icon rather than redrawn — not as a build step. `npm run
// dist:msix` copies the committed files; it never regenerates them.
//
// WHY ELECTRON: Electron is already a devDependency and its nativeImage does high-quality
// Lanczos downscaling, so the asset set needs no new dependency, no ImageMagick, and no
// native module. (`winapp manifest update-assets` would also work on Windows, but it rewrites
// the manifest as a side effect and only runs on Windows.)
//
// EVERY size here is SQUARE, deliberately. A wide tile (Wide310x150Logo) would require
// letterboxing a square mark onto a 2:1 canvas, i.e. inventing composition that is not in the
// approved icon. The wide tile is optional in the manifest, so it is simply not declared.
//
// SYNC: the file names produced here must match the Assets\* paths referenced in
// build/msix/Package.appxmanifest.template. tools/msix/stage-layout.js re-reads the generated
// manifest and fails the build if a referenced asset is missing, so a mismatch cannot ship.

const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(REPO_ROOT, 'assets', 'icon.png');
const OUT_DIR = path.join(REPO_ROOT, 'build', 'msix', 'assets');

// Base logos referenced (directly or via MRT scale resolution) by the manifest, plus their
// scale-200 variants. Windows picks <name>.scale-200.png automatically on high-DPI displays
// purely by file-name convention — the manifest only ever names the base file.
const BASE_LOGOS = [
  { name: 'StoreLogo', size: 50 },
  { name: 'Square44x44Logo', size: 44 },
  { name: 'Square71x71Logo', size: 71 },
  { name: 'Square150x150Logo', size: 150 },
  { name: 'Square310x310Logo', size: 310 },
];

// The app-list / taskbar / Start icon is resolved by targetsize rather than scale. The
// _altform-unplated twin is what Windows uses on the taskbar and in Start's app list; without
// it the icon gets a solid plate behind it and looks wrong next to every other app.
const TARGET_SIZES = [16, 24, 32, 48, 256];

function resizeTo(source, size) {
  const out = source.resize({ width: size, height: size, quality: 'best' });
  const buf = out.toPNG();
  if (!buf || buf.length === 0) throw new Error(`resize to ${size}px produced an empty PNG`);
  // Verify the PNG IHDR really carries the size we asked for — a silent no-op resize would
  // otherwise ship 512px images under 44px names and fail Store certification.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`resize to ${size}px produced ${width}x${height}`);
  }
  return buf;
}

function main() {
  if (!fs.existsSync(SOURCE)) throw new Error(`Source icon not found: ${SOURCE}`);
  const source = nativeImage.createFromPath(SOURCE);
  const { width, height } = source.getSize();
  if (width === 0 || height === 0) throw new Error(`Could not decode ${SOURCE}`);
  if (width !== height) {
    throw new Error(`Source icon is ${width}x${height}; a square source is required.`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const written = [];
  const write = (name, size) => {
    const file = path.join(OUT_DIR, `${name}.png`);
    fs.writeFileSync(file, resizeTo(source, size));
    written.push(`${name}.png (${size}px)`);
  };

  for (const { name, size } of BASE_LOGOS) {
    write(name, size);
    // scale-200 must not exceed the source resolution or it is an upscale of a 512px mark.
    const scaled = size * 2;
    if (scaled <= width) write(`${name}.scale-200`, scaled);
  }

  for (const size of TARGET_SIZES) {
    write(`Square44x44Logo.targetsize-${size}`, size);
    write(`Square44x44Logo.targetsize-${size}_altform-unplated`, size);
  }

  console.log(`[msix:assets] source ${path.relative(REPO_ROOT, SOURCE)} (${width}x${height})`);
  for (const line of written) console.log(`[msix:assets]   ${line}`);
  console.log(`[msix:assets] wrote ${written.length} file(s) to ${path.relative(REPO_ROOT, OUT_DIR)}`);
}

try {
  main();
  // Exit before Electron initialises its display stack. Everything above is pure image
  // decoding/encoding and needs no window, no GPU and no X server — calling app.quit()
  // instead would drag in the full browser startup for nothing.
  process.exit(0);
} catch (err) {
  console.error(`[msix:assets] ${err.stack || err.message}`);
  process.exit(1);
}
