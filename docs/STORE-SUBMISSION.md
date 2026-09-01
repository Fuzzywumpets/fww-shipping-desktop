# FWW Shipping — Microsoft Store submission checklist

> **Do not submit anything to Partner Center until the Fuzzywumpets company account has
> completed verification.** As of this document the account is *awaiting verification* and the
> app name is *not reserved*, so no real identity values exist. Everything below is the
> sequence to follow once they do. The build tooling enforces this: `npm run dist:msix:store`
> refuses to run while the development placeholders in `build/msix/identity.json` are still in
> play.

Build and packaging commands live in the [README](../README.md#microsoft-store-msix). This
document covers the Partner Center side and the tests that need real hardware.

---

## 1. Before anything else — reserve the name

1. Partner Center → **Apps and games** → **New product** → **MSIX or PWA app**.
2. Reserve the app name. This is the `DisplayName` shoppers see and it must match the
   `DisplayName` in the package.
3. Reserving a name does **not** publish anything. It is safe, and it is the step that
   generates the identity values everything else depends on.

## 2. Exact identity values to collect

Partner Center → your product → **Product management** → **Product identity**. Copy these
**verbatim** — a single character of drift makes the Store reject the package.

| Partner Center field | Supply as | Goes into |
|---|---|---|
| **Package/Identity/Name** | `MSIX_IDENTITY_NAME` | `<Identity Name="…">` |
| **Package/Identity/Publisher** (the `CN=<GUID>` string) | `MSIX_PUBLISHER` | `<Identity Publisher="…">` |
| **Package/Properties/PublisherDisplayName** | `MSIX_PUBLISHER_DISPLAY_NAME` | `<PublisherDisplayName>` |
| The reserved app name | `MSIX_DISPLAY_NAME` | `<DisplayName>` and `<uap:VisualElements DisplayName>` |
| *(optional)* package version override | `MSIX_PACKAGE_VERSION` | `<Identity Version="…">` |

Nothing is hand-edited in two places — these five inputs are the whole surface. Set them as
environment variables locally, or as repository secrets of the same names for the
`workflow_dispatch` MSIX workflow.

**Version:** defaults to `package.json` version + `.0` (today: `1.0.19` → `1.0.19.0`). The
fourth part must stay `0`; the Store reserves it. Each submission needs a *higher* version than
the last accepted one.

## 3. Do NOT sign the Store package

Microsoft signs every Store package with its own certificate and rejects a pre-signed one.
`npm run dist:msix:store` produces an **unsigned** `.msix` deliberately. Our Authenticode
certificate is not used for, and is not needed for, Store submission. The development
certificate (`build/msix/devcert.pfx`) is for local sideload testing only and must never be
committed or uploaded.

## 4. Visibility — use Private Audience, not a hidden link

- MSIX products support **Private audience**: Pricing and availability → Visibility → *Private
  audience*, then list the Microsoft accounts allowed to see and install it. This is real
  access control and is the right setting for internal-only shipping software.
- **"Hide this product / available by direct link only" is not access control.** Anyone with
  the link can install it. Do not treat it as a security boundary.
- Private audience products still go through full certification.

## 5. Listing metadata to prepare

- [ ] **Description** — what the app does (shipping console shell with silent label and
      packing-slip printing). Say plainly that it is intended for Fuzzywumpets staff.
- [ ] **Screenshots** — at least one, 1366×768 or larger. The main window and the Print
      Settings window are the two worth showing. Avoid capturing real customer addresses.
- [ ] **Store logo** — `build/msix/assets/StoreLogo.png` is in the package; Partner Center also
      wants listing images. All are derived from `assets/icon.png`.
- [ ] **Privacy policy URL** — **required**, because the app collects a sign-in identity via
      Cloudflare Access. Must be a live public URL.
- [ ] **Support contact / URL** — required.
- [ ] **Category** — Business or Productivity.
- [ ] **Age rating** questionnaire.
- [ ] **Markets** — restrict to the ones you actually need.

## 6. Certification notes (the "Notes for certification" box)

Testers cannot get past the login or exercise printing without help. Say so explicitly, or the
submission will fail certification for "cannot be evaluated":

> This app is a desktop shell for an internal Fuzzywumpets shipping console.
>
> **Sign-in:** the app loads `https://shipping.fuzzyreporting.com/ui`, which is gated by
> Cloudflare Access (Google IdP) and restricted to an allow-list of company accounts. There is
> no public or test account, and no self-service sign-up. A tester will reach the Cloudflare
> Access login page and will not be able to proceed past it. This is expected: the app is
> intended for a private audience of company staff.
>
> **Printing:** the core feature is silent background printing of 4×6 shipping labels and
> Letter packing slips to specific configured printers (a Rollo label printer and a Canon
> office printer). Without those printers attached and selected in the app's Print Settings,
> the printing features cannot be exercised. The app enumerates system printers and prints via
> the standard Windows print stack; it requires no elevation.
>
> **Full trust:** the package declares `runFullTrust` and a `Windows.FullTrustApplication`
> entry point because it is an Electron/Win32 desktop app that must enumerate named printers,
> print silently, write temporary PDF files, and run a system tray icon. It runs as
> `asInvoker` and never requests elevation.

## 7. Pre-submission technical checks

- [ ] `npm test` passes.
- [ ] `npm run dist:msix:store` completes with the real identity values.
- [ ] The generated `dist/msix/Package.appxmanifest` shows the exact Partner Center strings.
- [ ] **Windows App Certification Kit** run against the package on a real Windows machine:
      `"C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe" test
      -appxpackagepath dist\msix\<package>.msix -reportoutputpath wack.xml`, then review the
      report. (The CI job runs WACK best-effort; the authoritative run is this one.)
- [ ] The manual hardware matrix in §8 has been completed on a real shipping PC.

## 8. Manual test matrix — REQUIRES REAL HARDWARE

**None of the following has been or can be verified in CI or in an automated environment.**
They need a physical Windows PC with the actual printers attached. Run them against a
locally installed development MSIX (`Add-AppxPackage`) before submitting.

### 8a. Printer / hardware tests — cannot be automated

| # | Test | Expected |
|---|---|---|
| 1 | **Rollo 4×6 label** — buy a label with auto-print ON | Spools to the Rollo, prints white and scannable at full 4×6, not shrunk or rotated |
| 2 | **Canon Letter slip** — trigger a packing slip | Prints on Letter, **white** background with logo (not dark-mode dark), slip window never appears visibly |
| 3 | **Batch labels** — spool a batch | Every label prints; none dropped |
| 4 | **Save to PDF** — "Open as PDF" on a shipped order | A Chromium PDF viewer opens showing the FULL 4×6 label; the file opens cleanly in Edge/Acrobat |
| 5 | **Barcode scanner focus** — auto-print a label, then immediately scan the next order with nothing clicked | The scan registers (main window kept OS keyboard focus) |
| 6 | **Test prints** — Print Settings → Test Print on each printer | Label: correctly sized 4×6. Slip: white on Letter |
| 7 | **Printer enumeration** — open Print Settings in the **MSIX** build | Both dropdowns list the real system printers. *This is the single most important MSIX-specific check — it is what would fail if the package were ever put in an AppContainer.* |

### 8b. MSIX packaging behaviour — needs a Windows machine, not special hardware

| # | Test | Expected |
|---|---|---|
| 8 | Install the dev MSIX after trusting the dev certificate | Installs; appears in the Start menu |
| 9 | Launch it | Loads the shipping UI (after login) |
| 10 | Launch a second time while running | No second window/process; the existing window restores and focuses (single-instance lock) |
| 11 | Close the window | Minimizes to tray; auto-printing keeps working; tray menu opens the app again |
| 12 | Change a setting in Print Settings, quit, relaunch | The setting persisted |
| 13 | **Help → Check for Updates** | Shows "Updates are managed by the Microsoft Store", offers to open the Store. **No** GitHub request (confirm with Fiddler/netstat if you want to be sure) |
| 14 | Tray → Check for Updates | Same dialog as #13 |
| 15 | Uninstall (`Remove-AppxPackage`), then reinstall | Uninstalls cleanly; reinstall launches normally |
| 16 | **Settings continuity** — install the MSIX on a PC that already has the NSIS build configured | Printer settings carry over (see the README note) |
| 17 | **Login continuity** | Expect a **one-time re-login** through Cloudflare Access. Anything better is a bonus, not a requirement |
| 18 | **Shared account** — log in as a second Windows user on the same PC | Note: MSIX is per-user. The second account must install the Store app itself; NSIS remains the per-machine option |

### 8c. NSIS regression — prove the existing channel is untouched

| # | Test | Expected |
|---|---|---|
| 19 | `npm run dist` on Windows | Produces `dist\FWW-Shipping-Setup-1.0.19.exe` + `latest.yml`, exactly as before |
| 20 | Install it | Installs to `C:\Program Files\FWW Shipping` with **all-users** shortcuts (per-machine) |
| 21 | Help → Check for Updates in the NSIS install | A real GitHub check with a visible outcome dialog — the original behaviour |

## 9. Hard rules

- Do **not** submit to Partner Center until company account verification completes.
- Do **not** commit a `.pfx`, `.cer`, certificate password, or Partner Center secret.
- Do **not** upload a development-signed or unsigned MSIX to a public GitHub Release; it is a
  CI artifact, not a distributable.
- Do **not** flip `nsis.perMachine` to `false`. It is load-bearing for shared shipping PCs.
- Do **not** add `uap10:TrustLevel="appContainer"` to the manifest — it breaks printer
  enumeration, silent printing and temp writes. See the comment block in
  `build/msix/Package.appxmanifest.template`.
