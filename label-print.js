'use strict';

const SHIPENGINE_LABEL_HOSTS = new Set(['api.shipengine.com']);

function parseHttpsUrl(raw, label) {
  let url;
  try { url = new URL(String(raw || '')); } catch (_) { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`${label} must be an HTTPS URL without credentials`);
  }
  return url;
}

function isBridgeHost(hostname) {
  return hostname === 'shipping.fuzzyreporting.com'
    || /^(?:[a-z0-9]+-)?fww-shipping-bridge\.alex-037\.workers\.dev$/.test(hostname);
}

function validateLabelPngPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('label payload must be an object');
  }
  const labelId = String(payload.labelId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(labelId)) throw new Error('invalid label id');

  const pngUrl = parseHttpsUrl(payload.pngUrl, 'PNG URL');
  if (!SHIPENGINE_LABEL_HOSTS.has(pngUrl.hostname)) throw new Error('PNG URL host is not allowed');

  const fallbackUrl = parseHttpsUrl(payload.fallbackUrl, 'fallback URL');
  if (!isBridgeHost(fallbackUrl.hostname)
      || !/^\/label\/print-view(?:\/|$)/.test(fallbackUrl.pathname)) {
    throw new Error('fallback URL is not an allowed bridge label print-view');
  }

  return {
    labelId,
    pngUrl: pngUrl.href,
    fallbackUrl: fallbackUrl.href,
    order: String(payload.order || '').slice(0, 80),
    tracking: String(payload.tracking || '').slice(0, 120),
    rendererSentAt: Number.isFinite(Number(payload.rendererSentAt)) ? Number(payload.rendererSentAt) : null,
  };
}

function isPng(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

function buildLabelHtml(pngBytes) {
  if (!isPng(pngBytes)) throw new Error('downloaded label is not a PNG');
  const src = `data:image/png;base64,${pngBytes.toString('base64')}`;
  return '<!doctype html><html><head><meta charset="utf-8"><style>'
    + ':root{color-scheme:light}*{box-sizing:border-box}html,body{margin:0;width:4in;height:6in;overflow:hidden;background:#fff}'
    + 'img{display:block;width:4in;height:6in;object-fit:contain;background:#fff}'
    + '@page{size:4in 6in;margin:0}@media print{html,body,img{width:4in;height:6in}}'
    + '</style></head><body><img alt="Shipping label" src="' + src + '"></body></html>';
}

module.exports = { buildLabelHtml, isPng, validateLabelPngPayload };
