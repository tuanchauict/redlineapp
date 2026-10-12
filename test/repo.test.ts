import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';
import { ROOT, repoRoot, rootUrl } from '../src/hosts/node/root.js';

// The two fields of package.json that the suite reads.
interface Pkg {
  bin: Record<string, string>;
  scripts: Record<string, string>;
}

// Where the repository is.
test('the repository root is found from a file, in source or compiled', async () => {
  // Node-run code compiles into out/, which mirrors the repository, so a `..` count that is
  // right in src/ is wrong one directory deeper. The root is found by walking up to the first
  // package.json instead, and out/ has none because tsc does not emit one.
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
});

// The suite runs what ships. `npm test` compiles first (pretest) and runs the compiled copy of
// each file under test/; pointed back at the source, every assertion in them would be about code
// no npm script runs, and nothing would say so.
test('the suite and every npm script run the compiled copy, compiled first', async () => {
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
      /\bnode (scripts|bin|test)\/|\btest\/[^\s"]*\.ts\b/,
      `${name} runs compiled code`,
    );
    // `node --test` is handed its files the way `node` is, so it is held to the same gate.
    if (!/\bnode (?:--[\w-]+ )*"?out\//.test(cmd)) continue;
    const gate = compiledBy[name] ? pkg.scripts[compiledBy[name]] : cmd;
    assert.match(gate, /^npm run build:(ts|web|site)\b/, `${name} compiles before it runs`);
  }
  // The suite is checked like the code it tests. Left out of the project, a type error in it
  // would be invisible, and a comment that switches the check off would say nothing at all.
  const text = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const nodeProject = JSON.parse(text('tsconfig.node.json'));
  assert.ok(nodeProject.include.includes('test'), 'the suite is part of the node project');
  const suite = fs.readdirSync(rootUrl('test/'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'));
  for (const f of suite) {
    assert.ok(
      !/@ts-(nocheck|ignore|expect-error)/.test(text(`test/${f}`)),
      `and nothing in test/${f} turns the check off`,
    );
  }
  // `npm test` runs what its glob names, and a file it does not name passes by never running.
  assert.match(pkg.scripts.test, /^node --test\b.*"out\/test\/\*\*\/\*\.test\.js"/,
    'npm test runs every test file, compiled');
  assert.deepStrictEqual(
    suite.filter((f) => f !== 'support.ts' && !f.endsWith('.test.ts')),
    [],
    'and every file under test/ is a test file, or the one they share',
  );
});

// The ratchet only goes up. A flag that is on must not be switched off to make an error go away:
// `tsc -b` would pass, and nothing else would say a project had got looser. This is a floor and
// not a target, so it fails a step backwards and does not ask for a step forward: a project that
// is not listed is not held to anything. A later PR adds a flag to the table (a new entry for a
// project, or one more flag in an existing entry) and leaves the logic alone. A strict-family
// flag a project does not set falls back to `strict`, the way tsc resolves it; a flag outside
// that family (noUnusedLocals) does not, so an entry for one needs the fallback taken out. Every
// project extends the base and nothing deeper, so one merge is enough.
test('the ratchet\'s flags are on, and no comment under src/ turns a check off', async () => {
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
});

// bin/ and scripts/ are TypeScript. A .js or .mjs left in either is compiled and never checked
// (checkJs is off), and nothing else would say it was forgotten. The other half is that every
// compiled path package.json hands to Node exists: scripts/ is .mts so that what it emits is
// the .mjs that every npm script, dev.mts and bundle.mts already name, and a file renamed to
// the wrong extension would otherwise be found by the first person to run that script.
test('bin/ and scripts/ are TypeScript, and the compiled paths npm runs exist', async () => {
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
});
