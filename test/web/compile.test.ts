import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { rootUrl } from '../../src/hosts/node/root.js';

// The page imports its bundles from ./vendor/, which exists only once build:web has run, so tsc
// cannot look there. types/vendor/ holds a shim for each, re-exporting the source the bundle is
// built from, and rootDirs in tsconfig.page.json is what makes `./vendor/render.js` find it. An
// entry in build-web's BUNDLES that changed while its shim did not would check the page against
// a module it no longer loads, and nothing else would say so.
test('the page project has its shims, and each names the bundle it stands for', async () => {
  const text = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const bundles = [...text('scripts/build-web.mts').matchAll(/entry: '([^']+)', out: '([^']+)'/g)]
    .map(([, entry, out]) => ({ entry, out }));
  assert.ok(bundles.length >= 5, "the walk found build-web's bundles");
  // The one bundle the page does not import: the web backend starts it as a worker.
  const notImported = new Set(['reader-worker.js']);
  for (const { entry, out } of bundles.filter((b) => !notImported.has(b.out))) {
    const shim = text(`types/vendor/${out.replace(/\.js$/, '.d.ts')}`);
    assert.ok(
      shim.includes(`export * from '../../${entry.replace(/\.ts$/, '.js')}';`),
      `types/vendor/${out.replace(/\.js$/, '.d.ts')} re-exports ${entry}`,
    );
  }
  assert.ok(
    /export \{ default \} from 'mermaid';/.test(text('types/vendor/mermaid/mermaid.esm.min.d.mts')),
    'and mermaid, which is not built here, has its own',
  );

  // The config is JSON, so its reasons are in docs/typescript.md and these are the lines that
  // would silently stop working: no exclude and `tsc` compiles nothing and exits 0.
  const page = JSON.parse(text('tsconfig.page.json'));
  assert.deepStrictEqual(page.exclude, ['node_modules', 'out'],
    'the page project names its own exclude: outDir "." makes the default exclude the repository');
  assert.strictEqual(page.compilerOptions.outDir, '.', 'it emits beside its sources');
  assert.strictEqual(page.compilerOptions.declarationDir, 'out/page-types',
    'and keeps the .d.ts that composite forces out of public/ and site/');
  assert.deepStrictEqual(page.compilerOptions.rootDirs, ['public', 'types'],
    'rootDirs is what resolves ./vendor/*.js to the shims');
  // rootDirs tries the path as written first, and with allowJs the built bundle in public/vendor/
  // answers it, so once build:web has run the shim is never reached and tsc compiles the bundle.
  assert.strictEqual(page.compilerOptions.allowJs, false,
    'and allowJs is off, or the built bundle in public/vendor/ shadows the shim');
  assert.ok(
    JSON.parse(text('tsconfig.json')).references.some((r) => r.path === './tsconfig.page.json'),
    'tsc -b builds it',
  );

  // tsc checks public/app/ and esbuild compiles it, each told about JSX on its own: the root
  // tsconfig holds only references, so esbuild has none to read the setting from.
  const app = JSON.parse(text('tsconfig.app.json'));
  assert.strictEqual(app.compilerOptions.noEmit, true,
    'the app project only checks: app.js is build:web\'s, and an emit would be a second one');
  assert.strictEqual(app.compilerOptions.jsx, 'react-jsx', 'it reads JSX as the automatic runtime');
  const buildWeb = text('scripts/build-web.mts');
  assert.ok(
    /jsx: 'automatic'/.test(buildWeb) &&
      buildWeb.includes(`jsxImportSource: '${app.compilerOptions.jsxImportSource}'`),
    'and esbuild compiles it against the same runtime tsc checked it against',
  );
  assert.ok(
    JSON.parse(text('tsconfig.json')).references.some((r) => r.path === './tsconfig.app.json'),
    'tsc -b checks it',
  );
});

// A page source with no compiled sibling means the page project compiled nothing, which is a
// thing tsc will do without a word (see docs/typescript.md). `pretest` runs the compile, so
// the sibling is there whenever the project works.
test('every page source has been compiled in place', async () => {
  for (const dir of ['public', 'site']) {
    const names = fs.readdirSync(fileURLToPath(rootUrl(`${dir}/`)));
    for (const f of names.filter((n) => n.endsWith('.ts'))) {
      assert.ok(
        fs.existsSync(fileURLToPath(rootUrl(`${dir}/${f.replace(/\.ts$/, '.js')}`))),
        `${dir}/${f} has been compiled in place: run npm run build:ts`,
      );
    }
  }
  // The three are compiled beside their sources and must never be committed: a tracked copy would
  // go stale against its .ts and look exactly like the change not working.
  const ignored = fs.readFileSync(rootUrl('.gitignore'), 'utf8').split('\n');
  for (const f of ['public/app.js', 'public/backend.js', 'site/landing.js']) {
    assert.ok(ignored.includes(f), `${f} is generated, and gitignored`);
  }
});

// The step in front of `tsc -b` that brings a deleted page back (bootstrap/heal-page-build.mjs),
// run against a page-shaped directory in the temp dir: the real test of it deletes public/app.js,
// and a suite does not delete the files it is about to serve. The tsconfig in the fixture is the
// real one, so what counts as a page source and where the build record lives are read from where
// the project says them, and a change there that the step did not follow turns this red.
test('a deleted page is rebuilt: the step before tsc -b forgets the record it trusts', async () => {
  const heal = fileURLToPath(rootUrl('bootstrap/heal-page-build.mjs'));
  const roots = [];
  const put = (root, rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '{}');
  };
  const makeRoot = ({ compiled, built }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-heal-'));
    roots.push(root);
    fs.copyFileSync(rootUrl('tsconfig.page.json'), path.join(root, 'tsconfig.page.json'));
    for (const f of ['public/app', 'public/backend', 'site/landing']) {
      put(root, `${f}.ts`);
      if (compiled) put(root, `${f}.js`);
    }
    // Neither of these is output, so neither is ever missing: a hand-written .js with no .ts
    // beside it, and a declaration file, which emits nothing.
    put(root, 'public/host.js');
    put(root, 'public/shim.d.ts');
    if (built) {
      put(root, 'out/tsconfig.page.tsbuildinfo');
      put(root, 'out/tsconfig.src.tsbuildinfo');
    }
    return root;
  };
  const run = (root) => spawnSync(process.execPath, [heal, root], { encoding: 'utf8' });
  const has = (root, rel) => fs.existsSync(path.join(root, rel));
  const record = 'out/tsconfig.page.tsbuildinfo';

  // Nothing wrong: the record stays, so that the compile after it is the no-op it should be.
  let root = makeRoot({ compiled: true, built: true });
  let r = run(root);
  assert.strictEqual(r.status, 0, 'the step exits 0');
  assert.strictEqual(r.stdout, '', 'and says nothing when the page is all there');
  assert.ok(has(root, record), 'and leaves the build record, so tsc -b stays a no-op');

  // One compiled file gone, as a branch switch leaves it: the record goes, and says why.
  fs.rmSync(path.join(root, 'site/landing.js'));
  r = run(root);
  assert.strictEqual(r.status, 0, 'a missing page file is not an error');
  assert.match(r.stdout, /site\/landing\.js missing/, 'it names the file that is gone');
  assert.doesNotMatch(r.stdout, /app\.js|backend\.js/, 'and only that one');
  assert.ok(!has(root, record), 'and removes the page project\'s build record, so tsc rebuilds it');
  assert.ok(has(root, 'out/tsconfig.src.tsbuildinfo'), 'but not the other projects\'');

  // All three gone, the branch-switch case itself.
  root = makeRoot({ compiled: false, built: true });
  r = run(root);
  for (const f of ['public/app.js', 'public/backend.js', 'site/landing.js']) {
    assert.ok(r.stdout.includes(f), `${f} is named when the whole page is gone`);
  }
  assert.ok(!has(root, record), 'and the record goes');

  // A checkout that has never built has no record to remove, and nothing to say about it. The
  // step must not create the out/ that the compile will.
  root = makeRoot({ compiled: false, built: false });
  r = run(root);
  assert.strictEqual(r.status, 0, 'a fresh checkout is fine');
  assert.strictEqual(r.stdout, '', 'and silent');
  assert.ok(!has(root, 'out'), 'and creates nothing');

  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});
