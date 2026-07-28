'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ─── Expose safe APIs to the renderer ────────────────────────────────────────

// DEPENDS: every ipcRenderer.send/invoke/on channel name below must exactly match an
// ipcMain.on/handle registration (or a webContents.send) in main.js — no shared import
// enforces this string match:
//   print:open-manager    -> main.js ipcMain.on('print:open-manager')  (openPrintManager)
//   print:label-pdf       -> main.js ipcMain.on('print:label-pdf')     (silentPrintPdfBuffer)
//   print:slip-url        -> main.js ipcMain.on('print:slip-url')     (handleSlipPrint)
//   print:status  (recv)  -> main.js mainWindow.webContents.send('print:status', ...)
//   updater:status (recv) -> main.js autoUpdater 'update-available'/'update-downloaded' handlers
contextBridge.exposeInMainWorld('__fwwDesktop', {
  // Is this the desktop app?
  isDesktop: true,

  // Open the print manager
  openPrintManager: () => ipcRenderer.send('print:open-manager'),

  // Manually trigger a label print (url to PDF or base64 data)
  printLabel: (data) => ipcRenderer.send('print:label-pdf', data),

  // Manually trigger a slip print
  printSlip: (url) => ipcRenderer.send('print:slip-url', { url }),

  // Listen for print status events from main
  onPrintStatus: (cb) => {
    ipcRenderer.on('print:status', (event, status) => cb(status));
  },

  // Listen for updater events
  onUpdaterStatus: (cb) => {
    ipcRenderer.on('updater:status', (event, status) => cb(status));
  },
});

// ─── Forward DOM events from the page to the main process ────────────────────
//
// These CustomEvents are dispatched by the injected interceptor code
// (see injectPrintInterceptor in main.js). They cross the context-isolation
// boundary via the shared DOM.

window.addEventListener('DOMContentLoaded', () => {
  // Label PDF ready to print (fired after fetch intercept)
  document.addEventListener('fww:label-pdf', (e) => {
    ipcRenderer.send('print:label-pdf', e.detail);
  });

  // Slip page called window.print() — tell main to handle it
  document.addEventListener('fww:slip-print', (e) => {
    ipcRenderer.send('print:slip-url', e.detail);
  });

  // Floating button clicked → open print manager
  document.addEventListener('fww:open-print-manager', () => {
    ipcRenderer.send('print:open-manager');
  });
});

// ─── Print Manager page IPC (runs when print-manager.html is loaded) ─────────

if (location.protocol === 'file:') {
  // We're in the print manager window
  // DEPENDS: channel names below must match main.js exactly — printers:list, settings:get,
  // settings:set, print:test, app:version are all ipcMain.handle(...) registrations there.
  // settings:get/settings:set also carry the printSettings field shape, which is separately
  // SYNC'd against print-manager.html at main.js's store.defaults declaration.
  contextBridge.exposeInMainWorld('printManagerAPI', {
    getPrinters:    ()       => ipcRenderer.invoke('printers:list'),
    getSettings:    ()       => ipcRenderer.invoke('settings:get'),
    saveSettings:   (s)      => ipcRenderer.invoke('settings:set', s),
    testPrint:      (type)   => ipcRenderer.invoke('print:test', { type }),
    getAppVersion:  ()       => ipcRenderer.invoke('app:version'),
  });
}
