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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWindow        = null;
let printManagerWindow = null;
let tray              = null;
let quitting          = false;   // true when user explicitly quits

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  createMainWindow();
  createTray();
  setupAutoUpdater();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // Keep process alive for background printing; only quit on explicit action
  if (process.platform !== 'darwin') {
    // Don't quit — tray keeps app alive
  }
});

// ─── Main window ─────────────────────────────────────────────────────────────

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

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'win32') {
        // Show tray balloon on first hide
        if (!store.get('trayHintShown')) {
          tray?.displayBalloon?.({
            iconType: 'info',
            title:    APP_NAME,
            content:  'FWW Shipping is still running in the background for auto-printing.',
          });
          store.set('trayHintShown', true);
        }
      }
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Intercept new-window requests (slip-render pages, PDF downloads, etc.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSlipRenderUrl(url)) {
      handleSlipPrint(url);
      return { action: 'deny' };
    }
    if (url.startsWith('https://shipping.fuzzyreporting.com') ||
        url.startsWith('https://accounts.google.com') ||
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

  mainWindow.loadURL(SHIPPING_URL);
}

// ─── Inject fetch/print interceptor into the shipping page ────────────────────
//
// Runs in the MAIN (page) world. Patches window.fetch to detect label PDF
// responses and dispatches a CustomEvent that the preload catches.

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

function isSlipRenderUrl(url) {
  return url.includes('/slip-render') || url.includes('slip-render');
}

function handleSlipPrint(slipUrl) {
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
  silentPrintUrl(slipUrl, 'slip', settings);
}

// ─── Silent printing via hidden BrowserWindow ────────────────────────────────

function silentPrintUrl(url, type, settings) {
  const printerName = type === 'label' ? settings.labelPrinter : settings.slipPrinter;
  const copies      = type === 'label' ? settings.labelCopies  : settings.slipCopies;
  const isLabel     = type === 'label';

  // Inherit the same session so Cloudflare Access cookies apply
  const printWin = new BrowserWindow({
    show: false,
    webPreferences: {
      partition:        'persist:shipping',
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  // For slip-render pages, override window.print() BEFORE the auto-fire
  if (!isLabel) {
    printWin.webContents.on('dom-ready', () => {
      printWin.webContents.executeJavaScript(`
        window.print = function() {
          document.dispatchEvent(new CustomEvent('fww:ready-to-print'));
        };
      `).catch(() => {});
    });
  }

  const doPrint = () => {
    const opts = {
      silent:          true,
      printBackground: true,
      deviceName:      printerName,
      copies:          copies || 1,
    };

    if (isLabel) {
      opts.pageSize   = { width: settings.labelPaperWidth, height: settings.labelPaperHeight };
      opts.margins    = { marginType: 'none' };
      opts.landscape  = false;
      opts.scaleFactor = 100;
    } else {
      opts.pageSize   = settings.slipPaperSize;  // e.g. 'Letter'
      opts.margins    = { marginType: 'printableArea' };
      opts.landscape  = false;
    }

    printWin.webContents.print(opts, (success, reason) => {
      if (!success) {
        console.error(`[fww-print] ${type} print failed (${printerName}): ${reason}`);
        if (mainWindow) {
          mainWindow.webContents.send('print:status', {
            type, success: false, reason, printer: printerName,
          });
        }
      } else {
        console.log(`[fww-print] ${type} printed to "${printerName}"`);
        if (mainWindow) {
          mainWindow.webContents.send('print:status', {
            type, success: true, printer: printerName,
          });
        }
      }
      // Small delay before closing to ensure spooler receives the job
      setTimeout(() => printWin.destroy(), 1500);
    });
  };

  if (isLabel) {
    printWin.webContents.on('did-finish-load', doPrint);
  } else {
    // Wait for slip page to signal it's ready (our overridden window.print fires)
    printWin.webContents.on('did-finish-load', () => {
      // Fallback: if the CustomEvent approach doesn't fire, print after a delay
      const fallbackTimer = setTimeout(doPrint, 600);
      printWin.webContents.executeJavaScript(`
        new Promise((resolve) => {
          document.addEventListener('fww:ready-to-print', resolve, { once: true });
        });
      `).then(() => {
        clearTimeout(fallbackTimer);
        doPrint();
      }).catch(() => {});
    });
  }

  printWin.loadURL(url);
}

function silentPrintPdfBuffer(buf, labelId, settings) {
  const tmpPath = path.join(os.tmpdir(), `fww-label-${labelId}-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, buf);
  } catch (e) {
    console.error('[fww-print] could not write temp PDF:', e.message);
    return;
  }

  const printWin = new BrowserWindow({
    show: false,
    webPreferences: {
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  printWin.webContents.on('did-finish-load', () => {
    const opts = {
      silent:          true,
      printBackground: true,
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
          type: 'label', success: false, reason, printer: settings.labelPrinter,
        });
      } else {
        console.log(`[fww-print] label ${labelId} printed to "${settings.labelPrinter}"`);
        mainWindow?.webContents.send('print:status', {
          type: 'label', success: true, labelId, printer: settings.labelPrinter,
        });
      }
      setTimeout(() => printWin.destroy(), 1500);
    });
  });

  printWin.loadURL(`file://${tmpPath}`);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

// Label PDF received from page (base64-encoded)
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
  const buf = Buffer.from(data, 'base64');
  silentPrintPdfBuffer(buf, labelId, settings);
});

// Slip print triggered from page
ipcMain.on('print:slip-url', (event, { url }) => {
  const settings = store.get('printSettings');
  handleSlipPrint(url);
});

// Open print manager window
ipcMain.on('print:open-manager', () => openPrintManager());

// Get available printers
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
  printManagerWindow.on('closed', () => { printManagerWindow = null; });
  printManagerWindow.loadFile(path.join(__dirname, 'print-manager.html'));
}

// ─── System tray ─────────────────────────────────────────────────────────────

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
      click: () => autoUpdater.checkForUpdates(),
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

function setupAutoUpdater() {
  if (!app.isPackaged) return;  // skip in dev mode

  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
    mainWindow?.webContents.send('updater:status', {
      type: 'available', version: info.version,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version}`);
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

  autoUpdater.on('error', (e) => console.error('[updater] error:', e.message));

  // Check on startup, then every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ─── Test print content ───────────────────────────────────────────────────────

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
