'use strict';

// WHAT: pure resolution of every MSIX identity value, plus the package.json -> MSIX version
// mapping. No filesystem writes, no process.exit — so generate-manifest.js can use it and
// test/msix-identity.test.js can exercise every rejection path.
//
// WHY IT EXISTS: Partner Center hands you five opaque strings (Identity/Name,
// Identity/Publisher, PublisherDisplayName, the reserved display name, and a version policy)
// that must appear byte-identically in the package or the Store rejects the submission. They
// arrive LATER — the Fuzzywumpets company account is still awaiting verification and the app
// name is not reserved — so they are treated as deployment inputs, never as checked-in
// constants. One place resolves them; nothing is hand-edited in two files.
//
// SYNC: the token names produced by resolveIdentity() must match the {{TOKEN}} placeholders in
// build/msix/Package.appxmanifest.template. generate-manifest.js fails loudly if the template
// contains a token this module does not produce, so the two cannot drift silently.

const DEV_PLACEHOLDER_PUBLISHER = 'CN=Fuzzywumpets Development, O=Fuzzywumpets, C=US';

// MSIX version parts are unsigned 16-bit. The Store additionally requires the fourth part
// (revision) to be 0 on submission — it reserves that slot for its own republishing.
const MAX_VERSION_PART = 65535;

class MsixIdentityError extends Error {}

// ─── Version mapping ─────────────────────────────────────────────────────────

// WHAT: map package.json's human semver ("1.0.19") onto the Store's four-part numeric
// package version ("1.0.19.0").
//
// package.json is the SINGLE source of the human version — the NSIS channel already derives
// its installer name and electron-updater metadata from it, and a Store build that disagreed
// with the installer of the same release would be untraceable.
//
// Rejected LOUDLY rather than coerced:
//   • prerelease / build metadata ("1.0.19-beta.1", "1.0.19+sha") — MSIX has no way to
//     express them, and silently dropping the tag would ship a package that claims to be the
//     final release.
//   • any part > 65535, or a non-numeric part.
//   • a leading zero like "01" (ambiguous, and Partner Center normalises it away, so the
//     manifest would stop matching what the Store shows).
function mapVersionToPackageVersion(semver) {
  if (typeof semver !== 'string' || semver.trim() === '') {
    throw new MsixIdentityError('package.json "version" is missing or not a string.');
  }
  const value = semver.trim();

  if (/[-+]/.test(value)) {
    throw new MsixIdentityError(
      `Cannot map version "${value}" to an MSIX package version: prerelease/build metadata ` +
      'is not representable in a four-part numeric MSIX version. Release a plain ' +
      'MAJOR.MINOR.PATCH version, or set MSIX_PACKAGE_VERSION explicitly.'
    );
  }

  const parts = value.split('.');
  if (parts.length !== 3) {
    throw new MsixIdentityError(
      `Cannot map version "${value}" to an MSIX package version: expected exactly ` +
      `MAJOR.MINOR.PATCH (3 parts), got ${parts.length}.`
    );
  }

  const numbers = parts.map((part, i) => {
    if (!/^(0|[1-9][0-9]*)$/.test(part)) {
      throw new MsixIdentityError(
        `Cannot map version "${value}" to an MSIX package version: part ${i + 1} ("${part}") ` +
        'is not a non-negative integer without leading zeros.'
      );
    }
    const n = Number(part);
    if (n > MAX_VERSION_PART) {
      throw new MsixIdentityError(
        `Cannot map version "${value}" to an MSIX package version: part ${i + 1} (${n}) ` +
        `exceeds the MSIX maximum of ${MAX_VERSION_PART}.`
      );
    }
    return n;
  });

  // Revision is pinned to 0: the Store rejects a submission whose fourth part is non-zero.
  return `${numbers[0]}.${numbers[1]}.${numbers[2]}.0`;
}

// WHAT: validate a caller-supplied MSIX_PACKAGE_VERSION override (an escape hatch for a
// Store resubmission that must bump the package version without a code release).
function validatePackageVersion(value, { requireZeroRevision }) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(value.trim())) {
    throw new MsixIdentityError(
      `MSIX_PACKAGE_VERSION "${value}" is not a four-part numeric version (e.g. 1.0.19.0).`
    );
  }
  const parts = value.trim().split('.').map(Number);
  parts.forEach((n, i) => {
    if (n > MAX_VERSION_PART) {
      throw new MsixIdentityError(
        `MSIX_PACKAGE_VERSION "${value}": part ${i + 1} (${n}) exceeds ${MAX_VERSION_PART}.`
      );
    }
  });
  if (requireZeroRevision && parts[3] !== 0) {
    throw new MsixIdentityError(
      `MSIX_PACKAGE_VERSION "${value}" ends in .${parts[3]}. The Microsoft Store reserves the ` +
      'fourth version part and rejects submissions where it is non-zero — use .0.'
    );
  }
  return parts.join('.');
}

// ─── Identity resolution ─────────────────────────────────────────────────────

// Partner Center's Identity/Name and the reserved display name are free-form, but the
// manifest schema constrains Name to this character set.
const IDENTITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{2,49}$/;

// Publisher must be an X.500 distinguished name. Partner Center gives you something like
// "CN=A1B2C3D4-1234-5678-9ABC-DEF012345678"; a human DN is also valid for dev certs.
function assertPublisherDn(publisher) {
  if (typeof publisher !== 'string' || publisher.trim() === '') {
    throw new MsixIdentityError('Publisher is empty.');
  }
  if (!/(^|,)\s*CN=/i.test(publisher)) {
    throw new MsixIdentityError(
      `Publisher "${publisher}" is not an X.500 distinguished name — it must contain a CN= ` +
      'component (copy Package/Identity/Publisher verbatim from Partner Center).'
    );
  }
}

// WHAT: resolve the full token set for the manifest template.
//
// @param {object} opts
// @param {'dev'|'store'} opts.mode        'store' demands real Partner Center values.
// @param {object}        opts.pkg         parsed package.json
// @param {object}        opts.env         process.env (or a stub in tests)
// @param {object}        opts.defaults    parsed build/msix/identity.json
function resolveIdentity({ mode, pkg, env = {}, defaults = {} }) {
  if (mode !== 'dev' && mode !== 'store') {
    throw new MsixIdentityError(`Unknown mode "${mode}" (expected "dev" or "store").`);
  }
  const storeMode = mode === 'store';

  // Precedence: environment variable > identity.json > derived from package.json.
  // Environment first so CI can inject Partner Center values as secrets without a file.
  const pick = (envKey, jsonKey, fallback) => {
    const fromEnv = env[envKey];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    const fromJson = defaults[jsonKey];
    if (typeof fromJson === 'string' && fromJson.trim() !== '') return fromJson.trim();
    return fallback;
  };

  const identityName = pick('MSIX_IDENTITY_NAME', 'identityName', null);
  const publisher = pick('MSIX_PUBLISHER', 'publisher', null);
  const publisherDisplayName = pick('MSIX_PUBLISHER_DISPLAY_NAME', 'publisherDisplayName', null);
  const displayName = pick('MSIX_DISPLAY_NAME', 'displayName', null);
  const description = pick('MSIX_DESCRIPTION', 'description', pkg && pkg.description);

  const missing = [];
  if (!identityName) missing.push('MSIX_IDENTITY_NAME / identityName');
  if (!publisher) missing.push('MSIX_PUBLISHER / publisher');
  if (!publisherDisplayName) missing.push('MSIX_PUBLISHER_DISPLAY_NAME / publisherDisplayName');
  if (!displayName) missing.push('MSIX_DISPLAY_NAME / displayName');
  if (!description) missing.push('MSIX_DESCRIPTION / description');
  if (missing.length) {
    throw new MsixIdentityError(
      `Missing MSIX identity value(s): ${missing.join(', ')}. Set them in ` +
      'build/msix/identity.json or as environment variables.'
    );
  }

  if (!IDENTITY_NAME_RE.test(identityName)) {
    throw new MsixIdentityError(
      `Identity Name "${identityName}" is invalid. It must be 3-50 characters of ` +
      'A-Z a-z 0-9 . - and start with a letter or digit. Copy Package/Identity/Name ' +
      'verbatim from Partner Center.'
    );
  }
  assertPublisherDn(publisher);

  // GUARD: never let a development placeholder reach a Store artifact. A package signed for
  // "CN=Fuzzywumpets Development" is worthless to Partner Center and the failure would only
  // surface after upload.
  if (storeMode) {
    if (publisher === DEV_PLACEHOLDER_PUBLISHER) {
      throw new MsixIdentityError(
        'Refusing to build a Store package with the development placeholder publisher. ' +
        'Set MSIX_PUBLISHER to the exact Package/Identity/Publisher string from Partner Center.'
      );
    }
    if (/^FuzzywumpetsDev\b/i.test(identityName)) {
      throw new MsixIdentityError(
        'Refusing to build a Store package with the development placeholder identity name. ' +
        'Set MSIX_IDENTITY_NAME to the exact Package/Identity/Name string from Partner Center.'
      );
    }
  }

  const versionOverride = env.MSIX_PACKAGE_VERSION;
  const packageVersion = (typeof versionOverride === 'string' && versionOverride.trim() !== '')
    ? validatePackageVersion(versionOverride, { requireZeroRevision: storeMode })
    : mapVersionToPackageVersion(pkg && pkg.version);

  // SYNC: the executable name is electron-builder's build.productName + ".exe" — that is what
  // `electron-builder --dir` writes into dist/win-unpacked. Deriving it here (rather than
  // hardcoding "FWW Shipping.exe" in the template) means renaming productName can never leave
  // the manifest pointing at an executable that is not in the package.
  const productName = (pkg && pkg.build && pkg.build.productName) || (pkg && pkg.name);
  if (!productName) {
    throw new MsixIdentityError('package.json build.productName is missing — cannot derive the executable name.');
  }

  return {
    IDENTITY_NAME: identityName,
    PUBLISHER: publisher,
    PUBLISHER_DISPLAY_NAME: publisherDisplayName,
    DISPLAY_NAME: displayName,
    DESCRIPTION: description,
    PACKAGE_VERSION: packageVersion,
    EXECUTABLE: `${productName}.exe`,
  };
}

module.exports = {
  MsixIdentityError,
  DEV_PLACEHOLDER_PUBLISHER,
  mapVersionToPackageVersion,
  validatePackageVersion,
  resolveIdentity,
};
