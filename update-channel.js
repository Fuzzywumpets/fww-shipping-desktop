'use strict';

// WHAT: the SINGLE source of truth for "which update channel is this build?".
//
// WHY IT EXISTS: the same main.js ships through two distribution channels that have
// mutually exclusive update stories:
//
//   • 'github' — the NSIS installer from GitHub Releases. electron-updater owns updates:
//                startup check, 4-hour poll, download prompt, quitAndInstall.
//   • 'store'  — the MSIX package from the Microsoft Store. WINDOWS owns updates. Arming
//                electron-updater here is not merely redundant, it is wrong: the package
//                directory under C:\Program Files\WindowsApps is read-only and signed, so a
//                download+quitAndInstall can only ever fail, and the app must never fetch
//                update metadata from GitHub for a Store-distributed build.
//   • 'dev'    — `npm start` from source. No install metadata exists at all.
//
// INVARIANT: every place that asks "should I update?" (startup wiring, the Help menu, the
// tray menu) MUST route through this one function. Three call sites deciding on their own
// is exactly how one of them drifts and a Store build starts pinging GitHub.
//
// DEPENDS: main.js is the only consumer — it calls resolveUpdateChannel() ONCE after
// app.whenReady() (process.windowsStore is only meaningful once Electron has initialised)
// and caches the answer. Both setupAutoUpdater() and checkForUpdatesInteractive() branch on
// that cached value.
// DEPENDS: package.json build.files MUST list "update-channel.js" or the packaged app
// crashes on require() at startup. package.json is JSON and cannot carry a comment, so this
// is the marker for that coupling.
//
// This module is deliberately dependency-free and side-effect-free so both branches can be
// unit-tested (test/update-channel.test.js) without building a Store package.

/** electron-updater against GitHub Releases (the NSIS installer). */
const CHANNEL_GITHUB = 'github';
/** MSIX from the Microsoft Store — Windows/Store owns updates, we do nothing. */
const CHANNEL_STORE = 'store';
/** Unpackaged `npm start` run — no updater at all. */
const CHANNEL_DEV = 'dev';

const UPDATE_CHANNELS = Object.freeze({
  GITHUB: CHANNEL_GITHUB,
  STORE: CHANNEL_STORE,
  DEV: CHANNEL_DEV,
});

const VALID_OVERRIDES = new Set([CHANNEL_GITHUB, CHANNEL_STORE, CHANNEL_DEV]);

// TEST SEAM: FWW_UPDATE_CHANNEL=store|github|dev forces a channel on a NON-Store process.
// This exists so the Store branch (the "Windows manages updates" dialog, and the absence of
// any GitHub traffic) can be exercised on a normal dev machine BEFORE a package is ever
// accepted by Partner Center — there is otherwise no way to make process.windowsStore true.
// Unrecognised values are ignored rather than throwing, so a typo degrades to normal
// detection instead of bricking startup.
//
// It deliberately CANNOT override a real Store build — see resolveUpdateChannel below.
function normalizeOverride(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return VALID_OVERRIDES.has(value) ? value : null;
}

// WHAT: pure channel decision. Takes plain values rather than reading `app`/`process` itself
// so tests can drive every combination.
//
// Ordering is load-bearing:
//   1. windowsStore === true -> 'store', UNCONDITIONALLY, ahead of the override.
//      "A Store build never contacts or applies a GitHub update" is a hard invariant, not a
//      default, so nothing in the environment may switch it off. An inherited or stale
//      FWW_UPDATE_CHANNEL=github — set once for testing and left in a user or machine
//      environment, or inherited from a parent process — would otherwise arm electron-updater
//      inside a real Store package, which is precisely the failure this module exists to
//      prevent. The seam only ever needs to SIMULATE store on a non-Store process; it never
//      needs to turn a genuine Store build into a GitHub one, so it does not get to.
//      This check is also ahead of the isPackaged check, because a Store build is packaged
//      too and would otherwise classify as 'github'.
//   2. An explicit override wins for every non-Store process (the test seam).
//   3. Not packaged -> 'dev'.
//   4. Otherwise -> 'github'.
//
// @param {{isPackaged?: boolean, windowsStore?: boolean, override?: string}} input
// @returns {'github'|'store'|'dev'}
function resolveUpdateChannel(input) {
  const { isPackaged, windowsStore, override } = input || {};

  // process.windowsStore is `true` in an appx/MSIX build and `undefined` otherwise, so
  // compare strictly rather than relying on truthiness of an absent property.
  if (windowsStore === true) return CHANNEL_STORE;

  const forced = normalizeOverride(override);
  if (forced) return forced;

  if (!isPackaged) return CHANNEL_DEV;

  return CHANNEL_GITHUB;
}

/** True only for the channel that is allowed to talk to GitHub Releases. */
function usesGithubUpdater(channel) {
  return channel === CHANNEL_GITHUB;
}

module.exports = {
  UPDATE_CHANNELS,
  resolveUpdateChannel,
  usesGithubUpdater,
  normalizeOverride,
};
