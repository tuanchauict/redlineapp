import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { rootUrl } from '../src/hosts/node/root.js';

// Layering.
// src/ is layers, and which of them a file may import is a rule rather than a habit -- the
// page bundles (build:web) depend on nothing under core/, page/ or reader/ touching node:.
// It is a grep with rules, the same kind of check as the wiring above: collect every
// `import … from`, `export … from` and `import()`, resolve the relative ones, and check each
// against the rule in docs/architecture.md, under the directory map.
let layered;
const SRC = fileURLToPath(rootUrl('src/'));

test('the import graph obeys the layers', async () => {
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
  layered = srcFiles();
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
});

// contract/ is types and nothing else, so importing it adds nothing to a bundle: it exports no
// value, it imports with `import type`, and everything that reaches it says `import type` too,
// which tsc and esbuild both erase. Without this a "type-only" layer is a promise in a comment.
test('contract/ is types only, and imported as such', async () => {
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
});

// The contract is checked by tsc, so what a test can say is that it is wired -- each host names
// it in its signature, and a host that stopped saying so would stop being checked without a
// word -- and that it can fail: a Backend with a method left out, and one whose `fonts` answers
// the session's shape and not the page's, must both be refused by the compiler the build runs.
test('the contract is wired into every host, and can fail', async () => {
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
});
