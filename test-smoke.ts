// Smoke test: boot the server on a sample file, edit the file, verify the
// paragraph diff, live-reload event, version history and mark-read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert';
import { createServer } from './src/hosts/node/server.js';
import { createMarkdown } from './src/core/render.js';
import { renderDocument, titleOf as docTitleOf } from './src/core/document.js';
import { nodePlatform } from './src/hosts/node/platform.js';
import { ROOT, repoRoot, rootUrl } from './src/hosts/node/root.js';
import { LIST_FAMILIES } from './src/reader/fonts.js';
import { NO_GIT } from './src/reader/git.js';
import { makePaths } from './src/core/paths.js';
import { directives, inlineScriptHashes, serialize } from './src/core/csp.js';
import { walkPath, shorten } from './src/core/links.js';
import type { AckedVersion } from './src/contract/payload.js';

// Every server here listens on a TCP port, so address() is an AddressInfo; the string it can also
// be is a pipe's path, and nothing in this file listens on one.
const portOf = (s: { address(): string | AddressInfo | null }) => (s.address() as AddressInfo).port;

// The two fields of package.json that the suite reads.
interface Pkg {
  bin: Record<string, string>;
  scripts: Record<string, string>;
}

// What the suite reads out of the server's JSON, which `Response.json()` types as `unknown`.
// Only the members some assertion reads are here; which reply carries which is the server's.
interface Version {
  hash: string;
  current?: boolean;
  baseline?: boolean;
  git?: { subject: string };
}
interface Reply {
  name?: string;
  id?: string;
  path?: string;
  text?: string;
  tracked?: boolean;
  baseline?: string;
  baselineAvailable?: boolean;
  removed?: number;
  history?: Version[];
  acked?: string[];
  fonts?: string[];
  svg?: string;
  error?: string;
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-'));
process.env.REDLINE_HOME = path.join(tmp, 'home');

const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);

const { server } = await createServer({ file });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${portOf(server)}`;

// The server sends the two versions of the text and the page renders them, so
// the test renders them too — the assertions below are about what a reader
// ends up looking at, and that is now one step further on than the response.
// Exactly what `adopt` does in public/app.js, for the same reason: rendering it
// a second way here would be testing something nobody runs.
const mdPage = createMarkdown();
const render = (d) =>
  d.text == null
    ? d
    : Object.assign(d, renderDocument(mdPage, d.text, d.base, { keys: d.acked, from: d.ackedFrom }));
/** A reader talking to one server: fetch a document, render it, as the page does. */
const clientFor = (origin) => async (p, init?) => render(await (await fetch(origin + p, init)).json());
const get = clientFor(base);
const postDoc = (p) => get(p, { method: 'POST' });

// --- 1. first open: no changes -----------------------------------------
let doc = await get('/api/doc');
assert.deepStrictEqual(doc.stats, { added: 0, removed: 0, modified: 0 }, 'fresh open is clean');
assert.match(doc.html, /<h1 [^>]*id="project-notes">Project Notes<\/h1>/);
assert.match(doc.html, /markdown-alert-note/, 'GitHub alert rendered');
assert.match(doc.html, /<table[ >]/, 'table rendered');
assert.match(doc.html, /hljs-keyword|<code class="language-js">/, 'code highlighted');
assert.ok(!doc.html.includes('data-chg'), 'no change marks yet');
console.log('✓ first open renders clean');

// --- 1a. diagram fences --------------------------------------------------
assert.match(doc.html, /<pre class="mermaid">graph TD/, 'mermaid fence handed to the client');
assert.ok(!/<code class="language-mermaid"/.test(doc.html), 'mermaid not left as a code block');
// PlantUML is now a placeholder too: the jar cannot run in a webview, so the
// render leaves the source in the page and the page asks for the SVG. What the
// render has to get right is that the source survives intact — it is the only
// copy the request will have to go on.
assert.match(doc.html, /diagram-plantuml[\s\S]*<pre class="plantuml">/, 'plantuml fence left for the page');
assert.match(doc.html, /Alice -&gt; Bob/, 'with its source, escaped');
assert.ok(!/<code class="language-plantuml"/.test(doc.html), 'and not left as a code block');

// The request the page makes for each one. Answers 200 either way: a diagram
// that will not draw is something to show in the page, not a failed request.
const { createPlantumlRenderer } = await import('./src/reader/plantuml.js');
const puml = await createPlantumlRenderer({}, nodePlatform);
const pumlRes = await fetch(base + '/api/plantuml', { method: 'POST', body: 'Alice -> Bob: hi' });
assert.strictEqual(pumlRes.status, 200, 'the render endpoint answers');
const pumlOut = (await pumlRes.json()) as Reply;
if (puml.available) {
  assert.match(pumlOut.svg, /^<svg/, 'plantuml rendered to inline SVG');
  assert.ok(!pumlOut.svg.includes('<?xml'), 'XML prolog stripped from inlined SVG');
} else {
  assert.match(pumlOut.error, /brew install plantuml/, 'or explains how to fix it');
  assert.ok(!pumlOut.svg, 'and offers no SVG');
}
assert.strictEqual(
  (await fetch(base + '/api/plantuml', { method: 'POST', body: '  ' })).status,
  400,
  'an empty diagram is a bad request, not an empty render',
);
console.log(`✓ diagram fences (plantuml ${puml.available ? 'via ' + puml.hint : 'not installed'})`);

// plantuml jar detection: bad path reports it, valid path is used, a jar that
// cannot actually run degrades to an in-page error rather than crashing.
const missingJar = await createPlantumlRenderer({ jar: path.join(tmp, 'nope.jar') }, nodePlatform);
assert.strictEqual(missingJar.available, false);
assert.match(missingJar.hint, /jar not found/, 'bad --plantuml-jar is reported');

const fakeJar = path.join(tmp, 'fake.jar');
fs.writeFileSync(fakeJar, 'not really a jar');
const broken = await createPlantumlRenderer({ jar: fakeJar }, nodePlatform);
assert.strictEqual(broken.available, true, 'an existing jar path is accepted');
assert.match(broken.hint, /^java -jar /, 'runs the jar through java');
const out = await broken.render('Alice -> Bob: hi');
assert.ok(out.error && !out.svg, `a failing jar yields an error, not a crash: ${JSON.stringify(out)}`);

// The same two failures one level down, where "not a crash" is load-bearing in
// a way a jar cannot be relied on to show. A child that exits without reading
// its stdin leaves the write with nowhere to go, and an unhandled EPIPE on a
// stdin stream ends the process -- no rejection to catch, the whole run gone.
// A bogus jar finds it only on a machine where java loses the race, so it is
// provoked here directly: more than a pipe buffer of input, into a command that
// is already finished. Without the handler in src/hosts/node/platform.ts this line does
// not fail the suite, it kills it.
const unread = await nodePlatform.spawn('true', [], { input: 'x'.repeat(1024 * 1024) });
assert.strictEqual(unread.code, 0, 'a child that never reads its input is not a crash');
const absent = await nodePlatform.spawn('redline-no-such-binary', [], { input: 'hi' });
assert.strictEqual(absent.code, 'ENOENT', 'and a command that is not there is reported, not thrown');
console.log('✓ plantuml jar detection + failure handling');

// --- 1b. static assets -------------------------------------------------
for (const asset of [
  '/',
  '/app.js',
  '/styles.css',
  '/vendor/github-markdown.css',
  '/vendor/hljs-light.css',
  '/vendor/hljs-dark.css',
  '/vendor/mermaid/mermaid.esm.min.mjs',
  '/vendor/sanitize.js',
  '/icon.svg',
]) {
  const r = await fetch(base + asset);
  assert.strictEqual(r.status, 200, `${asset} serves`);
  assert.ok((await r.text()).length > 100, `${asset} is non-empty`);
}
// The favicon needs its real type or the browser ignores it.
assert.match(
  (await fetch(base + '/icon.svg')).headers.get('content-type'),
  /image\/svg\+xml/,
  'icon served as SVG',
);
assert.strictEqual((await fetch(base + '/nope')).status, 404, 'unknown path 404s');

// mermaid lazy-loads chunks relative to its own URL; they must resolve too
const bundle = await (await fetch(base + '/vendor/mermaid/mermaid.esm.min.mjs')).text();
const chunk = bundle.match(/from"(\.\/chunks\/[^"]+)"/)?.[1];
assert.ok(chunk, 'bundle imports relative chunks');
const chunkRes = await fetch(base + '/vendor/mermaid/' + chunk.slice(2));
assert.strictEqual(chunkRes.status, 200, `mermaid chunk ${chunk} serves`);
assert.match(
  chunkRes.headers.get('content-type'),
  /javascript/,
  'chunks served as javascript (browsers refuse modules otherwise)',
);
// must not escape the mermaid dist directory
assert.strictEqual(
  (await fetch(base + '/vendor/mermaid/../../../package.json')).status,
  404,
  'no path traversal out of the mermaid mount',
);
console.log('✓ static assets serve (incl. mermaid bundle + chunks)');

// --- 1c. what a document may do, and who may ask ---------------------------
// A document is someone else's text and markdown-it lets its HTML through, so
// the page sanitizes at insertion, a CSP stands under that, and in the app the
// shell refuses what the reader never asks for. None of it can be watched
// working here -- there is no DOM to sanitize in and no window to run a hostile
// document through -- so what is asserted is that each layer exists, is wired
// to the place it guards, and agrees with the code it mirrors.

/** A request with headers fetch will not let a caller set, Host among them. */
const raw = (p, headers = {}, method = 'GET') =>
  new Promise((resolve, reject) => {
    const req = http.request(base + p, { method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
const own = new URL(base).host;
assert.strictEqual(await raw('/api/fonts', { host: `localhost:${portOf(server)}` }), 200,
  'localhost is this server too');
assert.strictEqual(await raw('/', { host: `evil.example:${portOf(server)}` }), 403,
  'a rebound name is refused, the static page included');
assert.strictEqual(await raw('/api/doc', { host: 'evil.example' }), 403, 'and so is its API');
assert.strictEqual(
  await raw('/api/open?path=/etc/hosts', { host: own, origin: 'https://evil.example' }, 'POST'),
  403,
  'a cross-site POST cannot make the reader open, and so snapshot, any file',
);
assert.strictEqual(await raw('/', { host: own, 'sec-fetch-site': 'cross-site' }), 403,
  'nor can a cross-site link, since the page opens whatever path its URL names');
assert.strictEqual(await raw('/api/doc', { host: own, 'sec-fetch-site': 'same-site' }), 403,
  'same-site is another port on this machine, which is not this page');
assert.strictEqual(
  await raw('/api/doc', { host: own, origin: base, 'sec-fetch-site': 'same-origin' }),
  200,
  "the page's own requests go through",
);
assert.strictEqual(await raw('/', { host: own, 'sec-fetch-site': 'none' }), 200,
  'and so does an address typed in, or opened by the CLI');

const indexHtml = fs.readFileSync(rootUrl('public/index.html'), 'utf8');
const inline = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.strictEqual(inline.length, 1, 'one inline script, the head prefs');
const headHash = crypto.createHash('sha256').update(inline[0]).digest('base64');
const served = (await fetch(base + '/')).headers.get('content-security-policy') ?? '';
/** A policy as directive -> sources, so two can be compared by meaning. */
const policy = (csp) =>
  Object.fromEntries(
    csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]),
  );
const servedCsp = policy(served);
assert.deepStrictEqual(servedCsp['script-src'], ["'self'", `'sha256-${headHash}'`],
  'index.html is served with a CSP: script from here, plus the head script by its hash');
assert.ok(!(await fetch(base + '/app.js')).headers.get('content-security-policy'),
  'on the page, not on every asset');

// The app's copy is in tauri.conf.json, where the bundler adds the hash itself
// -- and must be kept off style-src, where a nonce would switch off the
// 'unsafe-inline' every inline style on the page depends on.
// (JSON.parse is handed a Buffer and reads its text; only its `string` parameter type objects.)
const shellConf = JSON.parse(
  fs.readFileSync(rootUrl('shell/tauri.conf.json')) as unknown as string,
);
const appCsp = Object.fromEntries(
  Object.entries(shellConf.app.security.csp as Record<string, string>).map(([k, v]) => [
    k,
    v.split(/\s+/),
  ]),
);
assert.deepStrictEqual(appCsp['connect-src'], ["'self'", 'ipc:', 'http://ipc.localhost'],
  'the app may talk to its shell, and nowhere else');
assert.deepStrictEqual(
  { ...appCsp, 'script-src': ["'self'"], 'connect-src': ["'self'"] },
  { ...servedCsp, 'script-src': ["'self'"] },
  'the app and the browser tab are held to the same policy',
);
assert.deepStrictEqual(shellConf.app.security.dangerousDisableAssetCspModification, ['style-src'],
  'Tauri leaves style-src as written');

// Sanitized where it goes in. Every innerHTML in the page is named here: the
// two that carry what a document said go through DOMPurify. The page's own
// markup -- the count, the tick, a row's ✕ -- is JSX now, which writes text and
// never markup, so there is no third kind. A new one has to be the first.
// The page's source is every module under public/app/, read as one text: these greps are about
// what the page does, and which file of it a line moved to is not their business.
const pageSource = () => {
  const dir = fileURLToPath(rootUrl('public/app/'));
  return fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
};
const appJs = pageSource();
assert.match(appJs, /import \{ sanitizeDocument \} from '\.\.\/\.\.\/vendor\/sanitize\.js';/,
  'the page loads the sanitizer, in vm/core.ts');
assert.match(appJs, /import \{ sanitizeSvg \} from '\.\.\/\.\.\/vendor\/sanitize\.js';/,
  'and vm/diagrams.ts its other half');
assert.match(appJs, /const source = raw \? d\.rawHtml : d\.html;[\s\S]*?doc\.innerHTML = sanitizeDocument\(source\);/,
  'the document, rendered or raw, is sanitized on its way into the page');
assert.match(appJs, /closest\('\.diagram'\)\.innerHTML = sanitizeSvg\(out\.svg\);/,
  'and so is a PlantUML drawing, which the jar made from the document');
assert.deepStrictEqual(
  [...appJs.matchAll(/([\w$]+)(?:\([^)]*\))?\.innerHTML =/g)].map((m) => m[1]).sort(),
  ['closest', 'doc'],
  'no innerHTML the page does not know is safe',
);
assert.ok(!appJs.includes('dangerouslySetInnerHTML'), 'and no component reaches round JSX for it');
// The capture above sees `x.innerHTML =` and `x(…).innerHTML =`, but not the forms TypeScript
// brings in -- `$<T>('x').innerHTML =`, `(el as T).innerHTML =` -- which it would pass unseen.
// So every assignment in the source has to be one it captured.
assert.strictEqual(
  [...appJs.matchAll(/([\w$]+)(?:\([^)]*\))?\.innerHTML =/g)].length,
  appJs.match(/\.innerHTML =/g)?.length ?? 0,
  'every innerHTML assignment is one the list above can see',
);
const sanitizeJs = fs.readFileSync(rootUrl('src/page/sanitize.ts'), 'utf8');
assert.match(sanitizeJs, /FORBID_TAGS: \['style', 'form'\]/,
  'a document cannot restyle the window or hide its own marks');
assert.match(sanitizeJs, /SANITIZE_DOM: false,\n\s*FORBID_ATTR: \['name'\]/,
  'heading ids keep their anchors, and name is what goes instead');
assert.ok(fs.readFileSync(rootUrl('public/vendor/sanitize.js'), 'utf8')
  .includes('DOMPurify'), 'build:web bundles DOMPurify into it');
assert.match(fs.readFileSync(rootUrl('scripts/stage-page.mts'), 'utf8'),
  /'vendor\/sanitize\.js'/, 'and no host stages a page without it');

// The shell runs only the command lines the reader builds. Each spawn in src/
// is one arm of `may_spawn`, and the arguments it is matched against are
// copied from these files -- so the two are compared here, not trusted.
const hostRsCheck = fs.readFileSync(rootUrl('shell/src/host.rs'), 'utf8');
/**
 * Every .js and .ts file under `dir` (relative to src/), so a new host that spawns is scanned
 * too -- and so is a file that has been converted, which a .js-only walk would quietly drop.
 */
const sourcesUnder = (dir) =>
  fs.readdirSync(rootUrl(`src/${dir}/`), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourcesUnder(`${dir}/${e.name}`)
      : /\.(js|ts)$/.test(e.name) ? [`${dir}/${e.name}`] : [],
  );
const srcSpawns = ['reader', 'hosts']
  .flatMap(sourcesUnder)
  .filter((f) => !/^platform\.[jt]s$/.test(path.basename(f)))
  .flatMap((f) => {
    const js = fs.readFileSync(rootUrl(`src/${f}`), 'utf8');
    return [...js.matchAll(/platform\.spawn\(([^,]+),/g)].map((m) => `${f}: ${m[1]}`);
  })
  .sort();
assert.deepStrictEqual(srcSpawns,
  ["reader/fonts.ts: 'osascript'", "reader/git.ts: 'git'", 'reader/plantuml.ts: found.cmd'],
  'every program the reader runs is one host.rs allows -- a new one needs an arm there');
const rustFamilies = hostRsCheck.match(/const LIST_FAMILIES: &str = r#"(.*)"#;/)?.[1];
assert.strictEqual(rustFamilies, LIST_FAMILIES,
  'the one osascript the shell runs is the one src/reader/fonts.ts asks for');
const gitSrc = fs.readFileSync(rootUrl('src/reader/git.ts'), 'utf8');
const rustList = (js) => js.replaceAll("'", '"');
for (const call of [
  "'ls-files', '--full-name', '--error-unmatch', '--'",
  "'rev-parse', '--show-toplevel'",
  "'--follow',\n          '--name-only',",
]) {
  assert.ok(gitSrc.includes(call), `src/reader/git.ts still runs ${call}`);
  assert.ok(hostRsCheck.includes(rustList(call.replace(/,\n\s*/g, ', '))),
    `and host.rs allows ${call}`);
}
assert.ok(gitSrc.includes('`--format=%x00%H${SEP}%at${SEP}%s`') && gitSrc.includes("SEP = '\\x1f'")
  && hostRsCheck.includes('"--format=%x00%H\\x1f%at\\x1f%s"'), 'the log format, separator and all');
const pumlSrc = fs.readFileSync(rootUrl('src/reader/plantuml.ts'), 'utf8');
assert.ok(pumlSrc.includes("'-tsvg', '-pipe', '-charset', 'UTF-8'")
  && hostRsCheck.includes('["-tsvg", "-pipe", "-charset", "UTF-8"]'), 'the PlantUML arguments');
assert.ok(pumlSrc.includes("platform.join(root, 'plantuml.jar')")
  && hostRsCheck.includes('f == "plantuml.jar"'), 'and the jar the store can hold');

// Writing is held to the store's own layout -- the four calls in src/reader/store.ts.
for (const cmd of ['write_text', 'mkdirp', 'remove', 'rename']) {
  assert.match(hostRsCheck, new RegExp(`pub fn ${cmd}\\(app: AppHandle,`),
    `${cmd} knows where home is, to know where the store is`);
}
const storeSrc = fs.readFileSync(rootUrl('src/reader/store.ts'), 'utf8');
assert.ok(storeSrc.includes("join(root, 'objects')") && storeSrc.includes("hash + '.md'")
  && hostRsCheck.includes('*dir == "objects" && name.ends_with(".md")'), 'snapshots');
assert.ok(storeSrc.includes("join(root, 'docs')") && storeSrc.includes("docKey(absPath) + '.json'")
  && hostRsCheck.includes('*dir == "docs" && name.ends_with(".json")'), 'and the index per file');
assert.ok(storeSrc.includes("join(home, '.md-reader')")
  && hostRsCheck.includes('home.join(".md-reader") || Path::new(&to) != home.join(".redline")'),
  'and the one move the store ever makes');
console.log('✓ a document cannot run, and the shell does only what the reader asks');

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

// core/paths.js agrees with node:path on the cases it claims. Not claimed: a trailing
// separator on dirname, and the root of a drive (`C:\a` has dirname `C:`, node says `C:\`).
// Nothing is resolved against a working directory, so only absolute paths are compared.
const posixPaths = makePaths('/');
const winPaths = makePaths('\\');
for (const [paths, ref, cases] of [
  [posixPaths, path.posix, {
    join: [['a', 'b'], ['/a/', '/b'], ['/a', '', 'b'], ['/a//b', 'c.md'], [], ['', '']],
    dirname: ['/a/b.md', '/a', '/a/b/c', 'b.md'],
    basename: ['/a/b.md', 'b.md', '/a/b'],
    resolve: ['/a/./b/../c', '/a//b', '/..', '/a/b/..', '/', '/a/../../b'],
  }],
  [winPaths, path.win32, {
    join: [['C:\\a', 'b'], ['C:\\a\\', '\\b'], ['C:/a', 'b'], ['C:\\a', '', 'b']],
    dirname: ['C:\\a\\b.md', 'C:\\a\\b\\c', 'b.md'],
    basename: ['C:\\a\\b.md', 'b.md'],
    resolve: ['C:\\a\\.\\b\\..\\c', 'C:/a/b', 'C:\\', 'C:\\..', 'C:\\a\\\\b'],
  }],
] as const) {
  for (const args of cases.join) {
    assert.strictEqual(paths.join(...args), ref.join(...args), `join ${JSON.stringify(args)}`);
  }
  for (const fn of ['dirname', 'basename', 'resolve']) {
    for (const p of cases[fn]) assert.strictEqual(paths[fn](p), ref[fn](p), `${fn} ${p}`);
  }
}
assert.deepStrictEqual([posixPaths.sep, winPaths.sep], ['/', '\\'], 'each carries its separator');
console.log('✓ core/paths.js agrees with node:path');

// core/csp.js: the header the server sends for the current index.html, written out the long
// way -- a literal directive list and node's own hash -- so that a change to the list in
// csp.js has to be made here too, on purpose. The Tauri copy is compared with the same list
// above; the web build's `_headers` and the extension's <meta> are made from this one.
assert.strictEqual(
  served,
  [
    "default-src 'self'",
    `script-src 'self' 'sha256-${headHash}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'the CSP header is the same bytes it always was',
);
assert.deepStrictEqual(
  inlineScriptHashes('<script src="host.js"></script><script> a </script><script>b</script>'),
  [' a ', 'b'].map((body) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`
  ),
  'every inline script is named by its hash, exactly as written, and one with a src is not',
);
assert.strictEqual(
  serialize(directives({ 'connect-src': ["'none'"], 'frame-ancestors': null })),
  served
    .replace(/script-src [^;]*/, "script-src 'self'")
    .replace("connect-src 'self'", "connect-src 'none'")
    .replace('; frame-ancestors \'none\'', ''),
  'a host can tighten a directive or drop one, and the rest is left alone',
);
console.log('✓ core/csp.js builds the served header');

// core/links.js. The CLI's cases are held against the function as it was in app.js, so that
// moving it was a move; the rest are the places a document can now live.
const legacyWalk = (dir, rel) => {
  const parts = dir.split('/');
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg !== '..') parts.push(seg);
    else if (parts.length > 1) parts.pop();
  }
  return parts.join('/') || '/';
};
const legacyShorten = (abs, d) => {
  const cut = d.dirLabel.startsWith('~') ? d.dir.length - d.dirLabel.length + 1 : -1;
  const home = cut >= 0 ? d.dir.slice(0, cut) : '';
  if (!home) return abs;
  if (abs === home) return '~';
  return abs.startsWith(home + '/') ? '~' + abs.slice(home.length) : abs;
};
for (const dir of ['/', '/a', '/a/b', '/Users/me/notes']) {
  for (const rel of ['c.md', './c.md', '../c.md', '../../c.md', '../../../../c.md', 'x/./y/../z.md',
    '', '.', '..', 'a//b.md']) {
    // A dir of `/` is not compared: it used to come back as `//c.md`.
    if (dir === '/') continue;
    assert.strictEqual(walkPath(dir, rel), legacyWalk(dir, rel), `${dir} + ${rel}`);
  }
}
assert.strictEqual(walkPath('/', 'a.md'), '/a.md', 'a file in the root is /a.md, not //a.md');
assert.strictEqual(walkPath('/', '../../a.md'), '/a.md', 'and the root has nothing above it');
for (const d of [
  { dir: '/Users/me/notes', dirLabel: '~/notes' },
  { dir: '/Users/me', dirLabel: '~' },
  { dir: '/var/log', dirLabel: '/var/log' },
  { dir: '/Users/me/footnotes', dirLabel: '~/footnotes' },
]) {
  for (const abs of ['/Users/me', '/Users/me/x.md', '/Users/me/notes/y.md', '/Users/mex/y.md',
    '/Users/other/y.md', '/etc/x', '/', '/var/log/z.log']) {
    assert.strictEqual(shorten(abs, d), legacyShorten(abs, d), `${abs} in ${d.dir}`);
  }
}

assert.strictEqual(walkPath('C:\\notes\\sub', '..\\x.md'), 'C:\\notes\\x.md', 'a drive path');
assert.strictEqual(walkPath('C:\\notes', 'a/b.md'), 'C:\\notes\\a\\b.md',
  'keeps its separator when the link is written with the other one');
assert.strictEqual(walkPath('C:\\notes', '..\\..\\..\\x.md'), 'C:\\x.md', '.. stops at the drive');
assert.strictEqual(walkPath('C:\\', 'a.md'), 'C:\\a.md', 'the root of a drive');
assert.strictEqual(walkPath('web:r1/docs', '../../../x.md'), 'web:r1/x.md',
  'a link cannot climb out of the folder the web app was given');
assert.strictEqual(walkPath('web:r1', 'a.md'), 'web:r1/a.md', 'the root itself');
assert.strictEqual(walkPath('file:///a/b', '../c.md'), 'file:///a/c.md', 'a file: URI');
assert.strictEqual(
  walkPath('vscode-remote://ssh-remote+box/home/me', '../../../../etc/x.md'),
  'vscode-remote://ssh-remote+box/etc/x.md',
  'and a remote one, which keeps its authority',
);
assert.strictEqual(walkPath('/a/b', 'c\\d.md'), '/a/b/c\\d.md',
  'a backslash on a POSIX path is part of a name');

assert.strictEqual(
  shorten('C:\\Users\\me\\x.md', { dir: 'C:\\Users\\me\\notes', dirLabel: '~\\notes' }),
  '~\\x.md',
  'home on Windows',
);
assert.strictEqual(
  shorten('vscode-remote://box/home/me/a.md', {
    dir: 'vscode-remote://box/home/me/notes',
    dirLabel: '~/notes',
  }),
  '~/a.md',
  'home behind a URI',
);
assert.strictEqual(
  shorten('web:r1/x.md', { dir: 'web:r1/docs', dirLabel: 'r1/docs' }),
  'r1/x.md',
  'a label that is not home is taken from the pair, not assumed',
);
console.log('✓ core/links.js: the CLI cases are unchanged, the others work');

// The show/hide-changes switch is spread over three files; if one half is
// dropped it silently stops doing anything, which nothing else catches. It has
// no button of its own — the newest row in the history is where it is thrown
// from, so the bar carries no version list and it has to be in the sidebar.
const [pageHtml, pageCss] = await Promise.all(
  ['/', '/styles.css'].map(async (p) => (await fetch(base + p)).text()),
);
// The greps below are about how the page is written, so they read the source: tsc reprints what
// it emits. What is served is the compiled file, and the checks on that read it instead.
const pageJs = pageSource();
// The Settings sheet is a component, so its markup is read from where it is written.
const settingsTsx = fs.readFileSync(rootUrl('public/app/ui/Settings.tsx'), 'utf8');
const pageServed = fs.readFileSync(rootUrl('public/app.js'), 'utf8');

// The page has to load from any base URL: the web app may be served under a path, and a VS
// Code webview's files live under a `vscode-cdn.net` URL, where `/app.js` is the wrong root.
// The `/api/...` URLs in backend.js stay absolute, because only this server answers them.
assert.ok(!/(?:href|src)="\//.test(pageHtml), 'the page names its files relative to itself');
assert.ok(!pageServed.includes("import('/"), 'and so does the lazy mermaid import');
assert.match(pageServed, /import\(['"]\.\/vendor\/mermaid\//, 'which is still the vendored one');
// Every preference goes through one name, so a host without localStorage can supply a store
// of its own. The one line that names localStorage is the fallback, in each file.
const bareStorage = (src) => src.match(/\blocalStorage\b/g)?.length ?? 0;
for (const [name, src] of [['index.html', pageHtml], ['app.js', pageServed]]) {
  assert.ok(!/\blocalStorage\./.test(src), `${name} reaches no preference through localStorage`);
  assert.match(
    src,
    // `var` in app.js: esbuild writes a bundle's top-level `const` as one.
    /(?:const|var) prefs = globalThis\.__REDLINE_PREFS \?\? localStorage;/,
    `${name} has the one fallback line`,
  );
}
assert.strictEqual(bareStorage(pageHtml.replace(/\/\/.*$/gm, '')), 1, 'one fallback in the head');
// host.js is a classic script and the first one in the head, so it runs before the head script
// and before app.js. It is the same origin, so the CSP needs no hash for it.
const pageHead = pageHtml.slice(0, pageHtml.indexOf('</head>'));
const headScripts = [...pageHead.matchAll(/<script\b[^>]*>/g)];
assert.strictEqual(headScripts[0]?.[0], '<script src="host.js">', 'host.js is the first script');
assert.ok(!/type="module"/.test(headScripts[0][0]), 'and not a module');
assert.strictEqual((await fetch(base + '/host.js')).status, 200, 'and it is served');
console.log('✓ the page is relative, and reads its preferences through one name');

assert.match(pageHtml, /id="histList"/, 'the history list is in the sidebar');
assert.ok(!pageHtml.includes('id="baseline"'), 'no version dropdown on the bar');
assert.ok(!pageHtml.includes('id="markRead"'), 'no "Mark read" button on the bar');
assert.match(pageHtml, /no-diff/, 'marks suppressed before first paint');
assert.match(pageJs, /classList\.toggle\('no-diff'/, 'the switch drives the class');
assert.match(pageJs, /v\.current\) return !state\.diff/, 'the newest row shows that state');
// Moving the read mark is not a button on the row: the row is the button you
// click to compare against its version, and the two side by side did nearly the
// same thing from an inch apart. It is in the row's menu instead, beside
// forgetting, where any row can be marked — an older one meaning "read up to
// here" — and the keys still say it with the sidebar shut.
assert.ok(!pageJs.includes('readAction') && !pageCss.includes('.ver-act'), 'no button for it on the row');
assert.match(pageJs, /markRead\(v\.current \? undefined : v\.hash\)/, "the row's menu marks that row read");
assert.match(pageJs, /if \(at\) setMarks\(true, \{ redraw: false \}\);/, 'an older one with the marks on');
assert.match(pageJs, /function markRead/, 'and the key still moves the mark');
assert.match(pageJs, /key === 'm'/, 'and `m` is what reaches it');
// Undo went with it. The version the mark came off is still in the history, so
// the way back is clicking its row; a second, stored way back is a field, an
// endpoint and a label that flips under the reader.
for (const gone of ['undoMarkRead', 'canUndoRead', 'readState']) {
  assert.ok(!pageJs.includes(gone), `${gone} is gone from the page`);
}
assert.strictEqual(
  (await fetch(base + '/api/undo-mark-read', { method: 'POST' })).status,
  404,
  'and the endpoint with it',
);
// A row has to be callable by a name that is the same name tomorrow, so the
// relative time is the line underneath and never the one you read first.
assert.match(pageJs, /function clockName/, 'a version nobody named is named by its clock');
assert.match(pageJs, /<span class="ver-name">\{name\}<\/span>/, 'and that name is the row title');
assert.ok(pageCss.includes('.ver-name'), 'which the stylesheet sets as one');
assert.ok(!pageCss.includes('.ver-when'), 'the relative time is no longer it');
for (const rule of ['.no-diff .chg', '.no-diff .chg-del', '.no-diff .w-del', '.no-diff .raw-del']) {
  assert.ok(pageCss.includes(rule), `stylesheet neutralises ${rule}`);
}
console.log('✓ show/hide-changes toggle wired end to end');

// The link peek is spread over the same three files, and its failure is silent
// in both directions: no element and hovering says nothing, no `pointer-events:
// none` and it eats the clicks aimed at the last paragraph of the document.
assert.match(pageHtml, /id="peek"/, 'the peek has somewhere to go');
assert.match(pageJs, /addEventListener\('pointerover'/, 'and something to fill it');
assert.match(pageCss, /\.peek \{[^}]*pointer-events: none/, 'and never takes a click');
console.log('✓ link peek wired end to end');

// The bar is the window's title bar in the app, and there is nothing else to
// drag the window by — no OS title bar is drawn. It went once already: the
// rules said `-webkit-app-region`, which is Chromium's and does nothing in the
// WebKit the shell uses, so the window could not be moved at all. The attribute
// is what the shell looks for; "deep" is what makes the whole strip count.
assert.match(
  pageHtml,
  /<header class="bar" data-tauri-drag-region="deep">/,
  'the bar is the window\'s drag region',
);
assert.ok(
  !/-webkit-app-region\s*:/.test(pageCss),
  'and not by a Chromium property this webview does not have',
);
console.log('✓ the bar can move the native window');

// The app's icon, at the bar's left edge in a browser tab: the web app's and the CLI's. The
// file is the favicon's, which every host serves beside the page (`/icon.svg` above,
// `stage-page.mts` for the other two), so a relative src holds under any base URL.
assert.match(
  pageHtml,
  /<header class="bar"[^>]*>\s*(<!--[\s\S]*?-->\s*)?<img class="app-icon" src="icon\.svg" alt=""/,
  'the icon is the first thing in the bar, and a picture of the name the page already has',
);
assert.match(pageCss, /\.app-icon \{[^}]*flex: none;/, 'and the name beside it never squeezes it');
assert.match(
  pageCss,
  /\.native \.app-icon \{\s*display: none;\s*\}/,
  'and it is not in the native window, whose left edge is the traffic lights\'',
);
console.log('✓ a browser tab starts its bar with the app icon');

// The contents list and the checked-off marks are each spread over the same
// three files, and each fails quietly if one part goes: a list with no rows, or
// a tag you can click that never changes.
assert.match(pageHtml, /id="tocList"/, 'the contents list has somewhere to go');
assert.match(pageJs, /function paintToc/, 'and something to fill it');
assert.match(pageJs, /function spyToc/, 'and it follows where you are reading');
// Contents is a component (ui/Contents.tsx): main.ts pairs headings with their nodes, after the
// document is written, and the list draws whatever that left in `state.toc`.
assert.match(pageJs, /mountContents\(\$\('tocList'\), \{ go: \(node\) => scrollToNode\(node\) \}\);/,
  'the list is mounted where the page has room for it, and a row lands where a link does');
assert.match(pageJs, /state\.toc = has \? heads\.map\(\(h\) => \(\{ h, node: headingNode\(h\) \}\)\) : \[\];/,
  'each heading is paired with its node in the document just written');
assert.match(pageJs, /function Contents\([\s\S]*?if \(!toc \|\| !state\.tocSide\) return null;/,
  'and a shut column, or no document, draws no list at all');
assert.match(pageJs, /class=\{\['toc', h\.level === top && 'toc-top', i === at && 'on'\]/,
  'the row you are reading under is lit from state.tocAt');
assert.match(pageJs, /useEffect\(\(\) => \{\s*current\.current\?\.scrollIntoView\(\{ block: 'nearest' \}\);\s*\}, \[toc, at\]\);/,
  'and scrolled into view when that changes, not on every render');
const spy = pageJs.match(/function spyToc\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(/state\.tocAt = at;/.test(spy) && !/classList|scrollIntoView|\.row\b/.test(spy),
  'the spy only says which heading; it never reaches into the rows Preact owns');
assert.match(pageCss, /\.toc\.on::before/, 'and says which row that is');
// Two columns, not three lists in one. Open files is alone on the left, so
// choosing a file fades once it is chosen; Contents and History share the
// right column, so a reader following a long document through a review can
// have the map and the versions up together. All three fold away, each the
// list its own column stops needing most often.
assert.strictEqual(
  (pageHtml.match(/class="side-twist"/g) ?? []).length,
  3,
  'Open files, Contents and History are all disclosures',
);
assert.match(pageHtml, /redline:shut/, 'and remember themselves before first paint');
assert.match(pageJs, /prefs\.setItem\(SHUT_KEY/, 'and write that back');
assert.ok(pageCss.includes('.shut-files #filesSec'), 'the stylesheet folds Open files away');
assert.ok(pageCss.includes('.shut-toc #tocSec'), 'and Contents too');
assert.ok(pageCss.includes('.shut-hist #histSec'), 'and History too');
assert.match(pageHtml, /data-shut="hist"/, 'History shuts under its own key');
assert.match(pageHtml, /k === "hist"/, 'restored before first paint, like the other two');
assert.match(pageHtml, /id="tocSide"[^>]*class="side side-r"/, 'the contents are their own column');
assert.ok(pageCss.includes('.toc-open #tocSide'), 'laid out down the right');
assert.ok(pageCss.includes('.toc-open main'), 'with the document keeping clear of it');
assert.match(pageHtml, /redline:toc"/, 'and open or shut before first paint');
assert.match(pageJs, /function setTocSide/, 'which is a thing the page can change');
assert.match(pageJs, /id="tocBtn"|\$\('tocBtn'\)/, 'from a switch of its own');
assert.match(pageHtml, /id="tocBtn"[\s\S]*?id="prefsBtn"/, 'at the end of the bar, like VS Code');
assert.match(pageHtml, /id="side"[\s\S]*?id="tocBtn"/, 'in the order the columns appear');
// Each toggle is a picture of the window, so its state is in the picture: the
// band is the sidebar, filled when that column is open. The button gets no
// selected background — a filled rounded square around a drawing of a rounded
// square reads as a smudge, and says "the button is on" rather than "the column
// is open". Two bands, one per icon, and `.i` sets `fill: none` on the svg, so
// the fill has to be put back on exactly these.
assert.strictEqual(
  (pageHtml.match(/class="i-band"/g) ?? []).length,
  2,
  'both panel toggles draw their column as a band',
);
assert.ok(pageCss.includes('#side[aria-pressed="true"] .i-band'), 'which fills when it is open');
assert.ok(pageCss.includes('#tocBtn[aria-pressed="true"] .i-band'), 'each from its own switch');
assert.doesNotMatch(
  pageCss,
  /#(side|tocBtn)\[aria-pressed="true"\](,|\s*\{)/,
  'and neither button wears a selected fill of its own',
);
// The versions sit under Contents, with a draggable seam between them, in
// both the app and a browser tab — unlike Open files, neither Contents nor
// History is desktop-only, so the seam carries no `data-shell` of its own.
assert.match(
  pageHtml,
  /id="histGrip"[^>]*role="separator"/,
  'the seam is a handle, not a bare line',
);
assert.match(
  pageCss,
  /\.hist-grip \{[^}]*border-top: 1px solid var\(--line\)/,
  'and, unlike the sidebar edges, visible at rest rather than only on hover',
);
// The two used to share one panel behind a tab strip. Nothing of that may be
// left: a stale `data-panel` rule would stop one of the sections laying out at
// all, and the symptom is an empty column rather than an error.
for (const gone of ['.side-seg', '.side-tab', 'data-panel']) {
  assert.ok(!pageCss.includes(gone) && !pageHtml.includes(gone), `${gone} is gone`);
}
assert.ok(!/function setPanel|PANEL_KEY/.test(pageJs), 'and so is the switch between them');
// `redline:panel` may only appear as the migration that retires it: a reader
// who was on Contents when the update landed gets the new column opened for
// them, because an update that quietly took away the list you had up reads as
// a bug.
assert.match(pageHtml, /prefs\.removeItem\("redline:panel"\)/, 'the old key is retired');
assert.ok(!pageJs.includes('redline:panel'), 'and nothing else reads it');
// A document whose only heading is its title has no contents. The column says
// so rather than closing itself — whether it is open is the reader's standing
// choice, and the payload that would decide it arrives after first paint.
assert.match(pageJs, /No headings in this document/, 'an empty contents list says so');

// Forgetting versions is the only destructive thing in the sidebar, and it does
// not stop at the row it sits on. It was a picture on the row — a bin, then
// scissors, then a perforation — and none of them could say "this one and
// everything older"; a menu item can. Pointing at the item still dims every row
// that would go. That preview is pure CSS off a sibling combinator, which holds
// only while the list is rows in one order.
assert.ok(!pageJs.includes('cutButton') && !pageCss.includes('.ver-cut'), 'the cut icon is gone');
assert.match(pageHtml, /<div id="verMenu" class="menu" role="menu"/, 'a version has a menu');
assert.match(pageJs, /<\/span>\s*<More v=\{v\} n=\{n\} actions=\{actions\} \/>\s*<\/button>/,
  'behind a "…" on every row');
assert.match(
  pageJs,
  /const onContextMenu = \(e: MouseEvent\) => \{\s*e\.preventDefault\(\);[\s\S]*?onContextMenu=\{onContextMenu\}/,
  'and behind a right-click on it, which the browser no longer answers',
);
assert.match(
  pageJs,
  /const mark = \(on\) => \(cutFrom\.value = on \? v\.hash : null\);\s*forget\.addEventListener\('pointerenter'/,
  'Forget… says what it would take',
);
assert.match(pageJs, /if \(!v\.current\) \{\s*const one = n === 1;\s*const forget = /, 'and is never offered for the version on disk');
assert.match(pageJs, /closeVerMenu\(\);\s*askPrune\(v\.hash\);/, 'and asks in the row, as the icon did');
assert.ok(pageCss.includes('.ver.cutting ~ .ver'), 'and the stylesheet dims that far down');
// `.ver:hover .ver-more` is a class heavier than a bare `.ver-more:hover`, so the
// hover state has to be qualified or it never applies and the control you are
// pointing at sits at the same hint as the one you are not.
assert.ok(pageCss.includes('.ver .ver-more:hover'), 'the "…" lights fully when pointed at');
assert.match(pageJs, /read\.disabled = !!v\.baseline;/, '"Mark as read" is off on the row already read');
assert.match(pageCss, /\.menu button:disabled \{\s*background: none;/, 'and does not light up as if it were on');
// The menu's keys are its own while it has them: `m` would otherwise mark the
// newest version read from under a menu opened on an older one.
assert.match(
  pageJs,
  /\$\('verMenu'\)\.addEventListener\('keydown', \(e\) => \{[^}]*e\.stopPropagation\(\);/,
  'the menu keeps its keys',
);
assert.match(
  pageJs,
  /function paintHistory\(d\) \{[^}]*closeVerMenu\(\);/,
  'and a repaint closes a menu about a row it is replacing',
);
assert.match(pageJs, /<div class="ver ask cutting">/,
  'the confirmation keeps the dim it was reached from');
// Preact owns the rows, so nothing else may set a class on one: the row reads `held` and
// `cutting` off the signals the menu and Clear history set, and a class put on by hand would be
// taken off again by the next render, or left on a node Preact has moved to another version.
assert.match(pageJs, /menuFor\.value === v\.hash && 'held',\s*cutFrom\.value === v\.hash && 'cutting',/,
  'a row is lit and dimmed from state');
assert.ok(!/classList\.\w+\([^)]*'(?:held|cutting)'/.test(pageJs),
  'and never by a hand on its classes');
assert.match(
  pageJs,
  /cutFrom\.value = on \? \(shownHistory\.value\?\.history\?\.\[1\]\?\.hash \?\? null\) : null;/,
  'and Clear history previews the same act the same way',
);

assert.match(pageJs, /id="ackCount"/, 'the checked changes are countable');
assert.match(pageJs, /unack: \(\) => clearAcks\(\),/, 'and the count is the way back to them');
assert.match(pageJs, /function applyAcks/, 'and shown as checked');
assert.match(pageJs, /function clearAcks/, 'and can all be brought back');
assert.match(pageCss, /\.chg-ok \{/, 'and a checked change reads as plain text');
assert.ok(pageCss.includes('.no-diff .chg-tag'), 'the tag goes with the marks it belongs to');
// ADDED/CHANGED/REMOVED is the app labelling a block, not the block's own
// prose, so it reads in the UI font even when the document's is serif or mono.
assert.match(
  pageCss,
  /\.chg-tag \{[^}]*font-family: var\(--font-sans\)/,
  'the tag ignores --doc-font',
);
console.log('✓ contents list + checked changes wired end to end');

// The change ruler is the same three-file shape, and it fails invisibly: no
// element and the marks go nowhere, no `[hidden]` rule and an empty strip
// stays over the scrollbar, no `pointer-events: none` and it swallows every
// grab of the scrollbar it is drawn on top of.
assert.match(pageHtml, /id="ruler"/, 'the ruler has somewhere to draw');
assert.match(pageJs, /function paintRuler/, 'and something to fill it');
assert.match(pageJs, /new ResizeObserver\(queueRuler\)/, 'and redraws as the document settles');
assert.match(pageCss, /\.ruler \{[^}]*pointer-events: none/, 'and never takes a click');
assert.ok(pageCss.includes('.ruler[hidden]'), 'and goes away with the marks it stands for');
// `main` is the scroll area, so its right edge is where its scrollbar runs.
// With the contents column up, both have to come in by its width or the ruler
// is a strip of marks lined up with nothing, behind a list painted over it.
const inset = /\.toc-open (main|\.ruler) \{\s*right: var\(--toc-w\)/g;
assert.equal([...pageCss.matchAll(inset)].length, 2, 'the pane and the ruler both end at it');
for (const rule of ['.ruler-add', '.ruler-mod', '.ruler-del']) {
  assert.ok(pageCss.includes(rule), `stylesheet colours ${rule}`);
}
// `--mod` is blue, for "changed" marks, so it cannot also be the `[!WARNING]`
// alert's colour any more -- that would make a warning read as just another
// `[!NOTE]`. `--warn` keeps the old amber for that one alert alone.
assert.match(
  pageCss,
  /\.markdown-alert-warning \{[^}]*var\(--warn\)/,
  'the warning alert keeps its own amber, not the blue "changed" colour',
);
assert.ok(
  !/\.markdown-alert-warning[^{]*\{[^}]*var\(--mod\)/.test(pageCss),
  'and does not fall back to --mod',
);
// AccentColorText does not reliably resolve in every WebKit, so an opaque
// AccentColor fill there can leave the default dark text on a bright fill --
// unreadable rather than merely off-brand. The safe form is the translucent
// tint `.tab.on`/`.ver.on` already use, which needs no text-colour override.
assert.ok(
  !/\.menu button:hover \{[^}]*AccentColorText/.test(pageCss),
  'a hovered menu row never pairs AccentColor with AccentColorText',
);
assert.match(
  pageCss,
  /\.menu button:hover \{[^}]*color-mix\(in srgb, AccentColor/,
  'it tints with AccentColor instead, the way .tab.on and .ver.on do',
);
// `n`/`p` move `state.changeIndex`; the mark for the node it lands on gets its
// own class rather than relying on the next unrelated repaint to catch up.
assert.match(
  pageJs,
  /changeNodes\(\)\[state\.changeIndex\]/,
  'paintRuler asks which node is current',
);
assert.match(pageJs, /ruler-current/, 'and names the mark that stands for it');
assert.match(
  pageJs,
  /function goToNode\(node\)[\s\S]*?highlightRulerCurrent\(\)/,
  'and lights the mark right away so it shows at once',
);
assert.match(
  pageJs,
  /function goToChange\(step, kind = null\)[\s\S]*?goToNode\(/,
  'the key path lands through the same function a ruler click will',
);
assert.match(pageCss, /\.ruler-current \{/, 'and the stylesheet gives that mark its own look');

// What runs in a vm has to be JavaScript, and annotated TypeScript is not: `fn`, `konst` and
// `applySchemeSrc` lift their text out of main.ts and the viewmodels with its types stripped,
// where the greps for how the source is written read the .ts. Stripped, not read from the bundle:
// app.js has Preact scope-hoisted in beside the page, and esbuild renames the page's top-level
// names wherever they meet Preact's minified ones -- `$` is `$2` there -- so a lifted function
// would call a helper the vm's fakes do not name. Transforming file by file renames nothing.
const { transformSync } = await import('esbuild');
const pageRun = ['main.ts', 'vm/changes.ts', 'vm/acks.ts', 'vm/settings.ts']
  .map((file) => fs.readFileSync(rootUrl(`public/app/${file}`), 'utf8'))
  .map((ts) => transformSync(ts, { loader: 'ts', target: 'es2022' }).code)
  .join('\n');

// Stepping through the changes, run over fakes the way `applyScheme` is below: the arrows, `n`,
// `p` and the count on the bar all go through `goToChange`, and what it has to get right is
// *which* change, which needs only rectangles and a list.
{
  const vm = await import('node:vm');
  const { renderRawDiff } = await import('./src/core/diff.js');
  // `export` is taken off what is lifted: the vm runs it as a script, where it is not a word.
  const unexport = (src) => src?.replace(/^\nexport /, '\n');
  const fn = (name) =>
    unexport(pageRun.match(new RegExp(`\\n(?:export )?function ${name}\\(.*?\\n\\}\\n`, 's'))?.[0]);
  // One line ending in `;`, or an arrow function that closes with `};` in the first column.
  const konst = (name) =>
    unexport(pageRun.match(
      new RegExp(`\\n(?:export )?const ${name} = (?:[^\\n]*;|[\\s\\S]*?\\n\\};)\\n`),
    )?.[0]);
  for (const name of ['stepIndex', 'goToChange', 'changeNodes']) {
    assert.ok(fn(name), `vm/changes.ts has ${name}`);
  }
  for (const name of ['changeKind', 'continuesRun', 'LANDING_MS']) {
    assert.ok(konst(name), `vm/changes.ts has ${name}`);
  }

  // The count and the arrows reach it, and the count says which kind it was pressed on.
  assert.match(
    pageJs,
    /id="count"[\s\S]*?onClick=\{\(e\) =>\s+actions\.go\(\s+e\.shiftKey \? -1 : 1,\s+\(e\.target as Element\)\.closest<HTMLElement>\('\[data-kind\]'\)\?\.dataset\.kind,\s+\)/,
    'pressing the count steps through the changes, ⇧ backwards, of the kind pressed on',
  );
  assert.match(pageJs, /mountChanges\(\$\('changesSlot'\), \{[^}]*go: goToChange,/,
    'which is where the arrows go too');
  assert.ok(!/id="count"[^>]*onClick=\{\(\) => \w*[Tt]ocSide/.test(pageJs),
    'and no longer opens the right column');
  for (const kind of ['add', 'mod', 'del']) {
    assert.match(pageJs, new RegExp(`class="c-${kind}" data-kind="${kind}"`), `${kind} knows its kind`);
  }
  assert.match(pageJs, /id="count"[^>]*title="Next change/, 'the count says what it does');

  // `stepIndex` and `goToChange`, over nodes that are only a kind and a rectangle.
  let clock = 100000;
  const view = { top: 50, bottom: 650 };
  const build = (kinds, tops, current = -1) => {
    const nodes = kinds.map((k, i) => ({
      dataset: { chg: k },
      getBoundingClientRect: () => ({ top: tops[i], bottom: tops[i] + 40 }),
    }));
    const landed = [];
    const ctx = vm.createContext({
      state: { changeIndex: current },
      pane: { getBoundingClientRect: () => view },
      performance: { now: () => clock },
      changeNodes: () => nodes,
      goToNode: (n) => landed.push(n),
    });
    vm.runInContext(
      [konst('LANDING_MS'), 'let landedAt = -Infinity;', konst('changeKind'), fn('stepIndex'),
        fn('goToChange'), 'state.diff = true;'].join('\n'),
      ctx,
    );
    const press = (step, kind?) => {
      vm.runInContext(`goToChange(${step}, ${JSON.stringify(kind ?? null)})`, ctx);
      return nodes.indexOf(landed.at(-1));
    };
    return { press, ctx, state: ctx.state };
  };
  const K = ['add', 'mod', 'add', 'del', 'mod'];

  // Nothing chosen yet, at the top of the page: down is the first change, and up wraps to the
  // last one -- it used to land on the one before it.
  let t = build(K, [100, 700, 1300, 1900, 2500]);
  assert.strictEqual(t.press(1), 0, 'down from nothing chosen is the first change');
  t = build(K, [100, 700, 1300, 1900, 2500]);
  assert.strictEqual(t.press(-1), 4, 'and up from nothing chosen is the last, not the one before');

  // Pressed again and again with the page scrolled to wherever the last one put it, it walks the
  // lot and wraps, in order, in both directions.
  t = build(K, [300, 700, 1300, 1900, 2500], 0);
  const walked = [];
  for (let i = 0; i < K.length; i++) {
    walked.push(t.press(1));
    // The scroll lands the change on screen; fake it by moving the window to it.
    const at = t.state.changeIndex;
    view.top = [300, 700, 1300, 1900, 2500][at] - 100;
    view.bottom = view.top + 600;
  }
  assert.deepStrictEqual(walked, [1, 2, 3, 4, 0], 'down visits every change once, then wraps');
  Object.assign(view, { top: 50, bottom: 650 });

  // Scrolled away from the last one by hand: a step is from where the reader is.
  t = build(K, [-900, -400, 700, 1200, 1700], 0);
  assert.strictEqual(t.press(1), 2, 'down goes to the first change below, not back up the page');
  t = build(K, [-900, -400, 700, 1200, 1700], 0);
  assert.strictEqual(t.press(-1), 1, 'and up to the last change above the window');

  // A reload puts the page back to nothing chosen, with the reader well down it: same rule.
  t = build(K, [-3000, -2500, -2000, 400, 900], -1);
  assert.strictEqual(t.press(1), 3, 'after a reload, down starts from the window');

  // Pressed twice before the smooth scroll of the first has got anywhere: the second goes on
  // from the change just chosen, and not from the window, which is still back where it was.
  t = build(K, [-900, 2000, 2600, 3200, 3800], 1);
  vm.runInContext(`landedAt = ${clock - 100}`, t.ctx);
  assert.strictEqual(t.press(1), 2, 'a second press while the scroll is under way goes on');
  // Not so once it is long over and the change is nowhere near: the window rules again.
  t = build(K, [-900, 2000, 2600, 3200, 3800], 1);
  assert.strictEqual(t.press(1), 1, 'and later, with the reader elsewhere, it is from the window');

  // The count presses it by kind: the next *changed* from the window, going round only those.
  t = build(K, [100, 700, 1300, 1900, 2500]);
  assert.strictEqual(t.press(1, 'mod'), 1, 'the first of the kind pressed on');
  vm.runInContext(`landedAt = ${clock}`, t.ctx);
  assert.strictEqual(t.press(1, 'mod'), 4, 'then the next of that kind, skipping the others');
  assert.strictEqual(t.press(1, 'mod'), 1, 'and round again');
  assert.strictEqual(t.press(-1, 'mod'), 4, 'with ⇧ the other way');
  t = build(['add', 'add'], [100, 700]);
  assert.strictEqual(t.press(1, 'mod'), 0, 'a kind this view has none of goes through them all');

  // The raw view marks lines: a rewritten paragraph is a run of them, and a removal is marked by
  // a class rather than a `data-chg`. One stop for each run, removals included.
  const raw = renderRawDiff(
    'intro\n\nalpha one\nalpha two\nalpha three\n\noutro\n',
    'intro\n\nbeta one\nbeta two\nbeta three\n\noutro\n\nadded para\n',
  );
  const lines = [];
  for (const m of raw.matchAll(/<span class="raw-line((?: raw-(?:add|del))?)"[^>]*?(?: data-chg="(\w+)")?>/g)) {
    const classes = ['raw-line', ...m[1].split(' ').filter(Boolean)];
    lines.push({
      classes,
      dataset: m[2] ? { chg: m[2] } : {},
      previousElementSibling: lines.at(-1) ?? null,
      classList: { contains: (c) => classes.includes(c) },
      matches: (sel) => sel === '[data-chg], .raw-del' && (!!m[2] || classes.includes('raw-del')),
    });
  }
  const rawCtx = vm.createContext({
    doc: {
      querySelectorAll: (sel) => {
        assert.strictEqual(sel, '[data-chg], .raw-del', 'one selector for everything marked');
        return lines.filter((l) => l.matches(sel));
      },
    },
  });
  vm.runInContext([konst('changeKind'), konst('continuesRun'), fn('changeNodes')].join('\n'), rawCtx);
  // The two members of a stop that the order is read from; the nodes come out of the vm context.
  interface Stop {
    classList: { contains(c: string): boolean };
    dataset: { chg?: string };
  }
  const stops = vm.runInContext('changeNodes()', rawCtx);
  assert.deepStrictEqual(
    // `from`, so the array is this realm's and not the context's, which never compares equal.
    Array.from(stops, (n: Stop) => (n.classList.contains('raw-del') ? 'del' : n.dataset.chg)),
    ['del', 'add', 'add'],
    'the raw view has a stop per change, removals too, and not one per line',
  );
  assert.ok(lines.filter((l) => l.matches('[data-chg], .raw-del')).length > stops.length,
    'though it marks more lines than that');
  console.log('✓ the arrows and the count step from where the reader is, one stop per change');
}
// The marks are a component (ui/Ruler.tsx). `paintRuler` measures and leaves bands in
// `rulerBands`; `highlightRulerCurrent` only names the current node, so hover and `n`/`p`
// measure nothing again. Marks are keyed by position, so a repaint keeps the elements on screen
// and `.ruler-mark`'s opacity transition has a "before" to fade from.
assert.match(pageJs, /mountRuler\(\$\('ruler'\), \{/, 'the marks are mounted on the ruler');
assert.match(pageJs, /rulerBands\.value = bands\.map\(/, 'from the bands paintRuler measured');
assert.match(
  pageJs,
  /function highlightRulerCurrent\(\) \{\s*rulerCurrent\.value =/,
  'the mark is relit without measuring the ruler again',
);
assert.match(pageJs, /current && nodes\.includes\(current\) && 'ruler-current'/,
  'a band is current when any node it stands for is');
assert.match(pageJs, /rulerBands\.value\.map\(\(\{ kind, ok, top, height, nodes \}, i\) => \(\s*<div\s*key=\{i\}/,
  'each mark keeps its element across a repaint');
assert.ok(!/ruler\.replaceChildren|ruler\.children/.test(pageJs),
  'and nothing reaches past the component into the marks');
assert.match(pageCss, /\.ruler-mark \{[^}]*transition: opacity/, 'so losing current can fade');
// The same highlight on hover, not only on `n`/`p` -- delegated, since the
// marked blocks are replaced whole on every paint and a listener bound to one
// would go with it.
assert.match(pageJs, /doc\.addEventListener\('pointerover'/, 'hovering a block is also caught');
assert.match(pageJs, /doc\.addEventListener\('pointerout'/, 'and leaving it is too');
assert.match(pageJs, /hoverNode = null/, 'cleared when the document it points into is gone');
// `c` checks off what the pointer is on -- the block the ruler shows as current --
// before it falls back to the last change `n`/`p` landed on.
assert.match(
  pageJs,
  /function changeUnderCursor\(\) \{[^}]*hoverNode\?\.isConnected[^}]*return hoverNode/,
  '`c` acts on the hovered change first',
);
// A mark is also something to point at, not only something to read: a click
// lands on the change it stands for, and hovering it tints the block(s) back,
// the reverse of the doc-to-ruler hover above.
assert.match(pageJs, /onClick=\{\(\) => actions\.go\(nodes\[0\]\)\}/, 'a mark can be clicked');
assert.match(
  pageJs,
  /mountRuler\(\$\('ruler'\), \{\s*go: \(node\) => \{[\s\S]*?goToNode\(node\);/,
  'and lands the same way n\\/p do',
);
assert.match(pageJs, /onPointerEnter=\{\(\) => actions\.hover\(nodes\)\}/,
  'and hovering one is caught too');
assert.match(pageJs, /onPointerLeave=\{\(\) => actions\.hover\(null\)\}/, 'and leaving it is too');
assert.match(pageJs, /hover: hoverMarks,/, 'which tint and untint the blocks it stands for');
assert.match(
  pageJs,
  /classList\.add\('chg-hot'\)/,
  'hovering a mark tints the blocks it stands for',
);
assert.match(
  pageCss,
  /\.chg:hover,\s*\n\s*\.chg-hot \{/,
  'the stylesheet folds that class into the block-hover look',
);
assert.match(
  pageCss,
  /\.chg:hover > \.chg-tag,\s*\n\s*\.chg-hot > \.chg-tag,/,
  'including the label the hover brings up',
);
assert.match(
  pageCss,
  /\.ruler-mark \{[^}]*pointer-events: auto/,
  'the mark alone takes the click',
);
assert.match(pageCss, /\.ruler-mark \{[^}]*cursor: pointer/, 'and admits it');
// The hit box and the colour are two different rules on purpose: a hover area
// generous enough to land a click on would be a thick bar on the eye if its
// own background were the mark's colour, so the colour is a narrower
// pseudo-element centred inside it instead.
assert.match(pageCss, /\.ruler-mark::after \{/, 'the visible stripe is its own element');
assert.match(
  pageCss,
  /\.ruler-current::after \{[^}]*width:/,
  'the current mark widens the stripe, not the hit box behind it',
);
// The platform scrollbar `main` otherwise leaves alone grows on hover and
// while scrolling, wide enough in that state to swallow several ruler marks
// at once -- pinning its width is what keeps the two from fighting over the
// same track.
assert.match(pageCss, /main::-webkit-scrollbar \{/, 'the scrollbar is pinned to a fixed width');
assert.match(
  pageCss,
  /main \{[^}]*scrollbar-width: thin/,
  'and asked the same of the one engine without it',
);
console.log('✓ change ruler wired end to end');

// A path in a table cell. github-markdown-css gives a table `width:
// max-content; max-width: 100%; overflow: auto`, so one `code` span holding
// something with no spaces in it — `/Users/me/src/a-long-project-name` — pins its
// column to the width of that path and the rest of the row is clipped, behind a
// macOS overlay scrollbar that is invisible until something scrolls it. Only
// `anywhere` lowers the min-content width the table layout reads, so only
// `anywhere` lets the column shrink; `break-word`, which `.markdown-body`
// already sets, breaks a token after it has overflowed and so changes nothing
// here. It has to stay off the cell itself: there it breaks ordinary words too
// and the layout squeezes a column until `Source` reads `Sourc/e`.
assert.match(
  pageCss,
  /\.markdown-body table code,\s*\.markdown-body table a \{[^}]*overflow-wrap: anywhere/,
  'a path in a table cell wraps instead of hiding the row',
);
assert.ok(
  !/table th,\s*\.markdown-body table td \{[^}]*overflow-wrap: anywhere/.test(pageCss),
  'and not on the cell, which would break ordinary words',
);
console.log('✓ long inline code in a table cell wraps');

// Dragging either column's inner edge. The grip has to exist, has to be styled
// (a 1px border with no cursor is not a handle anyone finds), and both widths
// have to be applied before first paint — restoring them afterwards reflows
// the whole document on every open, which is exactly what the inline script is
// for.
assert.match(pageHtml, /id="sideGrip"/, 'the sidebar edge is something to pull');
assert.match(pageHtml, /id="tocGrip"/, 'and so is the contents edge');
assert.match(pageHtml, /redline:sidew/, 'their widths are restored before first paint');
assert.match(pageHtml, /redline:tocw/, 'both of them');
assert.match(pageJs, /wireGrip\(\$\('sideGrip'\), SIDE_W_KEY, 1\)/, 'the left edge drags right');
assert.match(pageJs, /wireGrip\(\$\('tocGrip'\), TOC_W_KEY, -1\)/, 'and the right edge drags left');
assert.match(pageJs, /prefs\.setItem\(key, String\(clampSideW/, 'and both write back');
assert.match(pageCss, /\.side-grip \{/, 'and the grips are styled');
assert.ok(pageCss.includes('cursor: col-resize'), 'and say what they do under the pointer');
// Two columns that are each a reasonable width can still leave no document
// between them, so the pair is clamped together as well as separately — in the
// inline script and in app.js both, which is the price of having the widths
// right on the first frame.
assert.match(pageJs, /function fitWidths/, 'the pair of widths is fitted to the window');
assert.match(pageHtml, /innerWidth - 320/, 'by the inline script too, to the same number');
assert.match(pageJs, /DOC_W_MIN = 320/, 'and app.js agrees with it');
console.log('✓ both sidebars resize, and leave the document room');

// The page's layout is modules of its own (layout/), each wired from main.ts and none importing
// it back. The widths and the height are imported for what they do as they load -- wire their
// grips -- so a dropped import would leave both edges dead with nothing failing to compile.
{
  const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
  const layout = (f) => fs.readFileSync(rootUrl(`public/app/layout/${f}`), 'utf8');
  assert.match(mainTs, /^import '\.\/layout\/widths\.js';$/m,
    'main.ts loads the widths');
  assert.match(mainTs, /^import '\.\/layout\/toc-height\.js';$/m, 'and the height');
  assert.match(mainTs, /^bindKeys\(\{$/m, 'binds the keys');
  assert.match(mainTs, /^bindNative\(\{$/m, 'and the shell');
  assert.ok(mainTs.indexOf('bindNative({') < mainTs.indexOf('await initSettings();'),
    'before it waits on anything, so the first tabs are asked for and heard');
  for (const f of ['widths.ts', 'toc-height.ts', 'keys.ts', 'native.ts', 'fonts.ts']) {
    assert.ok(!/from '\.\.\/main\.js'/.test(layout(f)), `${f} does not import main.ts`);
  }
  assert.match(layout('widths.ts'), /\nfunction fitWidths\(/, 'fitWidths is in widths.ts');
  assert.match(layout('toc-height.ts'), /\nconst tocHMax = /, 'and tocHMax in toc-height.ts');
  assert.match(pageHead, /`fitWidths` in public\/app\/layout\/widths\.ts/,
    'which is where the head script says its mirror is');
  assert.match(pageHead, /`tocHMax` in public\/app\/layout\/toc-height\.ts/, 'both of them');
}
console.log('✓ the layout is its own modules, wired from main.ts');

// The viewmodels (vm/) are the page's features, each owning its signals and what it does, and
// they hold together only while every import points down: main.ts wires them, a component in
// ui/ may read them, and none of them reaches up into either. A vm importing main.ts compiles,
// and runs until the first time a value is read before main.ts has defined it.
{
  const dir = rootUrl('public/app/vm/');
  const vms = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).sort();
  const imports = (src) => [...src.matchAll(/^import [^;]*?from '([^']+)';$/gms)].map((m) => m[1]);
  const graph = new Map<string, string[]>();
  for (const f of vms) {
    const specs = imports(fs.readFileSync(new URL(f, dir), 'utf8'));
    for (const spec of specs) {
      assert.ok(
        spec === '@preact/signals' ||
          /^\.\.\/(state|dom|backend|layout\/(native|widths))\.js$/.test(spec) ||
          /^\.\.\/\.\.\/vendor\//.test(spec) ||
          /^\.\/[\w-]+\.js$/.test(spec),
        `vm/${f} imports ${spec}: a viewmodel reaches only the state, the DOM, the backend, ` +
          'the shell, the column widths, the vendored renderer and its siblings',
      );
    }
    const siblings = specs.flatMap((s) => /^\.\/([\w-]+)\.js$/.exec(s)?.[1] ?? []);
    graph.set(f.replace(/\.ts$/, ''), siblings);
  }
  // And among themselves, one way: a cycle of viewmodels is main.ts's tangle over again.
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    assert.ok(!path.includes(name),
      `the viewmodels import in a circle: ${[...path, name].join(' → ')}`);
    if (done.has(name)) return;
    for (const next of graph.get(name) ?? []) visit(next, [...path, name]);
    done.add(name);
  };
  for (const name of graph.keys()) visit(name, []);

  for (const f of fs.readdirSync(rootUrl('public/app/ui/'))) {
    assert.ok(!/from '\.\.\/main\.js'/.test(fs.readFileSync(rootUrl(`public/app/ui/${f}`), 'utf8')),
      `ui/${f} does not import main.ts`);
  }
  // Each is reached. Most wire their own listeners as they load, so one that main.ts no longer
  // loads, by itself or through another viewmodel, is a feature gone with nothing failing to
  // compile.
  const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
  const reached = new Set<string>();
  const reach = (name: string) => {
    if (reached.has(name)) return;
    reached.add(name);
    for (const next of graph.get(name) ?? []) reach(next);
  };
  for (const spec of imports(mainTs)) {
    const name = /^\.\/vm\/([\w-]+)\.js$/.exec(spec)?.[1];
    if (name) reach(name);
  }
  for (const f of vms) {
    assert.ok(reached.has(f.replace(/\.ts$/, '')), `main.ts loads vm/${f}`);
  }
  assert.match(mainTs, /^import \{ backend \} from '\.\/backend\.js';$/m,
    'and the backend, which is a module under all of them');
  const vm = (f) => fs.readFileSync(new URL(f, dir), 'utf8');
  assert.match(vm('find.ts'), /\$\('findInput'\)\.addEventListener\('input'/, 'find hears its bar');
  assert.match(vm('peek.ts'), /doc\.addEventListener\('pointerover'/, 'the peek hears the links');
  assert.match(vm('peek.ts'), /pane\.addEventListener\('scroll', hidePeek\);/,
    'and goes when the document scrolls');
  assert.match(vm('contents.ts'), /pane\.addEventListener\('scroll', queueSpy\);/,
    'as Contents follows it, on a listener of its own');
  assert.match(vm('contents.ts'), /doc\.addEventListener\('click', \(e\) => \{\n  const a = \(e\.target as Element\)\.closest\('a\[href\^="#"\]'\);/,
    'and takes the document\'s links to its own headings');
  assert.match(vm('sidebars.ts'), /\$\('side'\)\.addEventListener\('click', \(\) => setSide\(!state\.side\)\);/,
    'the columns are opened from their buttons');
  assert.match(vm('sidebars.ts'), /\$\('tocBtn'\)\.addEventListener\('click', \(\) => setTocSide\(/,
    'both of them');
  assert.match(vm('sidebars.ts'), /querySelectorAll<HTMLElement>\('\.side-twist'\)/,
    'and the disclosures at their tops wired');
  assert.match(mainTs, /^setSide\(state\.side, false\);\nsetTocSide\(state\.tocSide, false\);$/m,
    'which main.ts lays out once from what the head script put on the root');
  assert.match(mainTs, /\n  baseline: chooseBaseline,\n  reveal: [^\n]*\n  check: checkUpdate,\n  go: getUpdate,\n/,
    'Settings is handed the baseline choice and the update check from their viewmodels');
  assert.match(vm('settings.ts'),
    /export function chooseBaseline\(v\) \{[\s\S]{0,300}?state\.baseline = defaultBaseline\(\);\s*load\(\{ keepScroll: true \}\);/,
    'a baseline chosen is the document in front of you compared again');
  assert.match(vm('diagrams.ts'), /doc\.addEventListener\('toggle', \(e\) => drawDiagrams\(/,
    'a diagram is drawn when its "before" opens');
  assert.match(vm('settings.ts'),
    /if \(\(sepia\(\) !== wasSepia \|\| schemeMoved\) && retheme\(\)\) paint\(\);/,
    'and redrawn on a new tint or scheme, only once Mermaid has drawn anything');
  assert.match(vm('settings.ts'), /if \(!applyScheme\(\)\) return;\s*retheme\(\);\s*paint\(\);/,
    'which System moving is too');
  const chromeTs = fs.readFileSync(rootUrl('public/app/ui/chrome.ts'), 'utf8');
  assert.match(chromeTs, /\$\('findCount'\)\.textContent = findCount\.value;/,
    'the find count is drawn from its signal');
  assert.match(chromeTs, /box\.hidden = text === null;/, 'and the notice from its');
  assert.ok(!/\$\('findCount'\)|\$\('notice'\)|\$\('peek'\)/.test(mainTs),
    'and main.ts writes none of them');

  // The changes and their check-offs. acks.ts repaints the count and the ruler after it moves
  // the classes they read, so it imports changes.ts; the other way round would be a circle.
  assert.match(vm('acks.ts'), /^import \{[^}]*\} from '\.\/changes\.js';$/m,
    'check-offs repaint through the changes viewmodel');
  assert.ok(!/from '\.\/acks\.js'/.test(vm('changes.ts')), 'which knows nothing of them');
  assert.match(vm('changes.ts'), /new ResizeObserver\(queueRuler\)\.observe\(doc\);/,
    'the ruler watches the document settle');
  assert.match(vm('changes.ts'), /doc\.addEventListener\('pointerover'/,
    'and hears the pointer over a change');
  assert.match(vm('acks.ts'), /doc\.addEventListener\('click'/, 'a tag in the margin checks off');
  // `hoverNode` is read by acks.ts through the live binding, and only its own module may assign
  // it -- an assignment anywhere else is a TypeError at run time, and a silent one in a listener.
  assert.ok(!/hoverNode =/.test(vm('acks.ts') + vm('core.ts') + mainTs), 'and the hover is changes.ts\'s to set');
  assert.match(vm('core.ts'), /hidePeek\(\);\s*forgetHover\(\);/,
    'which paint has forget the node it is about to replace');
  const moved = 'paintRuler|paintCount|changeNodes|goToChange|keepAnchored|setAck|tapCheck';
  assert.ok(!new RegExp(`^(?:async )?function (?:${moved})\\(`, 'm').test(mainTs),
    'and none of it is in main.ts any more');
  const stateTs = fs.readFileSync(rootUrl('public/app/state.ts'), 'utf8');
  assert.ok(!/export const (?:rulerBands|rulerCurrent|tally) /.test(stateTs),
    'the ruler and the count are the viewmodel\'s signals, not the shared state\'s');
  for (const [f, names] of [['Ruler.tsx', 'rulerBands, rulerCurrent'], ['Changes.tsx', 'tally']]) {
    assert.match(fs.readFileSync(rootUrl(`public/app/ui/${f}`), 'utf8'),
      new RegExp(`^import \\{ ${names} \\} from '\\.\\./vm/changes\\.js';$`, 'm'),
      `ui/${f} reads them from there`);
  }

  // History, the view and Settings. Each redraws the document, and is drawn by it, so they
  // reach the core through vm/document.ts, which vm/core.ts fills as it is imported.
  assert.match(vm('core.ts'), /^bindDocument\(\{ load, adopt, paint, rerender \}\);$/m,
    'the core hands itself to the port');
  assert.ok(!/bindDocument/.test(mainTs), 'and main.ts has nothing to do with it');
  assert.ok(!/from '\.\/core\.js'/.test(vm('history.ts') + vm('view.ts') + vm('settings.ts')),
    'which is what keeps the core out of the modules it draws');
  for (const f of ['history.ts', 'view.ts', 'settings.ts']) {
    assert.match(vm(f), /^import \{[^}]*\} from '\.\/document\.js';$/m, `${f} redraws through it`);
  }
  // One way: History picks a version by turning the marks on, the view stores them as a setting,
  // and Settings hands them back through `shownSettings` rather than calling the view.
  assert.match(vm('history.ts'), /^import \{ setMarks \} from '\.\/view\.js';$/m,
    'History turns the marks on through the view');
  assert.match(vm('view.ts'), /^import \{ writeSettings \} from '\.\/settings\.js';$/m,
    'which stores them as a setting');
  assert.ok(!/from '\.\/(view|history)\.js'/.test(vm('settings.ts')),
    'and Settings knows nothing of either');
  assert.match(vm('view.ts'),
    /effect\(\(\) => \{\s*const s = shownSettings\.value;\s*if \(s\) untracked\(\(\) => setDiff\(s\.marks\)\);/,
    'the view takes the marks from the settings as they are applied');
  assert.ok(!/setDiff/.test(vm('settings.ts')), 'which apply no marks themselves');
  // The repaints that are now signals: the version read alone is worked out, not left, and the
  // History heading keeps to the payload the list is drawn from.
  assert.match(vm('history.ts'), /export const soloName = computed\(\(\) => \{/,
    'the name of the version read alone is computed from what it depends on');
  assert.ok(!/soloName/.test(stateTs), 'and is not shared state for something to forget to set');
  assert.match(fs.readFileSync(rootUrl('public/app/ui/Changes.tsx'), 'utf8'),
    /^import \{ soloName \} from '\.\.\/vm\/history\.js';$/m, 'the bar reads it from there');
  assert.ok(!/paintSolo/.test(pageJs), 'and nothing paints it');
  assert.match(chromeTs, /\$\('histSolo'\)\.hidden = versions\.length < 2 && !state\.solo;/,
    'the switch is drawn from the list and from itself');
  assert.match(chromeTs, /press\(\s*\$\('histSolo'\),\s*state\.solo,/, 'and pressed from its state');
  assert.match(vm('history.ts'),
    /export function paintHistory\(d\) \{[^}]*closeVerMenu\(\);[^}]*shownHistory\.value = d;\s*\}/,
    'what is left of painting History is handing it the payload');
  assert.ok(!/\$\('hist(Count|Clear|Solo)'\)\.(hidden|textContent)|setAttribute/.test(vm('history.ts')),
    'and none of the heading is drawn by hand');
  const historyTsx = fs.readFileSync(rootUrl('public/app/ui/History.tsx'), 'utf8');
  assert.match(historyTsx, /^import \{ isBaseline, versionName, pruneFocus \} from '\.\.\/vm\/history\.js';$/m,
    'the list names a version and asks what is compared against as the bar does');
  const vmMoved = 'setDiff|setMarks|setView|sourceAt|applySettings|applyScheme|markRead|' +
    'openVerMenu|pickVersion|setSolo|initSettings';
  assert.ok(!new RegExp(`^(?:async )?function (?:${vmMoved})\\(`, 'm').test(mainTs),
    'and none of History, the view or Settings is in main.ts any more');
}
console.log('✓ the viewmodels are modules of their own, and import only downwards');

// The line between Contents and History is a third thing to drag, the same
// deal turned on its side: a handle in the markup, styling for it, a wired-up
// drag, and the two numbers that keep History from being squeezed to nothing,
// mirrored in the inline script for the same reason the widths are.
assert.match(
  pageHtml,
  /role="separator"[^>]*aria-orientation="horizontal"/s,
  'the handle says what it moves',
);
assert.match(pageJs, /function wireTocGrip/, 'and dragging it is wired up');
assert.match(pageJs, /wireTocGrip\(\$\('histGrip'\)\)/, 'to the one handle in the page');
assert.match(pageJs, /TOC_H_DEFAULT = 180/, 'tall enough to place a document\'s shape by default');
assert.match(pageJs, /TOC_H_MIN = 90/, 'with a floor under Contents');
assert.match(pageJs, /HIST_H_MIN = 110/, 'and one under History so the handle cannot swallow it');
assert.match(
  pageJs,
  /prefs\.setItem\(TOC_H_KEY, String\(clampTocH/,
  'and it writes back',
);
assert.match(
  pageCss,
  /#tocSec \{[^}]*height: var\(--toc-h\)/,
  'the height is a variable, not a share',
);
assert.match(pageHtml, /redline:toch/, 'restored before first paint, like the widths');
assert.match(pageHtml, /tocHMax/, 'against the same floor the inline script keeps for History');
assert.match(
  pageCss,
  /\.shut-toc #histGrip,\s*\.shut-hist #histGrip \{[^}]*display: none/,
  'and the handle goes away with either section it could belong to',
);
assert.match(
  pageCss,
  /\.shut-hist:not\(\.shut-toc\) #tocSec/,
  'and Contents takes over when History alone is put away',
);
console.log('✓ Contents resizes against History, and defaults to room for a document\'s shape');

// History moved columns, and three places still had to agree where it lives
// now: the paint function must not skip itself because the *other* column is
// shut, opening the right column must be what fills a list that was never
// built while it was closed, and the counter that answers "changed since
// what?" must open the column the answer is actually in.
assert.match(
  pageJs,
  /function History\([\s\S]*?if \(!d \|\| !state\.tocSide\) return null;/,
  'History paints against the column it is actually in',
);
assert.match(
  pageJs,
  /function setTocSide[\s\S]*?paintToc\(state\.data\);\s*paintHistory\(state\.data\);/,
  'opening that column fills both of its lists',
);
assert.match(
  pageJs,
  /\$\('tocBtn'\)\.addEventListener\('click', \(\) => setTocSide/,
  'and the column history is in has a button of its own, which the counter no longer is',
);
assert.match(pageHtml, /id="tocBtn"[^>]*title="[^"]*⌥⌘B/, 'whose tooltip names the key');
console.log('✓ History paints, opens and is reached through the right column');

// Settings. The two controls nobody could work — a slider for a size in
// whole pixels, and a text field you had to spell a font's name into — are
// gone, and what replaced them has to be reachable: a stepper is two buttons
// and a readout, and the typeface popup is empty markup until the script
// fills it from the fonts this machine actually resolves.
assert.ok(![pageHtml, settingsTsx].some((src) => src.includes('type="range"')),
  'no slider for a size counted in whole pixels');
assert.ok(!settingsTsx.includes('id="setFontName"'), 'and no font to spell by hand');
assert.match(settingsTsx, /id="setSizeDown"[\s\S]*?disabled=\{s\.textSize <= SIZE_MIN\}/,
  'text size steps down, as far as the floor');
assert.match(settingsTsx, /id="setSizeUp"[\s\S]*?disabled=\{s\.textSize >= SIZE_MAX\}/,
  'and up, as far as the ceiling');
assert.match(pageJs, /const stepSize =/, 'and the step is bounded, not free');
assert.match(pageJs, /listFonts/, 'the typeface popup is filled from this machine');
assert.match(pageJs, /function fontInstalled/, 'with a measured catalogue behind it');
assert.match(pageCss, /\.seg input:checked \+ span \{/, 'a segmented control shows its answer');
assert.match(pageCss, /\.switch input:checked \+ \.track \{/, 'and an on/off setting is a switch');
// A popup left to itself is drawn by the system — a grey slab with a blue
// arrow, next to controls that are neither. The chevron has to come back with
// it, and it can only hang off the wrapper.
assert.match(pageCss, /\.select \{[^}]*appearance: none/, 'the popup is not the system one');
assert.match(pageCss, /\.popup::before,/, 'so it draws its own chevron');
assert.match(settingsTsx, /class="popup"/, 'on the wrapper that can hold one');
// The sheet is a component, shut until asked: a slot in the page, the dialog drawn into it, and
// one signal between the ways in (⌘,, the button, the menu) and showModal.
{
  const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
  assert.match(pageHtml, /<span id="prefsSlot" class="slot"><\/span>/, 'Settings has a slot');
  assert.ok(!/<dialog/.test(pageHtml), 'and no dialog of its own in the page');
  assert.match(settingsTsx, /<dialog id="prefs" class="sheet" ref=\{sheet\} onClose=\{\(\) => \(prefsOpen\.value = null\)\}>/,
    'the dialog tells the signal when it shuts, by Escape or by Done');
  assert.match(settingsTsx, /if \(!dialog\.open\) dialog\.showModal\(\);/, 'and is shown modal');
  const settingsTs = fs.readFileSync(rootUrl('public/app/vm/settings.ts'), 'utf8');
  assert.match(settingsTs,
    /function openPrefs\(\) \{\s*if \(prefsOpen\.value === null\) prefsOpen\.value = '';/,
    'opening it is the signal');
  assert.match(settingsTs, /\$\('prefsBtn'\)\.addEventListener\('click', openPrefs\);/, 'from the bar');
  assert.match(settingsTs, /native\?\.onOpenSettings\(\(\) => openPrefs\(\)\);/, 'and from the menu');
  const keysTs = fs.readFileSync(rootUrl('public/app/layout/keys.ts'), 'utf8');
  assert.match(keysTs, /e\.key === ',' && \(e\.metaKey \|\| e\.ctrlKey\)\) \{\s*e\.preventDefault\(\);\s*openPrefs\(\);/,
    'and from ⌘, in a tab');
  assert.match(mainTs, /bindKeys\(\{[^}]*\n  openPrefs,\n/, 'which main.ts hands the keys');
  assert.ok(!/\$<HTMLDialogElement>\('prefs'\)|\$\('set[A-Z]|\$\('update/.test(mainTs + settingsTs),
    'and neither main.ts nor the viewmodel reaches into the sheet for anything');
  // What the sheet shows is what was applied: written once, at the end of applySettings.
  assert.match(settingsTs,
    /shownSettings\.value = settings;\s*docMeasure\.value = getComputedStyle\(root\)/,
    'the sheet sees each setting as it is applied, and the measure the width came to');
  const fontsTs = fs.readFileSync(rootUrl('public/app/layout/fonts.ts'), 'utf8');
  assert.match(fontsTs, /fontGroups\.value = listed;/, "the machine's fonts go to the popup");
  assert.match(mainTs, /await initSettings\(\);\s*(?:\/\/[^\n]*\n\s*)*listFonts\(backend, \(\) => settings\);/,
    'asked for once the settings are in, and reading them as they are when the fonts come');
  assert.match(settingsTsx, /fontGroups\.value\.map\(/, 'which draws them');
  for (const [control, write] of [
    ['setAppearance', /actions\.write\(\{ appearance: v \}\)/],
    ['setReopen', /actions\.write\(\{ reopenLast: v === '1' \}\)/],
    ['setFinder', /actions\.write\(\{ finderOpensIn: v \}\)/],
    ['setWidth', /actions\.write\(\{ width: v \}\)/],
    ['setMarks', /actions\.write\(\{ marks: \(e\.target as HTMLInputElement\)\.checked \}\)/],
    ['setBaseline', /pick=\{actions\.baseline\}/],
  ] as [string, RegExp][]) {
    const from = settingsTsx.indexOf(`id="${control}"`);
    assert.ok(from > 0 && write.test(settingsTsx.slice(from, from + 900)), `${control} is wired`);
  }
  assert.match(mainTs, /mountSettings\(\$\('prefsSlot'\), [^\n]*\n  write: writeSettings,\n  step: stepSize,/,
    'and writes through writeSettings, which applies, stores and tells the shell');
}
console.log('✓ the settings sheet is a component, opened by a signal and wired to writeSettings');
// The specimen is only honest if it reads the same two variables the document
// does; drawn from settings in script instead, it drifts the first time one
// of them is set from somewhere else.
assert.match(pageCss, /\.sample \{[^}]*var\(--doc-font\)/, 'the specimen is the document type');
assert.match(pageCss, /\.sample \{[^}]*var\(--doc-size\)/, 'at the document size');
// A custom typeface stops at the prose. The label on a changed block sits
// inside the document but is the app talking, and `font: inherit` on a button
// would hand it whatever the document happens to be set in.
assert.match(
  pageCss,
  /button,\s*\.select \{[^}]*font-family: var\(--font-sans\)/,
  'the tooling in the document keeps the system font',
);
// And the names in it come from the OS, because nothing in a browser will say:
// a catalogue written by hand lists faces this machine has never had and
// misses the one it is set in. An empty list is a fair answer off macOS.
const { fonts } = (await (await fetch(base + '/api/fonts')).json()) as Reply;
assert.ok(Array.isArray(fonts), '/api/fonts answers with a list of families');
if (process.platform === 'darwin') {
  assert.ok(fonts.length > 20, 'and on a Mac it is the ones installed here');
  assert.ok(fonts.includes('Helvetica'), 'named the way a font menu names them');
  assert.ok(!fonts.some((f) => /wingding|emoji/i.test(f)), 'minus what is not for reading');
}
console.log('✓ settings controls wired end to end');

// Sepia is the one appearance in four places at once, and each is a way for it
// to half work: a radio nobody's code reads, a tint applied a frame late (a
// white flash on every open), a window the shell leaves following a dark
// system (a dark bar round a cream page), or a cream that reaches paper.
const prefsRs = fs.readFileSync(rootUrl('shell/src/prefs.rs'), 'utf8');
assert.match(settingsTsx, /\{ value: 'sepia', text: 'Sepia' \}/, 'sepia can be chosen');
assert.match(
  pageHtml.slice(0, pageHtml.indexOf('</head>')),
  /s\.appearance === "sepia"\) document\.documentElement\.dataset\.tint = "sepia"/,
  'and is tinted before first paint',
);
assert.match(pageJs, /if \(settings\.appearance === 'sepia'\) root\.dataset\.tint = 'sepia'/,
  'and again whenever the setting changes');
assert.match(pageJs, /else delete root\.dataset\.tint/, 'and untinted when it changes away');
assert.match(prefsRs, /"light" \| "sepia" => Some\(tauri::Theme::Light\)/,
  'the shell pins a sepia window light');
assert.match(pageCss, /@media screen \{\s*:root\[data-tint="sepia"\] \{/,
  'the palette is drawn on screen only, so print stays white');
assert.match(pageCss, /:root\[data-tint="sepia"\] \.markdown-body \{[^}]*--bgColor-muted/,
  "and github-markdown-css's own palette is tinted with it");
assert.match(pageJs, /sepia\(\)\s*\?[\s\S]{0,200}theme: 'base'/, 'diagrams are drawn in it too');
console.log('✓ sepia wired through page, head script, stylesheet and shell');

// Light and dark are the page's to draw, from the setting, as `data-scheme` on <html>: a browser
// tab cannot be told it is dark the way the shell tells a window, so anything left to
// `prefers-color-scheme` would draw a tab set to Dark light on a light system. Each half of that
// is a way for it to half work -- a head script and `applyScheme` that disagree (the wrong scheme
// for one frame, on every open), a stylesheet still keyed to the media query, a highlight.js sheet
// left on, a dark palette that reaches paper, or diagrams drawn for the system's scheme.
{
  const vm = await import('node:vm');
  const { createRequire } = await import('node:module');
  const { keyToScheme } = await import('./scripts/markdown-css.mjs');
  const DARK_QUERY = '(prefers-color-scheme: dark)';
  const headScript = pageHead.match(/<script>([\s\S]*?)<\/script>/)[1];
  const fakeLinks = () => ({ hljsLight: { media: '' }, hljsDark: { media: '' } });
  const seen = (html, links) => ({
    scheme: html.dataset.scheme,
    tint: html.dataset.tint,
    light: links.hljsLight.media,
    dark: links.hljsDark.media,
  });

  // The head script as it runs before first paint, over a fake of what it touches.
  const runHead = (appearance, systemDark) => {
    const store = new Map();
    if (appearance) store.set('redline:settings', JSON.stringify({ appearance }));
    const links = fakeLinks();
    const html = {
      dataset: {},
      style: { setProperty() {} },
      classList: { add() {}, contains: () => false },
      matches: () => false,
    };
    vm.runInNewContext(headScript, {
      __REDLINE_PREFS: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
      location: { search: '' },
      URLSearchParams,
      innerWidth: 1200,
      innerHeight: 800,
      matchMedia: (q) => {
        assert.strictEqual(q, DARK_QUERY, 'the head script asks the one query');
        return { matches: systemDark };
      },
      document: { documentElement: html, getElementById: (id) => links[id] },
    });
    return seen(html, links);
  };

  // `applyScheme` out of app.js, over the same fakes.
  const applySchemeSrc = pageRun
    .match(/\n(?:export )?function applyScheme\(\) \{[\s\S]*?\n\}\n/)?.[0]
    .replace(/^\nexport /, '\n');
  assert.ok(applySchemeSrc, 'vm/settings.ts has applyScheme');
  assert.ok(pageJs.includes(`const darkMode = matchMedia('${DARK_QUERY}');`),
    'and reads System off the same query the head script does');
  const appScheme = (appearance, systemDark) => {
    const links = fakeLinks();
    const html = { dataset: {} };
    const ctx = vm.createContext({
      settings: { appearance },
      darkMode: { matches: systemDark },
      $: (id) => links[id],
      document: { documentElement: html },
    });
    vm.runInContext(applySchemeSrc, ctx);
    const moved = vm.runInContext('applyScheme()', ctx);
    return { ...seen(html, links), moved, again: vm.runInContext('applyScheme()', ctx), ctx };
  };

  const ON_DARK = { scheme: 'dark', light: 'print', dark: 'screen' };
  const ON_LIGHT = { scheme: 'light', light: 'all', dark: 'not all' };
  for (const [appearance, systemDark, want] of [
    ['system', false, ON_LIGHT],
    ['system', true, ON_DARK],
    ['light', true, ON_LIGHT],
    ['sepia', true, ON_LIGHT],
    ['dark', false, ON_DARK],
    ['dark', true, ON_DARK],
  ] as [string, boolean, typeof ON_DARK][]) {
    const head = runHead(appearance, systemDark);
    const app = appScheme(appearance, systemDark);
    const label = `${appearance} on a ${systemDark ? 'dark' : 'light'} system`;
    assert.deepStrictEqual(
      { scheme: head.scheme, light: head.light, dark: head.dark },
      want,
      `${label}: the head script draws it ${want.scheme}, highlight.js's dark sheet screen-only`,
    );
    assert.deepStrictEqual(
      { scheme: app.scheme, light: app.light, dark: app.dark },
      want,
      `${label}: and applyScheme agrees with it`,
    );
    assert.strictEqual(head.tint, appearance === 'sepia' ? 'sepia' : undefined,
      `${label}: tinted only for sepia`);
  }
  assert.deepStrictEqual(
    { scheme: runHead(null, true).scheme, light: runHead(null, false).scheme },
    { scheme: 'dark', light: 'light' },
    'with nothing saved, the head script follows the system, as the default System does',
  );
  // Whether it moved is what decides a repaint, so a second call with nothing changed says no
  // and a pinned scheme the system moves under says no too.
  const moving = appScheme('system', false);
  assert.ok(moving.moved && !moving.again, 'applyScheme says when the scheme moved, and only then');
  moving.ctx.darkMode.matches = true;
  assert.strictEqual(vm.runInContext('applyScheme()', moving.ctx), true, 'System follows it');
  moving.ctx.settings.appearance = 'dark';
  moving.ctx.darkMode.matches = false;
  assert.strictEqual(vm.runInContext('applyScheme()', moving.ctx), false,
    'a pinned Dark does not move with the system');

  // Wired: on every setting, and on the system's change, with diagrams redrawn only on a move.
  const applySettingsSrc = pageJs.match(/\nfunction applySettings\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(applySettingsSrc, /const schemeMoved = applyScheme\(\);/,
    'applySettings applies the scheme');
  assert.match(applySettingsSrc, /if \(\(sepia\(\) !== wasSepia \|\| schemeMoved\) && retheme\(\)\)/,
    'and redraws diagrams when it or the tint moved');
  assert.match(pageJs, /export function retheme\(\) \{\s*if \(!mermaid\) return false;/,
    'once Mermaid has drawn something in the old colours');
  assert.match(
    pageJs,
    /darkMode\.addEventListener\('change', \(\) => \{\s*if \(!applyScheme\(\)\) return;/,
    "the system's change goes through applyScheme, and repaints only if the scheme moved",
  );
  assert.ok(
    pageJs.includes("const dark = () => document.documentElement.dataset.scheme === 'dark';"),
    'diagrams read the scheme off the page',
  );
  assert.match(pageJs, /theme: dark\(\) \? 'dark' : 'default'/, 'and Mermaid is drawn in it');
  assert.ok(!/darkMode\.matches \?/.test(pageJs), "and not in the system's");

  // The stylesheets read the attribute, and none of them the media query.
  assert.match(pageHtml, /<link id="hljsLight" rel="stylesheet" href="vendor\/hljs-light\.css" \/>/,
    "highlight.js's light sheet has an id for the scheme to switch");
  assert.match(pageHtml, /<link id="hljsDark" rel="stylesheet" href="vendor\/hljs-dark\.css" \/>/,
    'and so does its dark one, neither with a media query of its own');
  assert.ok(pageHead.indexOf('id="hljsDark"') < pageHead.indexOf('<script>'),
    'both are in the head before the script that looks them up');
  assert.match(pageCss, /@media screen \{\s*:root\[data-scheme="dark"\] \{\s*color-scheme: dark;/,
    "the page's dark palette is keyed to the attribute, on screen only, with the browser's own");
  assert.ok(!pageCss.includes('prefers-color-scheme'), 'and styles.css asks no media query');

  // github-markdown-css, keyed by build:web.
  const require = createRequire(import.meta.url);
  const shipped = fs.readFileSync(
    require.resolve('github-markdown-css/github-markdown.css'),
    'utf8',
  );
  const keyed = keyToScheme(shipped);
  assert.ok(!keyed.includes('prefers-color-scheme'), 'the markdown palette follows no media query');
  const darkBody = keyed.match(
    /@media screen \{\s*:root\[data-scheme="dark"\] \.markdown-body \{([^}]*)\}\s*\}/,
  )?.[1];
  const lightBody = keyed.match(
    /(?:^|\n)\.markdown-body \{([^}]*color-scheme: light;[^}]*)\}/,
  )?.[1];
  assert.ok(darkBody?.includes('--bgColor-default:'),
    'its dark palette is under data-scheme, on screen');
  assert.ok(lightBody?.includes('--bgColor-default:'), 'and its light one is the default');
  const names = (body) => [...body.matchAll(/(--[\w-]+):/g)].map((m) => m[1]).sort().join();
  assert.strictEqual(names(darkBody), names(lightBody),
    'the dark palette sets every variable the light one does, so nothing light shows through');
  assert.throws(() => keyToScheme('.markdown-body { color: red; }'), /found none/,
    'a release with the palettes moved stops the build');
  assert.throws(() => keyToScheme(shipped + shipped), /found dark, dark, light, light/,
    'and so does one with more than the two');
  const served = await (await fetch(base + '/vendor/github-markdown.css')).text();
  assert.strictEqual(served, keyed, 'the CLI serves the keyed one, not the one in node_modules');

  // Shown in a browser tab, where the rest of General is not.
  const general = settingsTsx.match(/<section([^>]*)>\s*<h3>General<\/h3>([\s\S]*?)<\/section>/);
  assert.ok(general && !general[1].includes('data-shell'),
    "General is not the shell's as a whole");
  const rowOf = (id) => general[2].split('<div class="row"').find((r) => r.includes(`id="${id}"`));
  assert.ok(rowOf('setAppearance').startsWith('>'), 'Appearance shows in a browser tab');
  assert.ok(rowOf('setReopen').startsWith(' data-shell="">'), 'On launch does not');
  assert.ok(rowOf('setFinder').startsWith(' data-shell="">'), 'nor does Files from Finder');
}
console.log('✓ the scheme is the page\'s: head script and applyScheme agree, every sheet reads it');

// The remembered comparison. The reader keeps it, but only if the page asks in
// the form that means "show me this document" rather than "compare it against
// this": every site that *shows* one has to send `last:`, and the one that
// changes the setting must not, or changing it would look like it did nothing.
const KEPT = /const keptBaseline = \(\) => `last:\$\{defaultBaseline\(\)\}`/;
assert.match(pageJs, KEPT, 'the form that means "show me this document" exists');
assert.strictEqual(
  (pageJs.match(/state\.baseline = keptBaseline\(\)/g) || []).length,
  4,
  'and is sent on first open, a tab switch, a file event and following a link',
);
assert.strictEqual(
  (pageJs.match(/state\.baseline = defaultBaseline\(\)/g) || []).length,
  1,
  'while changing the setting still names a baseline outright',
);
// And since a choice now sticks, the list has to hold the way out of one: the
// row carrying the read mark names `read`, not its own hash, or there would be
// nothing to click to stop comparing against a fixed version.
assert.match(
  pageJs,
  /state\.baseline = v\.baseline \? 'read' : `snap:\$\{v\.hash\}`/,
  'the read row is the way back to a baseline that moves',
);
console.log('✓ remembered comparison wired end to end');

// Reading one version by itself is a mode in the History heading. Each half is
// silent when dropped: no switch and it cannot be reached, no render branch and
// the switch lights up over a diff, no tag and an old version passes for the file.
assert.match(pageHtml, /id="histSolo"/, 'the switch is in the History heading');
assert.match(pageJs, /\$\('histSolo'\)\.addEventListener\('click', toggleSolo\)/, 'and wired up');
assert.match(pageJs, /key === 'v'\) toggleSolo\(\)/, 'and reached from `v` too');
assert.match(
  pageJs,
  /renderDocument\(md, soloText\(data\), null\)/,
  'it renders a version plainly',
);
assert.match(pageJs, /if \(state\.solo\) \{/, 'and the marks switch redraws under it');
assert.match(pageJs, /id="soloTag"/, 'the bar names the version on the page');
assert.ok(
  /id="soloTag"[^>]*onClick=\{actions\.unsolo\}/.test(pageJs) &&
    /unsolo: \(\) => setSolo\(false\),/.test(pageJs),
  'and is the way back to the changes',
);
assert.match(pageCss, /\.side-tog\[hidden\]/, 'a switch that sets display still hides');
assert.ok(!pageJs.includes('redline:solo'), 'and a restart never opens on an old version');
console.log('✓ reading one version by itself wired end to end');

// `doc` in the client is the <article>, not a document, and an element has no
// getElementById — the call parses, ships, and throws only once the line runs.
// It cost a contents list, a diagram and an honest change count the last time:
// the throw was inside paintToc, and paint() calls that before it draws either.
assert.ok(
  !/\bdoc\.getElementById\(/.test(pageJs),
  'an element is asked for a node with querySelector, not getElementById',
);
console.log('✓ no element/document confusion in the client');

// --- 2. listen for the live-reload event --------------------------------
const events = [];
const es = await fetch(base + '/events');
const reader = es.body.getReader();
(async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
    }
  }
})();

// --- 3. simulate an AI edit ---------------------------------------------
const edited = fs
  .readFileSync(file, 'utf8')
  .replace('Some text that the AI will rewrite later on.', 'Some text that the AI rewrote, with an extra clause.')
  .replace('A paragraph that will be deleted entirely.\n', '')
  .replace('## Goals', '## Goals\n\nA brand new paragraph inserted by the assistant.');
fs.writeFileSync(file, edited);

await new Promise((r) => setTimeout(r, 600));
assert.ok(events.some((e) => e.type === 'change'), 'change event pushed over SSE');
console.log('✓ live-reload event fired');

// --- 4. paragraph-level diff --------------------------------------------
doc = await get('/api/doc');
assert.deepStrictEqual(doc.stats, { added: 1, removed: 1, modified: 1 }, `stats: ${JSON.stringify(doc.stats)}`);
assert.match(doc.html, /chg chg-add[\s\S]*brand new paragraph/, 'insertion marked added');
assert.match(doc.html, /chg chg-mod[\s\S]*AI/, 'edit marked changed');
assert.match(doc.html, /chg chg-del[\s\S]*deleted entirely/, 'deletion shown');

// the edited paragraph is diffed word by word, in place
const mod = doc.html.slice(doc.html.indexOf('chg-mod'));
assert.match(mod, /<del class="w-del">will rewrite later on\.<\/del>/, 'replaced words struck out');
assert.match(mod, /<ins class="w-add">rewrote, with an extra clause\.<\/ins>/, 'new words marked');
assert.ok(mod.includes('Some text that the AI <del'), 'untouched words left alone');
assert.ok(!mod.includes('chg-before'), 'no before-disclosure when the words are marked in place');
// untouched blocks must stay unmarked
const intro = doc.html.slice(0, doc.html.indexOf('Intro paragraph'));
assert.ok(!intro.includes('chg-'), 'unchanged intro not marked');
console.log('✓ paragraph diff:', doc.stats);

// --- 4a. word-level diff inside a changed block --------------------------
// The marks are injected into rendered HTML, so the main risk is producing
// tags that interleave — `<strong><ins>x</strong>y</ins>` and friends. Every
// case here is checked for balance as well as for what it marked.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function unbalanced(html) {
  const stack = [];
  for (const [, closing, name, selfClosing] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
    // `<path … />` inside the SVG icons closes itself, and XML allows that of
    // any element — it is only HTML's own tags that must be in the void list.
    if (selfClosing || VOID_TAGS.has(name.toLowerCase())) continue;
    if (!closing) stack.push(name);
    else if (stack.pop() !== name) return `</${name}> does not close the open element`;
  }
  return stack.length ? `unclosed <${stack.join('>, <')}>` : null;
}

const mdDiff = createMarkdown();
const { renderDiff } = await import('./src/core/diff.js');
const diffOf = (a, b) => renderDiff(mdDiff, a, b).html;

const inlineCases = [
  {
    name: 'words inside emphasis',
    before: 'The **quick brown fox jumps** over the lazy dog.',
    after: 'The **slow** brown wolf leaps over the lazy dog.',
  },
  { name: 'link text and href', before: 'See [the docs](https://a.example) now.', after: 'See [the guide](https://b.example) now.' },
  { name: 'table cell', before: '| a | b |\n| - | - |\n| one | two |', after: '| a | b |\n| - | - |\n| one | three |' },
  { name: 'list item text', before: '- alpha item\n- beta item', after: '- alpha item\n- gamma item' },
  { name: 'heading', before: '# Old Title Here', after: '# New Title Here' },
  { name: 'inline code', before: 'Call `doThing(1)` to start.', after: 'Call `doThing(2)` to start.' },
  { name: 'code fence body', before: '```js\nconst a = 1;\n```', after: '```js\nconst a = 2;\n```' },
];
for (const c of inlineCases) {
  const html = diffOf(c.before, c.after);
  assert.match(html, /chg chg-mod chg-inline/, `${c.name}: diffed inline`);
  assert.match(html, /class="w-(add|del)"/, `${c.name}: something marked`);
  assert.strictEqual(unbalanced(html), null, `${c.name}: ${unbalanced(html)}`);
}

// A mark must never straddle a tag it does not own.
const emph = diffOf('The **quick brown fox jumps** over the lazy dog.', 'The **slow** brown wolf leaps over the lazy dog.');
assert.ok(!/<(ins|del) class="w-[^"]*">[^<]*<\/strong>/.test(emph), 'mark closed before </strong>');
assert.match(emph, /<strong>[\s\S]*?<\/strong>/, 'emphasis element survived');

// Fallback: a removal that spans block structure has no valid place inline.
const dropped = diffOf('- alpha item\n- beta item\n- gamma item', '- alpha item\n- gamma item');
assert.ok(!dropped.includes('chg-inline'), 'structural removal not inlined');
assert.match(dropped, /chg-before[\s\S]*beta item/, 'structural removal falls back to the before disclosure');

// Fallback: rewritten past recognition reads better as two versions.
const rewritten = diffOf(
  'The deployment pipeline runs on every push to main.',
  'Costs are tracked per team and billed monthly in arrears, yes.',
);
assert.ok(!rewritten.includes('w-add'), 'wholesale rewrite not word-diffed');

// Bridging: an edit either side of one unchanged word is one phrase, not two.
const bridged = diffOf('the red car and blue bike', 'the green car and yellow bike');
assert.strictEqual((bridged.match(/class="w-add"/g) ?? []).length, 1, 'nearby edits merged into one mark');
console.log('✓ word-level diff inside changed blocks');

// The page carries an opened "before" across a rebuild by the key of the block it is in (`paint`
// in public/app.js), so the disclosure has to sit directly in a keyed block, and the key has to be
// the same each time the same change is rendered -- from the same text, with unrelated text moving
// around it.
{
  const keyed = (html) => [...html.matchAll(/data-key="([^"]+)"[^>]*>(?:(?!<div class="chg)[\s\S])*?<details class="chg-before">/g)]
    .map((m) => m[1]);
  const before = '- alpha item\n- beta item\n- gamma item';
  const after = '- alpha item\n- gamma item';
  const first = diffOf(before, after);
  assert.strictEqual(keyed(first).length, 1, 'a "before" is inside a block that has a key');
  assert.deepStrictEqual(keyed(diffOf(before, after)), keyed(first), 'and the same change gets the same key again');
  // The new paragraph goes after the list: a run of removed blocks is paired with the added ones
  // by position, so one added in front would push the list off its partner and it would stop
  // being a "before" at all, which is a different thing to ask about.
  assert.deepStrictEqual(
    keyed(diffOf(`# Moved\n\nIntro.\n\n${before}`, `# Moved\n\nIntro.\n\n${after}\n\nA new closing paragraph.`)),
    keyed(first),
    'even with text added and unchanged text around it',
  );
  console.log('✓ a "before" belongs to a keyed block, and the key survives a rebuild');

  // And that the page does what that is for. Nothing here can run `paint`, so this is the
  // wiring: that a reload of the document on screen can leave the article standing, that
  // nothing else is allowed to, and that a rebuild puts an opened "before" back.
  assert.match(appJs, /paint\(\{ reuse: keepScroll \}\);/, 'a reload of the open document asks to reuse the article');
  assert.strictEqual((appJs.match(/paint\(\{ reuse:/g) ?? []).length, 1,
    'and it is the only caller that does: a theme or tint change has to rebuild the diagrams');
  assert.match(appJs, /const stay = reuse && painted\.id === state\.docId && painted\.source === source;/,
    'it stays only for the same document and the same markup');
  assert.match(appJs, /if \(!stay\) \{[\s\S]*?doc\.innerHTML = sanitizeDocument\(source\);[\s\S]*?painted = \{ id: state\.docId, source \};/,
    'otherwise the article is rebuilt, and what it was built from is remembered');
  assert.match(appJs.match(/function closeDocument\([\s\S]*?\n\}/)?.[0] ?? '', /painted = \{ id: '', source: null \};/,
    'and closing the document forgets it, so the same file opened again is not taken for what is gone');
  assert.match(appJs, /if \(!stay && findOpen\.value\)/,
    'a find is redone only when the nodes it marked were replaced');
  console.log('✓ the page leaves an unchanged article alone on a reload of the same markup');

  // What a rebuild does to what the reader did, which is the other half: it is read off the old
  // nodes, put on the new ones by name, and the names are the text's own.
  const paintFn = appJs.match(/function paint\([\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(paintFn, /const saved = painted\.id === state\.docId \? readKept\(\) : null;/,
    'a rebuild reads what was done to the article on screen, and only to this document\'s');
  assert.match(paintFn, /readKept\(\)[\s\S]*?doc\.innerHTML = sanitizeDocument\(source\);[\s\S]*?if \(saved\?\.size\) writeKept\(saved\);/,
    'before the nodes are replaced, and put back onto the new ones straight after');
  const keptDecl = appJs.match(/const kept = \[[\s\S]*?\n\];/)?.[0] ?? '';
  assert.match(keptDecl, /name: 'details',\s+selector: 'details',/, 'a disclosure is a kind of state kept');
  assert.match(keptDecl, /el\.closest\('\.chg\[data-key\]'\)\?\.dataset\.key/,
    'a "before" is named by its change, the key a check-off already uses');
  assert.match(keptDecl, /el\.querySelector\(':scope > summary'\)/,
    'and an author\'s disclosure by its summary, not by where it is');
  assert.match(keptDecl, /read: \(el\) => el\.open,[\s\S]*?el\.open = open;/, 'and both ways of the state are a property of the element');
  assert.match(appJs, /const nth = seen\.get\(base\) \?\? 0;[\s\S]*?`\$\{kind\.name\}:\$\{base\}#\$\{nth\}`/,
    'elements that say the same are told apart by their order, and kinds cannot be mistaken for each other');
  assert.ok(!/\.chg-before\[open\]|openBefores/.test(appJs), 'nothing reads one kind of disclosure by itself any more');

  // The renderer lets an author's `<details>` through, summary and all, which is what the name is
  // taken from.
  const authored = renderDocument(
    mdPage,
    '# T\n\n<details>\n<summary>FAQ</summary>\n\nAnswer.\n\n</details>\n',
    null,
  ).html;
  assert.match(authored, /<details>\s*<summary>FAQ<\/summary>/, 'an author\'s disclosure arrives with its summary');
  console.log('✓ a rebuild puts back what the reader did to a disclosure, by name');
}

// --- 5. raw view: syntax highlighting + line marks -----------------------
assert.match(doc.rawHtml, /raw-add[\s\S]*brand new paragraph/, 'raw view marks additions');
assert.match(doc.rawHtml, /raw-del/, 'raw view marks removals');
assert.match(doc.rawHtml, /class="hljs-section"/, 'raw view highlights markdown headings');
assert.match(doc.rawHtml, /class="hljs-(bullet|code|string|link)"/, 'raw view highlights other tokens');

// The lines that are not marked removed must reconstruct the file exactly —
// this catches any off-by-one in the line/diff alignment.
function rawLines(html) {
  return [...html.matchAll(/<span class="raw-line([^"]*)"[^>]*>([\s\S]*?)<\/span>\n?(?=<span class="raw-line|<\/pre>)/g)]
    .map(([, cls, body]) => ({
      removed: cls.includes('raw-del'),
      text: body
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&amp;/g, '&'),
    }));
}
const kept = rawLines(doc.rawHtml).filter((l) => !l.removed).map((l) => l.text);
assert.strictEqual(
  kept.join('\n'),
  fs.readFileSync(file, 'utf8'),
  'raw view reproduces the source exactly',
);
assert.ok(
  rawLines(doc.rawHtml).some((l) => l.removed && l.text.includes('deleted entirely')),
  'removed lines still shown in raw view',
);
console.log('✓ raw view: highlighted, line-aligned, marks changes');

// no baseline -> still highlighted, still exact
const plainRaw = (await get('/api/doc?baseline=none')).rawHtml;
assert.match(plainRaw, /class="hljs-section"/, 'raw view highlighted without a baseline');
assert.strictEqual(
  rawLines(plainRaw).map((l) => l.text).join('\n'),
  fs.readFileSync(file, 'utf8'),
  'undiffed raw view reproduces the source exactly',
);
assert.ok(!plainRaw.includes('raw-add') && !plainRaw.includes('raw-del'), 'no marks without a baseline');
console.log('✓ raw view without baseline');

// --- 4b. the same place in both views ------------------------------------
// Switching between the render and the source keeps your place, and the place
// is a line of the file: the raw view is the file's lines and the rendered view
// now says which line each block came from. Neither is any use to the other
// unless the lines are the file's own and they only ever go up — the page finds
// a place by binary search over them (see `sourceAt` in public/app.js).
const linesIn = (html) => [...html.matchAll(/ data-line="(\d+)"/g)].map(([, n]) => +n);
const docLines = linesIn(doc.html);
assert.ok(docLines.length > 5, `every block says where it is: ${docLines}`);
assert.deepStrictEqual(
  docLines,
  [...docLines].sort((a, b) => a - b),
  `and the lines only go up: ${docLines}`,
);
assert.strictEqual(new Set(docLines).size, docLines.length, 'each line claimed once');
// A block that is only in the baseline is not a line of the file, and a "before"
// folded inside a `details` measures as nothing while it is shut: neither is
// somewhere the other view could put you.
for (const [, inside] of doc.html.matchAll(/<div class="chg chg-del"[^>]*>([\s\S]*?)<\/div>/g)) {
  assert.ok(!inside.includes('data-line='), 'a deleted block is nowhere in the file');
}
for (const [, inside] of doc.html.matchAll(/<details class="chg-before">([\s\S]*?)<\/details>/g)) {
  assert.ok(!inside.includes('data-line='), 'and neither is the old copy of a rewrite');
}
{
  // The line named is the line the block starts on, counting from zero.
  const mdLines = createMarkdown();
  const src = '# Title\n\nA first paragraph, plain and simple.\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n\nLast para.\n';
  const at = (tag) =>
    +new RegExp(`<${tag} data-line="(\\d+)"`).exec(renderDocument(mdLines, src, null).html)[1];
  assert.strictEqual(at('h1'), 0, 'the heading is the first line');
  assert.strictEqual(at('ul'), 4, 'the list starts where the list starts');
  assert.strictEqual(at('code'), 7, 'and a fence at its fence');
  // Threaded through the diff too, where each block is rendered on its own and
  // would otherwise believe it starts at line 0.
  const edited = src.replace('plain and simple', 'plain and edited');
  const diffed = renderDiff(mdLines, src, edited).html;
  assert.deepStrictEqual(linesIn(diffed), [0, 2, 4, 7, 11], `diffed blocks keep the file's lines`);
  // The line is on the baseline's copy of a *modified* block as well, and has
  // to be: the word diff runs over the tags, so an attribute on one side only
  // would read as a change at the very first token and the whole paragraph
  // would come out rewritten instead of two words of it.
  assert.match(diffed, /chg-inline/, 'a small edit still reads as a small edit');
}
assert.match(pageJs, /function sourceAt/, 'the page reads its place off as a line');
assert.match(pageJs, /function scrollToSource/, 'and puts it back on the other side');
assert.match(pageJs, /const at = sourceAt\(\);[\s\S]{0,200}scrollToSource\(at\)/, 'across a view switch');
console.log('✓ both views name the same lines');

// --- 5a. the document's own headings -------------------------------------
// One walk of the source gives both the contents list down the side and the ids
// the rendered headings carry, so the two cannot disagree about what is in the
// document or where a link into it lands.
assert.deepStrictEqual(
  doc.toc.map((h) => [h.level, h.text, h.id]),
  [
    [1, 'Project Notes', 'project-notes'],
    [2, 'Goals', 'goals'],
  ],
  `the headings, in order: ${JSON.stringify(doc.toc)}`,
);
const srcLines = fs.readFileSync(file, 'utf8').split('\n');
for (const h of doc.toc) {
  assert.match(doc.html, new RegExp(`<h${h.level} [^>]*id="${h.id}"`), `#${h.id} is on its own heading`);
  // The raw view has no ids to jump to, so a row finds the line instead — and
  // that line had better be the heading it claims.
  assert.match(doc.rawHtml, new RegExp(`data-line="${h.line}"`), `#${h.id} names a line`);
  assert.match(srcLines[h.line], new RegExp(`^#+\\s+${h.text}$`), `line ${h.line} is "${h.text}"`);
}

const { outline, slugify } = await import('./src/core/render.js');
const mdToc = createMarkdown();
assert.strictEqual(slugify('Why *this*, and not That?'), 'why-this-and-not-that', 'GitHub-style slug');
// Two headings with the same words must not share an id, or the second link
// into the document quietly goes to the first one.
const dupes = outline(mdToc, '# Notes\n\n## Notes\n\n### Notes\n');
assert.deepStrictEqual(dupes.map((h) => h.id), ['notes', 'notes-1', 'notes-2'], 'repeats told apart');
assert.deepStrictEqual(dupes.map((h) => h.level), [1, 2, 3], 'each keeps its own level');
assert.strictEqual(outline(mdToc, '# `code` and ![a pic](x.png)\n')[0].text, 'code and a pic', 'a heading reads as words');
assert.strictEqual(outline(mdToc, '# !!!\n')[0].id, 'section', 'a heading with no words still gets an id');

// A heading that exists only in the baseline must not take the id belonging to
// one in the file: the ids are handed to the renderer as a queue, and a removed
// block drawing from it would shift every id after it along by one.
const hadMore = '# Kept\n\nBody.\n\n## Dropped\n\nGone.\n\n## Last\n\nEnd.\n';
const hasLess = '# Kept\n\nBody.\n\n## Last\n\nEnd.\n';
const afterDrop = renderDiff(mdToc, hadMore, hasLess, outline(mdToc, hasLess).map((h) => h.id)).html;
assert.match(afterDrop, /<h1 [^>]*id="kept">/, 'the kept heading keeps its id');
assert.match(afterDrop, /<h2 [^>]*id="last">/, 'and so does the one after the removal');
assert.ok(!/<h2 [^>]*id="[^"]*">Dropped/.test(afterDrop), 'the removed heading takes none');
console.log('✓ contents list + heading anchors');

// --- 5b. checking a change off -------------------------------------------
// Not the same as marking the version read. The read mark says "all of this is
// seen" and moves what everything is measured from; this says "that bit is
// seen", one block at a time, and leaves the rest of what moved still marked.
assert.strictEqual(doc.changes.length, 3, `every marked block is named: ${JSON.stringify(doc.changes)}`);
assert.deepStrictEqual(doc.changes.map((c) => c.kind).sort(), ['add', 'del', 'mod'], 'and says which kind');
assert.deepStrictEqual(doc.acked, [], 'nothing checked off to begin with');
for (const c of doc.changes) {
  assert.ok(doc.html.includes(`data-key="${c.key}"`), `${c.key} is on the block it names`);
}
assert.strictEqual(new Set(doc.changes.map((c) => c.key)).size, 3, 'no two changes share a name');

const oneKey = doc.changes[0].key;
const ackRes = (await (
  await fetch(`${base}/api/ack?key=${oneKey}`, { method: 'POST' })
).json()) as Reply;
assert.deepStrictEqual(ackRes.acked, [oneKey], 'the change is remembered as checked');
// The document is not rebuilt for it: the page has already hidden the mark, and
// it knows what it clicked.
assert.deepStrictEqual(Object.keys(ackRes), ['acked'], 'and nothing else comes back');
assert.deepStrictEqual((await get('/api/doc')).acked, [oneKey], 'and it is read back with the document');
// Still counted, though: a checked change is one, it is just not one you are
// being asked to look at. Subtracting them is the page's business.
assert.deepStrictEqual((await get('/api/doc')).stats, doc.stats, 'the stats are left alone');
// A different baseline is a different set of changes, and marks made against
// one must not be thrown away by looking at the document against another.
assert.deepStrictEqual((await get('/api/doc?baseline=none')).acked, [oneKey], 'kept across baselines');

await fetch(`${base}/api/ack?key=${oneKey}&on=0`, { method: 'POST' });
assert.deepStrictEqual((await get('/api/doc')).acked, [], 'and it can be brought back');
for (const c of doc.changes) await fetch(`${base}/api/ack?key=${c.key}`, { method: 'POST' });
assert.deepStrictEqual((await get('/api/doc')).acked, doc.changes.map((c) => c.key), 'all three, in the order marked');
const clearedAcks = (await (
  await fetch(`${base}/api/ack?clear=1`, { method: 'POST' })
).json()) as Reply;
assert.deepStrictEqual(clearedAcks.acked, [], 'and cleared in one call');
// Naming no change is a mistake, not an empty instruction to carry out.
assert.strictEqual((await fetch(`${base}/api/ack`, { method: 'POST' })).status, 400, 'a change must be named');
console.log('✓ check a change off');

// --- 5b'. a checked-off change becomes that block's own baseline ---------
// Check a block off, have it edited, and what comes back is what moved since
// you checked it — not the whole block replayed against the baseline, which is
// still where everything else is measured from. See docs/changes.md.
{
  const { blockId } = await import('./src/core/diff.js');
  const { hashContent } = await import('./src/core/hash.js');
  const mdAck = createMarkdown();
  const added = (html) => [...html.matchAll(/<ins class="w-add">([\s\S]*?)<\/ins>/g)].map((m) => m[1]);
  const read = 'The release paragraph, written for the team.';
  const now = 'The release paragraph, written for the whole team today.';
  // A version without its `hash`: renderDiff reads only `text` and `blocks` of each (see
  // seenBlocks), and the payload type asks for the hash as well.
  const from = (text) =>
    [{ text: `# Doc\n\n${text}\n`, blocks: [blockId(text)] }] as AckedVersion[];

  // An addition, checked off and then edited: changed, and only the new words.
  const sinceAdd = renderDiff(mdAck, '# Doc\n', `# Doc\n\n${now}\n`, [], { from: from(read) });
  assert.deepStrictEqual(sinceAdd.stats, { added: 0, removed: 0, modified: 1 }, 'counted as ~, which is what is drawn');
  assert.match(sinceAdd.html, /data-chg="mod"[^>]*>[\s\S]*chg-inline|chg-inline[^>]*data-chg="mod"/, 'and drawn inline');
  assert.ok(added(sinceAdd.html).join(' ').includes('whole'), 'the new words are marked');
  assert.ok(!added(sinceAdd.html).join(' ').includes('release'), 'and the words already read are not');
  assert.strictEqual(sinceAdd.changes[0].block, blockId(now), 'and the change names its block for the next check-off');

  // A change, checked off and edited again: the newest edit, not the first one.
  const was = 'The release paragraph, written for a team.';
  const sinceMod = renderDiff(mdAck, `# Doc\n\n${was}\n`, `# Doc\n\n${now}\n`, [], { from: from(read) });
  const removed = (html) => [...html.matchAll(/<del class="w-del">([\s\S]*?)<\/del>/g)].map((m) => m[1]);
  assert.deepStrictEqual(removed(sinceMod.html), ['team.'], 'the edit already checked is not replayed');
  assert.ok(added(sinceMod.html).join(' ').includes('whole'), 'the one since is shown');

  // Without the version the check-off was made in, nothing to diff against:
  // plain "added", as before, and no throw.
  const orphan = renderDiff(mdAck, '# Doc\n', `# Doc\n\n${now}\n`, [], { from: [] });
  assert.deepStrictEqual(orphan.stats, { added: 1, removed: 0, modified: 0 }, 'an orphaned check-off degrades to added');

  // A block checked off as it stands is still what was read, and must not be
  // claimed by some other check-off that has lapsed and happens to resemble it.
  const asIs = renderDiff(mdAck, '# Doc\n', `# Doc\n\n${now}\n`, [], {
    keys: ['add' + hashContent(now).slice(0, 10)],
    from: from(read),
  });
  assert.match(asIs.html, /data-chg="add"/, 'a block still checked as it stands stays an addition');
  assert.strictEqual(asIs.changes[0].key, 'add' + hashContent(now).slice(0, 10), 'under the key it was checked as');

  // A baseline edit closer to the file than any check-off is a baseline edit.
  const tenMin = 'The cache is flushed every ten minutes by the worker.';
  const fiveMin = 'The cache is flushed every five minutes by the worker.';
  const other = 'The cache is warmed once on boot by the worker process.';
  const unrelated = renderDiff(mdAck, `# Doc\n\n${tenMin}\n`, `# Doc\n\n${fiveMin}\n`, [], { from: from(other) });
  assert.ok(unrelated.html.includes('w-del">ten<'), 'a resembling check-off does not displace the baseline');

  // The same, end to end: a real store, a real reader, the file moving under it.
  const { createReader } = await import('./src/reader/reader.js');
  const { DocStore } = await import('./src/reader/store.js');
  const ackFile = path.join(tmp, 'acked.md');
  fs.writeFileSync(ackFile, '# Doc\n');
  const reader = await createReader({ platform: nodePlatform });
  const id = await reader.retain(ackFile);
  const edit = (text) =>
    new Promise<void>((resolve) => {
      const stop = reader.subscribe(id, (e) => e.type === 'change' && (stop(), resolve()));
      fs.writeFileSync(ackFile, text);
    });
  const show = async () => render(await reader.doc(id, 'read'));
  const check = (d, c) => reader.ack(id, { key: c.key, at: d.hash, block: c.block });
  const objects = path.join(process.env.REDLINE_HOME, 'objects');

  await edit(`# Doc\n\n${read}\n`);
  const v1 = await show();
  assert.deepStrictEqual(v1.stats, { added: 1, removed: 0, modified: 0 }, 'an addition to begin with');
  await check(v1, v1.changes[0]);

  await edit(`# Doc\n\n${now}\n`);
  const v2 = await show();
  assert.deepStrictEqual(v2.ackedFrom.map((v) => v.hash), [v1.hash], 'the version it was checked in travels with the document');
  assert.deepStrictEqual(v2.stats, { added: 0, removed: 0, modified: 1 }, 'checked, edited: changed, not added');
  assert.ok(!added(v2.html).join(' ').includes('release'), 'showing only what moved since');

  // An object that has gone — a store from before gc knew about check-offs, a
  // hand tidy — is a check-off with nothing to read back.
  const v1Object = path.join(objects, v1.hash + '.md');
  fs.renameSync(v1Object, v1Object + '.away');
  const gone = await show();
  assert.deepStrictEqual(gone.ackedFrom, [], 'an unreadable version is left out quietly');
  assert.deepStrictEqual(gone.stats, { added: 1, removed: 0, modified: 0 }, 'and the block is plain added again');
  fs.renameSync(v1Object + '.away', v1Object);

  await check(v2, v2.changes[0]);
  const later = `# Doc\n\n${now.replace('today.', 'today, before Friday.')}\n`;
  await edit(later);
  const v3 = await show();
  assert.deepStrictEqual(v3.stats, { added: 0, removed: 0, modified: 1 }, 'checked again, edited again: still changed');
  assert.ok(added(v3.html).join(' ').includes('Friday'), 'with the newest words marked');
  assert.ok(!added(v3.html).join(' ').includes('whole'), 'and not the ones checked last time');

  // Forgetting the version a check-off was made in is tidying the list; the
  // object behind it stays, or the feature stops working for whoever tidies.
  const v0 = v1.history.find((h) => !h.current);
  // Past the grace period gc gives a young object, or there would be nothing to sweep.
  const aged = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(objects, v0.hash + '.md'), aged, aged);
  await reader.prune(id, v1.hash, 'read');
  assert.ok(!fs.existsSync(path.join(objects, v0.hash + '.md')), 'gc ran');
  assert.ok(fs.existsSync(v1Object), 'and kept the version a check-off reads back from');

  // "All of this is seen" subsumes every "that bit is seen".
  const marked = render(await reader.markRead(id));
  assert.deepStrictEqual([marked.acked, marked.ackedFrom], [[], []], 'marking read clears the check-offs');

  // An older version is "I have read up to here", which says nothing about what
  // came after it: the mark goes back to it, and a check-off on a change made
  // since is still a check-off.
  await edit(`${later}\nA line written after the read, and then checked off.\n`);
  const v5 = await show();
  await check(v5, v5.changes[0]);
  assert.ok(!v5.history.find((h) => h.hash === v2.hash)?.baseline, 'v2 is an older version, not the one read');
  const upTo = render(await reader.markRead(id, v2.hash));
  assert.strictEqual(upTo.history.find((h) => h.baseline)?.hash, v2.hash, 'the read mark moves to the version named');
  assert.strictEqual(upTo.base, `# Doc\n\n${now}\n`, 'and the marks are measured from it');
  assert.deepStrictEqual(upTo.acked, [v5.changes[0].key], 'with the check-off made since kept');
  // A row drawn before another window forgot its version: nothing moves, and
  // the list that comes back says why.
  const stale = render(await reader.markRead(id, 'f'.repeat(16)));
  assert.strictEqual(stale.history.find((h) => h.baseline)?.hash, v2.hash, 'a version not in the history moves nothing');
  assert.deepStrictEqual(stale.acked, upTo.acked, 'and clears nothing');
  // Naming the version on disk is the plain mark-read, check-offs and all.
  const named = render(await reader.markRead(id, v5.hash));
  assert.ok(named.history.find((h) => h.baseline)?.current, 'the version on disk, named, is marked read');
  assert.deepStrictEqual(named.acked, [], 'and takes the check-offs with it, as it always has');
  reader.closeAll();

  // Check-offs written before they carried a version are kept, as keys.
  // Written to the index itself, as an older version of the app left it: a change is applied to
  // the index on disk, so poking the store's memory would be undone by the next one.
  const legacyPath = path.join(tmp, 'legacy.md');
  const seed = await DocStore.open(legacyPath, nodePlatform);
  fs.writeFileSync(
    seed.file,
    JSON.stringify({ path: legacyPath, history: [], baseline: null, acked: ['addold0000001', 'mod0000000002'] }),
  );
  const legacy = await DocStore.open(legacyPath, nodePlatform);
  assert.deepStrictEqual(legacy.acked, ['addold0000001', 'mod0000000002'], 'bare string acks still read');
  assert.deepStrictEqual(legacy.ackRecords, [{ key: 'addold0000001' }, { key: 'mod0000000002' }], 'as records with no version');
  await legacy.record('# Legacy\n');
  const held = legacy.latest.hash;
  await legacy.setAcked('addnew0000003', true, { at: held, block: 'abcdef0123' });
  await legacy.setAcked('addbad0000004', true, { at: '../../../etc/passwd', block: 'abcdef0123' });
  assert.deepStrictEqual(
    legacy.ackRecords,
    [
      { key: 'addold0000001' },
      { key: 'mod0000000002' },
      { key: 'addnew0000003', at: held, block: 'abcdef0123' },
      { key: 'addbad0000004' },
    ],
    'old ones survive a new check-off, and a version that is not one of ours is not kept',
  );
}
const serverJsSrc = fs.readFileSync(rootUrl('src/hosts/node/server.ts'), 'utf8');
assert.match(serverJsSrc, /at: param\('at'\)/, 'the server passes the version a change was checked in');
assert.match(pageJs, /backend\.ack\(\{ key, on, at: state\.data\?\.hash, block \}\)/, 'and the page sends it');
assert.match(pageJs, /from: data\.ackedFrom/, 'and renders against what came back');
console.log('✓ a checked-off change becomes that block\'s own baseline');

// A reader on a platform with no `spawn` -- nothing but a map of files. Nothing here may throw
// for want of git, PlantUML or a font list; the payload says what is missing instead.
{
  const { createReader } = await import('./src/reader/reader.js');
  const pp = makePaths('/');
  const files = new Map();
  const dirs = new Set(['/']);
  let clock = 1;
  const under = (dir) => (dir.endsWith('/') ? dir : dir + '/');
  const memory = {
    readText: async (p) => files.get(p)?.text ?? null,
    writeText: async (p, text) => void files.set(p, { text, mtime: clock++ }),
    mkdirp: async (p) => void dirs.add(p),
    readDir: async (p) => [
      ...new Set(
        [...files.keys(), ...dirs]
          .filter((k) => k.startsWith(under(p)) && k !== p)
          .map((k) => k.slice(under(p).length).split('/')[0]),
      ),
    ],
    remove: async (p) => void files.delete(p),
    rename: async (from, to) => {
      if (!files.has(from)) return false;
      files.set(to, files.get(from));
      files.delete(from);
      return true;
    },
    exists: async (p) => files.has(p) || dirs.has(p),
    modified: async (p) => files.get(p)?.mtime ?? null,
    // The poll is what notices a change here; there is nothing to watch.
    watch: async () => () => {},
    homeDir: async () => '/home/me',
    env: (name) => ({ REDLINE_HOME: '/store' })[name],
    os: 'linux',
    ...pp,
  };
  assert.ok(!('spawn' in memory), 'a platform with no spawn at all, not one that throws');

  const doc = '/home/me/notes/a.md';
  files.set(doc, { text: '# Notes\n\nFirst.\n', mtime: clock++ });
  const mem = await createReader({ platform: memory, pollMs: 20 });
  const memId = await mem.retain(doc);
  const first = await mem.doc(memId, 'last:read');
  assert.deepStrictEqual(first.caps, { git: false, plantuml: false }, 'caps say what this host lacks');
  assert.strictEqual(first.tracked, false, 'no file is in a repo');
  assert.strictEqual(first.pathLabel, '~/notes/a.md', 'and the default label still shortens home');
  assert.deepStrictEqual(await mem.fonts(), [], 'no font list');
  assert.ok(
    ((await mem.plantumlSvg('A -> B')) as { error: string }).error,
    'a diagram says why it did not draw',
  );

  const changed = new Promise<void>((resolve) => {
    const stop = mem.subscribe(memId, (e) => e.type === 'change' && (stop(), resolve()));
  });
  await memory.writeText(doc, '# Notes\n\nFirst.\n\nSecond.\n');
  await changed;
  const second = render(await mem.doc(memId, 'read'));
  assert.deepStrictEqual(second.stats, { added: 1, removed: 0, modified: 0 }, 'it diffs');
  assert.strictEqual(second.history.length, 2, 'and keeps both versions');
  const oldest = second.history.find((h) => !h.current);
  const pruned = await mem.prune(memId, oldest.hash, 'read');
  assert.strictEqual(pruned.removed, 1, 'it prunes');
  assert.strictEqual(pruned.history.length, 1, 'down to the version on disk');
  mem.closeAll();

  // The providers are what a host brings: its own, or none.
  const calls = [];
  const custom = await createReader({
    platform: memory,
    git: { ...NO_GIT, info: async (p) => (calls.push(p), { root: '/', relPath: 'a.md' }) },
    plantuml: false,
    fonts: async () => ['Serif'],
    label: (abs) => ({ dirLabel: 'D', pathLabel: abs.split('/').at(-1) }),
  });
  const customId = await custom.retain(doc);
  const shown = await custom.doc(customId, 'last:read');
  assert.deepStrictEqual(calls, [doc], 'a provider is asked, not the default');
  assert.deepStrictEqual(shown.caps, { git: true, plantuml: false }, 'and it is what caps report');
  assert.deepStrictEqual([shown.dirLabel, shown.pathLabel], ['D', 'a.md'], 'the label is the host\'s');
  assert.deepStrictEqual(await custom.fonts(), ['Serif'], 'so are the fonts');
  custom.closeAll();
}
console.log('✓ a reader with no spawn opens, diffs and prunes, and says what it lacks');

// --- 5c. the `---` header block ------------------------------------------
// Front matter, which markdown-it has no idea about: left to it, the opening
// `---` is a thematic break and the closing one turns everything above it into
// a setext heading, so the whole header lands as one enormous `<h2>` — and that
// `<h2>` then takes the top row of the contents list. Read as a block instead,
// it is a card of fields, it contributes no heading, and it is one unit to the
// diff like any other block.
const { parseFrontMatter, looksLikeFrontMatter } = await import('./src/core/front-matter.js');
const hdr = path.join(tmp, 'header.md');
fs.writeFileSync(
  hdr,
  '---\n' +
    'name: kdoc-conventions\n' +
    'description: "Mandatory KDoc conventions. MUST be applied when writing Kotlin."\n' +
    'allowed-tools: Skill(kotlin-conventions) Skill(ste-style)\n' +
    '---\n\n# KDoc conventions\n\nBody paragraph.\n',
);
const fmServer = await createServer({ file: hdr });
await new Promise<void>((r) => fmServer.server.listen(0, '127.0.0.1', r));
const fmDoc = await clientFor(`http://127.0.0.1:${portOf(fmServer.server)}`)('/api/doc');
assert.match(fmDoc.html, /<div class="front-matter" data-line="0">/, 'the header renders as a card');
assert.match(fmDoc.html, /<dt>allowed-tools<\/dt><dd>Skill\(kotlin-conventions\)/, 'field by field');
// The one that was actually broken, and the reason this is worth a block rule.
assert.deepStrictEqual(
  fmDoc.toc.map((h) => h.text),
  ['KDoc conventions'],
  `the header is not a heading: ${JSON.stringify(fmDoc.toc)}`,
);
assert.ok(!/<h2/.test(fmDoc.html), 'and nothing of it is set as one');
// `data-line` on it, like every other top-level block, or switching to the raw
// view from the top of the document has nowhere to land.
assert.match(fmDoc.rawHtml, /data-line="0"[^>]*>---/, 'and the raw view still shows it as lines');
fmServer.server.close();

const mdFm = createMarkdown();
const fmHtml = (src) => renderDocument(mdFm, src, null).html;
// `---`, a line of prose, `---` is valid markdown for an `<h2>` and has to keep
// meaning that, so a header block is only one when its first line is a field.
assert.match(fmHtml('---\nSome text\n---\n'), /<h2[^>]*>Some text<\/h2>/, 'a setext heading survives');
assert.ok(!fmHtml('# T\n\npara\n\n---\n\nmore\n').includes('front-matter'), 'so does a plain rule');
assert.ok(!fmHtml('---\nname: x\n\n# T\n').includes('front-matter'), 'an unclosed fence is not a header');
assert.match(fmHtml('---\nname: x\n...\n'), /front-matter/, 'but `...` closes one');
// Values are shown, never rendered: this is what a tool consuming the file will
// be handed, and markdown eating a pair of underscores would misreport it.
assert.match(fmHtml('---\nname: <b>x</b>_y_\n---\n'), /&lt;b&gt;x&lt;\/b&gt;_y_/, 'a value is text');
// A value edited in place is a word diff inside that one field — the reason the
// header is a token in the parse rather than something stripped off before it.
const fmEdit = renderDiff(
  mdFm,
  '---\nname: a\ndescription: old wording\n---\n\n# T\n',
  '---\nname: a\ndescription: new wording\n---\n\n# T\n',
  ['t'],
);
assert.strictEqual(fmEdit.stats.modified, 1, 'an edited header is one changed block');
assert.match(fmEdit.html, /<dd><del class="w-del">old<\/del>/, 'and the wording is marked in its field');
assert.match(fmEdit.html, /<dt>name<\/dt><dd>a<\/dd>/, 'while the fields that held still are plain');

// The shapes a header is written in. Not a YAML implementation — nothing here
// is coerced or resolved — but these are what the format is used for, and a
// line it cannot make a field of is kept as written rather than dropped.
const rows = (body) => parseFrontMatter(body).map((r) => [r.key, r.value]);
assert.deepStrictEqual(rows('tags: [a, "b c"]'), [['tags', { kind: 'list', items: ['a', 'b c'] }]]);
assert.deepStrictEqual(rows('t:\n- x\n- y'), [['t', { kind: 'list', items: ['x', 'y'] }]], 'a sequence may sit at its key\'s indent');
assert.deepStrictEqual(rows('t:\n  - x'), [['t', { kind: 'list', items: ['x'] }]], 'or under it');
assert.deepStrictEqual(
  rows('a:\n  b: 1'),
  [['a', { kind: 'map', rows: [{ key: 'b', value: { kind: 'text', text: '1' } }] }]],
  'a nested mapping stays nested',
);
assert.deepStrictEqual(rows('s: |\n  one\n  two'), [['s', { kind: 'text', text: 'one\ntwo', pre: true }]], '`|` keeps its breaks');
assert.deepStrictEqual(rows('s: >\n  one\n  two'), [['s', { kind: 'text', text: 'one two', pre: false }]], '`>` folds them');
assert.deepStrictEqual(rows('u: https://x.test/a'), [['u', { kind: 'text', text: 'https://x.test/a' }]], 'the first colon ends the key');
assert.deepStrictEqual(rows('n: "he said: hi"'), [['n', { kind: 'text', text: 'he said: hi' }]], 'and quotes come off');
assert.deepStrictEqual(rows('# c\nn: x'), [['n', { kind: 'text', text: 'x' }]], 'comments are structure');
assert.deepStrictEqual(rows('n: x # why'), [['n', { kind: 'text', text: 'x' }]], 'including trailing ones');
assert.deepStrictEqual(rows('n: x\nloose line\nk: y').map((r) => r[0]), ['n', null, 'k'], 'an unreadable line is kept');
assert.ok(!looksLikeFrontMatter(parseFrontMatter('just prose')), 'prose is not a header');
assert.ok(!looksLikeFrontMatter(parseFrontMatter('')), 'and neither is nothing');

// A header that names the document is what the bar calls it. `SKILL.md` is the
// convention the tool reading the file insists on, not what the document is,
// and three windows of them are three windows with the same title.
assert.strictEqual(fmDoc.title, 'kdoc-conventions', 'a header names the document');
assert.strictEqual(
  fmDoc.pathLabel,
  `${fmDoc.dirLabel}/${fmDoc.name}`,
  'and the file is named in the path instead, which is why the path carries it',
);
const titleOf = (src) => renderDocument(mdFm, src, null).title;
assert.strictEqual(titleOf('---\ntitle: T\nname: N\n---\n'), 'T', '`title` wins over `name`');
assert.strictEqual(titleOf('---\nname: N\ntitle: T\n---\n'), 'T', 'wherever the two sit');
// The three ways a `title:` is not one. The parse is the gate for the first,
// which is the point of taking this off the token rather than off the text: a
// setext heading shows no card, so it must give no title either.
assert.strictEqual(titleOf('---\ntitle: T\n'), '', 'an unclosed fence is not a header');
assert.strictEqual(titleOf('---\nSome prose\n---\n'), '', 'nor is a setext heading');
assert.strictEqual(titleOf('---\nouter:\n  title: T\n---\n'), '', 'a nested title is not it');
assert.strictEqual(titleOf('---\ntitle: |\n  one\n  two\n---\n'), '', 'nor is a block value');

// Failing a header, a document with exactly one `# ` is named by it -- a README
// or a design note, where the heading and the file are about the same thing.
// The count is the whole of the evidence: several are a document of equal
// parts, whose first heading is a section that happens to be at the top, and
// naming the document by it would be picking a chapter's name for the book.
assert.strictEqual(titleOf('# Only One\n\ntext\n'), 'Only One', 'a lone h1 names the document');
assert.strictEqual(titleOf('# A\n\n## B\n\n### C\n'), 'A', 'whatever sits under it');
assert.strictEqual(titleOf('# A\n\ntext\n\n# B\n'), '', 'but two h1s name neither');
assert.strictEqual(titleOf('## B\n\ntext\n'), '', 'and a document with none is unnamed');
assert.strictEqual(titleOf('text\n'), '', 'as is one with no headings at all');
assert.strictEqual(titleOf('# `code` and *em*\n'), 'code and em', 'as text, not as markup');
assert.strictEqual(titleOf('---\ntitle: T\n---\n\n# H\n'), 'T', 'a header outranks the heading');
assert.strictEqual(titleOf('---\nd: x\n---\n\n# H\n'), 'H', 'a header that names nothing does not');

// And the bar uses it. Both halves, because a title with the filename still
// only in the tooltip would have thrown the name away, and a filename behind
// both halves of an untitled document's bar would say it twice.
assert.ok(pageJs.includes('d.title || d.name'), 'the bar prefers the title it was given');
assert.ok(
  pageJs.includes('d.title ? d.pathLabel : d.dirLabel'),
  'and the path behind it takes the filename on, but only then',
);

// The path sits behind the name rather than under it now, so the bar is one
// line at rest and hovering is what asks "where is this" -- a swap in place,
// not a second line that is there whether anyone looks at it or not.
assert.match(pageCss, /\.name-dir \{[^}]*position: absolute/, 'the path overlays the name');
assert.match(pageCss, /\.name-dir \{[^}]*opacity: 0/, 'and starts out hidden behind it');
assert.ok(pageCss.includes('.name:hover .name-file'), 'pointing at it fades the name');
assert.ok(pageCss.includes('.name:hover .name-dir'), 'and brings the path forward in its place');
// Not when there is no path to bring forward -- nothing open, or a file granted by itself in the
// web app -- where the swap would empty the bar under the pointer. The mark is worked out from the
// path in the render that draws it, so nothing can set the one and leave the other as it was.
assert.match(pageCss, /\.name\.no-path:hover \.name-file \{\s*opacity: 1;/,
  'a box with no path keeps its name');
assert.match(appJs, /barName = signal\(\{ name: '…', dir: '', path: '' \}\)/,
  'which it has none of to start');
assert.ok(
  /id="nameBox" class=\{dir \? 'name' : 'name no-path'\}/.test(appJs) &&
    !/\$\('(nameBox|nameDir|name)'\)/.test(appJs),
  'and is marked as it is drawn, by the one component that draws it',
);
assert.match(appJs, /mountName\(\$\('nameSlot'\)\);/, 'which is mounted on the bar');

// `.name` grows to fill the bar's spare width, so a button placed after it in
// the markup sits wherever that grown box happens to end, not next to the
// (short, left-aligned) title it hangs off -- empty space the whole way
// there. Before it, the chevron is at a fixed point by the dot and the gap
// never opens.
assert.ok(
  pageHtml.indexOf('id="tabMenuSlot"') > 0 &&
    pageHtml.indexOf('id="tabMenuSlot"') < pageHtml.indexOf('id="nameSlot"'),
  'the all-open-files chevron sits before the name, not adrift after it',
);

// The bar's moving parts, the open files and the chevron's menu are Preact components
// (public/app/ui/), mounted into empty slots that lay out as if the slot were not there; the
// bar's fixed buttons stay markup, so they are drawn on the first frame, and follow signals.
assert.match(pageCss, /\.slot \{\s*display: contents;/, 'a slot is no box of its own');
for (const [slot, mount] of [
  ['tabMenuSlot', /mountTabMenu\(\$\('tabMenuSlot'\), \$\('tabListSlot'\), \{/],
  ['nameSlot', /mountName\(\$\('nameSlot'\)\)/],
  ['changesSlot', /mountChanges\(\$\('changesSlot'\), \{/],
  ['tabListSlot', /mountTabMenu\(\$\('tabMenuSlot'\), \$\('tabListSlot'\)/],
] as const) {
  assert.match(pageHtml, new RegExp(`<(span|div) id="${slot}" class="slot"></\\1>`), `${slot} is empty`);
  assert.match(appJs, mount, `and ${slot} is drawn into`);
}
for (const id of ['tabMenu', 'nameBox', 'soloTag', 'count', 'ackCount', 'prev', 'next', 'divide',
  'tabList']) {
  assert.ok(!pageHtml.includes(`id="${id}"`), `#${id} is drawn by its component, not the markup`);
  assert.match(appJs, new RegExp(`id="${id}"`), `and is drawn by one`);
}
// `.bar` has a backdrop-filter, which makes it the containing block of a fixed child: the menu
// drawn inside it would be placed against the bar, so its slot is after the header.
assert.ok(
  pageHtml.indexOf('id="tabListSlot"') > pageHtml.indexOf('</header>'),
  'the chevron\'s menu is drawn outside the bar',
);
assert.match(pageCss, /\.bar \{[^}]*backdrop-filter/, 'which is the reason');
assert.match(appJs, /mountFiles\(\$\('fileList'\), \{ select: selectTab, close: closeTab \}\);/,
  'the sidebar\'s rows are drawn by Files, and pick and close through the host');
assert.match(appJs, /class=\{on \? 'tab on' : 'tab'\}/, 'with the current file lit');
assert.match(appJs, /const on = t\.id === state\.docId;/, 'which is the document on screen');
assert.match(appJs, /onAuxClick=\{\(e\) => e\.button === 1 && actions\.close\(t\.id\)\}/,
  'and the middle button closes a row');
assert.match(appJs, /const shown = \(\) => !state\.side && state\.tabs\.length > 1;/,
  'the chevron is there with the sidebar shut and more than one file open');
assert.match(appJs, /effect\(\(\) => \{\s+if \(!shown\(\)\) tabMenuAt\.value = null;/,
  'and its menu is shut with it, so the chevron coming back does not bring it back open');
assert.match(appJs, /e\.key === 'Escape' && closeTabMenu\(\)/, 'Escape shuts it too');
assert.ok(
  !/function paintTabs|tabsFor|\$\('(fileList|tabList)'\)\.replaceChildren/.test(appJs),
  'and nothing outside them redraws the rows Preact owns',
);
assert.ok(
  /tabMenuAt\.value = left;/.test(appJs) &&
    /function closeTabMenu\(\) \{\s+tabMenuAt\.value = null;\s+\}/.test(appJs) &&
    /document\.addEventListener\('click', \(\) => closeTabMenu\(\)\);/.test(appJs),
  'the menu opens at the chevron and shuts on any click elsewhere',
);
// The fixed chrome: one effect each, and nothing else writing the attribute it keeps.
assert.match(appJs, /bindChrome\(\);/, 'the bar\'s buttons are bound to their signals');
for (const [what, re] of [
  ['the view', /press\(view, raw, raw \? 'Show rendered \(r\)' : 'Show raw source \(r\)'\)/],
  ['the sidebar', /press\(\$\('side'\), state\.side,/],
  ['the contents', /press\(\$\('tocBtn'\), state\.tocSide,/],
  ['find', /\$\('findBar'\)\.hidden = !findOpen\.value;/],
  ['the dot', /live\.classList\.toggle\('off', why !== null\);/],
  ['the disclosures', /const folded = shut\.value\.includes\(twist\.dataset\.shut\);/],
] as const) {
  assert.match(appJs, re, `${what} follows its signal`);
}
{
  // main.ts and the viewmodels: everything that is not the effect keeping the attribute.
  const main = ['main.ts', ...fs.readdirSync(rootUrl('public/app/vm/')).map((f) => `vm/${f}`)]
    .map((f) => fs.readFileSync(rootUrl(`public/app/${f}`), 'utf8'))
    .join('\n');
  assert.ok(
    !/\$\('(side|tocBtn|view|find|live)'\)\.(setAttribute|title|classList)/.test(main) &&
      !/\$\('findBar'\)\.hidden =/.test(main) &&
      /function setLive\(on, why\?\) \{\s+liveWhy\.value = on \? null : why;/.test(main),
    'and nothing else sets them',
  );
}
assert.match(appJs, /tally\.value = \{[\s\S]*?nav: changeNodes\(\)\.length,/,
  'the count is worked out by paintCount, the reachable changes counted off the page');
assert.match(appJs, /const v = soloVersion\(state\.data\);\s*return v \? versionName\(v\) : null;/,
  'and the version being read is worked out of the document held');

// Wiring. The card is a `dl`, and github-markdown-css styles `dl dt` with two
// type selectors — so every rule here has to carry `.markdown-body` or it is
// the lighter rule and silently loses, leaving italic labels with 16px of air
// above each. Exactly the trap this stylesheet keeps falling into.
assert.ok(pageCss.includes('.markdown-body .front-matter dt'), 'the labels are styled, off two classes');
assert.ok(pageCss.includes('.markdown-body .front-matter dl'), 'and the pairs are laid out as a grid');
assert.ok(pageCss.includes('.fm-pre') && pageCss.includes('.fm-raw'), 'and so are the two odd values');
// Mono, and off `--font-mono` rather than `--doc-font`: a header is machine-facing
// text, and a custom document font must not drag it around — the same opt-out the
// tooling labels take.
assert.match(
  pageCss.slice(pageCss.indexOf('.markdown-body .front-matter {')),
  /^[^}]*font-family:\s*var\(--font-mono\)/,
  'the card is set in mono, independent of the document font',
);
console.log('✓ the `---` header block reads as fields');

// --- 6. what can be compared against -------------------------------------
// One list, not two. The versions are the history; "last read" and "nothing"
// are not rows of their own but a mark on a row and the absence of a
// comparison, so the payload has no second, toolbar-sized list to disagree
// with it.
assert.ok(!('options' in doc), 'no shortlist of versions for a toolbar');
assert.ok(doc.history.some((h) => h.current), 'the version on disk is in the list');
assert.ok(doc.history.some((h) => h.baseline), 'so is the one counted as read');
assert.strictEqual((await get('/api/doc?baseline=read')).baseline, 'read', '"last read" honoured');
const none = await get('/api/doc?baseline=none');
assert.deepStrictEqual(none.stats, { added: 0, removed: 0, modified: 0 }, 'baseline=none disables diff');
console.log('✓ the history is the whole list', doc.history.length, 'versions');

// --- 7. mark read resets the baseline ------------------------------------
const marked = await postDoc('/api/mark-read');
assert.deepStrictEqual(marked.stats, { added: 0, removed: 0, modified: 0 }, 'mark-read clears changes');
// The read mark moves to the newest row, which is how the list shows it: the
// `read` chip is the only thing that says where the mark ended up.
assert.ok(marked.history.find((h) => h.baseline)?.current, 'the read mark lands on the newest version');
assert.ok(!('canUndoRead' in marked), 'and the payload no longer offers to take it back');
const older = doc.history.find((h) => !h.current);
if (older) {
  const back = await get('/api/doc?baseline=snap:' + older.hash);
  assert.ok(back.stats.added + back.stats.modified + back.stats.removed > 0, 'older snapshot still diffable');
  // The server says which version it compared against, and the list highlights
  // that row — there is nowhere else for it to be shown.
  assert.strictEqual(back.baseline, 'snap:' + older.hash, 'and it says which one it used');
  console.log('✓ older snapshot still comparable', back.stats);
}
console.log('✓ mark read');

// --- 7a. ...and the way back is the list, not an undo ---------------------
// Marking read moves a pointer; the version it came off is still in the list
// and still comparable, which is the whole reason there is no undo. Asking for
// it by hash has to give back exactly what the undo used to.
if (older) {
  const back = await get('/api/doc?baseline=snap:' + older.hash);
  assert.deepStrictEqual(back.stats, doc.stats, 'the version marked read off is still comparable');
}
// Marking read twice over is a no-op rather than an error, since the key does
// not know what the list knows.
await fetch(base + '/api/mark-read', { method: 'POST' });
assert.deepStrictEqual(
  (await get('/api/doc')).stats,
  { added: 0, removed: 0, modified: 0 },
  'marking read again still works',
);
// Any row can be marked read from its menu, and an older one is "read up to
// here": the mark goes back to it, and the version on disk is one more away.
if (older) {
  const upTo = await postDoc('/api/mark-read?at=' + older.hash);
  assert.strictEqual(upTo.history.find((h) => h.baseline)?.hash, older.hash, 'mark-read?at= moves the mark there');
  assert.deepStrictEqual(upTo.stats, doc.stats, 'and the marks are what changed since it');
  const again = await postDoc('/api/mark-read');
  assert.ok(again.history.find((h) => h.baseline)?.current, 'and without it, back to the version on disk');
}
// Nothing is kept for an undo that no longer exists, including in a store
// written by a version that had one.
const indexDir = path.join(process.env.REDLINE_HOME, 'docs');
for (const name of fs.readdirSync(indexDir)) {
  const idx = JSON.parse(fs.readFileSync(path.join(indexDir, name), 'utf8'));
  assert.ok(!('prevBaseline' in idx), 'and the store keeps no pointer for it');
}
console.log('✓ the version marked read off is one click away');

// --- 8. snapshots survive a restart ---------------------------------------
server.close();
await reader.cancel().catch(() => {});
fs.appendFileSync(file, '\nA late addition after restart.\n');
const second = await createServer({ file });
await new Promise<void>((r) => second.server.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${portOf(second.server)}`;
const get2 = clientFor(base2);
const after = await get2('/api/doc');
assert.strictEqual(after.stats.added, 1, `restart diff vs stored baseline: ${JSON.stringify(after.stats)}`);
console.log('✓ baseline persisted across restarts');

// --- 9. compare against an arbitrary earlier snapshot ---------------------
// The versions live in the sidebar list, not in the toolbar dropdown: a history
// gets long, and a one-line bar has no room to say which version is which.
const snaps = after.history.filter((h) => !h.current);
assert.ok(snaps.length >= 1, `older versions listed: ${JSON.stringify(after.history.map((h) => h.hash))}`);
assert.ok(snaps.every((h) => typeof h.ts === 'number'), 'versions carry a timestamp for labelling');
assert.ok(after.history.some((h) => h.current), 'the version on disk is marked');
assert.ok(after.history.some((h) => h.baseline), 'the version counted as read is marked');

// The oldest snapshot is the original file, so diffing against it must report
// strictly more changes than diffing against the more recent baseline.
const oldest = snaps.at(-1);
const vsOldest = await get2('/api/doc?baseline=snap:' + oldest.hash);
const total = (s) => s.added + s.removed + s.modified;
assert.ok(
  total(vsOldest.stats) > total(after.stats),
  `oldest snapshot shows more changes: ${JSON.stringify(vsOldest.stats)} vs ${JSON.stringify(after.stats)}`,
);
assert.match(vsOldest.html, /chg chg-(add|mod|del)/, 'earlier-version diff is marked up');
console.log('✓ compare against earlier snapshot', oldest.hash, vsOldest.stats);

// --- 9w. one version, by itself --------------------------------------------
// Reading a version on its own is the same payload rendered another way: the
// version picked is already `base`, so the page renders it plainly, exactly as
// `adopt` does with the switch on — and keeps the bar naming the file as it is.
const solo = renderDocument(mdPage, vsOldest.base, null);
assert.ok(!/chg chg-/.test(solo.html), 'a version read by itself carries no marks');
assert.deepStrictEqual(solo.changes, [], 'and nothing to count or walk');
assert.notStrictEqual(
  solo.html,
  renderDocument(mdPage, vsOldest.text, null).html,
  'and it is that version, not the file as it is',
);
assert.strictEqual(
  docTitleOf(mdPage, vsOldest.text),
  vsOldest.title,
  'the title is still the file\'s',
);
console.log('✓ an older version reads by itself');

// --- 9x. the version chosen stays chosen ----------------------------------
// Picking a version out of the history is a reading position as much as a
// scroll offset is, so it is kept per document rather than reset on every
// open. A document is asked for with `last:<default>` — "whatever this one was
// last compared against, and the default only if it never has been" — and that
// is what the page sends whenever it *shows* a document rather than being told
// to compare against something.
assert.strictEqual(
  (await get2('/api/doc')).baseline,
  'snap:' + oldest.hash,
  'an unqualified open compares against the version last chosen',
);
assert.strictEqual(
  (await get2('/api/doc?baseline=last:read')).baseline,
  'snap:' + oldest.hash,
  'and so does the form the page actually sends',
);
// The default travels in the token as a fallback, not an instruction: a
// document with a choice of its own keeps it even when the setting says git.
assert.strictEqual(
  (await get2('/api/doc?baseline=last:git:HEAD')).baseline,
  'snap:' + oldest.hash,
  'a remembered choice beats the default that came with the request',
);
// Reading the file with no comparison at all is not a choice of version, so it
// must not overwrite one. The page keeps that as its own switch.
assert.strictEqual((await get2('/api/doc?baseline=none')).baseline, 'none', 'none is honoured');
assert.strictEqual(
  (await get2('/api/doc')).baseline,
  'snap:' + oldest.hash,
  'and reading with nothing compared does not forget what was chosen',
);
console.log('✓ the chosen version is remembered');

// --- 9a. cleaning up history to a version --------------------------------
// The one call that deletes rather than adds, so: it names what to drop, it
// refuses to drop the newest, and a baseline it orphans has to land somewhere.
const before = after.history.length;
const cutAt = after.history.at(-2) ?? after.history.at(-1);
const pruned = (await (
  await fetch(base2 + '/api/prune?upto=' + cutAt.hash, { method: 'POST' })
).json()) as Reply;
assert.ok(pruned.removed >= 1, `something was forgotten: ${pruned.removed}`);
assert.strictEqual(pruned.history.length, before - pruned.removed, 'the list shrank by what went');
assert.ok(pruned.history.some((h) => h.current), 'the version on disk survives a clean-up');
assert.ok(
  !pruned.history.some((h) => h.hash === cutAt.hash),
  'the version named is gone, not kept',
);
assert.ok(
  pruned.history.some((h) => h.baseline),
  'the baseline still points at a version that exists',
);
assert.ok(pruned.baselineAvailable, 'and that version can still be read back and diffed');
// Nothing older than the newest can be dropped: it is the comparison target.
const head = pruned.history.find((h) => h.current);
const noop = (await (
  await fetch(base2 + '/api/prune?upto=' + head.hash, { method: 'POST' })
).json()) as Reply;
assert.strictEqual(noop.removed, 0, 'the newest version cannot be forgotten');
assert.strictEqual(noop.history.length, pruned.history.length, 'a refused clean-up changes nothing');
// Still renders, and still says what it is comparing against. The version it
// was told to compare against in 9x went in the clean-up, so the memory of it
// went too and the request falls back — rather than the choice being carried
// forward as a hash of something no longer on disk.
assert.ok(
  !pruned.history.some((h) => h.hash === oldest.hash),
  'the version that was being compared against is one of the ones dropped',
);
assert.strictEqual(noop.baseline, 'read', 'and still names a baseline it can honour');
console.log('✓ clean up history to a version', `−${pruned.removed}`, `${pruned.history.length} left`);

second.server.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nall smoke tests passed');
process.exit(0);
