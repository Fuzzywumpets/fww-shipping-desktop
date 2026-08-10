'use strict';

// ─── Hidden-print-window redirect guard (pure logic, no Electron) ─────────────
//
// MONEY-CRITICAL: printLabelViaPdf / handleLabelSavePdf / handleSlipSavePdf (main.js)
// load an authenticated bridge page in a HIDDEN window and then spool/print whatever
// that window ends up showing. If the persist:shipping Cloudflare Access session has
// expired (typical for a reprint clicked hours after the buy), the load is redirected
// to https://<team>.cloudflareaccess.com/... which COMMITS with HTTP 200 — so the
// HTTP-status guard passes — and if that login page renders any image (org logo) the
// "at least one complete image" guard passes too. Without this check the LOGIN PAGE
// spooled to the Rollo as a 4x6 and print:status reported success:true — "Label
// printed ✓" for a bought, real-money label that never printed.
//
// The happy path NEVER ends a print-view load on a different origin, so the guard is:
// the window must finish the load on the same origin (and, for labels, a print-view
// path) it was asked to load, or we refuse to print.
//
// DEPENDS: main.js requires this module and calls verifyPrintPageUrl() from the
// did-finish-load handlers of printLabelViaPdf, handleLabelSavePdf and
// handleSlipSavePdf; it MUST stay listed in package.json build.files or the packaged
// app crashes on startup (require fails). test/print-guards.test.js is the regression
// suite for the expired-session scenario above.

// Matches the two bridge label print-view paths (single buy + batch).
// SYNC: keep in step with isLabelPrintViewUrl in main.js — both must recognize the
// same bridge print-view paths, or a legitimate label page would be refused here as a
// redirect and every reprint would fail.
const LABEL_PRINT_VIEW_PATH_RE = /\/(label|batch)\/print-view/;

// Returns null when the committed URL is acceptable to print, else a human-readable
// failure reason. Never throws. expectedPathRe is optional; when given, the committed
// pathname must also match it (a same-origin redirect to a non-print page is refused).
function verifyPrintPageUrl(requestedUrl, committedUrl, expectedPathRe) {
  let req, fin;
  try {
    req = new URL(requestedUrl);
    fin = new URL(committedUrl);
  } catch (_) {
    // Can't prove where the hidden window ended up — fail CLOSED on a print path.
    return `Could not verify the print page address (the window ended at "${committedUrl}"), ` +
      'so nothing was printed. Close and reopen the app, then try again.';
  }
  if (fin.origin !== req.origin) {
    return `The shipping session has expired (the page redirected to ${fin.hostname} ` +
      'instead of loading). Reopen the app / sign in, then print again.';
  }
  if (expectedPathRe && !expectedPathRe.test(fin.pathname)) {
    return `The print page ended on an unexpected page (${fin.pathname}) instead of the ` +
      'print view, so nothing was printed. Sign in again, then retry.';
  }
  return null;
}

module.exports = { verifyPrintPageUrl, LABEL_PRINT_VIEW_PATH_RE };
