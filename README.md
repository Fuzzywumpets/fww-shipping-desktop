# FWW Shipping — Desktop App

A true Windows desktop installer for the Fuzzywumpets Shipping console, with
**silent background printing** for shipping labels and packing slips.

It is a thin Electron shell around the live web app at
`https://shipping.fuzzyreporting.com/ui` — so **it always runs the most recent
code** (the Cloudflare Worker is deployed from the
[`fww-shipping-bridge`](https://github.com/fuzzyalex84/fww-shipping-bridge)
repo; this app just loads it). No bundled app logic to keep in sync.

---

## What it does

| Feature | How |
|---|---|
| **Installed Windows app** | NSIS `.exe` installer → Start-menu + desktop shortcuts, custom icon, uninstaller. |
| **OAuth + whitelist** | Delegated to **Cloudflare Access** on `shipping.fuzzyreporting.com` (Google IdP). Policy *"Fuzzywumpets staff + Erin"* allows `@fuzzywumpets.com` **and** `erin.m.karson@gmail.com`. Login cookies persist across restarts (`persist:shipping` session partition). |
| **Always-latest code** | Loads the live deployed Worker URL on launch. |
| **Silent label printing** | Intercepts the `/label` PDF response, prints it to the configured label printer (e.g. Rollo 4×6) with **no dialog** the moment a label is purchased. |
| **Silent slip printing** | Intercepts the packing-slip render page and prints to the configured slip printer (e.g. Canon, Letter). |
| **Print Manager** | Built-in settings window: choose label printer + slip printer independently, paper sizes, copies, auto-print toggles, and **test prints**. |
| **Runs in background** | Closing the window minimizes to the system tray so auto-printing keeps working. Tray menu has quick auto-print toggles + "Open app". |
| **Auto-update** | `electron-updater` checks GitHub Releases on launch and every 4h; prompts to restart when a new version is downloaded. |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  FWW Shipping.exe  (Electron main process)   │
│                                              │
│  main.js                                     │
│   • BrowserWindow → shipping.fuzzyreporting  │
│       .com/ui   (CF Access gate = OAuth)     │
│   • injects fetch/print interceptor          │
│   • hidden BrowserWindow.print({silent})     │
│   • Tray + Print Manager + auto-updater      │
│                                              │
│  preload.js  (contextIsolation bridge)       │
│   • forwards page CustomEvents → IPC         │
│                                              │
│  print-manager.html  (settings UI)           │
└─────────────────────────────────────────────┘
```

### Print interception
The page's `window.fetch` is patched (in the page world) to watch for the
`POST /label` response with `Content-Type: application/pdf`. The PDF bytes are
base64-encoded and dispatched as a `fww:label-pdf` DOM event; the preload
forwards it to the main process, which writes a temp PDF and prints it silently
to the label printer. Packing slips open a `/slip-render` page whose
`window.print()` is intercepted and routed to the slip printer instead.

Settings are stored **per machine** via `electron-store` at
`%APPDATA%/fww-shipping-desktop/config.json` (pinned explicitly via the store's
`cwd` option since 1.0.20 — before that, electron-store's own app detection
silently fell back to the machine-**shared**
`%APPDATA%/electron-store-nodejs/Config/config.json`, on dev *and* installed
builds alike). On first launch, 1.0.20+ migrates settings out of that legacy
file exactly once; the legacy file itself is never modified or deleted.

For sandboxed dev/test runs, two env vars isolate the app from the real
install: `FWW_SHIPPING_USERDATA_DIR` (absolute path) relocates **all**
persistent state — settings, the `persist:shipping` cookie jar, caches, and the
single-instance lock, so a test run coexists with a running production
instance — and starts with clean settings (no inherited real printers).
`FWW_SHIPPING_LEGACY_CONFIG_FILE` optionally points migration at a fixture
file for testing the migration itself.

---

## Build

Requires Node 18+ and (on the build machine) the `winCodeSign` cache workaround
noted below.

```powershell
npm install
npm run dist      # → dist/FWW Shipping Setup <version>.exe  +  latest.yml
```

The unsigned installer is ~84 MB. To smoke-test without installing:

```powershell
npm start                       # run from source
.\dist\win-unpacked\"FWW Shipping.exe"   # run the packaged build
```

### Windows build note — winCodeSign symlinks
`electron-builder` extracts `winCodeSign-2.6.0.7z`, which contains macOS
symlinks that Windows refuses to create without `SeCreateSymbolicLinkPrivilege`
(Developer Mode / elevated). On a machine that lacks that privilege the 7-Zip
step exits with code 2 and the build aborts. Two fixes, in order of preference:

1. **Enable Developer Mode** (Settings → For developers) or run the build shell
   **as Administrator** — grants the symlink privilege, build just works.
2. **Pre-populate the cache** (what this machine uses): the needed files
   (`libcrypto.dylib`, `libssl.dylib`) are actually extracted as regular files
   despite the error, so a populated
   `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`
   directory lets the build skip re-extraction. `binDownload.js` is patched to
   return a pre-populated cache dir if present. *(This patch lives in
   `node_modules` and is lost on reinstall — prefer fix #1 in CI.)*

CI (GitHub Actions, `.github/workflows/build.yml`) runs on `windows-latest`,
which has the privilege, so neither workaround is needed there. Pushing a
`v*` tag builds the installer and publishes a GitHub Release that the
auto-updater consumes.

---

## Install (operator machine)

1. Run `FWW Shipping Setup <version>.exe`.
2. First launch opens the Google login (Cloudflare Access) — sign in with a
   `@fuzzywumpets.com` account or `erin.m.karson@gmail.com`.
3. Click the 🖨 button (bottom-right) or the tray icon → **Print Settings**.
4. Pick the **label printer** (Rollo 4×6) and **slip printer** (Canon, Letter),
   run the **Test Print** for each, toggle auto-print on, **Save**.

That's it — labels auto-print to the Rollo on purchase, slips print to the Canon
when triggered, all in the background.

---

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main: window, print routing, tray, updater. |
| `preload.js` | contextIsolation bridge (page events ↔ IPC). |
| `print-manager.html` | Print settings UI. |
| `auth.html` | Loading splash (fallback). |
| `assets/icon.ico` / `icon.png` | App + installer icon. |
| `.github/workflows/build.yml` | CI build + release. |
