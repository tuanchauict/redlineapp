// Smoke test: boot the server on a sample file, edit the file, verify the
// paragraph diff, live-reload event, version history and mark-read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';
import { ROOT, repoRoot, rootUrl } from './src/hosts/node/root.js';

// The two fields of package.json that the suite reads.
interface Pkg {
  bin: Record<string, string>;
  scripts: Record<string, string>;
}

// --- 0. where the repository is ------------------------------------------
// Node-run code compiles into out/, which mirrors the repository, so a `..` count that is
// right in src/ is wrong one directory deeper. The root is found by walking up to the first
// package.json instead, and out/ has none because tsc does not emit one.
{
  assert.ok(fs.existsSync(path.join(ROOT, 'package.json')), 'ROOT holds package.json');
  assert.strictEqual(repoRoot(import.meta.url), ROOT, 'the same answer from this file');
  for (const deep of ['src/hosts/node/x.js', 'out/src/hosts/node/x.js', 'out/scripts/x.mjs']) {
    const from = pathToFileURL(path.join(ROOT, deep)).href;
    assert.strictEqual(repoRoot(from), ROOT, `from ${deep}, in source or compiled`);
  }
  assert.strictEqual(
    fileURLToPath(rootUrl('package.json')),
    path.join(ROOT, 'package.json'),
    'rootUrl names a file under the root',
  );
  assert.ok(
    rootUrl('src/').href.endsWith('/src/'),
    'and a trailing slash survives, for a directory',
  );
  assert.throws(() => repoRoot('file:///no-such-root/x.js'), /no package\.json/, 'or says so');
  console.log('✓ the repository root is found from a file, in source or compiled');
}

// The suite runs what ships. `npm test` compiles first (pretest) and this file is the compiled
// copy; pointed back at the source, every assertion below would be about code no npm script
// runs, and nothing would say so.
{
  assert.ok(
    fileURLToPath(import.meta.url).startsWith(path.join(ROOT, 'out') + path.sep),
    'the suite runs from out/, the compiled copy',
  );
  const pkg: Pkg = JSON.parse(fs.readFileSync(rootUrl('package.json'), 'utf8'));
  assert.strictEqual(pkg.bin.redline, 'out/bin/redline.js', 'the CLI is the compiled one');
  // tsc -b trusts its build record and never looks for its outputs, so a branch switch that
  // deletes the compiled page leaves it saying "up to date" over nothing. The step before it is
  // what notices (see bootstrap/heal-page-build.mjs, and the fixture test of it below).
  assert.strictEqual(
    pkg.scripts['build:ts'],
    'node bootstrap/heal-page-build.mjs && tsc -b',
    'one command compiles every project, after making sure the page is still there',
  );
  assert.ok(
    fs.existsSync(rootUrl('bootstrap/heal-page-build.mjs')),
    'and the step that heals a deleted page exists',
  );
  // A script with a pre hook gets its compile from the hook, which ends in build:web or
  // build:site, and both of those start with build:ts.
  const compiledBy = { start: 'prestart', webapp: 'prewebapp', site: 'presite', test: 'pretest' };
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(
      cmd,
      /\bnode (scripts|bin)\/|\bnode test-smoke/,
      `${name} runs compiled code`,
    );
    if (!/\bnode out\//.test(cmd)) continue;
    const gate = compiledBy[name] ? pkg.scripts[compiledBy[name]] : cmd;
    assert.match(gate, /^npm run build:(ts|web|site)\b/, `${name} compiles before it runs`);
  }
  // The suite is checked like the code it tests. Left out of the project, a type error in it
  // would be invisible, and a comment that switches the check off would say nothing at all.
  const text = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const nodeProject = JSON.parse(text('tsconfig.node.json'));
  assert.ok(nodeProject.include.includes('test-smoke.ts'), 'the suite is part of the node project');
  assert.ok(
    !/@ts-(nocheck|ignore|expect-error)/.test(text('test-smoke.ts')),
    'and nothing in it turns the check off',
  );
  console.log('✓ the suite and every npm script run the compiled copy, compiled first');
}

// The ratchet only goes up. A flag that is on must not be switched off to make an error go away:
// `tsc -b` would pass, and nothing else would say a project had got looser. This is a floor and
// not a target, so it fails a step backwards and does not ask for a step forward: a project that
// is not listed is not held to anything. A later PR adds a flag to the table (a new entry for a
// project, or one more flag in an existing entry) and leaves the logic alone. A strict-family
// flag a project does not set falls back to `strict`, the way tsc resolves it; a flag outside
// that family (noUnusedLocals) does not, so an entry for one needs the fallback taken out. Every
// project extends the base and nothing deeper, so one merge is enough.
{
  const FLOOR: Record<string, string[]> = { 'tsconfig.src.json': ['noImplicitAny'] };
  const read = (f: string) => JSON.parse(fs.readFileSync(rootUrl(f), 'utf8')).compilerOptions;
  for (const [project, flags] of Object.entries(FLOOR)) {
    const options = { ...read('tsconfig.base.json'), ...read(project) };
    for (const flag of flags) {
      assert.strictEqual(
        options[flag] ?? options.strict,
        true,
        `${project} must have ${flag} on: the ratchet only goes up`,
      );
    }
  }
  // A flag that is on does not mean the errors were fixed: a comment above the line would keep it
  // on and hide the error. It reads the .ts and not out/: the shim (a .d.ts) is never emitted,
  // and a check on how the source is written reads the source. The shim is walked too, since it
  // is code a reader would take on trust.
  const sources = fs
    .readdirSync(rootUrl('src/'), { encoding: 'utf8', recursive: true })
    .filter((f) => /\.ts$/.test(f));
  assert.ok(
    sources.length > 0,
    'there are sources under src/ to look at (readdirSync recursive needs Node 18.17+)',
  );
  const hidden = sources.filter((f) =>
    /@ts-(nocheck|ignore|expect-error)/.test(fs.readFileSync(rootUrl(`src/${f}`), 'utf8')),
  );
  assert.deepStrictEqual(hidden, [], 'no file under src/ turns the check off with a comment');
  console.log('✓ the ratchet\'s flags are on, and no comment under src/ turns a check off');
}

// bin/ and scripts/ are TypeScript. A .js or .mjs left in either is compiled and never checked
// (checkJs is off), and nothing else would say it was forgotten. The other half is that every
// compiled path package.json hands to Node exists: scripts/ is .mts so that what it emits is
// the .mjs that every npm script, dev.mts and bundle.mts already name, and a file renamed to
// the wrong extension would otherwise be found by the first person to run that script.
{
  for (const dir of ['bin', 'scripts']) {
    const stray = fs.readdirSync(rootUrl(`${dir}/`)).filter((n) => /\.m?js$/.test(n));
    assert.deepStrictEqual(stray, [], `${dir}/ holds TypeScript only`);
  }
  const pkg: Pkg = JSON.parse(fs.readFileSync(rootUrl('package.json'), 'utf8'));
  assert.ok(fs.existsSync(rootUrl(pkg.bin.redline)), `the CLI, ${pkg.bin.redline}, is emitted`);
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!/\bnode out\//.test(cmd)) continue;
    const named = cmd.match(/\bout\/[\w./-]+\.m?js\b/g);
    assert.ok(named, `${name} names a compiled file`);
    for (const rel of named) assert.ok(fs.existsSync(rootUrl(rel)), `${name}: ${rel} is emitted`);
  }
  // dev.mts and bundle.mts run their siblings by the compiled name, in a string tsc cannot check.
  for (const name of ['dev', 'bundle']) {
    const text = fs.readFileSync(rootUrl(`scripts/${name}.mts`), 'utf8');
    const siblings = [...text.matchAll(/'([\w-]+\.mjs)'/g)].map((m) => m[1]);
    assert.ok(siblings.length > 0, `${name}.mts runs a script by name`);
    for (const script of siblings) {
      assert.ok(fs.existsSync(rootUrl(`out/scripts/${script}`)), `${name} runs ${script}`);
    }
  }
  // tsc keeps a shebang, and npm marks the bin executable on install.
  const cli = fs.readFileSync(rootUrl(pkg.bin.redline), 'utf8');
  assert.ok(cli.startsWith('#!/usr/bin/env node\n'), 'the compiled CLI keeps its shebang');
  console.log('✓ bin/ and scripts/ are TypeScript, and the compiled paths npm runs exist');
}

// --- layering --------------------------------------------------------------
// src/ is layers, and which of them a file may import is a rule rather than a habit -- the
// page bundles (build:web) depend on nothing under core/, page/ or reader/ touching node:.
// It is a grep with rules, the same kind of check as the wiring above: collect every
// `import … from`, `export … from` and `import()`, resolve the relative ones, and check each
// against the rule in docs/architecture.md, under the directory map.
const SRC = fileURLToPath(rootUrl('src/'));
const srcFiles = (dir = '') =>
  fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? srcFiles(rel) : /\.(js|ts)$/.test(rel) ? [rel] : [];
  });
// A specifier says `.js` for a file that is `.ts` on disk (NodeNext; esbuild resolves it the
// same way), so "is it there" has to try the twin.
const there = (rel) =>
  [rel, rel.replace(/\.js$/, '.ts')].some((f) => fs.existsSync(path.join(SRC, f)));
// `ObjC.import("AppKit")` is a string for osascript, not a module: a real one is not preceded
// by a dot.
const importsOf = (js) =>
  [
    ...js.matchAll(/^\s*(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm),
    ...js.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
    ...js.matchAll(/(?<![.\w])import\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1]);
const layerOf = (rel) => (rel.startsWith('hosts/') ? rel.split('/').slice(0, 2).join('/') : rel.split('/')[0]);
/** Why `file` (relative to src/) may not import `spec`, or null when it may. */
const forbidden = (file, spec) => {
  const from = layerOf(file);
  if (spec.startsWith('node:')) {
    const ok = from === 'hosts/node' || file === 'hosts/vscode/extension-node.js';
    return ok ? null : 'node: is for hosts/node and extension-node.js only';
  }
  if (spec === 'vscode') {
    const ok = from === 'hosts/vscode' && !/\/(backend|host)\.js$/.test(file);
    return ok ? null : 'vscode is for the extension host only, never for the page side';
  }
  if (spec.startsWith('@tauri-apps/api')) {
    return from === 'hosts/tauri' ? null : '@tauri-apps/api is for hosts/tauri only';
  }
  if (!spec.startsWith('.')) {
    return ['reader', 'rpc', 'contract'].includes(from)
      ? 'reader/, rpc/ and contract/ import no packages'
      : null;
  }
  const to = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  const target = layerOf(to);
  if (to.startsWith('..')) return 'leaves src/';
  // contract/ is in every list: it is types only, so an `import type` of it costs a bundle
  // nothing, and it imports only itself, so the layers that may import almost nothing can still
  // reach it.
  const allowed = {
    contract: ['contract'],
    core: ['core', 'contract'],
    page: ['core', 'page', 'contract'],
    reader: ['core', 'reader', 'contract'],
    rpc: ['rpc', 'contract'],
  }[from] ?? ['core', 'page', 'reader', 'rpc', 'contract', from];
  return allowed.includes(target) ? null : `${from}/ may not import ${target}/`;
};
const layerBreaks = [];
const layered = srcFiles();
for (const file of layered) {
  assert.ok(
    /^(core|page|reader|rpc|contract)\/|^hosts\/[a-z]+\//.test(file),
    `src/${file} is in a layer: core, page, reader, rpc, contract or hosts/<host>`,
  );
  for (const spec of importsOf(fs.readFileSync(path.join(SRC, file), 'utf8'))) {
    const why = forbidden(file, spec);
    if (why) layerBreaks.push(`src/${file} imports '${spec}': ${why}`);
    else if (spec.startsWith('.')) {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!there(to)) layerBreaks.push(`src/${file}: '${spec}' is not there`);
    }
  }
}
assert.deepStrictEqual(layerBreaks, [], 'the import graph obeys the layers');
assert.ok(layered.length > 15, 'and the walk found the tree');
// The rule has to be able to fail, or an empty walk would pass it.
for (const [file, spec] of [
  ['core/render.js', '../reader/store.js'],
  ['core/hash.js', 'node:crypto'],
  ['reader/reader.js', '../hosts/node/platform.js'],
  ['reader/store.js', 'node:fs'],
  ['hosts/node/server.js', '../tauri/platform.js'],
  ['hosts/vscode/backend.js', 'vscode'],
  ['hosts/node/platform.js', '@tauri-apps/api/core'],
  ['rpc/client.js', '../reader/session.js'],
  ['contract/payload.ts', '../core/diff.js'],
  ['contract/payload.ts', 'markdown-it'],
]) {
  assert.ok(forbidden(file, spec), `${file} may not import ${spec}`);
}
for (const [file, spec] of [
  ['hosts/node/server.js', 'node:http'],
  ['hosts/vscode/extension-node.js', 'node:fs'],
  ['hosts/vscode/platform.js', 'vscode'],
  ['hosts/tauri/backend.js', '../../reader/reader.js'],
  ['core/render.js', 'markdown-it'],
  ['rpc/client.ts', '../contract/seam.js'],
  ['core/diff.ts', '../contract/payload.js'],
  ['hosts/tauri/backend.ts', '../../contract/seam.js'],
  ['contract/seam.ts', './payload.js'],
]) {
  assert.strictEqual(forbidden(file, spec), null, `${file} may import ${spec}`);
}
console.log('✓ the import graph obeys the layers');

// contract/ is types and nothing else, so importing it adds nothing to a bundle: it exports no
// value, it imports with `import type`, and everything that reaches it says `import type` too,
// which tsc and esbuild both erase. Without this a "type-only" layer is a promise in a comment.
const VALUE_EXPORT = /^export\s+(?!type\b|interface\b|declare\b)(\w+)/gm;
const VALUE_IMPORT = /^import\s+(?!type\b)/gm;
const CONTRACT_VALUE_IMPORT =
  /^\s*import\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"]*\/contract\/[^'"]+)['"]/gm;
const contractFiles = layered.filter((f) => f.startsWith('contract/'));
assert.ok(contractFiles.length >= 2, 'the contract layer exists (payload.ts, seam.ts)');
const notTypes = [];
for (const f of layered) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  if (f.startsWith('contract/')) {
    for (const m of text.matchAll(VALUE_EXPORT)) notTypes.push(`src/${f} exports a value: ${m[1]}`);
    for (const m of text.matchAll(VALUE_IMPORT)) {
      notTypes.push(`src/${f} has an import that is not \`import type\``);
    }
  }
  for (const m of text.matchAll(CONTRACT_VALUE_IMPORT)) {
    notTypes.push(`src/${f} imports ${m[1]} without \`type\``);
  }
}
assert.deepStrictEqual(notTypes, [], 'contract/ is types only, and imported as such');
// And the patterns have to be able to fail, or a typo in one would pass everything.
for (const [re, bad, good] of [
  [VALUE_EXPORT, 'export const x = 1;',
    'export type X = 1;\nexport interface Y {}\nexport declare const z: 1;'],
  [VALUE_IMPORT, "import { X } from './payload.js';", "import type { X } from './payload.js';"],
  [CONTRACT_VALUE_IMPORT, "import { X } from '../contract/payload.js';",
    "import type { X } from '../contract/payload.js';\nimport { Y } from '../core/diff.js';"],
] as const) {
  assert.ok([...bad.matchAll(re)].length > 0, `${re} catches ${bad}`);
  assert.strictEqual([...good.matchAll(re)].length, 0, `${re} lets ${good} through`);
}
console.log('✓ contract/ is types only, and imported as such');

// The contract is checked by tsc, so what a test can say is that it is wired -- each host names
// it in its signature, and a host that stopped saying so would stop being checked without a
// word -- and that it can fail: a Backend with a method left out, and one whose `fonts` answers
// the session's shape and not the page's, must both be refused by the compiler the build runs.
for (const [file, sig] of [
  ['src/hosts/tauri/backend.ts', /\): Promise<Backend>/],
  ['src/rpc/client.ts', /\): RpcBackend\b/],
  ['src/hosts/web/backend.ts', /\): Promise<WebBackend>/],
  ['src/reader/session.ts', /\): Session\b/],
  ['src/hosts/web/worker.ts', /function sessionFor\(.*\): Session\b/],
  ['src/reader/reader.ts', /Promise<DocPayload>/],
  ['src/hosts/node/platform.ts', /: Platform = /],
  ['src/hosts/tauri/platform.ts', /: Platform = /],
  ['src/hosts/web/platform.ts', /\): Platform\b/],
  ['public/backend.ts', /\): Promise<PageBackend>/],
  ['public/backend.ts', /\): Backend\b/],
] as const) {
  const text = fs.readFileSync(fileURLToPath(rootUrl(file)), 'utf8');
  assert.match(text, sig, `${file} names the type it implements`);
}
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-contract-'));
try {
  const seam = path
    .relative(fixtures, fileURLToPath(rootUrl('src/contract/seam.js')))
    .split(path.sep)
    .join('/');
  // One compile for all three, so it costs one tsc start. `good.ts` is the control: if the
  // import could not be resolved it would fail too, and the other two would pass for the wrong
  // reason.
  const backend = (omit, fonts) =>
    `import type { Backend } from '${seam}';\n` +
    'export const b: Backend = {\n' +
    '  doc: async () => null,\n' +
    (omit === 'markRead' ? '' : '  markRead: async () => null,\n') +
    '  ack: async () => [],\n' +
    '  prune: async () => null,\n' +
    '  plantumlSvg: async () => ({ svg: "" }),\n' +
    `  fonts: async () => ${fonts},\n` +
    '  watch: () => () => {},\n' +
    '};\n';
  fs.writeFileSync(path.join(fixtures, 'good.ts'), backend(null, '[]'));
  fs.writeFileSync(path.join(fixtures, 'missing.ts'), backend('markRead', '[]'));
  fs.writeFileSync(path.join(fixtures, 'shape.ts'), backend(null, '({ fonts: [] })'));
  const tsc = spawnSync(
    fileURLToPath(rootUrl('node_modules/.bin/tsc')),
    ['--noEmit', '--pretty', 'false', '--strict', 'false', '--skipLibCheck', '--target', 'es2022',
      '--module', 'esnext', '--moduleResolution', 'bundler',
      ...['good', 'missing', 'shape'].map((f) => path.join(fixtures, `${f}.ts`))],
    { encoding: 'utf8' },
  );
  // tsc prints paths relative to where it was run, so the file is found by its name.
  const errors = (f) => tsc.stdout.split('\n').filter((l) => l.includes(`/${f}(`));
  assert.deepStrictEqual(errors('good.ts'), [], `a correct Backend compiles: ${tsc.stdout}`);
  assert.match(errors('missing.ts').join('\n'), /markRead/,
    `tsc refuses a Backend with a method missing, and says which: ${tsc.stdout}`);
  assert.match(errors('shape.ts').join('\n'), /fonts/,
    `tsc refuses a fonts() in the session's shape: ${tsc.stdout}`);
  assert.notStrictEqual(tsc.status, 0, 'so tsc exits non-zero');
} finally {
  fs.rmSync(fixtures, { recursive: true, force: true });
}
console.log('✓ the contract is wired into every host, and can fail');

// The page imports its bundles from ./vendor/, which exists only once build:web has run, so tsc
// cannot look there. types/vendor/ holds a shim for each, re-exporting the source the bundle is
// built from, and rootDirs in tsconfig.page.json is what makes `./vendor/render.js` find it. An
// entry in build-web's BUNDLES that changed while its shim did not would check the page against
// a module it no longer loads, and nothing else would say so.
{
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
}
console.log('✓ the page project has its shims, and each names the bundle it stands for');

// A page source with no compiled sibling means the page project compiled nothing, which is a
// thing tsc will do without a word (see docs/typescript.md). `pretest` runs the compile, so
// the sibling is there whenever the project works.
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
console.log('✓ every page source has been compiled in place');

// The step in front of `tsc -b` that brings a deleted page back (bootstrap/heal-page-build.mjs),
// run against a page-shaped directory in the temp dir: the real test of it deletes public/app.js,
// and a suite does not delete the files it is about to serve. The tsconfig in the fixture is the
// real one, so what counts as a page source and where the build record lives are read from where
// the project says them, and a change there that the step did not follow turns this red.
{
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
  console.log('✓ a deleted page is rebuilt: the step before tsc -b forgets the record it trusts');
}
console.log('\nall smoke tests passed');
process.exit(0);
