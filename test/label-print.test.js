'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLabelHtml, isPng, validateLabelPngPayload } = require('../label-print');

const PNG = Buffer.from('89504e470d0a1a0a00000000', 'hex');

test('accepts only the ShipEngine PNG and bridge fallback contract', () => {
  const payload = validateLabelPngPayload({
    labelId: 'se-193428090',
    pngUrl: 'https://api.shipengine.com/v1/downloads/abc',
    fallbackUrl: 'https://shipping.fuzzyreporting.com/label/print-view?label_id=se-193428090',
    order: '#38654',
    tracking: '1Z20G64K6701277121',
    rendererSentAt: 123,
  });
  assert.equal(payload.labelId, 'se-193428090');
  assert.equal(payload.order, '#38654');
  assert.equal(payload.rendererSentAt, 123);
  assert.equal(validateLabelPngPayload({
    labelId: 'se-preview',
    pngUrl: 'https://api.shipengine.com/v1/downloads/preview',
    fallbackUrl: 'https://10a932db-fww-shipping-bridge.alex-037.workers.dev/label/print-view?label_id=se-preview',
  }).labelId, 'se-preview');
});

test('rejects arbitrary download and fallback hosts', () => {
  assert.throws(() => validateLabelPngPayload({
    labelId: 'se-1', pngUrl: 'https://evil.example/label.png',
    fallbackUrl: 'https://shipping.fuzzyreporting.com/label/print-view?label_id=se-1',
  }), /host is not allowed/);
  assert.throws(() => validateLabelPngPayload({
    labelId: 'se-1', pngUrl: 'https://api.shipengine.com/v1/downloads/a',
    fallbackUrl: 'https://evil.example/label/print-view?label_id=se-1',
  }), /not an allowed bridge/);
  assert.throws(() => validateLabelPngPayload({
    labelId: 'se-1', pngUrl: 'https://api.shipengine.com/v1/downloads/a',
    fallbackUrl: 'https://fww-shipping-bridge.evil.example/label/print-view?label_id=se-1',
  }), /not an allowed bridge/);
});

test('builds a white exact-4x6 local page only from PNG bytes', () => {
  assert.equal(isPng(PNG), true);
  const html = buildLabelHtml(PNG);
  assert.match(html, /@page\{size:4in 6in;margin:0\}/);
  assert.match(html, /background:#fff/);
  assert.match(html, /data:image\/png;base64,/);
  assert.throws(() => buildLabelHtml(Buffer.from('%PDF')), /not a PNG/);
});
