'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  session, shell, dialog, nativeTheme, systemPreferences
} = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store').default || require('electron-store');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Error logging (fww-error-sink) ──────────────────────────────────────────
// Reports main-process crashes + render-process-gone to the estate error sink.
// Best-effort; no-ops unless ERROR_SINK_BEARER is provided in the environment.
try {
  require('./fww-logsink.cjs').installMain({
    app: 'fww-shipping-desktop',
    repo: 'fuzzyalex84/fww-shipping-desktop',
    url: 'https://errors.fuzzyreporting.com',
    bearer: process.env.ERROR_SINK_BEARER,
  });
} catch (_) { /* logging must never block app startup */ }

// ─── Constants ───────────────────────────────────────────────────────────────

const SHIPPING_URL = 'https://shipping.fuzzyreporting.com/ui';
const APP_NAME     = 'FWW Shipping';
const ICON_PATH    = path.join(__dirname, 'assets', 'icon.png');

// ─── Persistent settings store ───────────────────────────────────────────────

const store = new Store({
  name: 'config',
  defaults: {
    printSettings: {
      labelPrinter:     null,   // system printer name for shipping labels
      slipPrinter:      null,   // system printer name for packing slips
      labelPaperWidth:  101600, // microns (4 in)
      labelPaperHeight: 152400, // microns (6 in)
      slipPaperSize:    'Letter',
      autoPrintLabels:  true,
      autoPrintSlips:   true,
      labelCopies:      1,
      slipCopies:       1,
    },
    windowBounds: { width: 1280, height: 900 },
  },
});

// ─── Single instance lock ─────────────────────────────────────────────────────

// SINGLE-INSTANCE LOCK: only one FWW Shipping process may run. A 2nd launch
// loses the lock, exits immediately, and pokes the 1st instance via the
// 'second-instance' handler (restore+focus). This pairs with window-all-closed
// and the close handler both calling app.quit() so NO lingering background
// process ever keeps the lock and blocks a reopen.
// CHANGE-GUARD: if you touch quit/close logic, TEST: close the window, then
// relaunch from the Start Menu — it must open a fresh window (not silently die
// because a zombie process still holds the lock).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWindow        = null;
let printManagerWindow = null;
let tray              = null;
let quitting          = false;   // true when user explicitly quits

// After any hidden print window / viewer / print-manager window is torn down,
// Windows can leave the main window without OS keyboard focus — so the next
// barcode scan's keystrokes never reach the page. Restore focus defensively.
// WHAT: re-assert OS keyboard focus on the main window + its webContents.
// WHY IT EXISTS: tearing down a hidden print window / PDF viewer / print-manager
// leaves the main window without OS focus on Windows, so the NEXT barcode scan's
// keystrokes never reach the page and the scan silently no-ops.
// INVARIANT: EVERY path that destroys a helper/hidden window must call this
// afterward (see the calls in printSlip, silentPrintPdfBuffer, handleSlipSavePdf
// catch, printManager 'closed'). Missing it = dead scanner after a print.
// CHANGE-GUARD: after editing, TEST end-to-end on a real PC: auto-print a label,
// then immediately scan another order with NOTHING clicked — the scan must register.
function restoreMainFocus() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      mainWindow.webContents.focus();
    }
  } catch (_) {}
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

// STARTUP ORDER is load-bearing: nativeTheme 'dark' is forced FIRST (the whole UI
// is dark-mode), which is exactly why slip printing has to force light/white on the
// hidden print page (see printSlip / handleSlipSavePdf). buildAppMenu reads settings
// ONCE here and never rebuilds — see updateTrayMenu note about checkbox desync.
// CHANGE-GUARD: reordering these can break first-paint or leave the tray/menu/
// updater uninitialized. TEST: cold launch shows the dark UI, tray icon appears,
// and Help > Check for Updates works.
app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  buildAppMenu();
  createMainWindow();
  createTray();
  setupAutoUpdater();
});

// ─── Application menu (makes Print Settings discoverable in the menu bar) ──────

// WHAT: builds the native menu bar (File / Printing / Edit / View / Help).
// The Printing submenu's auto-print checkboxes are seeded from a ONE-TIME settings
// snapshot taken here. This menu is built once at startup and never rebuilt.
// CROSS-DEP / GOTCHA: toggling auto-print from the TRAY (updateTrayMenu) writes the
// store but does NOT re-check these menu-bar boxes, so they go stale until restart.
// CHANGE-GUARD: F12 DevTools, CmdOrCtrl+R reload, CmdOrCtrl+P open Print Settings,
// CmdOrCtrl+Q quit — verify all still fire after any edit.
function buildAppMenu() {
  const settings = store.get('printSettings');
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload App', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: 'Quit FWW Shipping', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Printing',
      submenu: [
        { label: 'Print Settings…', accelerator: 'CmdOrCtrl+P', click: () => openPrintManager() },
        { type: 'separator' },
        {
          label: 'Auto-print Labels',
          type: 'checkbox',
          checked: !!settings.autoPrintLabels,
          click: (item) => {
            const s = store.get('printSettings');
            store.set('printSettings', { ...s, autoPrintLabels: item.checked });
            updateTrayMenu();
          },
        },
        {
          label: 'Auto-print Slips',
          type: 'checkbox',
          checked: !!settings.autoPrintSlips,
          click: (item) => {
            const s = store.get('printSettings');
            store.set('printSettings', { ...s, autoPrintSlips: item.checked });
            updateTrayMenu();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates', click: () => { try { checkForUpdatesInteractive(); } catch (_) {} } },
        { label: 'About', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info', title: 'FWW Shipping',
            message: 'FWW Shipping ' + app.getVersion(),
            detail: 'Desktop shell for shipping.fuzzyreporting.com with background printing.\nPrint Settings: menu Printing → Print Settings… (or the 🖨 button / tray icon).',
            buttons: ['OK'],
          });
        } },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', () => { quitting = true; });

// Closing the only window FULLY exits (no macOS-style background app). This is
// intentional on Windows: a lingering process would keep the single-instance lock
// and block the next launch. Do NOT add the usual `if (process.platform !== 'darwin')`
// guard here unless you also rework the lock + tray-keepalive story.
// CHANGE-GUARD: close the window, confirm the process is gone (Task Manager), then
// relaunch — must open cleanly.
app.on('window-all-closed', () => {
  // Closing the window fully exits the app — no lingering background instance
  // that would hold the single-instance lock and block reopening.
  app.quit();
});

// ─── Main window ─────────────────────────────────────────────────────────────

// WHAT: the single visible window that loads the live shipping UI (SHIPPING_URL).
// CRITICAL INVARIANT — partition 'persist:shipping': this named session is where the
// Cloudflare Access identity cookie lives. It MUST match the partition used by every
// hidden print window (printSlip / handleSlipSavePdf) so those authenticated pages can
// fetch slip-render content. Wiping it (reinstall / clearing app data) logs the user
// out of CF Access -> Messages pane 401s (msgWhoami) and slip pages fail to load.
// CHANGE-GUARD: if you rename/remove the partition, TEST: fresh load reaches the UI
// WITHOUT a CF Access login prompt, Messages tab loads, and a slip prints with the
// real logo (auth'd) — not a CF login page.
function createMainWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width:  bounds.width,
    height: bounds.height,
    minWidth:  900,
    minHeight: 640,
    title: APP_NAME,
    icon:  ICON_PATH,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Allow cookies to persist so Cloudflare Access session survives restarts
      partition:        'persist:shipping',
    },
  });

  // Persist window size
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  });

  // Closing the window quits the whole app — no lingering background instance.
  // Destroy any hidden print/helper windows first so nothing keeps the process
  // (and the single-instance lock) alive.
// On close: set quitting, destroy EVERY non-main window (hidden print windows, PDF
// viewers, print manager) so nothing keeps the process / single-instance lock alive,
// then app.quit(). Hidden print windows can outlive a 'normal' close otherwise.
// CHANGE-GUARD: kick off an auto-print, then close the main window mid-print — the
// app must fully exit with no orphaned hidden windows lingering in the background.
  mainWindow.on('close', () => {
    quitting = true;
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w !== mainWindow) { try { w.destroy(); } catch (_) {} }
    });
    app.quit();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Intercept new-window requests (slip-render pages, PDF downloads, etc.)
// NEW-WINDOW ROUTER. Decides what happens when the page opens a new window/tab:
//   - slip-render URLs  -> intercepted, printed/saved by handleSlipPrint, window DENIED
//   - shipping / Google accounts / bridge URLs -> ALLOWED (these are real auth popups)
//   - anything else -> opened in the system browser, window DENIED
// INVARIANT: the slip-render branch MUST run before the allow-list, and the allow-list
// MUST keep accounts.google.com + the bridge host or CF Access / Google login popups
// get hijacked into the external browser and auth breaks.
// CHANGE-GUARD: TEST printing a packing slip (slip window must NOT pop visibly) AND a
// fresh CF Access / Google sign-in (popup must open IN-APP, not in Chrome).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSlipRenderUrl(url)) {
      handleSlipPrint(url);
      return { action: 'deny' };
    }
    // Label / batch-label print-views: the UI opens these expecting the desktop
    // shell to silent-print them, exactly like packing slips (see sendToPrinter in
    // ui.html). Without this branch the window just opens visibly and "the label
    // opens as a PDF" instead of spooling to the Rollo.
    if (isLabelPrintViewUrl(url)) {
      handleLabelPrint(url);
      return { action: 'deny' };
    }
    if (url.startsWith('https://shipping.fuzzyreporting.com') ||
        url.startsWith('https://accounts.google.com') ||
        // CF Access team domain — the login flow 302s shipping.fuzzyreporting.com to
        // https://<team>.cloudflareaccess.com/cdn-cgi/access/login/... When any step of that flow
        // opens as a POPUP (a new window, which is all setWindowOpenHandler governs), this branch must
        // catch it or the popup falls through to shell.openExternal() below — ejected to the system
        // browser, where it CANNOT complete back into the app's persist:shipping session, so login
        // silently dies. This bit ONLY out-of-org users (7/27: erin.m.karson@gmail.com, the sole
        // non-@fuzzywumpets.com account): in-org Workspace logins flow as top-level redirects that
        // setWindowOpenHandler never sees, while an external Google account gets an extra interstitial
        // that opens as a popup and hit this gap. The team domain was never in the allow-list — a
        // hardcoded dependency on the login flow's exact domains that silently omitted this one.
        // Matches any <team>.cloudflareaccess.com so a team-domain rename can't re-break it.
        /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//i.test(url) ||
        url.startsWith('https://fww-shipping-bridge.')) {
      // Let auth popups open normally
      return { action: 'allow' };
    }
    // Other links open in default browser
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Inject print interception after each page load
  mainWindow.webContents.on('did-finish-load', () => {
    injectPrintInterceptor(mainWindow.webContents);
    injectPrintButton(mainWindow.webContents);
  });

  // Show window once page is ready (avoids white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

// did-finish-load re-injects BOTH the print interceptor and the floating settings
// button on EVERY navigation (SPA route changes included). Both injectors are
// idempotent via window.__fww* guards, so re-running is safe and required — a single
// inject would be lost on reload/login redirect.
// CHANGE-GUARD: reload the app (CmdOrCtrl+R); the 🖨 button must reappear and label
// auto-print must still fire (the fetch patch must be re-applied).
  mainWindow.loadURL(SHIPPING_URL);
}

// ─── Inject fetch/print interceptor into the shipping page ────────────────────
//
// Runs in the MAIN (page) world. Patches window.fetch to detect label PDF
// responses and dispatches a CustomEvent that the preload catches.

// WHAT: runs in the PAGE world; monkey-patches window.fetch to sniff label PDFs.
// When a fetch to '/label' returns application/pdf, it reads x-label-id /
// x-tracking-number headers, base64-encodes the body, and dispatches DOM event
// 'fww:label-pdf' (preload forwards it to ipc 'print:label-pdf' -> silentPrintPdfBuffer).
// INVARIANTS: (1) guarded by window.__fwwPrintInjected so a re-inject is a no-op.
// (2) it reads res.CLONE().arrayBuffer() — never the original body — so the page's own
// label download/preview still works. (3) base64 is built in 8KB chunks to avoid a
// String.fromCharCode stack overflow on large PDFs.
// CROSS-DEP: depends on the bridge worker setting content-type application/pdf AND the
// x-label-id / x-tracking-number response headers on the /label route.
// CHANGE-GUARD: buy a label and confirm it auto-prints; if you change the URL match or
// headers, TEST that the PDF is still captured and the on-page label preview still opens.
function injectPrintInterceptor(wc) {
  const code = `
(function() {
  if (window.__fwwPrintInjected) return;
  window.__fwwPrintInjected = true;

  // Intercept fetch calls to /label to detect PDF responses
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const res = await _origFetch(...args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      const ct  = res.headers.get('content-type') || '';
// MATCH CONTRACT: only fetches whose URL is exactly '/label' or ends in '/label' AND
// whose response is application/pdf are captured. If the bridge ever serves labels from
// a different path or as octet-stream, this silently stops auto-printing.
// CHANGE-GUARD: after any bridge label-route change, buy a label and confirm the hidden
// printer fires (check console for '[fww-print] label ... printed').
      if ((url === '/label' || url.endsWith('/label')) && ct.includes('application/pdf')) {
        const labelId   = res.headers.get('x-label-id') || 'unknown';
        const trackNum  = res.headers.get('x-tracking-number') || '';
        const clone     = res.clone();
        clone.arrayBuffer().then(buf => {
          // Convert ArrayBuffer → base64 in chunks to avoid stack overflow
          const bytes  = new Uint8Array(buf);
          let binary   = '';
          const chunk  = 8192;
          for (let i = 0; i < bytes.byteLength; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
          }
          const b64 = btoa(binary);
          document.dispatchEvent(new CustomEvent('fww:label-pdf', {
            detail: { labelId, trackingNumber: trackNum, data: b64 }
          }));
        }).catch(e => console.warn('[fww-desktop] label pdf intercept error:', e));
      }
    } catch(_) {}
    return res;
  };

  // Intercept window.print() calls on this page (shouldn't happen on /ui
  // but just in case)
  const _origPrint = window.print;
  window.print = function() {
    const url = window.location.href;
    if (url.includes('/slip-render')) {
      document.dispatchEvent(new CustomEvent('fww:slip-print', { detail: { url } }));
    } else {
      _origPrint.call(window);
    }
  };
})();
  `;
  wc.executeJavaScript(code).catch(() => {});
}

// Inject a floating "Print Settings" button into the shipping app
// WHAT: injects the floating 🖨 'Print Settings' button (bottom-right) into the page.
// Click dispatches DOM event 'fww:open-print-manager' -> preload -> ipc 'print:open-manager'
// -> openPrintManager(). Guarded by window.__fwwPrintBtnInjected (idempotent re-inject).
// CHANGE-GUARD: the 🖨 button must appear after every load AND clicking it must open the
// Print Settings window (it's one of three entry points: button, menu, tray).
function injectPrintButton(wc) {
  const code = `
(function() {
  if (window.__fwwPrintBtnInjected) return;
  window.__fwwPrintBtnInjected = true;
  const btn = document.createElement('button');
  btn.id = 'fww-print-settings-btn';
  btn.title = 'Print Settings';
  btn.innerHTML = '&#128438;';
  btn.style.cssText = [
    'position:fixed','bottom:18px','right:18px','z-index:99999',
    'width:40px','height:40px','border-radius:50%','border:none',
    'background:#9BBC0E','color:#1a1a1a','font-size:18px',
    'cursor:pointer','box-shadow:0 2px 8px rgba(0,0,0,.5)',
    'display:flex','align-items:center','justify-content:center',
    'padding:0','line-height:1'
  ].join(';');
  btn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('fww:open-print-manager'));
  });
  document.body.appendChild(btn);
})();
  `;
  wc.executeJavaScript(code).catch(() => {});
}

// ─── Slip print flow ──────────────────────────────────────────────────────────

// WHAT: identifies packing-slip / pick-list render URLs so setWindowOpenHandler can
// intercept and print them instead of opening a visible window.
// CHANGE-GUARD: if the bridge's slip-render path changes, update this matcher or slip
// printing/saving silently breaks (the window would open visibly instead).
function isSlipRenderUrl(url) {
  return url.includes('/slip-render') || url.includes('slip-render');
}

// SLIP PRINT ROUTER. Three branches by URL/settings:
//   1. ?out=pdf  -> handleSlipSavePdf (render to PDF + show in viewer; manual override)
//   2. autoPrintSlips OFF -> open in default browser for manual print
//   3. no slipPrinter set -> dialog offering Print Settings vs manual
//   else -> printSlip (silent hidden-window print).
// CHANGE-GUARD: TEST all 3 paths: (a) the 'Open as PDF' button, (b) auto-print off opens
// the browser, (c) auto-print on with no printer set shows the config dialog.
function handleSlipPrint(slipUrl) {
  // "Open as PDF" — render the slips to a PDF in an authenticated hidden window and
  // let the user save it (default name packingslips-YYMMDD-HHMMSS.pdf). Controlled
  // printToPDF avoids browser/Cloudflare-Access variability and always names + writes
  // a valid file (it waits for the logo image to finish loading first).
// The 'Open as PDF' override is signalled purely by an out=pdf query param on the slip
// URL (set by the UI button). If the UI stops appending it, slips silently go to the
// printer instead of opening the save/preview viewer.
// CHANGE-GUARD: click 'Open as PDF' and confirm a Chromium PDF viewer window opens
// (named packingslips-YYMMDD-HHMMSS.pdf) rather than the slip going to the printer.
  if (/[?&]out=pdf/.test(slipUrl)) {
    return handleSlipSavePdf(slipUrl);
  }
  const settings = store.get('printSettings');
  if (!settings.autoPrintSlips) {
    // Auto-print off: open in default browser so user can print manually
    shell.openExternal(slipUrl);
    return;
  }
  if (!settings.slipPrinter) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'No Slip Printer Configured',
      message: 'Please configure your packing slip printer in Print Settings before printing.',
      buttons: ['Open Print Settings', 'Print Manually'],
    }).then(({ response }) => {
      if (response === 0) openPrintManager();
      else shell.openExternal(slipUrl);
    });
    return;
  }
  printSlip(slipUrl, settings);
}

// ─── Label print flow ─────────────────────────────────────────────────────────
//
// The shipping UI prints labels the SAME way it prints packing slips: it opens an
// HTML auto-print page (/label/print-view?label_id=… for a single buy,
// /batch/print-view?batch_id=… for a batch) in a new window and relies on the
// desktop shell to capture it and silent-print. A raw PDF window can't be auto-
// printed by Electron; an HTML print-view can. This mirrors handleSlipPrint but
// routes to the LABEL printer (Rollo) at 4×6.

function isLabelPrintViewUrl(url) {
  return url.includes('/label/print-view') || url.includes('/batch/print-view');
}

function handleLabelPrint(labelUrl) {
  // "Open as PDF" toggle (output dropdown) — render to a saved PDF instead of
  // spooling, matching the slip out=pdf path.
  if (/[?&]out=pdf/.test(labelUrl)) {
    return handleLabelSavePdf(labelUrl);
  }
  const settings = store.get('printSettings');
  if (!settings.autoPrintLabels) {
    // Auto-print off: open in default browser so the user can print manually
    shell.openExternal(labelUrl);
    return;
  }
  if (!settings.labelPrinter) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'No Label Printer Configured',
      message: 'Please configure your shipping label printer (e.g. Rollo) in Print Settings before printing.',
      buttons: ['Open Print Settings', 'Print Manually'],
    }).then(({ response }) => {
      if (response === 0) openPrintManager();
      else shell.openExternal(labelUrl);
    });
    return;
  }
  printLabelViaPdf(labelUrl, settings);
}

// ─── Save batch/label print-view to a PDF (manual override) ──────────────────

function handleLabelSavePdf(url) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition:        'persist:shipping',
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  // Neutralize the page's own window.print() so only our printToPDF runs.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript('window.print = function(){};').catch(() => {});
  });
  win.webContents.on('did-finish-load', async () => {
    // Wait for the label images to finish loading before rendering. A batch can be
    // dozens of remote PNGs, so cap high (140s) rather than save a blank-page PDF.
    try {
      await win.webContents.executeJavaScript(
        'new Promise(function(res){var imgs=[].slice.call(document.images);' +
        'var n=imgs.filter(function(i){return !i.complete}).length;' +
        'if(!n)return res();imgs.forEach(function(i){if(!i.complete){' +
        'i.addEventListener("load",function(){if(--n<=0)res()});' +
        'i.addEventListener("error",function(){if(--n<=0)res()});}});' +
        'setTimeout(res,140000);})'
      );
    } catch (e) {}
    const settings = store.get('printSettings');
    try {
      // UNIT MISMATCH (fixed 7/22 — "Label PDF download: blank"). Electron's TWO print APIs disagree:
      //   webContents.print()     -> custom pageSize in MICRONS
      //   webContents.printToPDF() -> custom pageSize in INCHES
      // printSettings stores MICRONS (labelPaperWidth 101600 = 4in) because every other consumer in
      // this file is print(). Passing them straight to printToPDF requested a 101600 x 152400 INCH
      // page, so the 4x6 label rendered as a speck in the corner of an enormous sheet — the saved PDF
      // opened BLANK. The slip PDF was never affected: it passes the string 'Letter' (no units).
      // CHANGE-GUARD: "Label PDF" on a shipped order must open a PDF showing the FULL 4x6 label.
      const MICRONS_PER_INCH = 25400;
      const _wIn = (Number(settings.labelPaperWidth)  || 101600) / MICRONS_PER_INCH;
      const _hIn = (Number(settings.labelPaperHeight) || 152400) / MICRONS_PER_INCH;
      const data = await win.webContents.printToPDF({
        printBackground: true,
        pageSize:        { width: _wIn, height: _hIn },
        margins:         { marginType: 'none' },
      });
      win.destroy();
      const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
      const fname = 'labels-' + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate())
        + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.pdf';
      const tmpPath = path.join(os.tmpdir(), fname);
      fs.writeFileSync(tmpPath, data);
      const viewer = new BrowserWindow({ width: 560, height: 900, title: fname, autoHideMenuBar: true, webPreferences: { plugins: true } });
      viewer.loadURL('file:///' + tmpPath.replace(/\\/g, '/'));
      if (mainWindow) mainWindow.webContents.send('print:status', { type: 'label-pdf', success: true, path: tmpPath, timestamp: Date.now() });
    } catch (err) {
      console.error('[fww-print] label PDF save failed:', err);
      if (mainWindow) mainWindow.webContents.send('print:status', { type: 'label-pdf', success: false, reason: String(err), timestamp: Date.now() });
      win.destroy();
      restoreMainFocus();
    }
  });
  win.loadURL(url);
}

// Auto-print a label print-view page — mirrors printSlip EXACTLY (direct HTML print).
// WHY NOT round-trip through a PDF (the old v1.0.14 behavior): the app forces dark mode
// (nativeTheme 'dark', see app.whenReady), and reprinting a PDF through Chromium's
// built-in PDF viewer captures THAT viewer's dark canvas with printBackground -> a
// SOLID BLACK 4×6 label. This is the identical bug packing slips already hit and fixed
// (see printSlip's comment). The fix is the same: print the print-view HTML DIRECTLY —
// @media print emulation plus an injected light color-scheme/white background render it
// WHITE with black barcodes — then silent-print to the LABEL printer (Rollo) at 4×6. No
// intermediate PDF, no PDF viewer, no black. Every exit path is guarded (hard timeout,
// did-fail-load, error dialog) so it can never spin forever with no feedback.
// CHANGE-GUARD: buy a label with auto-print ON — it MUST spool a normal white, scannable
// 4×6 to the label printer (not a black rectangle); then a 2nd barcode scan must register.
function printLabelViaPdf(url, settings) {
  // A single label loads one PNG, but /batch/print-view can pull DOZENS of remote
  // ShipStation PNG URLs — a 25-label batch can legitimately take a minute-plus to
  // fully load. Keep the budget generous so a slow batch spools complete instead of
  // capturing blank pages. (The real speed fix is server-side: serve a merged PDF.)
  const LABEL_TIMEOUT_MS = 150000;
  let win     = null;
  let settled = false;
  let httpStatus = 200;   // main-frame HTTP status of the print-view — guard so we NEVER print an error page

  const finish = (success, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    if (success) {
      console.log(`[fww-print] label printed to "${settings.labelPrinter}"`);
    } else {
      console.error(`[fww-print] label print failed (${settings.labelPrinter}): ${reason}`);
    }
    if (mainWindow) {
      mainWindow.webContents.send('print:status', {
        type: 'label', success, reason: reason || null, printer: settings.labelPrinter, timestamp: Date.now(),
      });
    }
    if (!success && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Label Did Not Print',
        message: `The shipping label could not be printed to "${settings.labelPrinter}".`,
        detail: String(reason || 'Unknown error') +
          '\n\nCheck that the printer is online and selected in Print Settings, then try again.',
        buttons: ['OK'],
      }).catch(() => {});
    }
    // Give the spooler a moment to pick up the job before tearing the window down.
    setTimeout(() => {
      try { if (win) win.destroy(); } catch (_) {}
      // INVARIANT: every hidden-window teardown must restore focus or the next
      // barcode scan's keystrokes never reach the page (dead scanner after print).
      restoreMainFocus();
    }, 1500);
  };

  const guard = setTimeout(
    () => finish(false, `Timed out after ${LABEL_TIMEOUT_MS / 1000}s loading the label`),
    LABEL_TIMEOUT_MS
  );

  // Inherit the shipping session so Cloudflare Access cookies apply. White window
  // background so nothing dark ever shows through (dark-mode safety, like printSlip).
  win = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition:        'persist:shipping',
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  // Neutralize the page's own window.print() AND window.close(): the label print-view
  // self-prints (img onload -> window.print) and self-closes (afterprint -> window.close,
  // see labelPrintView in the bridge). We drive the print ourselves; if the page is allowed
  // to close itself, it tears the webContents down mid-spool on a real label (which takes
  // longer than the tiny "no label found" text page) and webContents.print() aborts with
  // success=false and an EMPTY reason — exactly the failure we saw. We own teardown (finish).
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript('window.print=function(){};window.close=function(){};').catch(() => {});
  });

  win.webContents.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame) finish(false, `Failed to load label page: ${desc} (${code})`);
  });

  // Capture the print-view's main-frame HTTP status. The bridge returns 404 "no label
  // found" when a label isn't in ShipStation (e.g. one created outside this app); printing
  // that 404 body is what spooled the black 4×6 (1.0.14) / "no label found" text (1.0.15).
  win.webContents.on('did-navigate', (_e, _navUrl, code) => { if (code) httpStatus = code; });

  win.webContents.on('did-finish-load', async () => {
    // GUARD 1: never print an error page. If the print-view came back 4xx/5xx (no label in
    // ShipStation for this order), bail with a clear message instead of spooling garbage.
    if (httpStatus >= 400) {
      return finish(false,
        `No label found in ShipStation for this order (print-view returned HTTP ${httpStatus}), so there is nothing to reprint. Labels created outside this app can't be reprinted here.`);
    }

    // Force a light color scheme + white background (the app runs in forced dark mode),
    // THEN wait for the label PNG(s) to finish so we never spool a half-loaded page. A
    // batch can be dozens of remote PNGs, so cap the image wait high (140s).
    try {
      await win.webContents.executeJavaScript(
        '(function(){try{var s=document.createElement("style");' +
        's.textContent=":root{color-scheme:light!important}html,body{background:#fff!important}";' +
        '(document.head||document.documentElement).appendChild(s);}catch(e){}})();' +
        'new Promise(function(res){var imgs=[].slice.call(document.images);' +
        'var n=imgs.filter(function(i){return !i.complete}).length;' +
        'if(!n)return res();imgs.forEach(function(i){if(!i.complete){' +
        'i.addEventListener("load",function(){if(--n<=0)res()});' +
        'i.addEventListener("error",function(){if(--n<=0)res()});}});' +
        'setTimeout(res,140000);})'
      );
    } catch (_) {}

    // GUARD 2: a 200 page with NO loaded label image is also nothing worth printing (a
    // blank/placeholder page, or a CF Access re-login that 200s). Confirm at least one real
    // label image before spooling, so we never send a blank/garbage page to the Rollo.
    let labelImgCount = 0;
    try {
      labelImgCount = await win.webContents.executeJavaScript(
        '[].slice.call(document.images).filter(function(i){return i.complete && i.naturalWidth>0;}).length'
      );
    } catch (_) {}
    if (!labelImgCount) {
      return finish(false,
        'The label print-view rendered no label image — nothing to print. The label may not be available in ShipStation for this order.');
    }

    // Print the print-view HTML DIRECTLY to the label printer at 4×6. Options MATCH the
    // proven Test-Print path (buildTestLabelHtml → print) EXACTLY. Do NOT add
    // printBackground or scaleFactor here: on a direct HTML print to the Rollo they made
    // webContents.print reject the job (success=false, empty reason) — the label reprint
    // silently failed with "Label Did Not Print". The 1.0.14 code only survived
    // scaleFactor:100 because it was printing a PDF (which ignores it). The label is a PNG
    // <img> (prints regardless of printBackground) and the injected light color-scheme +
    // white bg keep it white despite the app's forced dark mode.
    const opts = {
      silent:     true,
      deviceName: settings.labelPrinter,
      copies:     settings.labelCopies || 1,
      pageSize:   { width: settings.labelPaperWidth, height: settings.labelPaperHeight },
      margins:    { marginType: 'none' },
      landscape:  false,
    };
    win.webContents.print(opts, (success, reason) => {
      finish(success, success ? null : reason);
    });
  });

  win.loadURL(url);
}

// ─── Save packing slips / pick list to a PDF (manual override) ───────────────

// WHAT: renders the slip page to a Letter PDF in a HIDDEN authenticated window, writes
// it to a temp file, then shows it in a Chromium PDF viewer window (its own Save/Print).
// WHY printToPDF (not browser print): deterministic naming + always writes a valid file,
// avoiding CF-Access/browser variability. It WAITS for <img> (the logo) to finish — a
// fixed timeout could snapshot mid-render and produce a complete-but-corrupt PDF that
// Edge refuses to open; capped at 4s.
// INVARIANT: uses partition 'persist:shipping' so the slip page is authenticated.
// BUG-WATCH: there is NO did-fail-load handler and NO timeout here — if the page never
// finishes loading, the hidden window leaks and focus is never restored (see bug report).
// CHANGE-GUARD: 'Open as PDF' must produce a PDF that opens cleanly in Edge/Acrobat WITH
// the FWW logo visible (not a blank/black page).
function handleSlipSavePdf(url) {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  // ROBUSTNESS (mirrors printSlip): a single-fire `settled` latch + a 30s hard
  // timeout guard + a did-fail-load handler. did-finish-load is NOT guaranteed to
  // fire (CF Access redirect / network error) — without these the hidden window
  // leaks and focus is never restored. SUCCESS intentionally hands focus to the
  // visible viewer, so finish(true) does NOT destroy the hidden win or restore
  // focus; only the failure path tears the hidden window down + restoreMainFocus().
  const SLIP_PDF_TIMEOUT_MS = 30000;
  let win     = null;
  let settled = false;

  const finish = (success, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    if (success) return; // success path destroys the hidden win itself + keeps viewer focus
    console.error('[fww-print] slip PDF save failed:', reason);
    if (mainWindow) mainWindow.webContents.send('print:status', { type: 'slip-pdf', success: false, reason: String(reason), timestamp: Date.now() });
    try { if (win) win.destroy(); } catch (_) {}
    restoreMainFocus();
  };

  // Hard safety net so a slow/stuck slip page can never hang indefinitely.
  const guard = setTimeout(
    () => finish(false, `Timed out after ${SLIP_PDF_TIMEOUT_MS / 1000}s loading the packing slip`),
    SLIP_PDF_TIMEOUT_MS
  );

  win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition:        'persist:shipping',
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  // Neutralize the page's own window.print() so only our printToPDF runs.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript('window.print = function(){};').catch(() => {});
  });
  win.webContents.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame) finish(false, `Failed to load slip page: ${desc} (${code})`);
  });
  win.webContents.on('did-finish-load', async () => {
    // Wait until images (the logo) actually finish loading before rendering. A fixed
    // timeout could capture the page mid-render → a complete-but-corrupt PDF that
    // readers like Edge refuse to open. Cap the wait at 4s as a safety net.
    try {
      await win.webContents.executeJavaScript(
        'new Promise(function(res){var imgs=[].slice.call(document.images);' +
        'var n=imgs.filter(function(i){return !i.complete}).length;' +
        'if(!n)return res();imgs.forEach(function(i){if(!i.complete){' +
        'i.addEventListener("load",function(){if(--n<=0)res()});' +
        'i.addEventListener("error",function(){if(--n<=0)res()});}});' +
        'setTimeout(res,4000);})'
      );
    } catch (e) {}
    try {
      const data = await win.webContents.printToPDF({
        printBackground: true,
        pageSize:        'Letter',
        margins:         { marginType: 'default' },
      });
      finish(true); // latch + clear the timeout guard so a late fail/timeout can't fire
      win.destroy();
      const d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
      const fname = 'packingslips-' + String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate())
        + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.pdf';
      const tmpPath = path.join(os.tmpdir(), fname);
      fs.writeFileSync(tmpPath, data);
      // Show the generated PDF in a browser-style window — Chromium's built-in PDF
      // viewer, which has its own Save + Print controls. No save-folder prompt.
      const viewer = new BrowserWindow({ width: 920, height: 1100, title: fname, autoHideMenuBar: true, webPreferences: { plugins: true } });
      viewer.loadURL('file:///' + tmpPath.replace(/\\/g, '/'));
      if (mainWindow) mainWindow.webContents.send('print:status', { type: 'slip-pdf', success: true, path: tmpPath, timestamp: Date.now() });
    } catch (err) {
      finish(false, err); // destroys the hidden win once + restoreMainFocus() + sends failure status
    }
  });
  win.loadURL(url);
}

// ─── Silent printing via hidden BrowserWindow ────────────────────────────────

// Auto-print packing slips by printing the slip-render HTML page DIRECTLY in a
// hidden window. We deliberately do NOT render to an intermediate PDF and then
// reprint it: the app forces dark mode (nativeTheme 'dark'), and printing a PDF
// through Chromium's built-in PDF viewer captures that viewer's dark/black
// canvas with printBackground -> a solid black page. Printing the HTML directly
// uses print emulation (@media print), which the slip page renders white.
//
// We keep robust guards so this can never just "spin forever and go away":
//   - the page's own window.print() is neutralized (we drive the print)
//   - a hard timeout, a did-fail-load handler, and a visible error dialog
//   - we wait for the logo image to finish loading before printing
//   - we force a light color scheme + white background as a dark-mode safety net
// WHAT: silently auto-prints a packing slip by printing the slip-render HTML DIRECTLY
// in a hidden window to settings.slipPrinter.
// WHY direct HTML (not PDF): the app forces dark mode; reprinting a PDF via Chromium's
// PDF viewer captures its dark canvas -> solid black page. Direct HTML uses @media print
// emulation, which renders white. A light color-scheme + white-bg style is also injected
// as a dark-mode safety net.
// ROBUSTNESS (the GOOD template other print fns should copy): 30s hard timeout guard,
// did-fail-load handler, a single-fire `settled` latch, neutralized page window.print(),
// 4s image wait, visible error dialog on failure, and a 1.5s delay before destroy so the
// spooler grabs the job — then restoreMainFocus().
// INVARIANT: partition 'persist:shipping' (authenticated slip page).
// CHANGE-GUARD: print a real multi-item slip — must come out WHITE with the logo, to the
// configured slip printer; pull the printer offline and confirm the error dialog appears
// (no infinite spin).
function printSlip(url, settings) {
// The `settled` latch + clearTimeout(guard) inside finish() guarantee EXACTLY-ONCE
// completion: did-finish-load success, did-fail-load failure, and the timeout can race,
// but only the first wins. Do not remove the latch — duplicate finishes would double-
// report status and double-destroy the window.
// CHANGE-GUARD: simulate a slow slip page (>30s) and confirm exactly one error dialog
// and one window teardown.
  const SLIP_TIMEOUT_MS = 30000;
  let win     = null;
  let settled = false;

  const finish = (success, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    if (success) {
      console.log(`[fww-print] slip printed to "${settings.slipPrinter}"`);
    } else {
      console.error(`[fww-print] slip print failed (${settings.slipPrinter}): ${reason}`);
    }
    if (mainWindow) {
      mainWindow.webContents.send('print:status', {
        type: 'slip', success, reason: reason || null, printer: settings.slipPrinter, timestamp: Date.now(),
      });
    }
    if (!success && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Packing Slip Did Not Print',
        message: `The packing slip could not be printed to "${settings.slipPrinter}".`,
        detail: String(reason || 'Unknown error') +
          '\n\nCheck that the printer is online and selected in Print Settings, then try again.',
        buttons: ['OK'],
      }).catch(() => {});
    }
    // Give the spooler a moment to pick up the job before tearing the window down.
    setTimeout(() => { try { if (win) win.destroy(); } catch (_) {} restoreMainFocus(); }, 1500);
  };

  // Hard safety net so a slow/stuck slip page can never hang indefinitely.
  const guard = setTimeout(
    () => finish(false, `Timed out after ${SLIP_TIMEOUT_MS / 1000}s loading the packing slip`),
    SLIP_TIMEOUT_MS
  );

  // Inherit the same session so Cloudflare Access cookies apply. White window
  // background so nothing dark ever shows through.
  win = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition:        'persist:shipping',
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  // Neutralize the page's own window.print() so it can't fire an unmanaged
  // print (or hang) — we drive printing ourselves once the page is ready.
  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript('window.print = function(){};').catch(() => {});
  });

  win.webContents.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame) finish(false, `Failed to load slip page: ${desc} (${code})`);
  });

  win.webContents.on('did-finish-load', async () => {
    // Force a light color scheme + white background (the app runs in forced dark
    // mode), then wait for images (the logo) to finish so nothing prints
    // half-loaded. Cap the image wait at 4s as a safety net.
    try {
      await win.webContents.executeJavaScript(
        '(function(){try{var s=document.createElement("style");' +
        's.textContent=":root{color-scheme:light!important}html,body{background:#fff!important}";' +
        '(document.head||document.documentElement).appendChild(s);}catch(e){}})();' +
        'new Promise(function(res){var imgs=[].slice.call(document.images);' +
        'var n=imgs.filter(function(i){return !i.complete}).length;' +
        'if(!n)return res();imgs.forEach(function(i){if(!i.complete){' +
        'i.addEventListener("load",function(){if(--n<=0)res()});' +
        'i.addEventListener("error",function(){if(--n<=0)res()});}});' +
        'setTimeout(res,4000);})'
      );
    } catch (_) {}

    const opts = {
      silent:          true,
      printBackground: true,
      deviceName:      settings.slipPrinter,
      copies:          settings.slipCopies || 1,
      pageSize:        settings.slipPaperSize || 'Letter',
      margins:         { marginType: 'printableArea' },
      landscape:       false,
    };
    win.webContents.print(opts, (success, reason) => {
      finish(success, success ? null : reason);
    });
  });

  win.loadURL(url);
}

// WHAT: silently prints a LABEL PDF (already captured as a base64 buffer by the fetch
// interceptor) to settings.labelPrinter in a hidden window. Label uses the 4x6 paper
// size from settings (labelPaperWidth/Height in MICRONS) with marginType 'none' and
// scaleFactor 100 so the label is not shrunk.
// INVARIANT: writes a temp PDF, prints it, then fs.unlink's it in the print callback;
// restoreMainFocus() runs 1.5s after the job so the scanner keeps working.
// BUG-WATCH: unlike printSlip there is NO timeout and NO did-fail-load handler here — if
// did-finish-load never fires (corrupt/empty PDF), the temp file + hidden window LEAK,
// focus is never restored, and the failure is never reported (see bug report).
// CHANGE-GUARD: buy a label and confirm it prints at correct 4x6 size (not shrunk/rotated)
// to the label printer, and that a 2nd scan still registers afterward.
function silentPrintPdfBuffer(buf, labelId, settings) {
  const tmpPath = path.join(os.tmpdir(), `fww-label-${labelId}-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, buf);
  } catch (e) {
    console.error('[fww-print] could not write temp PDF:', e.message);
    return;
  }

  // ROBUSTNESS (mirrors printSlip): single-fire `settled` latch + 30s hard timeout
  // guard + did-fail-load handler. did-finish-load is NOT guaranteed to fire for a
  // corrupt/empty PDF or a load error — without these the temp file + hidden window
  // LEAK, focus is never restored, and the failure is never reported.
  const LABEL_TIMEOUT_MS = 30000;
  let settled = false;

  const cleanup = () => {
    fs.unlink(tmpPath, () => {});
    try { printWin.destroy(); } catch (_) {}
    restoreMainFocus();
  };
  const fail = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    console.error(`[fww-print] label print failed: ${reason}`);
    mainWindow?.webContents.send('print:status', {
      type: 'label', success: false, reason: String(reason), printer: settings.labelPrinter, timestamp: Date.now(),
    });
    cleanup();
  };

  // Hard safety net so a stuck/corrupt label PDF can never hang indefinitely.
  const guard = setTimeout(
    () => fail(`Timed out after ${LABEL_TIMEOUT_MS / 1000}s loading the label PDF`),
    LABEL_TIMEOUT_MS
  );

  // White window bg so nothing dark ever shows through behind the PDF.
  const printWin = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  printWin.webContents.on('did-fail-load', (e, code, desc, validatedURL, isMainFrame) => {
    if (isMainFrame) fail(`Failed to load label PDF: ${desc} (${code})`);
  });

  printWin.webContents.on('did-finish-load', () => {
    // Latch so the 30s guard / did-fail-load can't fire after we begin printing.
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    const opts = {
      silent:          true,
      // printBackground:false so the dark PDF-viewer canvas (the app is in forced dark
      // mode) is NOT captured — otherwise this raw-PDF fallback path spools a solid-black
      // label. The label's own black marks still print; the paper stays white. (The live
      // path is printLabelViaPdf, which prints the HTML print-view directly like slips.)
      printBackground: false,
      deviceName:      settings.labelPrinter,
      copies:          settings.labelCopies || 1,
      pageSize:        { width: settings.labelPaperWidth, height: settings.labelPaperHeight },
      margins:         { marginType: 'none' },
      landscape:       false,
      scaleFactor:     100,
    };
    printWin.webContents.print(opts, (success, reason) => {
      fs.unlink(tmpPath, () => {});
      if (!success) {
        console.error(`[fww-print] label print failed: ${reason}`);
        mainWindow?.webContents.send('print:status', {
          type: 'label', success: false, reason, printer: settings.labelPrinter, timestamp: Date.now(),
        });
      } else {
        console.log(`[fww-print] label ${labelId} printed to "${settings.labelPrinter}"`);
        mainWindow?.webContents.send('print:status', {
          type: 'label', success: true, labelId, printer: settings.labelPrinter, timestamp: Date.now(),
        });
      }
      setTimeout(() => { printWin.destroy(); restoreMainFocus(); }, 1500);
    });
  });

  printWin.loadURL(`file://${tmpPath}`);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Label PDF received from page (base64-encoded)
// IPC ENTRY for label auto-print. Fired by preload when the page dispatches
// 'fww:label-pdf' (from the fetch interceptor). Honors autoPrintLabels; if no
// labelPrinter is configured it reports failure AND pops Print Settings.
// CHANGE-GUARD: with auto-print OFF a bought label must NOT print; with it ON and a
// printer set, it must; with it ON and NO printer set, Print Settings must open.
ipcMain.on('print:label-pdf', (event, { labelId, data }) => {
  const settings = store.get('printSettings');
  if (!settings.autoPrintLabels) {
    console.log('[fww-print] auto-print labels disabled, skipping');
    return;
  }
  if (!settings.labelPrinter) {
    mainWindow?.webContents.send('print:status', {
      type: 'label', success: false, reason: 'No label printer configured',
    });
    openPrintManager();
    return;
  }
// `data` is the base64 the interceptor built in 8KB chunks. This must round-trip the
// raw PDF bytes exactly — if the interceptor's chunking/encoding is changed, a corrupt
// buffer prints blank or fails silently.
// CHANGE-GUARD: after any interceptor edit, diff a printed label against the on-screen
// preview — barcode must scan.
  const buf = Buffer.from(data, 'base64');
  silentPrintPdfBuffer(buf, labelId, settings);
});

// Slip print triggered from page
ipcMain.on('print:slip-url', (event, { url }) => {
  handleSlipPrint(url); // (removed an unused store.get(printSettings) read; handleSlipPrint re-reads it)
});

// Open print manager window
ipcMain.on('print:open-manager', () => openPrintManager());

// Get available printers
// Returns the OS printer list via the MAIN window's webContents (getPrintersAsync needs
// a live webContents). Returns [] if mainWindow is gone or the call throws.
// CHANGE-GUARD: open Print Settings and confirm the label/slip printer dropdowns are
// populated with real OS printers.
ipcMain.handle('printers:list', async () => {
  if (!mainWindow) return [];
  try {
    return await mainWindow.webContents.getPrintersAsync();
  } catch (e) {
    return [];
  }
});

// Settings get/set
ipcMain.handle('settings:get', () => store.get('printSettings'));

ipcMain.handle('settings:set', (event, newSettings) => {
  const current = store.get('printSettings');
  store.set('printSettings', { ...current, ...newSettings });
  return store.get('printSettings');
});

// Test print
// WHAT: 'Test Print' for label/slip from Print Settings — renders a self-contained test
// HTML (buildTestLabelHtml / buildTestSlipHtml) and prints it with the SAME paper/margin
// options the real printers use (4x6 microns + no margins for labels; slipPaperSize +
// printableArea for slips). This validates printer + paper config without a real order.
// CHANGE-GUARD: if you change real-print options in printSlip/silentPrintPdfBuffer, mirror
// them here or 'Test Print OK' will lie about real-world output.
ipcMain.handle('print:test', async (event, { type }) => {
  const settings = store.get('printSettings');
  const printerName = type === 'label' ? settings.labelPrinter : settings.slipPrinter;
  if (!printerName) return { success: false, reason: 'No printer configured' };

  const testWin = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true },
  });

  return new Promise((resolve) => {
    testWin.webContents.on('did-finish-load', () => {
      const opts = {
        silent: true,
        deviceName: printerName,
        copies: 1,
      };
      if (type === 'label') {
        opts.pageSize  = { width: settings.labelPaperWidth, height: settings.labelPaperHeight };
        opts.margins   = { marginType: 'none' };
        opts.landscape = false;
      } else {
        opts.pageSize  = settings.slipPaperSize;
        opts.margins   = { marginType: 'printableArea' };
      }
      testWin.webContents.print(opts, (success, reason) => {
        testWin.destroy();
        resolve({ success, reason: reason || null });
      });
    });

    const testHtml = type === 'label'
      ? buildTestLabelHtml()
      : buildTestSlipHtml();
    testWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(testHtml)}`);
  });
});

// App version
ipcMain.handle('app:version', () => app.getVersion());

// ─── Print manager window ─────────────────────────────────────────────────────

// WHAT: opens (or focuses, if already open) the Print Settings window (print-manager.html).
// Singleton guarded by printManagerWindow + isDestroyed(). Uses the SAME preload, which
// exposes printManagerAPI only on file:// pages. On close it restoreMainFocus() so the
// scanner survives.
// CHANGE-GUARD: open Print Settings twice — second click must focus the existing window,
// not spawn a duplicate; after closing it, a scan must still register.
function openPrintManager() {
  if (printManagerWindow && !printManagerWindow.isDestroyed()) {
    printManagerWindow.focus();
    return;
  }
  printManagerWindow = new BrowserWindow({
    width:  620,
    height: 760,
    title:  'Print Settings — FWW Shipping',
    icon:   ICON_PATH,
    parent: mainWindow || undefined,
    modal:  false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });
  printManagerWindow.once('ready-to-show', () => printManagerWindow.show());
  printManagerWindow.on('closed', () => { printManagerWindow = null; restoreMainFocus(); });
  printManagerWindow.loadFile(path.join(__dirname, 'print-manager.html'));
}

// ─── System tray ─────────────────────────────────────────────────────────────

// WHAT: system tray icon + tooltip; double-click re-shows/focuses the main window.
// Right-click menu is built by updateTrayMenu. The tray is a secondary entry point and a
// keepalive surface — do not remove it without revisiting window-all-closed quit logic.
// CHANGE-GUARD: minimize/close to tray scenario — double-click tray must restore the
// window and the right-click menu must work.
function createTray() {
  const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  updateTrayMenu();
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// WHAT: (re)builds the tray right-click menu with LIVE auto-print ON/OFF labels read from
// the store each call. Toggling here writes the store and rebuilds the tray.
// GOTCHA / CROSS-DEP: this does NOT refresh the menu-bar checkboxes in buildAppMenu (built
// once at startup), so the two surfaces can show different states until restart. The store
// is the single source of truth; the menu-bar boxes are the stale ones.
// CHANGE-GUARD: toggle Auto-print from the tray, then buy a label — behavior must follow
// the NEW setting (store), regardless of what the menu-bar checkbox shows.
function updateTrayMenu() {
  const settings = store.get('printSettings');
  const menu = Menu.buildFromTemplate([
    {
      label: '📦 FWW Shipping',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Shipping App',
      click: () => { mainWindow?.show(); mainWindow?.focus(); },
    },
    {
      label: 'Print Settings…',
      click: openPrintManager,
    },
    { type: 'separator' },
    {
      label: `Auto-print Labels: ${settings.autoPrintLabels ? 'ON' : 'OFF'}`,
      click: () => {
        const s = store.get('printSettings');
        store.set('printSettings', { ...s, autoPrintLabels: !s.autoPrintLabels });
        updateTrayMenu();
      },
    },
    {
      label: `Auto-print Slips: ${settings.autoPrintSlips ? 'ON' : 'OFF'}`,
      click: () => {
        const s = store.get('printSettings');
        store.set('printSettings', { ...s, autoPrintSlips: !s.autoPrintSlips });
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => checkForUpdatesInteractive(),
    },
    { type: 'separator' },
    {
      label: 'Quit FWW Shipping',
      click: () => { quitting = true; app.quit(); },
    },
  ]);
  tray.setContextMenu(menu);
}

// ─── Auto updater ─────────────────────────────────────────────────────────────

// Set true when the user explicitly clicks "Check for Updates" so the OUTCOME
// (already-current / error / now-downloading) is shown in a dialog. Without this
// a manual check was completely silent on every outcome except a downloaded
// update — so it looked like "checking for updates does nothing / never updates."
// Automatic startup + 4-hour checks stay silent except the restart prompt.
// FLAG: true only while a USER-initiated 'Check for Updates' is in flight, so the OUTCOME
// (up-to-date / error / now-downloading) is shown in a dialog. Without it, a manual check
// was silent on every outcome except a downloaded update — looked like 'updates do nothing'.
// Each autoUpdater handler resets it to false after consuming it (one-shot).
// CHANGE-GUARD: Help > Check for Updates on the LATEST version must show a 'you're on the
// latest' dialog; automatic startup/4h checks must stay silent (no nag dialogs).
let _updateCheckInteractive = false;
// WHAT: user-triggered update check (menu + tray). In a dev/unpackaged build it just
// explains auto-update only runs in the installed app and returns. In the packaged app it
// sets _updateCheckInteractive and kicks autoUpdater.checkForUpdates(); errors surface via
// the 'error' handler (hence the empty .catch).
// CHANGE-GUARD: run from source -> 'dev build' dialog; run installed -> a real check with a
// visible outcome dialog.
function checkForUpdatesInteractive() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: 'Check for Updates',
      message: 'Auto-update only runs in the installed app.',
      detail: 'This is a dev build (running from source), which does not self-update.',
      buttons: ['OK'],
    });
    return;
  }
  _updateCheckInteractive = true;
  autoUpdater.checkForUpdates().catch(() => {}); // failures surface via the 'error' handler
}

// WHAT: electron-updater wiring for the per-user installed app (public GitHub releases).
// autoDownload + autoInstallOnAppQuit are ON. Handlers: update-available (download starts),
// update-not-available, update-downloaded (prompt Restart Now / Later), error.
// INVARIANT: only ever runs in the packaged app (early return when !app.isPackaged) — dev
// builds never self-update. 'update-downloaded' sets quitting=true before quitAndInstall so
// the close/quit guards don't fight the relaunch.
// CHANGE-GUARD: publish a bump and confirm: silent auto-download, the Restart prompt, and a
// successful relaunch into the new version. Verify dev builds still skip all of this.
function setupAutoUpdater() {
// HARD GATE: never arm the updater in a dev/source run — electron-updater has no valid
// install metadata there and would error on every check. Do not remove this guard.
// CHANGE-GUARD: launch from source and confirm NO update errors are logged and no 4h
// interval is created.
  if (!app.isPackaged) return;  // skip in dev mode

  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
    mainWindow?.webContents.send('updater:status', {
      type: 'available', version: info.version,
    });
    if (_updateCheckInteractive) {
      _updateCheckInteractive = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'Update Available',
        message: `Version ${info.version} is downloading…`,
        detail: 'You will be prompted to restart once it has finished downloading.',
        buttons: ['OK'],
      });
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] no update available; on latest', app.getVersion());
    if (_updateCheckInteractive) {
      _updateCheckInteractive = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: 'No Updates',
        message: `You're on the latest version (${app.getVersion()}).`,
        buttons: ['OK'],
      });
    }
  });

// Prompts Restart Now / Later via a SYNC dialog. 'Restart Now' sets quitting=true THEN
// quitAndInstall() — the quitting flag is required so the window close/quit handlers treat
// this as an intentional quit and don't interfere with the installer relaunch. 'Later'
// defers to autoInstallOnAppQuit.
// CHANGE-GUARD: choosing 'Restart Now' must relaunch into the new version; 'Later' must
// keep running and apply the update on next manual quit.
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version}`);
    _updateCheckInteractive = false;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type:    'info',
      title:   'Update Ready',
      message: `FWW Shipping ${info.version} has been downloaded.`,
      detail:  'Restart now to apply the update, or it will apply automatically next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    });
    if (choice === 0) {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (e) => {
    console.error('[updater] error:', e?.message || e);
    if (_updateCheckInteractive) {
      _updateCheckInteractive = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: 'Update Check Failed',
        message: 'Could not check for updates.',
        detail: String(e?.message || e),
        buttons: ['OK'],
      });
    }
  });

  // Check on startup, then every 4 hours (silent unless an update downloads).
  autoUpdater.checkForUpdates().catch(() => {});
// Background poll: check on startup, then every 4h. SILENT by design (no dialog) unless an
// update actually downloads — _updateCheckInteractive stays false here so only the Restart
// prompt ever interrupts the user. The interval is never cleared (lives for app lifetime).
// CHANGE-GUARD: confirm background checks never pop 'no updates' nag dialogs.
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ─── Test print content ───────────────────────────────────────────────────────

// Self-contained 4x6 test-label HTML (no network/auth). @page size 4in 6in must stay in
// sync with the real label paper dimensions so a passing test reflects real output.
// CHANGE-GUARD: 'Test Print' on the label printer must produce a correctly-sized 4x6 page.
function buildTestLabelHtml() {
  return `<!doctype html><html><head><meta charset=utf-8>
<style>
@page{size:4in 6in;margin:0}
body{margin:0;padding:.25in;font-family:'Segoe UI',sans-serif;background:#fff;color:#111;
     width:4in;height:6in;box-sizing:border-box;display:flex;flex-direction:column;
     justify-content:center;align-items:center;text-align:center}
h1{font-size:22pt;margin:0 0 8px;letter-spacing:.12em;color:#9BBC0E}
p{margin:4px 0;font-size:11pt;color:#444}
.dashed{border:2px dashed #ccc;padding:16px 24px;border-radius:8px;margin-top:12px}
</style></head><body>
<h1>FUZZYWUMPETS</h1>
<p>Test Label Print</p>
<div class=dashed>
<p style="font-size:9pt;color:#888">4×6 Shipping Label</p>
<p style="font-size:14pt;font-weight:bold">✓ Label Printer OK</p>
</div>
</body></html>`;
}

// Self-contained Letter test-slip HTML. White background is deliberate — it proves the
// slip printer renders light (the real slip path also forces light to beat dark mode).
// CHANGE-GUARD: 'Test Print' on the slip printer must come out WHITE on Letter, not dark.
function buildTestSlipHtml() {
  return `<!doctype html><html><head><meta charset=utf-8>
<style>
@page{size:letter;margin:.5in}
body{font-family:'Segoe UI',sans-serif;background:#fff;color:#111;padding:24px}
h1{font-size:24pt;letter-spacing:.1em;color:#9BBC0E;margin:0 0 8px}
.band{background:#9BBC0E;color:#1a1a1a;font-weight:700;letter-spacing:.08em;
      text-transform:uppercase;font-size:10pt;padding:5px 10px;margin:16px 0}
p{margin:4px 0;font-size:11pt;color:#444}
.box{border:2px dashed #ccc;padding:20px 28px;border-radius:8px;margin-top:16px;text-align:center}
</style></head><body>
<h1>FUZZYWUMPETS</h1>
<div class=band>Test Packing Slip</div>
<div class=box>
<p style="font-size:12pt;font-weight:bold">✓ Packing Slip Printer OK</p>
<p style="font-size:9pt;color:#888">8.5×11 Letter</p>
</div>
</body></html>`;
}
