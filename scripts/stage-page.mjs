// Stage the page for a host that has no server of its own to hand it out.
//
//   import { stagePage } from './stage-page.mjs';
//   stagePage('shell/dist', { host: 'tauri' });
//   stagePage('dist/web', { host: 'web' });
//
// The desktop app and the web app both serve the page as a plain directory, and what is in
// that directory is the same except for two things: which backend bundle the page loads, and
// the shim that says which host it is. In the CLI, src/hosts/node/server.ts answers the page's
// requests by reading out of node_modules and assets/ wherever they happen to be; here the same
// files are copied next to the page.
//
// The layout is the server's routing table, flattened:
//
//   index.html, app.js, backend.js, styles.css,  public/
//   host.js                                      the host's own shim (see below)
//   vendor/render.js, vendor/sanitize.js         built by build-web.mjs, for every host
//   vendor/github-markdown.css                   the same (its palette keyed by markdown-css.mjs)
//   vendor/backend-*.js, vendor/reader-worker.js built by build-web.mjs, *this host's only*
//   vendor/hljs-*                                node_modules
//   vendor/mermaid/                              node_modules (the minified ESM tree)
//   icon.svg                                     assets/
//
// So the page's own `vendor/...` links (relative, so they hold under any base URL) work
// unchanged in every host, and nothing has to be rewritten on the way in.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from '../src/hosts/node/root.js';

const require = createRequire(import.meta.url);

/**
 * What differs between hosts.
 *
 * `bundles` are the files in public/vendor/ that only this host loads. `build:web` writes every
 * host's into the one directory, and `public/` is copied whole, so each host leaves out the rest:
 * a bundle a host never loads is code it only carries, and for the web app it is a file the
 * browser could be tricked into fetching that nothing on the page asks for.
 *
 * `shim` is the file that replaces public/host.js, which is empty -- the Mac app and the CLI
 * need nothing from it. It is not copied into public/, so a change to the web app's shim cannot
 * reach the other two, and a build that forgets to stage it is a page that does not say it is the
 * web app, which the tests (12e) look for -- `public/host.js` is there either way, so the check
 * below would not notice.
 */
export const HOSTS = {
  tauri: { bundles: ['backend-tauri.js'], shim: null, versioned: false },
  web: {
    bundles: ['backend-web.js', 'reader-worker.js'],
    shim: 'src/hosts/web/host.js',
    // The page is fetched over the network, and from a cache that is meant to hold it for a year.
    // The desktop app has its files inside the binary, and the CLI's server never caches them.
    versioned: true,
  },
};

/** Where each thing comes from, keyed by where the page looks for it. */
const FILES = {
  'vendor/hljs-light.css': require.resolve('highlight.js/styles/github.css'),
  'vendor/hljs-dark.css': require.resolve('highlight.js/styles/github-dark.css'),
  'icon.svg': path.join(ROOT, 'assets', 'icon.svg'),
};

// Mermaid lazy-loads a chunk per diagram kind, relative to its own URL, so a
// directory goes in rather than a single file -- the same reason the server
// mounts one.
//
// But only the minified ESM tree, which is what the page imports and is
// entirely self-contained: nothing under chunks/mermaid.esm.min/ reaches
// outside it or at anything that is not a .mjs. What mermaid ships alongside
// it -- the unminified and core builds, the UMD bundles, the source maps, the
// type declarations, the tests -- is 117 of its 123 MB and none of it is ever
// asked for. Shipping it would put all of that inside the app.
const MERMAID_ENTRY = require.resolve('mermaid/dist/mermaid.esm.min.mjs');
const MERMAID_CHUNKS = path.join(path.dirname(MERMAID_ENTRY), 'chunks', 'mermaid.esm.min');

/** The version a build carries, from the one place it is written. */
export const buildVersion = () =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Refuse to empty the repository, or a directory that holds it. `stagePage` removes whatever it
 * is given, recursively, and `''`, `'.'` and `'..'` are all things a caller can pass without
 * meaning to: the first two are the repository, `.git` and all, and the third is what it sits in.
 * It is a function of its own, and not a line in `stagePage`, so that a test can ask it about the
 * repository without ever handing the repository to something that deletes.
 *
 * Not a guard against `src/` or `public/`, which are inside the repository and are not it: those
 * are for whoever picks the destination, and what picks them today is a literal.
 *
 * @param {string} out  Absolute.
 * @param {string} [root]  Default: this repository.
 */
export function assertSafeDest(out, root = ROOT) {
  const rel = path.relative(out, root);
  // `rel` is where the repository is, seen from `out`. Going up (`..`, `../..`) means `out` is
  // inside it or beside it; an absolute `rel` (another drive) means they are unrelated. Anything
  // else is the repository below `out`, or `out` itself (''), and `..` has to be followed by a
  // separator because `..foo` is a directory's name and not a way up.
  const goesUp = rel === '..' || rel.startsWith(`..${path.sep}`);
  if (rel === '' || !(goesUp || path.isAbsolute(rel))) {
    throw new Error(`stagePage: refusing to empty ${out}, which is the repository or holds it`);
  }
}

/**
 * A short hash of the bytes the web app's reader is made of, for its build's name. Each is
 * prefixed with its length, so that a byte moved from the end of one bundle to the start of the
 * next is a different build and not the same concatenation.
 *
 * @param {Buffer[]} buffers  In a fixed order.
 */
export function bundleHash(buffers) {
  const h = crypto.createHash('sha256');
  for (const b of buffers) h.update(`${b.length}:`).update(b);
  return h.digest('hex').slice(0, 12);
}

/**
 * The id that goes in the URL of every file the web app loads, `?v=3fa9c2d1e0b4`: a hash of every
 * file under `dir`, by path and by bytes, and of `extra`. Anything that changes what ships is a new
 * one, and nothing else is, so a rebuild that changed nothing asks the browser for nothing.
 *
 * It is of the whole page and not of each file, on purpose. A file that imports another has the
 * other's id in its own text, so a per-file id would be one that has to be worked out in the
 * order of the imports, and a cycle between two files has no such order. One id for all of them
 * is one more download for the files that did not change, once per release, and that is all.
 *
 * @param {string} dir
 * @param {string} [extra]  What is part of the build and is not in `dir` yet.
 */
export function pageHash(dir, extra = '') {
  const h = crypto.createHash('sha256').update(`${extra.length}:${extra}`);
  const walk = (rel) =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const next = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(next) : [next];
    });
  // readdir's order is the filesystem's, and the id has to be the same on a Mac and on Linux.
  for (const rel of walk('').sort()) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    h.update(`${rel}\0${bytes.length}:`).update(bytes);
  }
  return h.digest('hex').slice(0, 12);
}

/**
 * The page's own files that import other files of it by a string literal, which the browser
 * resolves for itself and which therefore *do not* inherit the `?v=` of the file that has them.
 * `app.js` imports `./backend.js` and a browser asks for exactly that, with no query, however
 * `app.js` was asked for. So the query is written into the specifiers of the files that are not
 * bundled, and the build fails if one has nothing to write it into, which means the file has
 * changed shape and nobody has looked.
 *
 * Not the bundles (`vendor/*.js`), which import nothing by a path of their own: one that does
 * is for the test (12e) to say, and not for a pattern to rewrite inside minified code. The one
 * place a bundle builds a URL, the worker's, takes its query from its own (`hosts/web/backend.ts`).
 * And not Mermaid's chunks, whose names are a hash of their content already.
 */
const MODULES = ['app.js', 'backend.js'];

/**
 * Put `?v=<version>` on every file the staged page names, so that a file can be cached for as long
 * as a browser will keep it and a new build is still a new URL, asked for at once.
 *
 * `index.html` is the one file that is not versioned, because it is the one that says what the
 * version is: it is the file a browser has to ask about every time (`_headers` says so).
 *
 * @param {string} out  The staged page.
 * @param {string} version  From `pageHash`.
 */
function versionPage(out, version) {
  const query = `?v=${version}`;

  // A file of the page: not another site (`https:`), not the root of this one, not an anchor.
  const own = (url) => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url);
  const html = path.join(out, 'index.html');
  fs.writeFileSync(
    html,
    fs
      .readFileSync(html, 'utf8')
      .replace(/(<(?:script|link|img)\b[^>]*?\s(?:src|href)=")([^"]*)(")/g, (m, open, url, close) =>
        own(url) ? `${open}${url}${query}${close}` : m,
      ),
  );

  for (const file of MODULES) {
    const f = path.join(out, file);
    let n = 0;
    const text = fs.readFileSync(f, 'utf8').replace(
      /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"?]+)\2/g,
      (m, lead, q, specifier) => {
        n++;
        return `${lead}${q}${specifier}${query}${q}`;
      },
    );
    if (!n) throw new Error(`${file} has no imports to version -- stage-page.mjs is out of date`);
    fs.writeFileSync(f, text);
  }
}

/**
 * Write the page for `host` into `dest`, which is emptied first, so that a file that stops
 * being part of the page stops being shipped. Only ever what this wrote: `dest` is build output
 * and is not in the repository.
 *
 * @param {string} dest  Relative to the repository root, or absolute. Not the repository.
 * @param {{ host: keyof typeof HOSTS }} opts
 * @returns {{ dest: string, bytes: number, version: string|null }}  The absolute path, what is
 *   in it, and the `?v=` its files are asked for by: null for a host that does not version them.
 */
export function stagePage(dest, { host }) {
  const spec = HOSTS[host];
  if (!spec) throw new Error(`stagePage: no host called ${host}`);
  const out = path.resolve(ROOT, dest);

  assertSafeDest(out);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const others = new Set(
    Object.values(HOSTS)
      .flatMap((h) => h.bundles)
      .filter((b) => !spec.bundles.includes(b)),
  );
  fs.cpSync(path.join(ROOT, 'public'), out, {
    recursive: true,
    filter: (src) => !others.has(path.basename(src)),
  });
  for (const [to, from] of Object.entries(FILES)) {
    fs.mkdirSync(path.join(out, path.dirname(to)), { recursive: true });
    fs.copyFileSync(from, path.join(out, to));
  }
  const mermaid = path.join(out, 'vendor', 'mermaid');
  fs.mkdirSync(mermaid, { recursive: true });
  fs.copyFileSync(MERMAID_ENTRY, path.join(mermaid, path.basename(MERMAID_ENTRY)));
  fs.cpSync(MERMAID_CHUNKS, path.join(mermaid, 'chunks', 'mermaid.esm.min'), {
    recursive: true,
    filter: (src) => fs.statSync(src).isDirectory() || src.endsWith('.mjs'),
  });

  // The page has to be there, and it has to have a renderer and a backend to import: all of them
  // are generated or staged, and a silently empty dist would only show up as a blank window.
  const needed = [
    'index.html',
    'app.js',
    'host.js',
    'vendor/render.js',
    'vendor/sanitize.js',
    'vendor/github-markdown.css',
    ...spec.bundles.map((b) => `vendor/${b}`),
  ];
  for (const file of needed) {
    if (!fs.existsSync(path.join(out, file))) {
      throw new Error(`${dest} is missing ${file} — run npm run build:web first`);
    }
  }

  const shim = spec.shim ? fs.readFileSync(path.join(ROOT, spec.shim), 'utf8') : '';

  // The id is of everything that ships, and so it is worked out here, after the page is all there
  // and before anything is written into it: the shim is not in `out` yet, so it goes in by hand,
  // with the version. The query goes in only after, because a file's id cannot include itself.
  // It is the page's URLs that carry it. The worker's name, below, is the reader's alone, and
  // changes only when the reader does.
  const version = spec.versioned ? pageHash(out, `${buildVersion()}\n${shim}`) : null;
  if (version) versionPage(out, version);

  // The host's own shim goes over the empty one, with the build's name after it: the version and
  // a hash of the bundles. This is what writes the page, and a SharedWorker is found by its URL
  // and its name, so the web app names its worker for the build (hosts/web/backend.ts) and learns
  // which build it is from the file that says it is the web app. The version alone is the same
  // across every rebuild at one version -- each round of `npm run webapp`, any redeploy -- and a
  // tab left open would keep the old reader for the new tabs to join. The hash is of the bundles
  // because they are what runs in the worker and what talks to it, and it is of the staged ones
  // because those are what ship. It is semver's own build-metadata form, `0.7.0+3fa9c2d1e0b4`.
  if (spec.shim) {
    const bundles = spec.bundles.map((b) => fs.readFileSync(path.join(out, 'vendor', b)));
    const build = `${buildVersion()}+${bundleHash(bundles)}`;
    fs.writeFileSync(
      path.join(out, 'host.js'),
      `${shim.trimEnd()}\nglobalThis.__REDLINE_VERSION = ${JSON.stringify(build)};\n`,
    );
  }

  return { dest: out, bytes: size(out), version };
}

const size = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce(
      (n, e) =>
        n +
        (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size),
      0,
    );

/** `5.9 MB`, for the line a build prints when it is done. */
export const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
