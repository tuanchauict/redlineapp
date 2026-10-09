// Stage the page for the native shell.
//
//   npm run build:dist
//
// The desktop app has no server, so everything the page asks for over a URL has
// to be a file sitting next to it. In the CLI, src/hosts/node/server.js answers those
// requests by reading out of node_modules and assets/ wherever they happen to
// be; here the same files are copied into shell/dist, which tauri.conf.json
// names as the front end and Tauri serves from inside the bundle.
//
// The layout is the server's routing table, flattened:
//
//   index.html, app.js, backend.js, styles.css,  public/
//   host.js
//   vendor/render.js, vendor/backend-tauri.js    built by build-web.mjs
//   vendor/github-markdown.css, vendor/hljs-*    node_modules
//   vendor/mermaid/                              node_modules (the whole tree)
//   icon.svg                                     assets/
//
// So the page's own `vendor/...` links (relative, so they hold under any base URL) work
// unchanged in both, and nothing has to be rewritten on the way in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'shell', 'dist');

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

// Emptied first, so that a file that stops being part of the page stops being
// shipped. Only ever what this script wrote: shell/dist is build output and is
// not in the repository.
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

fs.cpSync(path.join(ROOT, 'public'), DIST, { recursive: true });
for (const [to, from] of Object.entries(FILES)) {
  fs.mkdirSync(path.join(DIST, path.dirname(to)), { recursive: true });
  fs.copyFileSync(from, path.join(DIST, to));
}
const mermaid = path.join(DIST, 'vendor', 'mermaid');
fs.mkdirSync(mermaid, { recursive: true });
fs.copyFileSync(MERMAID_ENTRY, path.join(mermaid, path.basename(MERMAID_ENTRY)));
fs.cpSync(MERMAID_CHUNKS, path.join(mermaid, 'chunks', 'mermaid.esm.min'), {
  recursive: true,
  filter: (src) => fs.statSync(src).isDirectory() || src.endsWith('.mjs'),
});

// The page has to be there, and it has to have a renderer to import: both are
// generated, and a silently empty dist would only show up as a blank window.
const NEEDED = [
  'index.html',
  'app.js',
  'vendor/render.js',
  'vendor/sanitize.js',
  'vendor/backend-tauri.js',
];
for (const needed of NEEDED) {
  if (!fs.existsSync(path.join(DIST, needed))) {
    throw new Error(`shell/dist is missing ${needed} — run npm run build:web first`);
  }
}

const size = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .reduce(
      (n, e) =>
        n +
        (e.isDirectory()
          ? size(path.join(dir, e.name))
          : fs.statSync(path.join(dir, e.name)).size),
      0,
    );

console.log(`\n  shell/dist  ${(size(DIST) / 1024 / 1024).toFixed(1)} MB\n`);
