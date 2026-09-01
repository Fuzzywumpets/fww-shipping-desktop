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
| **Installed Windows app** | NSIS `.exe` installer → Start-menu + desktop shortcuts, custom icon, uninstaller. A second, optional channel packages the *same* app as an MSIX for the Microsoft Store — see [Microsoft Store (MSIX)](#microsoft-store-msix). |
| **OAuth + whitelist** | Delegated to **Cloudflare Access** on `shipping.fuzzyreporting.com` (Google IdP). Policy *"Fuzzywumpets staff + Erin"* allows `@fuzzywumpets.com` **and** `erin.m.karson@gmail.com`. Login cookies persist across restarts (`persist:shipping` session partition). |
| **Always-latest code** | Loads the live deployed Worker URL on launch. |
| **Silent label printing** | Intercepts the `/label` PDF response, prints it to the configured label printer (e.g. Rollo 4×6) with **no dialog** the moment a label is purchased. |
| **Silent slip printing** | Intercepts the packing-slip render page and prints to the configured slip printer (e.g. Canon, Letter). |
| **Print Manager** | Built-in settings window: choose label printer + slip printer independently, paper sizes, copies, auto-print toggles, and **test prints**. |
| **Runs in background** | Closing the window minimizes to the system tray so auto-printing keeps working. Tray menu has quick auto-print toggles + "Open app". |
| **Auto-update** | **NSIS build:** `electron-updater` checks GitHub Releases on launch and every 4h; prompts to restart when a new version is downloaded. **Store (MSIX) build:** Windows owns updates — `electron-updater` is never armed. See [Updater channels](#updater-channels-nsis-vs-store). |

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
`%APPDATA%/fww-shipping-desktop/config.json`.

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

### Machine-wide install — do not revert to per-user

The installer is built **per-machine** (`nsis.perMachine: true`): it installs to
`C:\Program Files\FWW Shipping` and creates **all-users** Start-menu and Public
Desktop shortcuts, so every Windows account on the PC gets the app from a single
elevated install. This matters on shared shipping machines where operators
(Mason, Erin, …) log in under their own accounts.

**Every future build must keep `nsis.perMachine: true`.** Flipping it back to
`false` produces a `oneClick` per-user installer, which:

- silently installs into only the invoking user's `%LOCALAPPDATA%\Programs`,
- offers **no** "install for all users" prompt at all (a `oneClick` installer
  has no UI to click), and
- leaves every other account on the machine without the app.

That is the exact failure this setting fixes — it is load-bearing, not cosmetic.
Because `package.json` is JSON and cannot carry a `DEPENDS:` comment, this note
is the marker.

---

## Microsoft Store (MSIX)

### What MSIX is, and why there are two channels

**MSIX** is Windows' modern app package format — a single signed `.msix` container holding the
app files plus a `Package.appxmanifest` that declares its identity, icons and capabilities.
Windows installs it with a package identity, keeps it in a read-only, signature-enforced
directory under `C:\Program Files\WindowsApps`, and (for Store-delivered packages) updates it
itself. It is the only format the Microsoft Store accepts for a Win32 app.

The same Electron app now builds through two independent channels:

| | **NSIS** (existing, unchanged) | **MSIX / Store** (new) |
|---|---|---|
| Artifact | `dist/FWW-Shipping-Setup-<version>.exe` | `dist/msix/FWW-Shipping-<version>.0-x64-{dev,store}.msix` |
| Built by | `npm run dist` | `npm run dist:msix` |
| Install scope | **Per machine**, all users, `C:\Program Files\FWW Shipping` | **Per Windows user** (MSIX is always per-user; the Store can provision for all users on managed devices) |
| Signing | Unsigned / our own cert | Dev: throwaway local cert. **Store: unsigned — Microsoft signs it** |
| Updates | `electron-updater` ← GitHub Releases | Windows / Microsoft Store |
| Distribution | Direct download, internal | Microsoft Store |

The NSIS channel is untouched: same `nsis.perMachine: true`, same artifact name, same
`v*`-tag release workflow. Adding MSIX did not change a single NSIS setting.

> **Per-machine vs per-user is the one real behavioural difference.** The NSIS installer is
> deliberately per-machine so a single elevated install serves every operator account on a
> shared shipping PC (see [Machine-wide install](#machine-wide-install--do-not-revert-to-per-user)).
> MSIX has no per-machine mode. On a shared PC, each Windows account installs the Store app
> itself. If that is unacceptable for the shipping machines, keep them on NSIS — the two
> channels are meant to coexist.

### Local development build

Requires **Windows** (the packaging tools are Windows-only) and Node 18+.

```powershell
npm ci
npm run msix:tools     # one time: installs the pinned winapp CLI into build\msix
npm run dist:msix      # electron-builder --dir  ->  manifest  ->  staged layout  ->  signed .msix
```

`dist:msix` runs four steps you can also run individually:

| Command | Does |
|---|---|
| `npm run dist:dir` | electron-builder production layout → `dist\win-unpacked` |
| `npm run msix:manifest` | renders `build\msix\Package.appxmanifest.template` → `dist\msix\Package.appxmanifest` |
| `npm run msix:stage` | copies the layout + `build\msix\assets` + manifest → `dist\msix\layout`, then validates that the manifest's `Executable` and every `Assets\…` reference actually exist |
| `node tools\msix\pack.js --dev` | `winapp pack` → a locally signed `.msix` |

`npm run msix:assets` regenerates the logo/tile PNGs from `assets\icon.png`. The output is
committed, so you only need this if the icon changes.

### Development certificate

Windows refuses to install an MSIX whose signature subject differs from the manifest's
`Identity/Publisher` by even one character, so the certificate is generated **from the
manifest** rather than from a name typed twice. `npm run dist:msix` does it automatically on
first run, writing `build\msix\devcert.pfx` (gitignored — never commit a `.pfx`).

To trust it so the package will install, once per machine, **in an elevated shell**:

```powershell
build\msix\node_modules\.bin\winapp cert install build\msix\devcert.pfx
```

### Install / uninstall the test package

```powershell
# Install (or double-click the .msix)
Add-AppxPackage dist\msix\FWW-Shipping-1.0.19.0-x64-dev.msix

# Confirm it registered
Get-AppxPackage *FWWShipping*

# Uninstall
Get-AppxPackage *FWWShipping* | Remove-AppxPackage
```

The app appears in the Start menu as the manifest's `DisplayName` (**FWW Shipping (Dev)** for
a development build, so it is never confused with the real NSIS install sitting beside it).

### Updater channels: NSIS vs Store

`update-channel.js` is the single source of truth. It resolves one of three channels once, at
`app.whenReady()`, and both the Help menu and the tray menu read that one value:

| Channel | Detected by | Update behaviour |
|---|---|---|
| `github` | packaged, not a Store build | Unchanged: startup check, 4-hour poll, silent download, Restart Now / Later prompt |
| `store` | `process.windowsStore === true` | `electron-updater` is **never armed** — no timers, no GitHub requests, no `quitAndInstall`. "Check for Updates" shows a Store-managed message and offers to open the Store's updates page |
| `dev` | `npm start` from source | The existing "this is a dev build" dialog |

A Store build is also `app.isPackaged`, which is exactly why the check is not an `isPackaged`
check — see the comments in `update-channel.js` and `setupAutoUpdater()`.

To exercise the Store branch on a normal dev machine, without a Store package:

```powershell
$env:FWW_UPDATE_CHANNEL='store'; npm start
```

### Settings and login continuity

`app.getPath('userData')` returns the same `%APPDATA%\fww-shipping-desktop` path in both
channels, so **no path migration code exists and none is needed**. Per Microsoft's
[packaged-desktop-app behaviour](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes),
on Windows 10 1903+ a packaged app opening a file under `AppData` gets the per-package private
copy *if one exists*, and otherwise falls through to the real `AppData` file with no
virtualization at all. An existing `config.json` from an NSIS install is therefore opened in
place.

- **Printer settings are expected to carry over.** `printSettings` keys, the `config.json`
  name and the `electron-store` store name are all unchanged.
- **A one-time Cloudflare Access re-login is expected.** The `persist:shipping` partition name
  is unchanged, but Chromium rewrites its cookie database through temp-file-and-rename, which
  is precisely the pattern MSIX's AppData redirection handles least predictably. Rather than
  manipulate cookie files — which would be unsafe and could corrupt the profile — plan on
  signing in once after installing the MSIX. Nothing else is lost.
- Confirm both on real hardware (see the manual test matrix in `docs/STORE-SUBMISSION.md`).

### Producing the Store artifact

Needs the Partner Center identity values, which **do not exist yet** (see
`docs/STORE-SUBMISSION.md`). Once they do:

```powershell
$env:MSIX_IDENTITY_NAME          = '<Package/Identity/Name from Partner Center>'
$env:MSIX_PUBLISHER              = '<Package/Identity/Publisher, the CN=<GUID> string>'
$env:MSIX_PUBLISHER_DISPLAY_NAME = '<Package/Properties/PublisherDisplayName>'
$env:MSIX_DISPLAY_NAME           = '<the reserved app name>'
npm run dist:msix:store
```

That produces `dist\msix\FWW-Shipping-<version>.0-x64-store.msix`, **unsigned on purpose** —
Microsoft signs every Store package with its own certificate and rejects a pre-signed one. Our
Authenticode certificate is not involved in Store submission at all.

The build refuses to run if any placeholder from `build\msix\identity.json` is still in play,
so a development-identity package can never be uploaded by accident.

### Version mapping

`package.json` `version` is the single human version. `1.0.19` maps to the Store's four-part
`1.0.19.0`; the fourth part is pinned to `0` because the Store reserves it. Anything that
cannot be mapped — a prerelease tag, a part over 65535, a leading zero — is rejected with a
message rather than coerced. `MSIX_PACKAGE_VERSION` overrides the mapping for a resubmission
that needs a package bump without a code release.

### CI

`.github/workflows/msix.yml` is separate from the release workflow and has read-only
permissions, so it can never touch a GitHub Release:

- **on pull request** — a fast Ubuntu job: `npm ci`, `node --check`, `npm test`, manifest
  render, and an assertion that a Store-mode build *fails* while the placeholders are in place.
- **on `workflow_dispatch`** — a `windows-latest` job that builds the MSIX (`mode: dev` or
  `store`), validates it with the Windows SDK's `makeappx unpack`, runs the Windows App
  Certification Kit if present, and uploads the package as a **CI artifact only**.

`.github/workflows/build.yml` — the `v*`-tag NSIS release — is unchanged.

### Rollback / removal

MSIX is purely additive; nothing about the NSIS channel depends on it.

- **Remove a test package from a machine:** `Get-AppxPackage *FWWShipping* | Remove-AppxPackage`,
  then optionally untrust the dev certificate (`certlm.msc` → Trusted People → delete the
  "Fuzzywumpets Development" certificate).
- **Stop building MSIX:** simply stop running `dist:msix`. `npm run dist` and the tag-triggered
  release are untouched.
- **Remove it from the repo:** delete `build/msix/`, `tools/msix/`, `.github/workflows/msix.yml`,
  the `msix:*` / `dist:msix*` scripts, `update-channel.js`, and the `test/` files; then revert
  `main.js` to gate `setupAutoUpdater()` and `checkForUpdatesInteractive()` on `app.isPackaged`
  and drop `"update-channel.js"` from `build.files`.

See **[`docs/STORE-SUBMISSION.md`](docs/STORE-SUBMISSION.md)** for the submission checklist and
the manual (hardware) test matrix.

---

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main: window, print routing, tray, updater. |
| `update-channel.js` | Single source of truth for the distribution channel (NSIS vs Store vs dev). Listed in `build.files`. |
| `preload.js` | contextIsolation bridge (page events ↔ IPC). |
| `print-manager.html` | Print settings UI. |
| `auth.html` | Loading splash (fallback). |
| `assets/icon.ico` / `icon.png` | App + installer icon. Also the source for every MSIX tile. |
| `build/msix/Package.appxmanifest.template` | MSIX manifest template (identity values are placeholders). |
| `build/msix/identity.json` | Development identity defaults; overridden by `MSIX_*` env vars. |
| `build/msix/assets/` | Generated MSIX logo/tile PNGs (committed). |
| `build/msix/package.json` + lockfile | Pinned, Windows-only winapp CLI toolchain. |
| `tools/msix/` | Manifest generation, asset generation, layout staging, packaging. |
| `test/` | `node --test` unit tests for the channel split and identity/version mapping. |
| `.github/workflows/build.yml` | CI build + release (NSIS). |
| `.github/workflows/msix.yml` | CI validation + MSIX artifact (never a release). |
| `docs/STORE-SUBMISSION.md` | Store submission checklist + manual test matrix. |
