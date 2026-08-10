'use strict';

// Regression tests for the MONEY-CRITICAL hidden-print-window redirect guard.
//
// Motivating scenario (adversarially confirmed): an expired persist:shipping CF Access
// session redirects /label/print-view to https://<team>.cloudflareaccess.com/... which
// commits with HTTP 200 and can render an image (org logo) — both pre-existing guards
// in printLabelViaPdf pass, the LOGIN PAGE spools to the Rollo as a 4x6, and
// print:status reports success:true ("Label printed ✓") for a bought, real-money label
// that never printed. verifyPrintPageUrl must refuse that, and must never regress to
// letting a cross-origin commit through.
//
// Run: npm test   (node --test test/)

const test = require('node:test');
const assert = require('node:assert');
const { verifyPrintPageUrl, LABEL_PRINT_VIEW_PATH_RE } = require('../print-guards.js');

const LABEL_URL = 'https://shipping.fuzzyreporting.com/label/print-view?label_id=se-123456';
const BATCH_URL = 'https://shipping.fuzzyreporting.com/batch/print-view?batch_id=se-999';
const SLIP_URL  = 'https://shipping.fuzzyreporting.com/slip-render?orders=1001,1002';
const CF_LOGIN  = 'https://fuzzywumpets.cloudflareaccess.com/cdn-cgi/access/login/shipping.fuzzyreporting.com?kid=abc';

test('happy path: single-label print-view commits where it was asked to -> ok (null)', () => {
  assert.strictEqual(verifyPrintPageUrl(LABEL_URL, LABEL_URL, LABEL_PRINT_VIEW_PATH_RE), null);
});

test('happy path: batch print-view -> ok (null)', () => {
  assert.strictEqual(verifyPrintPageUrl(BATCH_URL, BATCH_URL, LABEL_PRINT_VIEW_PATH_RE), null);
});

test('happy path: query/hash differences on the same origin+path are still ok', () => {
  assert.strictEqual(
    verifyPrintPageUrl(LABEL_URL, LABEL_URL + '&cachebust=1#top', LABEL_PRINT_VIEW_PATH_RE),
    null
  );
});

test('REGRESSION (real money): expired CF Access session redirect must FAIL, never print', () => {
  const reason = verifyPrintPageUrl(LABEL_URL, CF_LOGIN, LABEL_PRINT_VIEW_PATH_RE);
  assert.ok(reason, 'a cross-origin commit must produce a failure reason');
  assert.match(reason, /session has expired/i, 'the reason must say the session expired, not "label unavailable"');
  assert.match(reason, /fuzzywumpets\.cloudflareaccess\.com/, 'the reason must name where the window ended up');
});

test('batch path hits the same expired-session guard', () => {
  const reason = verifyPrintPageUrl(BATCH_URL, CF_LOGIN, LABEL_PRINT_VIEW_PATH_RE);
  assert.ok(reason);
  assert.match(reason, /session has expired/i);
});

test('same-origin commit on a NON-print-view path (in-app login/error page) must FAIL for labels', () => {
  const reason = verifyPrintPageUrl(LABEL_URL, 'https://shipping.fuzzyreporting.com/ui', LABEL_PRINT_VIEW_PATH_RE);
  assert.ok(reason, 'a same-origin redirect off the print view must not spool');
});

test('slip PDF path (origin-only check): cross-origin commit must FAIL', () => {
  const reason = verifyPrintPageUrl(SLIP_URL, CF_LOGIN, null);
  assert.ok(reason);
  assert.match(reason, /session has expired/i);
});

test('slip PDF path: same-origin commit passes with no path regex', () => {
  assert.strictEqual(verifyPrintPageUrl(SLIP_URL, SLIP_URL, null), null);
});

test('unparseable or non-web committed URL fails CLOSED (never print what we cannot verify)', () => {
  assert.ok(verifyPrintPageUrl(LABEL_URL, '', LABEL_PRINT_VIEW_PATH_RE), 'empty URL (parse throws) fails closed');
  assert.ok(verifyPrintPageUrl(LABEL_URL, 'about:blank', LABEL_PRINT_VIEW_PATH_RE), 'about:blank (origin "null") fails closed');
});

test('never throws, even on garbage input', () => {
  assert.doesNotThrow(() => verifyPrintPageUrl(null, undefined, LABEL_PRINT_VIEW_PATH_RE));
  assert.ok(verifyPrintPageUrl(null, undefined, LABEL_PRINT_VIEW_PATH_RE), 'garbage input fails closed');
});

test('LABEL_PRINT_VIEW_PATH_RE recognizes exactly the paths isLabelPrintViewUrl (main.js) accepts', () => {
  assert.ok(LABEL_PRINT_VIEW_PATH_RE.test('/label/print-view'));
  assert.ok(LABEL_PRINT_VIEW_PATH_RE.test('/batch/print-view'));
  assert.ok(!LABEL_PRINT_VIEW_PATH_RE.test('/cdn-cgi/access/login'));
  assert.ok(!LABEL_PRINT_VIEW_PATH_RE.test('/ui'));
});
