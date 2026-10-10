// Stage the web app: a directory that any static host can serve.
//
//   npm run build:webapp         # -> dist/web/
//
// The page is the one the desktop app embeds, staged by the same code (stage-page.mjs) for a host
// with no server and no shell: the reader runs in a SharedWorker, over the browser's own file
// access and IndexedDB, so nothing here is anything but files. What this adds to the staging is
// `_headers`, which is what makes a static host say what the CLI's server says.
//
// `dist/web/` is gitignored, like every other thing built into dist/, and is emptied on every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directives, inlineScriptHashes, serialize } from '../src/core/csp.js';
import { stagePage, megabytes } from './stage-page.mjs';

export const WEB_DIST = 'dist/web';

/**
 * The content of `_headers` for a page whose index.html is `html`: one rule, for everything.
 *
 * Cloudflare Pages reads this file out of the directory it is given. The policy is the CLI's own
 * (core/csp.js: script from here and the head script by its hash, nothing posted anywhere else),
 * and one directive more, `worker-src 'self'`, for the reader's SharedWorker. A worker is governed
 * by the policy on its own response, not by its page's, and `/*` is what puts one on it.
 *
 * The hash is of the head script as it is in the *staged* index.html, which is why this is made
 * from the staged page rather than from public/: a change to that script changes its hash, and a
 * stale one would block the script the page needs before it can paint.
 *
 * @param {string} html  The staged index.html.
 */
export function headersFile(html) {
  const csp = serialize(
    directives({
      'script-src': ["'self'", ...inlineScriptHashes(html)],
      'worker-src': ["'self'"],
    }),
  );
  return [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    // A response is run as script only if the server called it one, never because it looks like
    // one. (Module scripts are refused under any other type anyway, which is why Mermaid's .mjs
    // chunks have to be served as text/javascript by whatever hosts this.)
    '  X-Content-Type-Options: nosniff',
    // Every badge a document loads and every link it has to the web is a request that would
    // otherwise say which site it came from.
    '  Referrer-Policy: no-referrer',
    '',
  ].join('\n');
}

/**
 * Stage the page for the web into `dest` and write `_headers` beside it.
 *
 * @param {string} [dest]  Relative to the repository root, or absolute.
 * @returns {{ dest: string, bytes: number }}
 */
export function buildWebapp(dest = WEB_DIST) {
  const staged = stagePage(dest, { host: 'web' });
  const html = fs.readFileSync(path.join(staged.dest, 'index.html'), 'utf8');
  const headers = headersFile(html);
  fs.writeFileSync(path.join(staged.dest, '_headers'), headers);
  return { dest: staged.dest, bytes: staged.bytes + Buffer.byteLength(headers) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = buildWebapp();
  console.log(`\n  ${WEB_DIST}  ${megabytes(bytes)}\n`);
}
