/**
 * fww-logsink — drop-in error logging for the Electron desktop apps
 * (fww-shipping-desktop, fww-b2b-admin-desktop, fww-admin if packaged).
 *
 * In the MAIN process entry (e.g. main.js), as early as possible:
 *   const { installMain } = require("./fww-logsink.cjs");
 *   installMain({ app: "fww-shipping-desktop", repo: "fuzzyalex84/fww-shipping-desktop" });
 *
 * Optionally in a renderer preload, forward window errors over IPC to main, or set
 * ERROR_SINK_URL/ERROR_SINK_BEARER and call reportEvent directly.
 *
 * Config via env or the install() opts: ERROR_SINK_URL, ERROR_SINK_BEARER.
 * Uses Node fetch (Electron ships modern Node). Never throws.
 */

let CFG = { url: process.env.ERROR_SINK_URL, bearer: process.env.ERROR_SINK_BEARER, app: "desktop", repo: null };

function reportEvent(payload) {
  if (!CFG.url) return;
  try {
    const body = JSON.stringify({
      app: CFG.app, host: "desktop", env: process.env.NODE_ENV || "prod",
      repo: CFG.repo, ts: Date.now(), ...payload,
    });
    fetch(CFG.url.replace(/\/$/, "") + "/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + (CFG.bearer || "") },
      body,
    }).catch(() => {});
  } catch (_) { /* swallow */ }
}

function installMain(opts = {}) {
  CFG = { ...CFG, ...opts, url: opts.url || CFG.url, bearer: opts.bearer || CFG.bearer };
  process.on("uncaughtException", (err) => {
    reportEvent({ kind: "unhandled", severity: "critical", message: String((err && err.message) || err), stack: err && err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    reportEvent({ kind: "unhandled", severity: "critical", message: "unhandledRejection: " + String((reason && reason.message) || reason), stack: reason && reason.stack });
  });
  try {
    const { app } = require("electron");
    if (app && app.on) {
      app.on("render-process-gone", (_e, _wc, d) => reportEvent({ kind: "error", severity: "critical", message: `render-process-gone: ${d && d.reason}`, context: d }));
      app.on("child-process-gone", (_e, d) => reportEvent({ kind: "error", severity: "error", message: `child-process-gone: ${d && d.type}/${d && d.reason}`, context: d }));
    }
  } catch (_) { /* not in electron main; global handlers still active */ }
}

module.exports = { installMain, reportEvent };
