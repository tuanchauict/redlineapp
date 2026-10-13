// Stage the web app: a directory that any static host can serve.
//
//   npm run build:webapp         # -> dist/web/
//
// The page is the one the desktop app embeds, staged by the same code (stage-page.mts) for a host
// with no server and no shell: the reader runs in a SharedWorker, over the browser's own file
// access and IndexedDB, so nothing here is anything but files. What this adds to the staging is
// `_headers`, which is what makes a static host say what the CLI's server says, and how long a
// browser may keep each file: a year for the ones the page asks for as `?v=<build>`, and a check
// every time for `index.html`, which is the one that says what the build is.
//
// `dist/web/` is gitignored, like every other thing built into dist/, and is emptied on every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directives, inlineScriptHashes, serialize } from '../src/core/csp.js';
import { stagePage, megabytes, type StagedPage } from './stage-page.mjs';

export const WEB_DIST = 'dist/web';

/**
 * What a browser may keep of a file asked for as `name?v=<build>`: for as long as it will, and
 * without asking again. The URL is the build, so the file under it is never anything else.
 */
export const HELD = 'public, max-age=31536000, immutable';

/**
 * The paths in `dir` that are asked for by a versioned URL, as `_headers` writes them: every file
 * at the top but `index.html`, and every directory with a `/*` after it. Not the other way round
 * (a list of what to revalidate) so that what is forgotten is held less, and not for ever.
 *
 * What it takes for granted is that the page asks for each of them by `?v=`, which
 * `stage-page.mts` writes into `index.html` and into the imports, and which the tests (12e) read
 * back out. A file added to `public/` and fetched by a name of its own would be held for a year
 * under a name that does not change.
 *
 * @param dir  The staged page, before `_headers` is in it.
 */
export function heldPaths(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'index.html')
    .map((e) => (e.isDirectory() ? `/${e.name}/*` : `/${e.name}`))
    .sort();
}

/**
 * The content of `_headers` for a page whose index.html is `html`: a rule for everything, and
 * after it, once `held` is given, the rules for how long to keep what.
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
 * @param html  The staged index.html.
 * @param held  Paths a browser may keep for a year (`heldPaths`). Default: none.
 */
export function headersFile(html: string, held: string[] = []): string {
  const csp = serialize(
    directives({
      'script-src': ["'self'", ...inlineScriptHashes(html)],
      'worker-src': ["'self'"],
    }),
  );
  const rules = [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    // A response is run as script only if the server called it one, never because it looks like
    // one. (Module scripts are refused under any other type anyway, which is why Mermaid's .mjs
    // chunks have to be served as text/javascript by whatever hosts this.)
    '  X-Content-Type-Options: nosniff',
    // Every badge a document loads and every link it has to the web is a request that would
    // otherwise say which site it came from.
    '  Referrer-Policy: no-referrer',
  ];
  if (held.length) {
    rules.push(
      '',
      // The one file whose URL is the same in every build, and so the one a browser has to ask
      // about every time: it is what says which build the rest are. `no-cache` is not `no-store`:
      // the browser keeps it and asks, and the usual answer is a 304 with no body. Every other
      // path is `?v=`'d, so a release is a new URL for each of them and is fetched at once, and an
      // old one is never asked for again.
      '# index.html is the one URL that does not change with the build: ask about it every time.',
      '/',
      '  Cache-Control: no-cache',
      '/index.html',
      '  Cache-Control: no-cache',
      '',
      '# Everything else is asked for as ?v=<build>, so a URL is only ever one file: keep it.',
      ...held.flatMap((p) => [p, `  Cache-Control: ${HELD}`]),
    );
  }
  return [...rules, ''].join('\n');
}

/**
 * Stage the page for the web into `dest` and write `_headers` beside it.
 *
 * @param dest  Relative to the repository root, or absolute.
 * @returns  `version` is the `?v=` the page's files are asked for by.
 */
export function buildWebapp(dest = WEB_DIST): StagedPage {
  const staged = stagePage(dest, { host: 'web' });
  const html = fs.readFileSync(path.join(staged.dest, 'index.html'), 'utf8');
  const headers = headersFile(html, heldPaths(staged.dest));
  fs.writeFileSync(path.join(staged.dest, '_headers'), headers);
  return {
    dest: staged.dest,
    bytes: staged.bytes + Buffer.byteLength(headers),
    version: staged.version,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = buildWebapp();
  console.log(`\n  ${WEB_DIST}  ${megabytes(bytes)}\n`);
}
