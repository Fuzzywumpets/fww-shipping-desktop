#!/usr/bin/env node
'use strict';

// WHAT: deterministically render build/msix/Package.appxmanifest.template into a real
// Package.appxmanifest, filling every {{TOKEN}} from package.json + build/msix/identity.json
// + MSIX_* environment variables.
//
// Usage:
//   node tools/msix/generate-manifest.js [--store] [--out <path>]
//
//   --store   demand real Partner Center identity values and reject the development
//             placeholders. Used by the Store artifact build.
//   --out     where to write (default: dist/msix/Package.appxmanifest).
//
// WHY A GENERATOR AT ALL: the five Partner Center identity strings do not exist yet (the
// company account is awaiting verification, the name is not reserved). Checking in a manifest
// with invented values guarantees somebody eventually ships one. Generating means the future
// values are supplied once, as inputs, and nothing is hand-edited in two places.
//
// SYNC: token names here come from tools/msix/msix-identity.js resolveIdentity(). Any
// {{TOKEN}} in the template that resolveIdentity() does not produce is a hard error below, so
// the template and the resolver cannot drift.

const fs = require('fs');
const path = require('path');
const { resolveIdentity, MsixIdentityError } = require('./msix-identity');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'build', 'msix', 'Package.appxmanifest.template');
const IDENTITY_PATH = path.join(REPO_ROOT, 'build', 'msix', 'identity.json');
const DEFAULT_OUT = path.join(REPO_ROOT, 'dist', 'msix', 'Package.appxmanifest');

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

// XML attribute/text escaping. Identity values are operator-supplied strings (a company name
// can legitimately contain & or '), and an unescaped one would produce a manifest that is not
// well-formed XML — which makeappx reports as an unhelpful parse error a long way from here.
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// XML forbids "--" inside a comment body. The manifest template carries a lot of explanatory
// prose, and one literal command-line flag written out in a comment makes the WHOLE manifest
// non-well-formed — which surfaces as an opaque parse failure from makeappx a long way from
// the sentence that caused it. (This is not hypothetical: an `electron-builder` invocation
// spelled out in a comment broke the first generated manifest.) Catch it at generation time.
function assertXmlCommentsValid(xml) {
  for (const comment of xml.match(/<!--[\s\S]*?-->/g) || []) {
    const body = comment.slice(4, -3);
    if (body.includes('--')) {
      const line = xml.slice(0, xml.indexOf(comment)).split('\n').length;
      throw new Error(
        `XML comment starting at line ${line} of the generated manifest contains "--", which ` +
        'is illegal inside an XML comment. Reword the comment in ' +
        'build/msix/Package.appxmanifest.template (do not write literal double-dash CLI flags in prose).'
      );
    }
  }
}

function parseArgs(argv) {
  const args = { store: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--store') args.store = true;
    else if (arg === '--out') {
      args.out = argv[i + 1];
      i += 1;
      if (!args.out) throw new Error('--out requires a path argument.');
    } else throw new Error(`Unknown argument "${arg}".`);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function generate({ store, out }) {
  const pkg = readJson(path.join(REPO_ROOT, 'package.json'));
  const defaults = fs.existsSync(IDENTITY_PATH) ? readJson(IDENTITY_PATH) : {};
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const tokens = resolveIdentity({
    mode: store ? 'store' : 'dev',
    pkg,
    env: process.env,
    defaults,
  });

  const unresolved = [];
  const rendered = template.replace(TOKEN_RE, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(tokens, name)) {
      unresolved.push(name);
      return match;
    }
    return escapeXml(tokens[name]);
  });

  if (unresolved.length) {
    throw new Error(
      `Template ${path.relative(REPO_ROOT, TEMPLATE_PATH)} uses token(s) the identity ` +
      `resolver does not produce: ${[...new Set(unresolved)].join(', ')}. Add them to ` +
      'resolveIdentity() in tools/msix/msix-identity.js.'
    );
  }
  // Belt and braces: nothing that looks like a placeholder may survive into the output.
  const leftovers = rendered.match(TOKEN_RE);
  if (leftovers) {
    throw new Error(`Unresolved placeholders remain in the generated manifest: ${leftovers.join(', ')}`);
  }

  assertXmlCommentsValid(rendered);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, rendered, 'utf8');

  return { out, tokens, store };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[msix:manifest] ${err.message}`);
    process.exit(2);
  }

  try {
    const { out, tokens, store } = generate(args);
    console.log(`[msix:manifest] mode              ${store ? 'STORE (unsigned artifact for Microsoft to sign)' : 'development'}`);
    console.log(`[msix:manifest] Identity/Name     ${tokens.IDENTITY_NAME}`);
    console.log(`[msix:manifest] Publisher         ${tokens.PUBLISHER}`);
    console.log(`[msix:manifest] PublisherDisplay  ${tokens.PUBLISHER_DISPLAY_NAME}`);
    console.log(`[msix:manifest] DisplayName       ${tokens.DISPLAY_NAME}`);
    console.log(`[msix:manifest] Version           ${tokens.PACKAGE_VERSION}`);
    console.log(`[msix:manifest] Executable        ${tokens.EXECUTABLE}`);
    console.log(`[msix:manifest] wrote             ${path.relative(REPO_ROOT, out)}`);
  } catch (err) {
    if (err instanceof MsixIdentityError) {
      console.error(`[msix:manifest] identity error: ${err.message}`);
    } else {
      console.error(`[msix:manifest] ${err.stack || err.message}`);
    }
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { generate, escapeXml, assertXmlCommentsValid };
