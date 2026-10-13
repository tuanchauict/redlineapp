// Bundle for the page.
//
//   npm run build:web
//
// Five bundles, all of them code that started life in src/ and has to end up
// running in a webview:
//
//   render.js         src/core/document.ts -- the diff and the markdown rendering.
//   sanitize.js       src/page/sanitize.ts -- DOMPurify, and what a document may put
//                     on the page. Not in render.js, which Node imports too.
//   backend-tauri.js  src/hosts/tauri/backend.ts -- the reader, the store and the
//                     Tauri platform, for the desktop build where there is no
//                     server to ask. Loaded only when the shell has left its
//                     facts on the window, so a browser never fetches it.
//   backend-web.js    src/hosts/web/backend.ts -- the page's end of the web app: the
//                     rpc client, the permission prompt, the page's lifecycle. Small,
//                     because the reader is not in it.
//   reader-worker.js  src/hosts/web/worker.ts -- the reader, the store and the web
//                     platform, as the SharedWorker's script, and as the module a
//                     page without SharedWorker imports to be its own worker.
//
// No entry point touches node:, which is the property that makes this
// possible and the one src/reader/platform.ts exists to preserve.
//
// Why bundle rather than ship the modules and let the browser resolve them:
// markdown-it's ESM entry imports its dependencies by bare name (entities,
// linkify-it, mdurl, uc.micro), highlight.js is CommonJS with an `es/` build
// reached through an exports alias, and diff is ESM under `libesm/`. An import
// map covering all of that would be a second package manager written in JSON,
// and it would have to stay right. esbuild already knows how to read the
// exports fields, so it reads them once, here.
//
// Mermaid is not in here. It is bigger than everything else put together, it
// only matters to documents that actually draw a diagram, and it is already
// mounted as its own lazily-imported asset tree.
//
// And one stylesheet, which is not a bundle but is written here for the same
// reason the bundles are -- every host's page loads it from vendor/, and this
// is the step every host runs first:
//
//   github-markdown.css  github-markdown-css, with its palette keyed to the
//                        page's scheme and not the system's (markdown-css.mts)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import { keyToScheme } from './markdown-css.mjs';
import { ROOT } from '../src/hosts/node/root.js';

const require = createRequire(import.meta.url);
const VENDOR = path.join(ROOT, 'public', 'vendor');

const BUNDLES = [
  { entry: 'src/core/document.ts', out: 'render.js' },
  { entry: 'src/page/sanitize.ts', out: 'sanitize.js' },
  { entry: 'src/hosts/tauri/backend.ts', out: 'backend-tauri.js' },
  { entry: 'src/hosts/web/backend.ts', out: 'backend-web.js' },
  { entry: 'src/hosts/web/worker.ts', out: 'reader-worker.js' },
];

const dev = process.argv.includes('--dev');

fs.mkdirSync(VENDOR, { recursive: true });

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

for (const { entry, out } of BUNDLES) {
  const outfile = path.join(VENDOR, out);

  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    // Both front ends are a current WebKit or Chromium, so there is nothing to
    // transpile down to. Naming a target at all is what stops esbuild guessing.
    target: ['safari17', 'chrome120'],
    minify: !dev,
    sourcemap: dev,
    // Kept, at the end of each bundle: a license that asks for its notice to
    // travel with the code is asking about this file, and minifying it away
    // would be shipping the code without it. THIRD-PARTY-NOTICES.md is the
    // complete list; these are the notices that sit with the code they cover.
    legalComments: 'eof',
    // Nothing in the graph reads these, but markdown-it and highlight.js both
    // contain the usual `typeof process` guards; substituting the values lets
    // esbuild drop the dead branch rather than leave a reference the page has
    // to satisfy at runtime.
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    metafile: true,
  });

  // What is actually in there, biggest first: the one number that decides
  // whether any of this stays a good idea.
  const inputs = Object.entries(
    result.metafile.outputs[path.relative(ROOT, outfile)].inputs,
  ).sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput);

  const group = (file: string): string => {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
    return m ? m[1] : 'redline';
  };
  const byPackage = new Map();
  for (const [file, { bytesInOutput }] of inputs) {
    byPackage.set(group(file), (byPackage.get(group(file)) ?? 0) + bytesInOutput);
  }

  const bytes = fs.statSync(outfile).size;
  console.log(`\n  ${path.relative(ROOT, outfile)}  ${kb(bytes)}${dev ? '  (dev)' : ''}\n`);
  for (const [pkg, n] of [...byPackage].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kb(n).padStart(7)}  ${pkg}`);
  }
}

// And the page itself: public/app/ bundled into public/app.js, beside the files it imports.
//
// Not in BUNDLES, because it is not one of them. It is not built from src/, it is not written
// to vendor/, and it is not minified, so a stack trace in the webview console names the
// function it is in. (The suite lifts functions from main.ts, not from here: bundling renames
// the page's top-level names where they meet Preact's.)
//
// Bundled at all because Preact is imported by its package name, and so is the JSX runtime
// every component compiles to; a browser resolves neither. What it imports by a path of its own
// stays a separate file, written as the page sees it from public/ — the source is a directory
// deeper — so app.js imports exactly what it did when tsc wrote it: the renderer, DOMPurify, the
// backend, Mermaid. stage-page.mts versions those four, and the suite counts them. Which file
// is meant is read off the resolved path, not the specifier: `../vendor/` from main.ts and
// `../../vendor/` from vm/ are the same file, and `./backend.js` from main.ts is the page's own
// public/app/backend.ts, which is bundled.
const PUBLIC = path.join(ROOT, 'public');
const PAGE_EXTERNAL = /^(vendor\/.+|backend\.js)$/;
const pageOut = path.join(ROOT, 'public', 'app.js');
await esbuild.build({
  entryPoints: [path.join(ROOT, 'public', 'app', 'main.ts')],
  outfile: pageOut,
  bundle: true,
  format: 'esm',
  target: ['safari17', 'chrome120'],
  sourcemap: dev,
  legalComments: 'eof',
  // tsconfig.app.json says the same for tsc; esbuild finds no tsconfig beside the source to
  // read it from, because the root one holds only references.
  jsx: 'automatic',
  jsxImportSource: 'preact',
  plugins: [
    {
      name: 'page-external',
      setup(build) {
        build.onResolve({ filter: /^\.\.?\// }, (args) => {
          if (!args.importer.startsWith(path.join(PUBLIC, 'app') + path.sep)) return undefined;
          const served = path.relative(PUBLIC, path.resolve(args.resolveDir, args.path));
          const name = served.split(path.sep).join('/');
          return PAGE_EXTERNAL.test(name) ? { path: `./${name}`, external: true } : undefined;
        });
      },
    },
  ],
});
console.log(`\n  ${path.relative(ROOT, pageOut)}  ${kb(fs.statSync(pageOut).size)}`);

const markdownCss = require.resolve('github-markdown-css/github-markdown.css');
const markdownOut = path.join(VENDOR, 'github-markdown.css');
fs.writeFileSync(markdownOut, keyToScheme(fs.readFileSync(markdownCss, 'utf8')));
console.log(`\n  ${path.relative(ROOT, markdownOut)}  ${kb(fs.statSync(markdownOut).size)}`);
console.log();
