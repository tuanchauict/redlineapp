// Stage the page for a host that has no server of its own to hand it out.
//
//   import { stagePage } from './stage-page.mjs';
//   stagePage('shell/dist', { host: 'tauri' });
//   stagePage('dist/web', { host: 'web' });
//
// The desktop app and the web app both serve the page as a plain directory, and what is in
// that directory is the same except for two things: which backend bundle the page loads, and
// the shim that says which host it is. In the CLI, src/hosts/node/server.js answers the page's
// requests by reading out of node_modules and assets/ wherever they happen to be; here the same
// files are copied next to the page.
//
// The layout is the server's routing table, flattened:
//
//   index.html, app.js, backend.js, styles.css,  public/
//   host.js                                      the host's own shim (see below)
//   vendor/render.js, vendor/sanitize.js         built by build-web.mjs, for every host
//   vendor/backend-*.js, vendor/reader-worker.js built by build-web.mjs, *this host's only*
//   vendor/github-markdown.css, vendor/hljs-*    node_modules
//   vendor/mermaid/                              node_modules (the minified ESM tree)
//   icon.svg                                     assets/
//
// So the page's own `vendor/...` links (relative, so they hold under any base URL) work
// unchanged in every host, and nothing has to be rewritten on the way in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * reach the other two, and a build that forgets to stage it fails the checks below.
 */
export const HOSTS = {
  tauri: { bundles: ['backend-tauri.js'], shim: null },
  web: {
    bundles: ['backend-web.js', 'reader-worker.js'],
    shim: 'src/hosts/web/host.js',
  },
};

/** Where each thing comes from, keyed by where the page looks for it. */
const FILES = {
  'vendor/github-markdown.css': require.resolve('github-markdown-css/github-markdown.css'),
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
 * Write the page for `host` into `dest`, which is emptied first, so that a file that stops
 * being part of the page stops being shipped. Only ever what this wrote: `dest` is build output
 * and is not in the repository.
 *
 * @param {string} dest  Relative to the repository root, or absolute.
 * @param {{ host: keyof typeof HOSTS }} opts
 * @returns {{ dest: string, bytes: number }}  The absolute path, and what is in it.
 */
export function stagePage(dest, { host }) {
  const spec = HOSTS[host];
  if (!spec) throw new Error(`stagePage: no host called ${host}`);
  const out = path.resolve(ROOT, dest);

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

  // The host's own shim goes over the empty one, with the build's version after it. The version
  // is here because this is what writes the page: a SharedWorker is found by its URL and its name,
  // so the web app names its worker for the build (hosts/web/backend.js), and the page learns
  // which build it is from the file that says it is the web app.
  if (spec.shim) {
    const shim = fs.readFileSync(path.join(ROOT, spec.shim), 'utf8');
    fs.writeFileSync(
      path.join(out, 'host.js'),
      `${shim.trimEnd()}\nglobalThis.__REDLINE_VERSION = ${JSON.stringify(buildVersion())};\n`,
    );
  }

  // The page has to be there, and it has to have a renderer and a backend to import: all of them
  // are generated or staged, and a silently empty dist would only show up as a blank window.
  const needed = [
    'index.html',
    'app.js',
    'host.js',
    'vendor/render.js',
    'vendor/sanitize.js',
    ...spec.bundles.map((b) => `vendor/${b}`),
  ];
  for (const file of needed) {
    if (!fs.existsSync(path.join(out, file))) {
      throw new Error(`${dest} is missing ${file} — run npm run build:web first`);
    }
  }

  return { dest: out, bytes: size(out) };
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
