// The page's content security policy, as data.
//
// The CLI's policy is the floor for every host (docs: invariant 6): a host may tighten it --
// VS Code adds `connect-src 'none'` -- and none may loosen it, add 'unsafe-eval', or allow an
// inline script that is not named by hash. So the directive list lives here, once, and the
// CLI server's header, the web build's `_headers` and the extension's <meta> are all made
// from it. The Tauri build carries a copy in shell/tauri.conf.json, where the bundler works
// out the hash itself; the test suite compares that copy with this list.
//
// Pure and synchronous on purpose, like hash.js: it runs in node build scripts, in the
// server and in the VS Code extension host.
import { sha256Hex } from './hash.js';

/**
 * The `'sha256-…'` source for every inline `<script>` in `html` -- the ones with no `src`.
 *
 * The head script has to run before first paint and so cannot be a file; a hash is how a
 * policy that forbids inline script lets that one through. The body is hashed exactly as it
 * stands between the tags, whitespace included, which is how the browser hashes it.
 */
export function inlineScriptHashes(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/g)].map(
    ([, body]) => `'sha256-${hexToBase64(sha256Hex(body))}'`,
  );
}

function hexToBase64(hex) {
  let bytes = '';
  for (let i = 0; i < hex.length; i += 2) {
    bytes += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  // btoa is in node since 16 and in every webview; Buffer is in only one of those.
  return btoa(bytes);
}

/**
 * The CLI's directives, as `{ name: [source, …] }`, in the order the header has them.
 *
 * `overrides` replaces a directive whole, or removes it when it is `null`. A host that adds
 * script hashes passes `{ 'script-src': ["'self'", ...hashes] }`; it is not done here because
 * which scripts are inline is a fact about the page this is applied to.
 */
export function directives(overrides = {}) {
  const base = {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    // Inline styles are the page's own -- sizes the head script restores, the widths a drag
    // sets, the styles mermaid writes into its SVG -- and a style cannot run anything.
    'style-src': ["'self'", "'unsafe-inline'"],
    // Anywhere, because a README's badges and screenshots are on the web and always have
    // been.
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'http:'],
    'font-src': ["'self'", 'data:'],
    // What keeps anything the page reads from being posted somewhere else.
    'connect-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  const out = { ...base, ...overrides };
  for (const [name, sources] of Object.entries(out)) if (sources == null) delete out[name];
  return out;
}

/** The header (or `<meta content>`) string for a directive object. */
export function serialize(policy) {
  return Object.entries(policy)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ');
}
