'use strict';

// Both distribution channels are verified here WITHOUT a published Store package: the channel
// decision is a pure function, so the 'store' branch can be driven by passing windowsStore
// directly. Run with `npm test`.

const test = require('node:test');
const assert = require('node:assert');

const {
  UPDATE_CHANNELS,
  resolveUpdateChannel,
  usesGithubUpdater,
  normalizeOverride,
} = require('../update-channel');

test('unpackaged source run is the dev channel', () => {
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: false, windowsStore: false }),
    UPDATE_CHANNELS.DEV
  );
});

test('packaged NSIS install is the github channel', () => {
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: true, windowsStore: false }),
    UPDATE_CHANNELS.GITHUB
  );
});

test('MSIX build is the store channel even though it is also packaged', () => {
  // This is the regression that matters: a Store build has isPackaged === true, so an
  // isPackaged-only check would classify it 'github' and arm electron-updater against
  // GitHub Releases from inside a read-only WindowsApps directory.
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: true, windowsStore: true }),
    UPDATE_CHANNELS.STORE
  );
});

test('process.windowsStore is undefined off-Store and must not be read as store', () => {
  // Electron leaves process.windowsStore undefined rather than false outside an appx build.
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: true, windowsStore: undefined }),
    UPDATE_CHANNELS.GITHUB
  );
});

test('only the github channel arms electron-updater', () => {
  assert.strictEqual(usesGithubUpdater(UPDATE_CHANNELS.GITHUB), true);
  assert.strictEqual(usesGithubUpdater(UPDATE_CHANNELS.STORE), false);
  assert.strictEqual(usesGithubUpdater(UPDATE_CHANNELS.DEV), false);
});

test('FWW_UPDATE_CHANNEL override forces either branch for testing', () => {
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: false, windowsStore: false, override: 'store' }),
    UPDATE_CHANNELS.STORE
  );
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: true, windowsStore: true, override: 'github' }),
    UPDATE_CHANNELS.GITHUB
  );
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: true, windowsStore: true, override: ' STORE ' }),
    UPDATE_CHANNELS.STORE
  );
});

test('an unrecognised override degrades to normal detection instead of throwing', () => {
  assert.strictEqual(normalizeOverride('nonsense'), null);
  assert.strictEqual(normalizeOverride(undefined), null);
  assert.strictEqual(
    resolveUpdateChannel({ isPackaged: true, windowsStore: true, override: 'nonsense' }),
    UPDATE_CHANNELS.STORE
  );
});

test('resolveUpdateChannel tolerates a missing argument', () => {
  assert.strictEqual(resolveUpdateChannel(), UPDATE_CHANNELS.DEV);
});
