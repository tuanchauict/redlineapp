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
import { createSession } from './src/reader/session.js';
import { serveRpc } from './src/rpc/serve.js';
import { createRpcBackend } from './src/rpc/client.js';
import type { Connection, WebBackend } from './src/hosts/web/backend.js';
import type { Kv } from './src/hosts/web/kv-files.js';
import type { AckedVersion } from './src/contract/payload.js';
import type { Session } from './src/contract/seam.js';
import type { HostName } from './scripts/stage-page.mjs';

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
// What `reader.read()` resolves to; the stand-in a closed stream is caught with has no value.
interface Chunk {
  done: boolean;
  value?: Uint8Array;
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
assert.match(appJs, /import \{ sanitizeDocument \} from '\.\.\/vendor\/sanitize\.js';/,
  'the page loads the sanitizer');
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
  assert.match(mainTs, /^import \{ applyWidths \} from '\.\/layout\/widths\.js';$/m,
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
          /^\.\.\/(state|dom|backend|layout\/native)\.js$/.test(spec) ||
          /^\.\.\/\.\.\/vendor\//.test(spec) ||
          /^\.\/[\w-]+\.js$/.test(spec),
        `vm/${f} imports ${spec}: a viewmodel reaches only the state, the DOM, the backend, ` +
          'the shell, the vendored renderer and its siblings',
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
  // Each is reached. find.ts, peek.ts and diagrams.ts wire their own listeners as they load, so
  // one dropped from main.ts would be a feature gone with nothing failing to compile.
  const mainTs = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
  for (const f of vms) {
    const name = f.replace(/\.ts$/, '');
    assert.match(mainTs, new RegExp(`^import [^;]*from '\\./vm/${name}\\.js';$`, 'ms'),
      `main.ts imports vm/${f}`);
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
  assert.ok(!/hoverNode =/.test(vm('acks.ts') + mainTs), 'and the hover is changes.ts\'s to set');
  assert.match(mainTs, /hidePeek\(\);\s*forgetHover\(\);/,
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

  // History, the view and Settings. Each redraws the document, which is still main.ts's, so
  // they reach it through vm/document.ts, which main.ts fills before anything can call it.
  assert.match(mainTs, /^bindDocument\(\{ load, adopt, paint, rerender \}\);$/m,
    'main.ts hands the document core to the port');
  assert.ok(mainTs.indexOf('bindDocument(') < mainTs.indexOf('bindNative({'),
    'before the shell, or anything else, can ask for a load');
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

// A menu item reaches the page over an event, through the seam, and every one
// of the three is a separate file that can be right on its own: the menu item
// that emits an event nobody listens for is greyed out by nothing and does
// nothing when picked. ⌘B and ⌥⌘B are checked as a pair because the second was
// added by copying the first, which is exactly how one of the three gets
// missed. The browser tab has no menu, so the key is the page's to catch.
const menuRs = fs.readFileSync(rootUrl('shell/src/menu.rs'), 'utf8');
const seamJs = fs.readFileSync(rootUrl('src/hosts/tauri/native.ts'), 'utf8');
for (const [item, accel, event, hook] of [
  ['side', 'CmdOrCtrl+B', 'md:toggle-side', 'onToggleSide'],
  ['sidetoc', 'Alt+CmdOrCtrl+B', 'md:toggle-toc', 'onToggleToc'],
  ['find', 'CmdOrCtrl+F', 'md:find', 'onFind'],
]) {
  assert.ok(menuRs.includes(`with_id("${item}"`), `View has an item for ${item}`);
  assert.ok(menuRs.includes(`accelerator("${accel}")`), `under ${accel}`);
  assert.ok(menuRs.includes(`"${item}" => win::to_front(app, "${event}"`), `sending ${event}`);
  // Whatever `cb` is typed as: this is about which event reaches which hook, not about the type.
  const hears = new RegExp(`${hook}: \\(cb\\b.*?\\) => on(?:<[^>]*>)?\\('${event}'`);
  assert.match(seamJs, hears, `the seam hears it as ${hook}`);
  assert.ok(pageJs.includes(`native.${hook}(`), `and the page acts on ${hook}`);
}
assert.match(pageJs, /!native && e\.code === 'KeyB'/, 'a browser tab catches the key itself');
assert.match(pageJs, /if \(e\.altKey\) setTocSide/, 'with Option choosing the contents');
assert.match(pageJs, /!native && e\.code === 'KeyF'/, 'and ⌘F, to beat the browser\'s own find');
console.log('✓ ⌘B, ⌥⌘B and ⌘F reach the page from the menu and from the keyboard');

// Print needs no key of its own in a browser tab -- ⌘P is the browser's -- and
// in the app it never reaches the page at all: `window.print()` is a no-op in
// WKWebView, so the menu drives the native print pipeline on the front window
// directly, through `print_window` rather than wry's own `print()` -- see
// print_window's doc comment in menu.rs for why: wry forces NSPrintInfo's
// margin to zero, and WebKit paginates against that margin, not `@page` CSS.
assert.ok(menuRs.includes(`with_id("print"`), 'View has an item for print');
assert.ok(menuRs.includes('accelerator("CmdOrCtrl+P")'), 'under CmdOrCtrl+P');
assert.match(
  menuRs,
  /"print" => \{[\s\S]*?win::front\(app\)[\s\S]*?print_window\(&w\)/,
  'dispatch prints the front window directly, not through the page',
);
assert.match(
  menuRs,
  /fn print_window\(w: &tauri::WebviewWindow\) \{[\s\S]*?setTopMargin\(72\.0\)/,
  "print_window sets a real native margin, since wry's own print() forces one to zero",
);
assert.match(pageCss, /@media print \{/, 'a print stylesheet exists');
assert.match(
  pageCss,
  /@media print \{[\s\S]*?\.bar,[\s\S]*?dialog \{[\s\S]*?display: none !important;[\s\S]*?\}/,
  'the window chrome is hidden on paper',
);
assert.match(
  pageCss,
  /@media print \{[\s\S]*?color-scheme: light;/,
  'and the page is forced light, whatever the system theme is',
);
console.log('✓ Print hides the chrome, forces a light page and prints with a real native margin');

// Restoring several tabs opens several documents, each its own file read, store
// and git subprocess -- sequential awaits would make the sidebar sit empty for
// the sum of every open instead of the slowest one.
assert.match(seamJs, /await Promise\.all\(\s*paths\.map\(async \(abs\)/, 'tabs are retained at once');

// A native window's starting document comes from `onTabs`'s own first answer,
// not from this module's own blind initial load -- the two used to race, and
// whichever settled last won even if it was the guess with no id at all. That
// let a tab go on looking highlighted in the sidebar while the pane quietly
// went back to showing whatever loaded slower.
assert.ok(
  pageJs.includes('const firstTabShown = new Promise'),
  'the first document is awaited rather than raced for',
);
assert.ok(
  pageJs.includes('.finally(openedFirstTab)'),
  "onTabs resolves it once its own load settles, win or lose",
);
assert.match(
  pageJs,
  /if \(native\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*await firstTabShown;\s*\} else \{/,
  'a native window waits for that answer instead of calling load() itself',
);
// Watched only if it painted: with the web app's welcome up there is no document to watch.
assert.match(
  pageJs,
  /else if \(await load\(\{ keepScroll: false \}\)\) \{\s*connect\(\);\s*\}/,
  'and any other window loads, and watches what it showed',
);

// Find in the current document. The three-file shape above gets it a menu item
// and a key; what is particular to it is that `#doc` is replaced whole on every
// paint (see `paint`), so a match held from before a repaint is a reference to
// a node no longer on the page — the bar has to redo the search rather than
// remember where it looked last.
assert.match(pageHtml, /id="findBar"/, 'the find bar has somewhere to show');
assert.match(pageHtml, /id="findInput"/, 'something to type the query into');
assert.match(pageHtml, /id="findCount"/, 'and somewhere to say how many it found');
assert.match(pageJs, /function markMatches/, 'matches are found fresh, not kept across a paint');
assert.match(pageJs, /!stay && findOpen\.value/, 'and paint redoes it after #doc is replaced');
assert.ok(pageCss.includes('.find-bar[hidden]'), 'the bar itself goes away with `hidden`');
assert.match(pageCss, /mark\.search-hit \{/, 'a match is styled');
assert.match(pageCss, /mark\.search-hit\.current \{/, 'and the current one is told apart');
console.log('✓ find in document wired end to end');

// ...and reach the window it was addressed to, and no other. The shell names a
// window in every one of those emits, but naming it is only half of it: Tauri
// exempts a listener registered without a target from the filter, so a page
// that signs up the easy way is signed up for every window's mail. That cost a
// bug where one window's "Open files" listed another window's documents, and —
// once the foreign paths could not be held — listed nothing at all under a
// document that was still on screen.
//
// Asserted by counting, not by matching: the fix is that *no* registration in
// the seam is untargeted, which a grep for the good one cannot show. Everything
// goes through `on`, so one `listen` is the whole of it.
const hostRs = fs.readFileSync(rootUrl('shell/src/host.rs'), 'utf8');
const winRs = fs.readFileSync(rootUrl('shell/src/win.rs'), 'utf8');
assert.strictEqual(
  // `listen<T>(` too: the type argument must not hide a registration from the count.
  (seamJs.match(/\blisten(?:<[^>]*>)?\(/g) ?? []).length,
  1,
  'the seam registers for the shell in exactly one place',
);
assert.ok(
  seamJs.includes('{ target: host.label }'),
  'naming the window it is in, so emit_to means what it says',
);
assert.match(hostRs, /pub label: String/, 'which is what the handoff tells it');
assert.match(winRs, /Handoff::new\(app, &label,/, 'from the window being built');
console.log('✓ a window only hears the events addressed to it');

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
  const main = fs.readFileSync(rootUrl('public/app/main.ts'), 'utf8');
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

// --- 9b. a version that comes back is still one version -------------------
// Undoing an edit puts content the document has held before back on disk. A
// version is named by the hash of its content, so a second row for it would
// give two rows one name: both would be marked as the version on disk, both as
// the version counted as read, and picking either would light up the other.
const wobbly = path.join(tmp, 'wobbly.md');
const v1 = '# Wobbly\n\nFirst wording.\n';
const v2 = '# Wobbly\n\nSecond wording, thought better of.\n';
fs.writeFileSync(wobbly, v1);
const wobble = await createServer({ file: wobbly });
await new Promise<void>((r) => wobble.server.listen(0, '127.0.0.1', r));
const getW = clientFor(`http://127.0.0.1:${portOf(wobble.server)}`);
await getW('/api/doc');
fs.writeFileSync(wobbly, v2);
await new Promise((r) => setTimeout(r, 700));
assert.strictEqual((await getW('/api/doc')).history.length, 2, 'an edit is a version');
fs.writeFileSync(wobbly, v1);
await new Promise((r) => setTimeout(r, 700));
const reverted = await getW('/api/doc');
const hashes = reverted.history.map((h) => h.hash);
assert.strictEqual(new Set(hashes).size, hashes.length, `one row per version: ${hashes}`);
assert.strictEqual(reverted.history.length, 2, 'the row moved, it was not added');
assert.deepStrictEqual(
  reverted.history.filter((h) => h.current).map((h) => h.hash),
  [hashes[0]],
  'the version on disk is marked exactly once, on the newest row',
);
// The read mark is on that row too, since v1 is what this document opened on.
assert.deepStrictEqual(
  reverted.history.filter((h) => h.baseline).map((h) => h.hash),
  [hashes[0]],
  'and so is the version counted as read',
);
console.log('✓ a version that comes back is one row', reverted.history.length, 'versions');

// --- 9c. ...and the chosen version survives a restart ---------------------
// The point of remembering it at all. Kept beside the snapshots rather than in
// the page's own storage: the page does not know which file it is showing until
// the document arrives, so looking the answer up there would mean a first paint
// against the wrong baseline and a visible correction — and a browser tab and
// the app's webview are separate origins, which would give one file two
// memories that disagreed.
const pickW = 'snap:' + hashes[1];
const chosenW = await getW('/api/doc?baseline=' + pickW);
assert.strictEqual(chosenW.baseline, pickW, 'the older version is chosen');
assert.ok(total(chosenW.stats) > 0, `and marks something: ${JSON.stringify(chosenW.stats)}`);
wobble.server.close();

const wobble2 = await createServer({ file: wobbly });
await new Promise<void>((r) => wobble2.server.listen(0, '127.0.0.1', r));
const getW2 = clientFor(`http://127.0.0.1:${portOf(wobble2.server)}`);
const reopened = await getW2('/api/doc');
assert.strictEqual(reopened.baseline, pickW, 'a restart opens on the version that was chosen');
assert.deepStrictEqual(reopened.stats, chosenW.stats, 'and shows the same changes it did before');
// Not the read mark: that is a different pointer, and remembering a comparison
// must not quietly move what counts as read.
assert.deepStrictEqual(
  reopened.history.filter((h) => h.baseline).map((h) => h.hash),
  [hashes[0]],
  'the read mark is where it was left, not on the version being compared against',
);
console.log('✓ the chosen version survives a restart');
wobble2.server.close();

// --- 10. git baseline ------------------------------------------------------
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-git-'));
const { execFileSync } = await import('node:child_process');
const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
const tracked = path.join(repo, 'doc.md');
fs.writeFileSync(tracked, '# Title\n\nCommitted paragraph.\n');
git('add', 'doc.md');
git('commit', '-qm', 'init');
fs.writeFileSync(tracked, '# Title\n\nCommitted paragraph.\n\nUncommitted new paragraph.\n');

const third = await createServer({ file: tracked });
await new Promise<void>((r) => third.server.listen(0, '127.0.0.1', r));
const gitDoc = await clientFor(`http://127.0.0.1:${portOf(third.server)}`)(
  '/api/doc?baseline=git:HEAD',
);
assert.ok(gitDoc.tracked, 'the file is known to be in a repo');
assert.strictEqual(gitDoc.baseline, 'git:HEAD', 'git HEAD is honoured as a baseline');
assert.deepStrictEqual(
  gitDoc.stats,
  { added: 1, removed: 0, modified: 0 },
  `git HEAD diff: ${JSON.stringify(gitDoc.stats)}`,
);
assert.match(gitDoc.html, /chg chg-add[\s\S]*Uncommitted new paragraph/);
console.log('✓ git HEAD baseline', gitDoc.stats);
third.server.close();

// A file outside a repo has no git baseline, and asking for one falls back
// rather than failing: the setting that asks for it is set once, for every file.
const loose = path.join(tmp, 'loose.md');
fs.writeFileSync(loose, '# Loose\n');
const fourth = await createServer({ file: loose });
await new Promise<void>((r) => fourth.server.listen(0, '127.0.0.1', r));
const looseDoc = (await (
  await fetch(`http://127.0.0.1:${portOf(fourth.server)}/api/doc?baseline=git:HEAD`)
).json()) as Reply;
assert.ok(!looseDoc.tracked, 'untracked file says so');
assert.strictEqual(looseDoc.baseline, 'read', 'and git HEAD falls back to last read');
console.log('✓ untracked file hides git baseline');
fourth.server.close();

// --- 10a. a tracked file arrives with its committed history ---------------
// Reading a repo happens off the critical path — the file opens first and the
// versions land after — so everything here waits for them rather than assuming.
const until = async (fn, what, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

const repo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-gitlog-'));
const git2 = (...a) => execFileSync('git', a, { cwd: repo2, stdio: 'ignore' });
git2('init', '-q');
git2('config', 'user.email', 'test@example.com');
git2('config', 'user.name', 'test');
const hist = path.join(repo2, 'notes.md');
fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n');
git2('add', 'notes.md');
git2('commit', '-qm', 'first thought');
fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n\nSecond thought.\n');
git2('commit', '-qam', 'second thought');
fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n\nSecond thought.\n\nThird thought.\n');
git2('commit', '-qam', 'third thought');

const gitSrv = await createServer({ file: hist });
await new Promise<void>((r) => gitSrv.server.listen(0, '127.0.0.1', r));
const baseG = `http://127.0.0.1:${portOf(gitSrv.server)}`;
const getG = (p = '/api/doc') => clientFor(baseG)(p);

const imported = await until(
  async () => {
    const d = await getG();
    return d.history.filter((h) => h.git).length >= 3 ? d : null;
  },
  'the committed history to be imported',
);
assert.deepStrictEqual(
  imported.history.filter((h) => h.git).map((h) => h.git.subject),
  ['third thought', 'second thought', 'first thought'],
  'every commit that touched the file, newest first, named by its subject',
);
assert.ok(
  imported.history.every((h) => !h.git || /^[0-9a-f]{40}$/.test(h.git.sha)),
  'each carries the commit it came from',
);
// The version on disk is the third commit, so it is one entry with a commit
// name — not a second copy of the same bytes under a content hash.
assert.strictEqual(imported.history.length, 3, 'the committed head is not duplicated');
assert.ok(imported.history[0].current, 'the newest version is the one on disk');
// Importing adds things to compare against; it does not decide what you have read.
assert.deepStrictEqual(
  imported.stats,
  { added: 0, removed: 0, modified: 0 },
  'an import leaves the baseline where it was',
);

// ...and an imported version is a real version: diffable like any other.
const first = imported.history.at(-1);
const vsFirst = await getG('/api/doc?baseline=snap:' + first.hash);
assert.strictEqual(vsFirst.stats.added, 2, `vs the first commit: ${JSON.stringify(vsFirst.stats)}`);
console.log('✓ git history imported', imported.history.map((h) => h.git.sha.slice(0, 7)).join(' '));

// --- 10b. ...and catches up on commits made while it was closed -----------
gitSrv.server.close();
fs.writeFileSync(hist, '# Notes\n\nFirst thought.\n\nSecond thought.\n\nFourth thought.\n');
git2('commit', '-qam', 'fourth thought');

const gitSrv2 = await createServer({ file: hist });
await new Promise<void>((r) => gitSrv2.server.listen(0, '127.0.0.1', r));
const baseG2 = `http://127.0.0.1:${portOf(gitSrv2.server)}`;
const caught = await until(
  async () => {
    const d = (await (await fetch(baseG2 + '/api/doc')).json()) as Reply;
    return d.history.some((h) => h.git?.subject === 'fourth thought') ? d : null;
  },
  'the commit made while the file was closed',
);
assert.strictEqual(caught.history.filter((h) => h.git).length, 4, 'one entry per commit, still');
assert.strictEqual(caught.history[0].git.subject, 'fourth thought', 'the new commit is the newest');
// The versions read the first time round are not read again.
assert.deepStrictEqual(
  caught.history.map((h) => h.git.subject),
  ['fourth thought', 'third thought', 'second thought', 'first thought'],
  'the earlier import is left alone',
);
console.log('✓ git history caught up after a commit made while closed');
gitSrv2.server.close();

// --- 11. switching documents at runtime (the app's File > Open) ------------
const docA = path.join(tmp, 'a.md');
const docB = path.join(tmp, 'b.md');
fs.writeFileSync(docA, '# Alpha\n\nFirst document.\n');
fs.writeFileSync(docB, '# Beta\n\nSecond document.\n');

const fifth = await createServer({ file: docA });
await new Promise<void>((r) => fifth.server.listen(0, '127.0.0.1', r));
const base5 = `http://127.0.0.1:${portOf(fifth.server)}`;

const events5 = [];
const es5 = await fetch(base5 + '/events');
const reader5 = es5.body.getReader();
(async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader5.read().catch(() => ({ done: true }) as Chunk);
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (line.startsWith('data: ')) events5.push(JSON.parse(line.slice(6)));
    }
  }
})();

assert.strictEqual(fifth.abs, docA);
await assert.rejects(
  () => fifth.setFile(path.join(tmp, 'does-not-exist.md')),
  /cannot read/,
  'bad path throws',
);
assert.strictEqual(fifth.abs, docA, 'a failed open leaves the current document in place');

await fifth.setFile(docB);
await new Promise((r) => setTimeout(r, 100));
assert.ok(
  events5.some((e) => e.type === 'file' && e.path === docB),
  `switch announced over SSE: ${JSON.stringify(events5)}`,
);
const docB1 = await clientFor(base5)('/api/doc');
assert.strictEqual(docB1.name, 'b.md', 'server now serves the new document');
assert.match(docB1.html, /Second document/);

// the old file's watcher must be gone, the new one must be live
events5.length = 0;
fs.writeFileSync(docA, '# Alpha\n\nFirst document, edited.\n');
await new Promise((r) => setTimeout(r, 400));
assert.strictEqual(events5.length, 0, 'edits to the closed document are ignored');
fs.appendFileSync(docB, '\nAppended to beta.\n');
await new Promise((r) => setTimeout(r, 400));
assert.ok(events5.some((e) => e.type === 'change'), 'the new document is watched');
console.log('✓ switch documents at runtime');

// --- 11a. following a link to another file ---------------------------------
// The browser's version of what the app answers with a new window. The page
// resolves `./a.md` against the directory the document it is reading came out
// of — it has nothing else to resolve against, being served from a loopback
// port — and posts the absolute path here.
const opened = (await (
  await fetch(`${base5}/api/open?path=${encodeURIComponent(docA)}`, { method: 'POST' })
).json()) as Reply;
assert.strictEqual(opened.path, docA, 'the referenced file is what got opened');
assert.ok(opened.id, 'and the page is told the id it is now on');
// The id comes back because it is not the one that was sent: the old document
// is released by the switch, and a page still holding its id would be asking
// after something that has closed.
const followed = await clientFor(base5)(`/api/doc?id=${opened.id}`);
assert.strictEqual(followed.name, 'a.md', 'and that id serves the new document');
assert.match(followed.html, /First document, edited/);

// A link a document has outlived. Nothing is released until the new file has
// been read, so the page stays exactly where it was.
const missing = await fetch(
  `${base5}/api/open?path=${encodeURIComponent(path.join(tmp, 'gone.md'))}`,
  { method: 'POST' },
);
assert.strictEqual(missing.status, 500, 'a link to a file that is not there fails');
assert.strictEqual(fifth.abs, docA, 'and leaves the document that is open alone');

// The page's half. Percent-escapes are markdown-it's doing, not the author's:
// `[図](./図.md)` reaches the client as `./%E5%9B%B3.md`, and a path built from
// that spelling exists on no disk — so the link is decoded before it is walked.
assert.match(pageJs, /function linkTarget/, 'a link resolves to a file');
assert.match(
  pageJs,
  /const bare = readable\(href\.split\('#'\)\[0\]/,
  'and is decoded before it is walked',
);
assert.match(pageJs, /walkPath\(dir, bare\)/, 'against the directory the document is in');
assert.match(pageJs, /backend\.open\(path\)/, 'and a browser tab follows it in place');
assert.match(pageJs, /async function openFile/, 'with the watch stood down across the swap');
console.log('✓ follow a link to a file beside this one');
await reader5.cancel().catch(() => {});
fifth.server.close();

// --- 12. several documents open at once (multiple windows / tabs) ----------
const docC = path.join(tmp, 'c.md');
const docD = path.join(tmp, 'd.md');
fs.writeFileSync(docC, '# Gamma\n\nThird document.\n');
fs.writeFileSync(docD, '# Delta\n\nFourth document.\n');

const sixth = await createServer({ file: docC });
await new Promise<void>((r) => sixth.server.listen(0, '127.0.0.1', r));
const base6 = `http://127.0.0.1:${portOf(sixth.server)}`;

const idC = sixth.initialId;
const idD = await sixth.retain(docD);
assert.notStrictEqual(idC, idD, 'distinct files get distinct ids');
assert.strictEqual(await sixth.retain(docD), idD, 'a second window on one file shares its id');
// And two windows asking at the same moment still share it: opening a document
// takes several awaits now, so the second must wait for the first rather than
// build a rival document and evict it.
assert.deepStrictEqual(
  await Promise.all([sixth.retain(docD), sixth.retain(docD)]),
  [idD, idD],
  'and so does a simultaneous pair',
);
sixth.release(idD);
sixth.release(idD);
sixth.release(idD); // balance the extra retain

const [dC, dD] = await Promise.all([
  fetch(`${base6}/api/doc?id=${idC}`).then((r) => r.json() as Promise<Reply>),
  fetch(`${base6}/api/doc?id=${idD}`).then((r) => r.json() as Promise<Reply>),
]);
assert.strictEqual(dC.name, 'c.md', 'id selects the document');
assert.strictEqual(dD.name, 'd.md', 'the second document is served alongside the first');
assert.strictEqual(dD.id, idD, 'the payload carries its own id');

// each listener hears only about its own file
const listen = async (id) => {
  const got = [];
  const res = await fetch(`${base6}/events?id=${id}`);
  const rd = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await rd.read().catch(() => ({ done: true }) as Chunk);
      if (done) break;
      for (const line of dec.decode(value).split('\n')) {
        if (line.startsWith('data: ')) got.push(JSON.parse(line.slice(6)));
      }
    }
  })();
  return { got, rd };
};
const lC = await listen(idC);
const lD = await listen(idD);

fs.appendFileSync(docD, '\nMore delta.\n');
await new Promise((r) => setTimeout(r, 400));
assert.ok(lD.got.some((e) => e.type === 'change'), 'the edited document notifies its window');
assert.strictEqual(lC.got.length, 0, 'the other window hears nothing');

// closing one window leaves the other watching
sixth.release(idD);
assert.strictEqual(sixth.pathOf(idD), null, 'the closed document is gone');
assert.strictEqual(sixth.pathOf(idC), docC, 'the open one stays');
fs.appendFileSync(docC, '\nMore gamma.\n');
await new Promise((r) => setTimeout(r, 400));
assert.ok(lC.got.some((e) => e.type === 'change'), 'the surviving document is still watched');

// a window that outlived its document says so, rather than showing the wrong file
const gone = await fetch(`${base6}/api/doc?id=${idD}`);
assert.strictEqual(gone.status, 410, 'a closed document is reported closed');
const unnamed = (await (await fetch(`${base6}/api/doc`)).json()) as Reply;
assert.strictEqual(unnamed.name, 'c.md', 'a request with no id still gets the open document');
console.log('✓ several documents open at once');
await Promise.all([lC.rd.cancel().catch(() => {}), lD.rd.cancel().catch(() => {})]);
sixth.server.close();

// --- 12a. the page behind a MessageChannel is answered as the page behind http is ----------
// One reader, asked two ways. The session decided what every call means, so the transports may
// differ in how a call arrives and in nothing else -- and this is the test that says so, rather
// than each transport's own tests each hoping.
{
  const docP = path.join(tmp, 'parity.md');
  fs.writeFileSync(docP, '# Parity\n\nOne.\n');
  const parity = await createServer({ file: docP });
  await new Promise<void>((r) => parity.server.listen(0, '127.0.0.1', r));
  const baseP = `http://127.0.0.1:${portOf(parity.server)}`;

  // node's MessagePort has the `onmessage` setter the web's does, and leaves it out of its types.
  type Receiving = { onmessage: (e: { data: any }) => void };
  const chan = new MessageChannel() as InstanceType<typeof MessageChannel> & {
    port1: Receiving;
    port2: Receiving;
  };
  const closeRpc = serveRpc({
    session: createSession(parity),
    post: (m) => chan.port1.postMessage(m),
    onMessage: (h) => {
      chan.port1.onmessage = (e) => h(e.data);
    },
  });
  const rpc = createRpcBackend({
    docId: () => parity.initialId,
    post: (m) => chan.port2.postMessage(m),
    onMessage: (h) => {
      chan.port2.onmessage = (e) => h(e.data);
    },
    host: { kind: 'test' },
  });
  // What an http client receives has been through JSON; what a channel delivers has been through
  // structured clone, which keeps an `undefined`. Neither is the reader's concern.
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const httpP = async (p, init?) => {
    const res = await fetch(`${baseP}${p}${p.includes('?') ? '&' : '?'}id=${parity.initialId}`, init);
    return { status: res.status, body: (await res.json()) as Reply };
  };

  assert.deepStrictEqual(
    plain(await rpc.doc()),
    (await httpP('/api/doc')).body,
    'the document is the same payload either way',
  );
  assert.deepStrictEqual(
    await rpc.fonts(),
    (await httpP('/api/fonts')).body.fonts,
    'and so are the fonts',
  );

  // A change reaches a page that is listening over the channel, as it reaches one on /events.
  const heard = [];
  const lives = [];
  const unwatch = rpc.watch({
    onEvent: (e) => heard.push(e),
    onLive: (on, why) => lives.push([on, why]),
  });
  await until(() => lives.length, 'the watch to go live');
  assert.deepStrictEqual(lives[0], [true, undefined], 'the watch is live once the reader has it');
  fs.appendFileSync(docP, '\nTwo.\n');
  await until(() => heard.some((e) => e.type === 'change'), 'a change over the channel');
  const changed = (await httpP('/api/doc')).body;
  assert.deepStrictEqual(plain(await rpc.doc()), changed, 'the changed document is the same too');
  assert.ok(changed.text.includes('Two.'), 'with the edit in it');

  // The same call, made both ways, leaves the same answer.
  assert.deepStrictEqual(
    plain(await rpc.markRead()),
    (await httpP('/api/mark-read', { method: 'POST' })).body,
    'marking read answers with the same document',
  );
  const keyP = 'parity-key';
  assert.deepStrictEqual(await rpc.ack({ key: keyP }), [keyP], 'a check-off over the channel');
  assert.deepStrictEqual(
    (await httpP(`/api/ack?key=${keyP}`, { method: 'POST' })).body.acked,
    [keyP],
    'and over http, which already knows it',
  );
  assert.deepStrictEqual(await rpc.ack({ clear: true }), [], 'clearing');

  // A call that is wrong in itself is the same refusal: a 400 on one, a BadRequest on the other.
  const noKey = await httpP('/api/ack', { method: 'POST' });
  assert.strictEqual(noKey.status, 400, 'http refuses a nameless check-off');
  await assert.rejects(rpc.ack({}), { name: 'BadRequest', message: noKey.body.error });
  await assert.rejects(rpc.open(''), { name: 'BadRequest' }, 'and a link to no file');

  // Versions: two more edits make something to clean up, and what is left is the same either way.
  for (const n of ['Three.', 'Four.']) {
    const seen = (await httpP('/api/doc')).body.history.length;
    fs.appendFileSync(docP, `\n${n}\n`);
    await until(async () => (await httpP('/api/doc')).body.history.length > seen, `version ${n}`);
  }
  const versions = (await httpP('/api/doc')).body.history;
  const cut = versions.at(-2);
  const trimmed = await rpc.prune(cut.hash);
  assert.ok(trimmed.removed >= 1, 'the clean-up over the channel forgot something');
  const head2 = trimmed.history.find((h) => h.current);
  assert.deepStrictEqual(
    plain(await rpc.prune(head2.hash)),
    (await httpP(`/api/prune?upto=${head2.hash}`, { method: 'POST' })).body,
    'refusing to forget the newest is the same answer on both',
  );
  // Reading up to an older version, the same both ways; and a version is a string or nothing.
  const olderP = trimmed.history.find((h) => !h.current);
  assert.deepStrictEqual(
    plain(await rpc.markRead(olderP.hash)),
    (await httpP(`/api/mark-read?at=${olderP.hash}`, { method: 'POST' })).body,
    'marking an older version read answers with the same document',
  );
  // 42 is not a version, on purpose.
  await assert.rejects(
    rpc.markRead(42 as unknown as string),
    { name: 'BadRequest' },
    'and a version that is not one is refused',
  );
  // Every backend the page can be handed takes the version along.
  for (const [f, through] of [
    ['./src/rpc/client.ts', /markRead: \(at\) => call(?:<\w+>)?\('markRead', docId\(\), at\),/],
    ['./src/hosts/tauri/backend.ts', /markRead: \(at\) => reader\.markRead\(docId\(\), at\),/],
    ['./public/backend.ts', /markRead: \(at\) => post\('\/api\/mark-read', \{ at \}\),/],
    ['./src/hosts/web/worker.ts', /markRead: async \(id, at\) => session\.markRead\(await owned\(conn, id\), at\),/],
  ] as const) {
    assert.match(fs.readFileSync(rootUrl(f), 'utf8'), through, `${f} passes the version on`);
  }

  // Following a link: both land on the sibling, and the page is told the id it is on now.
  const sibling = path.join(tmp, 'parity-sibling.md');
  fs.writeFileSync(sibling, '# Sibling\n');
  unwatch();
  const opened = await rpc.open(sibling);
  assert.strictEqual(opened.path, sibling, 'a link followed over the channel');
  assert.notStrictEqual(opened.id, parity.initialId, 'lands on a document of its own');
  const gonePage = await httpP('/api/doc');
  assert.strictEqual(gonePage.status, 410, 'and the id it left is closed, as http says');
  await assert.rejects(rpc.doc(), { name: 'Closed' }, 'which the channel says in its own words');
  await assert.rejects(
    new Promise((_, no) =>
      rpc.watch({ onEvent() {}, onLive: (on, why) => on || no(new Error(why)) }),
    ),
    /no longer open/,
    'and a watch on it is not live',
  );

  // What a page can call is what the other backends offer -- the page is written to one surface.
  const { createBackend } = await import(rootUrl('public/backend.js').href);
  const httpKeys = Object.keys(await createBackend({ docId: () => null }));
  assert.deepStrictEqual(
    Object.keys(rpc).filter((k) => httpKeys.includes(k)).sort(),
    httpKeys.sort(),
    'the channel backend has every method the http one does',
  );

  // And the layer between is wired: the server answers through the session, not around it.
  assert.match(
    fs.readFileSync(rootUrl('src/hosts/node/server.ts'), 'utf8'),
    /createSession\(reader\)/,
    'the http routes are the session',
  );
  console.log('✓ a page behind a channel is answered as one behind http is');
  closeRpc();
  chan.port1.close();
  chan.port2.close();
  parity.server.close();
}

// --- 12b. one store, two processes -------------------------------------------------------
// Two DocStores on one file stand in for two processes: each holds the index as it read it,
// which is what made a write from one undo the other's. (docs/architecture.md, The store)
{
  const { DocStore, hashContent } = await import('./src/reader/store.js');
  const { createReader } = await import('./src/reader/reader.js');
  const shared = path.join(tmp, 'shared.md');
  const text = (n) => `# Shared\n\nVersion ${n}.\n`;
  const A = await DocStore.open(shared, nodePlatform);
  const v1 = (await A.record(text(1))).hash;
  const B = await DocStore.open(shared, nodePlatform); // opened after v1, and never told about v2

  // A mark-read is not undone by another process saving a version.
  const v2 = (await A.record(text(2))).hash;
  await A.setBaseline(v2);
  const v3 = (await B.record(text(3))).hash; // B still thinks the baseline is v1
  const fresh = await DocStore.open(shared, nodePlatform);
  assert.strictEqual(fresh.baseline, v2, 'a mark-read survives the other process recording');
  assert.deepStrictEqual(
    fresh.data.history.map((h) => h.hash),
    [v1, v2, v3],
    'and neither process\'s version is lost',
  );

  // A check-off survives the other process recording.
  await B.setAcked('shared-key', true);
  const v4 = (await A.record(text(4))).hash;
  assert.deepStrictEqual(
    (await DocStore.open(shared, nodePlatform)).acked,
    ['shared-key'],
    'a check-off survives the other process saving',
  );

  // Cleared history does not come back.
  await A.prune(v3);
  await B.record(text(5));
  const after = await DocStore.open(shared, nodePlatform);
  assert.deepStrictEqual(
    after.data.history.map((h) => h.hash).filter((h) => [v1, v2, v3].includes(h)),
    [],
    'a prune in one process stays pruned when the other records',
  );
  assert.strictEqual(after.data.history.length, 2, 'and what is left is the newest two');
  assert.ok(after.data.history.some((h) => h.hash === v4), 'including the one the pruner saw');

  // Each notices the other: refresh says so once, and has the new index.
  await A.setBaseline(v4);
  assert.strictEqual(await B.refresh(), true, 'the other process is noticed');
  assert.strictEqual(B.baseline, v4, 'with its baseline');
  assert.strictEqual(await B.refresh(), false, 'and once');
  await B.setCompare('read');
  assert.strictEqual(await A.refresh(), true, 'both ways');
  // Its own write is not news: nothing to announce after it saves.
  await A.setCompare('git:HEAD');
  assert.strictEqual(await A.refresh(), false, 'a process does not notice itself');
  // An update that merged what another process had written does announce it.
  await B.setCompare('read'); // B writes; A has not looked since
  await A.setAcked('another', true); // A merges B's write into its own
  assert.strictEqual(await A.refresh(), true, 'a merge is announced, since the poll cannot see it');

  // A torn index is read again before it is believed.
  const idx = A.file;
  const good = fs.readFileSync(idx, 'utf8');
  fs.writeFileSync(idx, good.slice(0, good.length >> 1));
  setTimeout(() => fs.writeFileSync(idx, good), 20);
  assert.strictEqual(
    (await DocStore.open(shared, nodePlatform)).data.history.length,
    2,
    'an index caught mid-write is read once more',
  );

  // Two updates at once in one process both land.
  await Promise.all([A.setAcked('p', true), A.setAcked('q', true)]);
  assert.ok(['p', 'q'].every((k) => A.acked.includes(k)), 'concurrent changes both land');
  console.log('✓ two processes share a store without undoing each other');

  // --- atomic writes -------------------------------------------------------------------
  const target = path.join(tmp, 'atomic.json');
  const bodies = Array.from({ length: 12 }, (_, i) => `${i}:`.repeat(20000));
  await Promise.all(bodies.map((b) => nodePlatform.writeText(target, b)));
  assert.ok(bodies.includes(fs.readFileSync(target, 'utf8')), 'a write lands whole, never mixed');
  assert.deepStrictEqual(
    fs.readdirSync(tmp).filter((n) => n.endsWith('.writing')),
    [],
    'and leaves nothing beside it',
  );
  await assert.rejects(nodePlatform.writeText(path.join(tmp, 'no', 'such', 'dir.json'), 'x'));
  assert.match(
    fs.readFileSync(rootUrl('src/hosts/node/platform.ts'), 'utf8'),
    /\.writing/,
    'the node platform writes through a temporary file',
  );
  console.log('✓ a write replaces the file whole');

  // --- gc leaves young objects alone ---------------------------------------------------
  const objectsDir = path.join(process.env.REDLINE_HOME, 'objects');
  const young = path.join(objectsDir, 'a'.repeat(16) + '.md');
  const old = path.join(objectsDir, 'b'.repeat(16) + '.md');
  fs.writeFileSync(young, 'young and unreferenced\n');
  fs.writeFileSync(old, 'old and unreferenced\n');
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(old, hourAgo, hourAgo);
  await DocStore.gc(nodePlatform);
  assert.ok(fs.existsSync(young), 'gc keeps an unreferenced object younger than ten minutes');
  assert.ok(!fs.existsSync(old), 'and removes one that is older');
  assert.ok(fs.existsSync(A.objectPath(v4)), 'and what an index names is never touched');
  fs.rmSync(young);
  console.log('✓ gc has a grace period');

  // --- a version that comes back is made young again -----------------------------------
  // Its object is still on disk, unreferenced and old, so a sweep in another process that
  // lands between `record` finding it and the index naming it would take it. The sweep is
  // run at exactly that moment: when the index is read for the update.
  let sweepNow = false;
  const sweeping = {
    ...nodePlatform,
    async readText(p) {
      if (sweepNow && p === racing.file) {
        sweepNow = false;
        await DocStore.gc(nodePlatform);
      }
      return nodePlatform.readText(p);
    },
  };
  const racing = await DocStore.open(path.join(tmp, 'back.md'), sweeping);
  const returning = '# Back\n\nForgotten once, and written again.\n';
  const returningObject = racing.objectPath(hashContent(returning));
  fs.writeFileSync(returningObject, returning);
  fs.utimesSync(returningObject, hourAgo, hourAgo);
  sweepNow = true; // armed only now: opening the store reads the index too
  const { hash: returned } = await racing.record(returning);
  assert.ok(!sweepNow, 'the sweep ran between the object and the index');
  assert.strictEqual(
    await racing.read(returned),
    returning,
    'an old object a version comes back to survives a sweep before the index names it',
  );

  // Git's versions go through the same door.
  const committed = '# Back\n\nAs it was committed.\n';
  const committedObject = racing.objectPath(hashContent(committed));
  fs.writeFileSync(committedObject, committed);
  fs.utimesSync(committedObject, hourAgo, hourAgo);
  await racing.importGit([{ text: committed, ts: 1, git: { sha: 'c0ffee', subject: 'x' } }]);
  assert.ok(
    Date.now() - fs.statSync(committedObject).mtimeMs < 60 * 1000,
    'and so is one a commit comes back to',
  );
  console.log('✓ a version that comes back is not swept');

  // --- noticing, end to end ------------------------------------------------------------
  const both = path.join(tmp, 'both.md');
  fs.writeFileSync(both, '# Both\n\nFirst.\n');
  const r1 = await createReader({ platform: nodePlatform, pollMs: 50 });
  const r2 = await createReader({ platform: nodePlatform, pollMs: 50 });
  const id1 = await r1.retain(both);
  const id2 = await r2.retain(both);
  fs.writeFileSync(both, '# Both\n\nFirst.\n\nSecond.\n');
  await until(async () => (await r2.doc(id2, 'read')).history.length >= 2, 'both to see v2');
  await until(async () => (await r1.doc(id1, 'read')).history.length >= 2, 'both to see v2');
  const heard = [];
  r2.subscribe(id2, (e) => heard.push(e.type));
  await r1.markRead(id1);
  await until(() => heard.includes('history'), 'the other reader to hear of the mark', 4000);
  const rows = (await r2.doc(id2, 'last:read')).history;
  assert.ok(rows.find((h) => h.current).baseline, 'and it sees the version marked read');
  r1.closeAll();
  r2.closeAll();
  console.log('✓ a reader notices another process marking a version read');
}

// IndexedDB as a Map, for 12c and 12d. `tx` stages what `fn` does and keeps it only if `fn`
// finishes, one transaction at a time: the two things a readwrite transaction gives. What a Map
// cannot do is end a transaction early, which is the thing `idb.ts` has to be built not to need.
const memoryKv = () => {
  const data = new Map();
  const seen = { puts: 0 };
  const over = (m) => ({
    get: async (k) => structuredClone(m.get(k)),
    put: async (k, v) => void (seen.puts++, m.set(k, structuredClone(v))),
    del: async (k) => void m.delete(k),
    keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
  });
  let queue = Promise.resolve();
  const tx = (fn) => {
    const run = queue.then(async () => {
      const staged = new Map(data);
      const out = await fn(over(staged));
      data.clear();
      for (const [k, v] of staged) data.set(k, v);
      return out;
    });
    queue = run.catch(() => {});
    return run;
  };
  const now = over(data);
  return {
    data,
    seen,
    get: now.get,
    keys: now.keys,
    put: (k, v) => tx((t) => t.put(k, v)),
    del: (k) => tx((t) => t.del(k)),
    tx,
  };
};

// --- 12c. the store over a key-value store, and the web platform -------------------------
// What the web app runs on, with a Map where IndexedDB will be. `idb.ts` is the one file here
// that is only imported and never run: node has no IndexedDB and this repository has no browser,
// so how it handles a transaction is held by how it is written, and checked by reading it.
// (docs/architecture.md, The web app's reader)
{
  const { DocStore, hashContent, storeRoot } = await import('./src/reader/store.js');
  const { createKvFiles } = await import('./src/hosts/web/kv-files.js');
  const { createWebPlatform } = await import('./src/hosts/web/platform.js');
  const { createReader } = await import('./src/reader/reader.js');
  const pp = makePaths('/');
  const ROOT = '/redline';

  const realNow = Date.now;

  // --- #9: the file operations, then DocStore on them ----------------------------------
  const kv = memoryKv();
  const kfs = createKvFiles(kv, ROOT);
  const aa = '/redline/objects/aa.md';
  assert.strictEqual(await kfs.readText(aa), null, 'a missing file reads as null');
  assert.strictEqual(await kfs.modified(aa), null, 'and has no modified time');
  const putsBefore = kv.seen.puts;
  await kfs.writeText(aa, 'one');
  assert.strictEqual(
    kv.seen.puts - putsBefore,
    1,
    'a write is one put, so a file is replaced whole',
  );
  await kfs.writeText(aa, 'two');
  assert.strictEqual(await kfs.readText(aa), 'two', 'and a second write replaces the first');

  const stamped = '/redline/docs/t.json';
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const stamps = [];
    for (let i = 0; i < 3; i++) {
      await kfs.writeText(stamped, String(i));
      stamps.push(await kfs.modified(stamped));
    }
    assert.ok(
      stamps[0] < stamps[1] && stamps[1] < stamps[2],
      'modified moves on every write, even inside one millisecond',
    );
    Date.now = () => frozen - 5000;
    await kfs.writeText(stamped, 'back');
    assert.ok((await kfs.modified(stamped)) > stamps[2], 'and when the clock steps back');
  } finally {
    Date.now = realNow;
  }

  await kfs.writeText('/redline/objects/bb.md', 'b');
  assert.deepStrictEqual(
    await kfs.readDir('/redline/objects'),
    ['aa.md', 'bb.md'],
    'readDir is names',
  );
  assert.deepStrictEqual(
    await kfs.readDir(ROOT),
    ['docs', 'objects'],
    'a directory is listed once, however many files are in it',
  );
  assert.deepStrictEqual(
    await kfs.readDir('/redline/obj'),
    [],
    'and a name that only begins one is not it',
  );
  assert.ok(
    (await kfs.exists(aa)) && (await kfs.exists('/redline/objects')),
    'a file and the directory it is in both exist',
  );
  assert.ok(
    !(await kfs.exists('/redline/objectsx')) && !(await kfs.exists('/redline/none.md')),
    'and neither does what is only a prefix, or is not there',
  );
  await kfs.remove('/redline/objects/bb.md');
  await kfs.remove('/redline/objects/bb.md');
  assert.strictEqual(
    await kfs.readText('/redline/objects/bb.md'),
    null,
    'remove removes, once or twice',
  );

  const cc = '/redline/objects/cc.md';
  assert.strictEqual(await kfs.rename(aa, cc), true, 'a file renames');
  assert.deepStrictEqual(
    [await kfs.readText(aa), await kfs.readText(cc)],
    [null, 'two'],
    'and is where it was moved to, and no longer where it was',
  );
  assert.strictEqual(await kfs.rename(aa, cc), false, 'a file that is not there renames to false');
  assert.strictEqual(
    await kfs.rename('/redline/objects', '/redline/moved'),
    false,
    'and so does a directory',
  );
  assert.deepStrictEqual(await kfs.readDir(ROOT), ['docs', 'objects'], 'which stays where it was');
  const failing = {
    ...kv,
    tx: (fn) =>
      kv.tx((t) =>
        fn({
          ...t,
          del: async () => {
            throw new Error('disk full');
          },
        }),
      ),
  };
  const ee = '/redline/objects/ee.md';
  await assert.rejects(createKvFiles(failing, ROOT).rename(cc, ee), /disk full/);
  assert.deepStrictEqual(
    [await kfs.readText(cc), await kfs.readText(ee)],
    ['two', null],
    'a rename that fails half way is no rename: the file is in one place, not two or none',
  );
  for (const outside of ['/etc/passwd', '/redlinex/a.md', ROOT]) {
    await assert.rejects(
      () => kfs.writeText(outside, 'x'),
      /not under/,
      `a write to ${outside} is refused`,
    );
    await assert.rejects(() => kfs.readText(outside), /not under/, 'and so is a read of it');
  }

  // DocStore on it, unchanged: the version list, a version that comes back, a prune, a sweep.
  const cold = memoryKv();
  const web1 = {
    ...createKvFiles(cold, ROOT),
    ...pp,
    watch: async () => () => {},
    homeDir: async () => '/home/me',
    env: (name) => (name === 'REDLINE_HOME' ? ROOT : undefined),
    os: 'web',
  };
  const text = (n) => `# A\n\nVersion ${n}.\n`;
  const S = await DocStore.open('/home/me/notes/a.md', web1);
  const v1 = (await S.record(text(1))).hash;
  const v2 = (await S.record(text(2))).hash;
  const v3 = (await S.record(text(3))).hash;
  assert.strictEqual(S.baseline, v1, 'the first version is the baseline');
  assert.ok(
    cold.data.has(S.file) && S.file.startsWith('/redline/docs/'),
    'the index is in the store',
  );
  assert.ok(cold.data.has(S.objectPath(v1)), 'and each version is an object beside it');
  assert.strictEqual(await S.read(v2), text(2), 'a version reads back whole');

  const back = await S.record(text(1));
  assert.deepStrictEqual(
    [back.hash, back.added],
    [v1, true],
    'a version that comes back is recorded',
  );
  const listed = () => S.data.history.map((h) => h.hash);
  assert.deepStrictEqual(listed(), [v2, v3, v1], 'moved to the end, and not listed twice');

  await S.setBaseline(v2);
  assert.strictEqual(await S.prune(v2), 1, 'a prune forgets that version and what is older');
  assert.deepStrictEqual(listed(), [v3, v1], 'and the list is what is left');
  assert.strictEqual(S.baseline, v3, 'a baseline that was forgotten falls back to the oldest left');
  const reopened = await DocStore.open('/home/me/notes/a.md', web1);
  assert.deepStrictEqual(
    [reopened.baseline, reopened.data.history.map((h) => h.hash)],
    [v3, [v3, v1]],
    'and a store opened afterwards finds it so',
  );

  const young = '/redline/objects/' + 'a'.repeat(16) + '.md';
  await web1.writeText(young, 'young and unreferenced\n');
  await DocStore.gc(web1);
  assert.strictEqual(
    await S.read(v2),
    text(2),
    'gc keeps an unreferenced object younger than ten minutes',
  );
  // Backdating the record is how a Map is made to look old: there is no utimes to call.
  const backdate = (p) => cold.data.set(p, { ...cold.data.get(p), mtime: realNow() - 3600 * 1000 });
  backdate(S.objectPath(v2));
  backdate(S.objectPath(v3));
  await DocStore.gc(web1);
  assert.strictEqual(await S.read(v2), null, 'and sweeps one that is older');
  assert.strictEqual(await S.read(v3), text(3), 'but never one an index names, however old');
  assert.ok((await web1.readText(young)) != null, 'and a young one is still there after the sweep');

  // Two stores on one kv, as 12b has two on one disk.
  const shared = '/home/me/notes/shared.md';
  const body = (n) => `# Shared\n\nVersion ${n}.\n`;
  const A = await DocStore.open(shared, web1);
  const s1 = (await A.record(body(1))).hash;
  const B = await DocStore.open(shared, web1);
  const s2 = (await A.record(body(2))).hash;
  await A.setBaseline(s2);
  const s3 = (await B.record(body(3))).hash;
  const fresh = await DocStore.open(shared, web1);
  assert.strictEqual(fresh.baseline, s2, 'a mark-read survives the other store recording');
  assert.deepStrictEqual(
    fresh.data.history.map((h) => h.hash),
    [s1, s2, s3],
    'and neither store\'s version is lost',
  );
  // `refresh` reads the index only when `modified` has moved, and one clock reading can stand
  // for two writes: here it is made to.
  const stuck = realNow();
  Date.now = () => stuck;
  try {
    await A.refresh();
    await B.record(body(4));
    assert.ok(await A.refresh(), 'a write by the other store is noticed');
    await B.record(body(5));
    assert.ok(await A.refresh(), 'and a second one, in the same millisecond');
  } finally {
    Date.now = realNow;
  }
  assert.strictEqual(
    A.latest.hash,
    hashContent(body(5)),
    'with the newest version in what it sees',
  );
  console.log('✓ the store runs over a key-value store: versions, a prune, a sweep, two stores');

  // --- #10: the web platform -----------------------------------------------------------
  // Handles as the File System Access API shapes them, with the errors it throws for a name
  // that is not there. Every call that could write to a document is a spy: none may be reached.
  const touched = [];
  const asked = [];
  const refusal = (name) => Object.assign(new Error(name), { name });
  const fakeFile = (name, content, lastModified) => ({
    kind: 'file',
    name,
    getFile: async () => ({ text: async () => content, lastModified }),
    createWritable: async () => touched.push('createWritable'),
  });
  const fakeDir = (name, entries) => {
    const find = (n, kind, opts) => {
      asked.push(n);
      if (opts?.create) touched.push('create');
      const entry = entries[n];
      if (!entry) throw refusal('NotFoundError');
      if (entry.kind !== kind) throw refusal('TypeMismatchError');
      return entry;
    };
    return {
      kind: 'directory',
      name,
      getDirectoryHandle: async (n, opts) => find(n, 'directory', opts),
      getFileHandle: async (n, opts) => find(n, 'file', opts),
      removeEntry: async () => touched.push('removeEntry'),
    };
  };
  const notes = fakeDir('notes', { 'a.md': fakeFile('a.md', '# A\n', 200) });
  const handles = new Map<string, { kind: string; name: string; [member: string]: unknown }>([
    ['a', fakeDir('docs', { 'top.md': fakeFile('top.md', '# Top\n', 100), notes })],
    ['solo', fakeFile('one.md', '# One\n', 300)],
  ]);
  const drops = new Map([['d.md', { text: async () => '# Dropped\n', lastModified: 400 }]]);
  const kv2 = memoryKv();
  const web = createWebPlatform({ kv: kv2, root: (id) => handles.get(id) ?? null, drops });

  assert.strictEqual(
    await web.readText('web:a/notes/a.md'),
    '# A\n',
    'a web: path reads through the handles',
  );
  assert.strictEqual(
    await web.modified('web:a/notes/a.md'),
    200,
    'and is as modified as the file says',
  );
  assert.ok(
    (await web.exists('web:a/notes/a.md')) && !(await web.exists('web:a/notes/b.md')),
    'it exists, and a sibling that is not there does not',
  );
  assert.strictEqual(
    await web.readText('web:a/notes/b.md'),
    null,
    'a file that is not there reads as null',
  );
  assert.strictEqual(await web.modified('web:a/notes/b.md'), null, 'and has no modified time');
  assert.strictEqual(await web.readText('web:a/notes'), null, 'a directory is not a file, so null');
  assert.strictEqual(
    await web.readText('web:never/x.md'),
    null,
    'and so is a folder that was never granted',
  );
  assert.strictEqual(
    await web.readText('web:solo/one.md'),
    '# One\n',
    'a file granted by itself reads',
  );
  assert.strictEqual(await web.readText('web:solo/two.md'), null, 'and has nothing beside it');
  const revoked = refusal('NotAllowedError');
  handles.set('revoked', {
    kind: 'directory',
    name: 'r',
    getFileHandle: async () => {
      throw revoked;
    },
  });
  await assert.rejects(
    () => web.readText('web:revoked/x.md'),
    (err) => err === revoked,
    'a permission taken back is an error, not a file that is missing',
  );

  assert.strictEqual(web.resolve('web:a/x/../../y'), 'web:a/y', 'a .. stops at the root it is in');
  assert.strictEqual(web.resolve('web:a/../../../etc'), 'web:a/etc', 'however many there are');
  assert.strictEqual(web.resolve('drop:../x.md'), 'drop:x.md', 'in a drop as well');
  assert.strictEqual(web.resolve('/redline/a/../b'), '/redline/b', 'and a store path is tidied');
  asked.length = 0;
  assert.strictEqual(
    await web.readText('web:a/notes/../../../top.md'),
    '# Top\n',
    'a path is resolved before the handles are walked',
  );
  assert.deepStrictEqual(asked, ['top.md'], 'so no handle is ever asked for ..');

  assert.strictEqual(
    await web.readText('drop:d.md'),
    '# Dropped\n',
    'a drop: path reads the dropped file',
  );
  assert.strictEqual(await web.modified('drop:d.md'), 400, 'with its modified time');
  assert.ok(
    (await web.exists('drop:d.md')) && !(await web.exists('drop:no.md')),
    'a drop that is not there does not exist',
  );
  assert.strictEqual(await web.readText('drop:no.md'), null, 'and reads as null');

  await web.writeText('/redline/docs/x.json', '{}');
  assert.strictEqual(
    await web.readText('/redline/docs/x.json'),
    '{}',
    'a store path writes and reads back',
  );
  assert.deepStrictEqual(await web.readDir('/redline/docs'), ['x.json'], 'lists');
  assert.strictEqual(
    typeof (await web.modified('/redline/docs/x.json')),
    'number',
    'and has a time',
  );
  await web.mkdirp('/redline/objects');
  assert.strictEqual(
    await web.rename('/redline/docs/x.json', '/redline/docs/y.json'),
    true,
    'renames',
  );
  assert.strictEqual(await web.readText('/redline/docs/x.json'), null, 'so it has moved');
  await web.writeText('/redline/docs/z.json', 'kept');

  const stored = JSON.stringify([...kv2.data]);
  const refused = [
    'web:a/notes/a.md',
    'web:a',
    'web:solo/one.md',
    'drop:d.md',
    '/home/me/a.md',
    '/redlinex/a.md',
    '/redline/../etc/x',
    'web:a/../../redline/x',
  ];
  for (const p of refused) {
    const calls = {
      writeText: () => web.writeText(p, 'x'),
      mkdirp: () => web.mkdirp(p),
      remove: () => web.remove(p),
      'rename from': () => web.rename(p, '/redline/z'),
      'rename to': () => web.rename('/redline/docs/z.json', p),
      readDir: () => web.readDir(p),
    };
    for (const [what, call] of Object.entries(calls)) {
      // By the platform's own refusal, which says "only", and not by whatever else might throw.
      await assert.rejects(call, /\bonly\b/, `${what} ${p} is refused`);
    }
  }
  assert.strictEqual(JSON.stringify([...kv2.data]), stored, 'and the store is as it was');
  assert.deepStrictEqual(touched, [], 'no handle was asked to write, create or remove anything');
  assert.doesNotMatch(
    fs.readFileSync(rootUrl('src/hosts/web/platform.ts'), 'utf8'),
    /createWritable|removeEntry|create:\s*true/,
    'the web platform has no way to write a document',
  );

  assert.ok(!('spawn' in web), 'the platform has no spawn at all, not one that throws');
  assert.strictEqual(web.env('REDLINE_HOME'), ROOT, 'it answers REDLINE_HOME');
  assert.strictEqual(await storeRoot(web), ROOT, 'so the store is there with nothing to rename');
  assert.strictEqual(
    typeof (await web.watch('drop:d.md', () => {})),
    'function',
    'watch gives a stop',
  );

  // A reader on it, end to end: a dropped file is opened, changes, and is diffed.
  const rdr = await createReader({ platform: web, pollMs: 20 });
  const dropId = await rdr.retain('drop:d.md');
  assert.deepStrictEqual(
    (await rdr.doc(dropId, 'last:read')).caps,
    { git: false, plantuml: false },
    'a reader on it says what it lacks',
  );
  drops.set('d.md', { text: async () => '# Dropped\n\nAgain.\n', lastModified: 401 });
  await until(
    async () => (await rdr.doc(dropId, 'read')).history.length >= 2,
    'the dropped file to change',
  );
  assert.deepStrictEqual(
    render(await rdr.doc(dropId, 'read')).stats,
    { added: 1, removed: 0, modified: 0 },
    'and its change is a change mark',
  );
  assert.ok(
    [...kv2.data.keys()].every((k) => k.startsWith('/redline/')),
    'everything the reader wrote is in the store',
  );
  rdr.closeAll();

  // idb.ts is imported, never run. It is not allowed to reach for `indexedDB` before it is
  // called, or node could not import it; and the two lines below are what the traps in it come
  // down to, so they are held by a grep for want of a browser.
  const hadIdb = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  let reached = 0;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    get() {
      reached++;
    },
  });
  try {
    const { createIdbKv, STORES } = await import('./src/hosts/web/idb.js');
    const idb = createIdbKv('files');
    assert.strictEqual(reached, 0, 'idb.ts is imported, and a kv made, without touching indexedDB');
    assert.deepStrictEqual(
      STORES,
      ['files', 'roots', 'opened'],
      'with every store the app will use',
    );
    assert.deepStrictEqual(
      Object.keys(idb).sort(),
      ['del', 'get', 'keys', 'put', 'tx'],
      'and the five calls kv-files.ts asks of a kv',
    );
    await assert.rejects(
      () => idb.get('k'),
      /IndexedDB is not available/,
      'a call says so when it is not',
    );
    assert.ok(reached > 0, 'and it is reached only when called');
  } finally {
    if (hadIdb) Object.defineProperty(globalThis, 'indexedDB', hadIdb);
    else delete globalThis.indexedDB;
  }
  const idbSrc = fs.readFileSync(rootUrl('src/hosts/web/idb.ts'), 'utf8');
  assert.match(
    idbSrc,
    /IDBKeyRange\.bound\(prefix, prefix \+ '\\uffff'\)/,
    'a prefix is a key range',
  );
  assert.match(
    idbSrc,
    /oncomplete/,
    'a write is answered when it is committed, not when it is asked',
  );
  console.log(
    '✓ the web platform reads handles and drops, writes only the store, and runs a reader',
  );
}

// --- 12d. the web app's reader: a worker per origin, and a permission the user can take back ---
// The pieces of W2 end to end, over in-process ports, with folders that are fakes of what the File
// System Access API hands out and a Map where IndexedDB will be. What no test here can say is
// whether a browser behaves as the fakes do: whether a `SharedWorker` can call `getFile()` and
// `queryPermission()`, and what a handle throws once the grant is revoked, are the two checks
// left to a person with a browser. (docs/architecture.md, The web app's reader)
{
  const { createWebHost } = await import('./src/hosts/web/worker.js');
  const { createWebBackend } = await import('./src/hosts/web/backend.js');
  const { createHandles, parseWebPath, webPath } = await import('./src/hosts/web/handles.js');
  const { createWebPlatform } = await import('./src/hosts/web/platform.js');
  const { createReader } = await import('./src/reader/reader.js');

  const refusal = (name) => Object.assign(new Error(name), { name });
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

  // A promise that rejects and is not handled would only be a warning in a browser's console and
  // a crash here, and either way it is the failure #35 is about: so every one is written down.
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  // IndexedDB keeps a handle by cloning it, which a fake cannot be cloned to do, so the two
  // stores that hold handles do not clone. The third is the real shape of one.
  // No `tx`: the two stores that hold handles are only ever read and written a key at a time, so
  // the `Kv` they are handed as has a member that nothing calls on them.
  const plainKv = () => {
    const m = new Map();
    return {
      m,
      get: async (k) => m.get(k),
      put: async (k, v) => void m.set(k, v),
      del: async (k) => void m.delete(k),
      keys: async (prefix) => [...m.keys()].filter((k) => k.startsWith(prefix)).sort(),
    } as Kv & { m: Map<any, any> };
  };
  const newStores = () => ({ files: memoryKv(), roots: plainKv(), opened: plainKv() });

  /** A folder as the File System Access API shapes one, with a permission a test can move. */
  const folder = (name, files) => {
    const h = {
      kind: 'directory',
      name,
      state: 'granted',
      allow: true, // what the user says when asked
      asked: 0,
      reads: 0,
      mtime: 1000,
      files: { ...files },
      queryPermission: async () => h.state,
      requestPermission: async () => {
        h.asked++;
        if (h.allow) h.state = 'granted';
        return h.state;
      },
      isSameEntry: async (other) => other === h,
      getDirectoryHandle: async () => {
        throw refusal('NotFoundError');
      },
      getFileHandle: async (n) => {
        if (!Object.hasOwn(h.files, n)) throw refusal('NotFoundError');
        return {
          kind: 'file',
          name: n,
          getFile: async () => {
            // What a handle does once the grant has gone, and the whole of what #35 turns on.
            if (h.state !== 'granted') throw refusal('NotAllowedError');
            h.reads++;
            return { text: async () => h.files[n], lastModified: h.mtime };
          },
        };
      },
    };
    return h;
  };
  const edit = (h, n, text) => {
    h.files[n] = text;
    h.mtime += 1000;
  };

  interface FakePort {
    onmessage: ((e: { data: unknown }) => void) | null;
    peer: FakePort | null;
    closed: boolean;
    postMessage(data: any): void;
    close(): void;
  }
  // A pair of ports that deliver what is posted, a turn later and in order, like a MessageChannel.
  // Everything is cloned on the way, as it would be, except the handle and the file a page hands
  // over: those are cloned by the browser, and a fake is not something a clone can be made of.
  const ports = (): [FakePort, FakePort] => {
    // The two methods are added in the loop below, once there are two ends to point at each other.
    const end = () => ({ onmessage: null, peer: null, closed: false }) as FakePort;
    const [a, b] = [end(), end()];
    a.peer = b;
    b.peer = a;
    for (const me of [a, b]) {
      me.postMessage = (data) => {
        const raw = data?.t === 'call' && /^add(Root|Drop)$/.test(data.m);
        const sent = raw ? data : structuredClone(data);
        setImmediate(() => !me.peer.closed && me.peer.onmessage?.({ data: sent }));
      };
      me.close = () => {
        me.closed = me.peer.closed = true;
      };
    }
    return [a, b];
  };

  // --- serveRpc: `bye` ----------------------------------------------------------------
  {
    const log = [];
    let hear;
    const stop = serveRpc({
      session: { watch: () => () => log.push('unwatch') } as unknown as Session,
      post: () => {},
      onMessage: (handler) => {
        hear = handler;
      },
      onHello: (doc) => log.push(`hello ${doc}`),
      onBye: () => log.push('bye'),
    });
    hear({ t: 'hello', doc: 'abc' });
    hear({ t: 'call', id: 1, m: 'watch', a: ['abc'] });
    await settle(5);
    hear({ t: 'ping' });
    hear({ t: 'bye' });
    assert.deepStrictEqual(
      log,
      ['hello abc', 'unwatch', 'bye'],
      'bye stops the watch and then tells the host; a ping is neither',
    );
    stop();
    assert.deepStrictEqual(log.slice(3), [], 'closing the connection is not a bye');
    // Without it, as every host before this one is served.
    const quiet = serveRpc({
      session: {} as Session,
      post: () => {},
      onMessage: (h) => h({ t: 'bye' }),
    });
    quiet();
    console.log('✓ serveRpc tells the host when a page says bye, after its watch has stopped');
  }

  // --- the reader's poll: a file it may no longer read -------------------------------------
  {
    const dir = folder('notes', { 'a.md': '# A\n\nOne.\n' });
    const platform = createWebPlatform({
      kv: memoryKv(),
      root: async (id) => (id === 'r1' ? dir : null),
      drops: new Map(),
    });
    const reader = await createReader({ platform, pollMs: 30 });
    const id = await reader.retain('web:r1/a.md');
    const heard = [];
    reader.subscribe(id, (e) => heard.push(e));
    await settle(120);
    assert.deepStrictEqual(heard, [], 'a file that can be read says nothing');

    dir.state = 'prompt'; // the grant goes
    await until(() => heard.length, 'the poll to say it cannot read');
    await settle(150); // several more polls, which have nothing new to say
    assert.deepStrictEqual(
      heard.map((e) => [e.type, e.name]),
      [['unreadable', 'NotAllowedError']],
      'a poll refused by the browser says so, once, with the reason',
    );

    dir.state = 'granted';
    await until(() => heard.length === 2, 'the poll to read again');
    assert.strictEqual(heard[1].type, 'readable', 'and says when it can read again');
    edit(dir, 'a.md', '# A\n\nTwo.\n');
    await until(() => heard.some((e) => e.type === 'change'), 'the edit after the grant');
    assert.deepStrictEqual(unhandled, [], 'and none of it was a rejection nobody handled');
    reader.closeAll();
    console.log('✓ a poll that cannot read the file says so once, and says when it can again');
  }

  // --- handles.ts ----------------------------------------------------------------------
  {
    const stores = newStores();
    let n = 0;
    const handles = createHandles({
      roots: stores.roots,
      opened: stores.opened,
      randomId: () => `root-${++n}`,
    });
    const docs = folder('docs', { 'a.md': '# A\n' });
    const other = folder('other', {});

    const [first, again] = await Promise.all([handles.addRoot(docs), handles.addRoot(docs)]);
    assert.deepStrictEqual(
      [first, again],
      [
        { rootId: 'root-1', name: 'docs', kind: 'directory' },
        { rootId: 'root-1', name: 'docs', kind: 'directory' },
      ],
      'the same folder granted twice, even at once, is one root',
    );
    assert.strictEqual((await handles.addRoot(other)).rootId, 'root-2', 'another is another');
    assert.strictEqual(stores.roots.m.size, 2, 'and two are stored');

    assert.strictEqual(await handles.permission('root-1'), 'granted', 'a root says what it may');
    docs.state = 'prompt';
    assert.strictEqual(await handles.permission('root-1'), 'prompt', 'and says when that changes');
    assert.strictEqual(await handles.permission('nope'), 'gone', 'a root it never had is gone');
    docs.queryPermission = async () => {
      throw refusal('InvalidStateError');
    };
    assert.strictEqual(
      await handles.permission('root-1'),
      'gone',
      'so is one that cannot be asked',
    );

    await handles.rememberOpened('abc123', 'root-1', 'sub/a.md');
    assert.deepStrictEqual(
      await handles.openedAs('abc123'),
      { rootId: 'root-1', rel: 'sub/a.md' },
      'what a doc id was is remembered',
    );
    assert.strictEqual(await handles.openedAs('zzz'), null, 'and one that was never opened is not');
    assert.strictEqual(await handles.lastOpened(), null, 'with nothing shown yet there is no last');
    await handles.rememberLast('abc123');
    assert.strictEqual(await handles.lastOpened(), 'abc123', 'the last document shown is kept');
    assert.strictEqual(await handles.openedAs('last'), null, 'in a key that no doc id can be');

    assert.deepStrictEqual(parseWebPath(webPath('r', 'a/b.md')), { rootId: 'r', rel: 'a/b.md' });
    assert.strictEqual(parseWebPath('drop:x.md'), null, 'only a web: path has a root');
    assert.strictEqual(parseWebPath('/etc/passwd'), null, 'and no other kind has');

    assert.deepStrictEqual(
      handles.label('web:root-1/sub/a.md'),
      { pathLabel: 'docs/sub/a.md', dirLabel: 'docs/sub' },
      'a file in a folder is labelled as part of it',
    );
    assert.deepStrictEqual(
      handles.label('web:root-1/a.md'),
      { pathLabel: 'docs/a.md', dirLabel: 'docs' },
      'and one at its top by the folder alone',
    );
    assert.deepStrictEqual(
      handles.label('drop:d.md'),
      { pathLabel: 'drop: d.md', dirLabel: 'drop:' },
      'a drop says what it is',
    );
    console.log('✓ the handle registry: one root per folder, what may be read, what an id was');
  }

  // --- the worker, and the pages of a browser ----------------------------------------------
  const clock = { t: 0 };
  const stores = newStores();
  const notes = folder('notes', {
    'a.md': '# A\n\nOne.\n',
    'b.md': '# B\n\nBee.\n',
  });
  const hosts = [];
  const startHost = () => {
    const host = createWebHost({
      stores,
      pollMs: 30,
      silentMs: 1000,
      sweepMs: 10,
      now: () => clock.t,
    });
    hosts.push(host);
    return host;
  };
  // What `addDrop` takes. The drops here are plain objects with the members the reader reads, and
  // some with fewer, to be refused: a `File` is not something a test can make by hand.
  type DropFile = Parameters<WebBackend['addDrop']>[0];
  /** A tab, as `openPage` builds it: `backend`, `watch` and `fire` are added once it exists. */
  interface FakeWindow {
    id: string | null;
    win: EventTarget;
    port: FakePort;
    live: Array<{ on: boolean; why?: string }>;
    events: any[];
    asked: Array<{ name: string }>;
    backend: WebBackend;
    watch: () => ReturnType<WebBackend['watch']>;
    fire: (type: string, init?: object) => boolean;
  }
  const pages: FakeWindow[] = [];
  /**
   * A tab: a backend on its own port into `host`, which shows whatever `shows` is. `kv` is what
   * the page reads, which is the host's stores; a host on stores of its own needs them passed.
   */
  const openPage = async (host, shows = null, kv = stores) => {
    const [mine, theirs] = ports();
    host.connect(theirs);
    const page = {
      id: shows,
      win: new EventTarget(),
      port: mine,
      live: [],
      events: [],
      asked: [],
    } as FakeWindow;
    page.backend = await createWebBackend({
      docId: () => page.id,
      connect: async () => ({ port: mine as unknown as Connection['port'], onError() {} }),
      stores: { roots: kv.roots, opened: kv.opened },
      win: page.win as unknown as typeof globalThis,
      pingMs: 60_000,
    });
    page.backend.onNeedsPermission((who) => page.asked.push(who));
    page.watch = () =>
      page.backend.watch({
        onLive: (on, why) => page.live.push({ on, why }),
        onEvent: (e) => page.events.push(e),
      });
    page.fire = (type, init = {}) => page.win.dispatchEvent(Object.assign(new Event(type), init));
    pages.push(page);
    return page;
  };
  const rejection = (p, name) =>
    assert.rejects(p, (err: Error) => err.name === name, `rejects with ${name}`);

  const host1 = startHost();
  const reader1 = await host1.reader;
  const tab1 = await openPage(host1);

  // A page with nothing to show is told so, and not shown somebody else's file.
  await rejection(tab1.backend.doc(), 'NoDocument');

  const root = await tab1.backend.addRoot(notes);
  assert.deepStrictEqual(
    [root.name, root.kind, typeof root.rootId],
    ['notes', 'directory', 'string'],
    'a folder handed over comes back with the id it is known by',
  );
  assert.strictEqual(
    (await tab1.backend.addRoot(notes)).rootId,
    root.rootId,
    'and handed over again, the same one',
  );
  await rejection(tab1.backend.addRoot({ name: 'x' }), 'BadRequest');

  const a = await tab1.backend.open(`web:${root.rootId}/a.md`);
  tab1.id = a.id;
  assert.strictEqual(a.path, `web:${root.rootId}/a.md`, 'open answers the path it opened');
  assert.deepStrictEqual(
    await stores.opened.get(a.id),
    { rootId: root.rootId, rel: 'a.md' },
    'and remembers what the id means, for the reload',
  );
  const docA = await tab1.backend.doc();
  assert.strictEqual(docA.id, a.id, 'the document is the one that was opened');
  assert.match(docA.pathLabel, /^notes\/a\.md$/, 'and is labelled by its folder');
  assert.strictEqual(docA.caps.git, false, 'and says what the web reader lacks');

  // A second tab opens another file: the first is not taken along with it.
  const tab2 = await openPage(host1);
  const b = await tab2.backend.open(`web:${root.rootId}/b.md`);
  tab2.id = b.id;
  assert.notStrictEqual(b.id, a.id, 'another file is another document');
  assert.strictEqual(
    (await tab1.backend.doc()).id,
    a.id,
    'a tab keeps its document when another opens one',
  );
  assert.strictEqual((await tab2.backend.doc()).id, b.id, 'and each has its own');
  tab1.id = b.id;
  await rejection(tab1.backend.doc(), 'Closed');
  tab1.id = null;
  assert.strictEqual(
    (await tab1.backend.doc()).id,
    a.id,
    'a call that names no document is answered with the tab\'s own, never the first open',
  );
  tab1.id = a.id;

  // What a page may open: what it was given, and nothing else.
  await rejection(tab1.backend.open('/redline/objects/x.md'), 'BadRequest');
  await rejection(tab1.backend.open('/etc/hosts'), 'BadRequest');
  await rejection(tab1.backend.open(''), 'BadRequest');
  assert.ok(await tab1.backend.open(`web:${root.rootId}/nope.md`).then(() => false, () => true));
  assert.strictEqual(
    (await tab1.backend.doc()).id,
    a.id,
    'a file that will not open leaves the page on the one it had',
  );

  // --- hello and bye -----------------------------------------------------------------------
  const tab3 = await openPage(host1, a.id); // a reload of a document the worker has open
  assert.strictEqual(
    (await tab3.backend.doc()).id,
    a.id,
    'a page that says hello joins the document',
  );
  tab3.fire('pagehide');
  await settle(30);
  assert.ok(reader1.pathOf(a.id), 'a bye lets go of what that page held, not what another does');
  tab1.fire('pagehide');
  await until(() => reader1.pathOf(a.id) === null, 'the last holder to let go');
  assert.ok(reader1.pathOf(b.id), 'and a tab that is still there keeps its own');
  tab1.fire('pageshow', { persisted: false });
  await settle(30);
  assert.strictEqual(
    reader1.pathOf(a.id),
    null,
    'a page shown for the first time has said hello already',
  );

  tab1.watch();
  await until(() => tab1.live.length, 'the watch to be subscribed');
  tab1.fire('pageshow', { persisted: true });
  await until(() => reader1.pathOf(a.id), 'a page back from the cache to be held again');
  await until(() => tab1.events.some((e) => e.type === 'change'), 'it to be told to look again');
  edit(notes, 'a.md', '# A\n\nTwo.\n');
  const before = tab1.events.length;
  await until(() => tab1.events.length > before, 'the watch to follow the file after a restore');
  assert.match(
    (await tab1.backend.doc()).text,
    /Two\./,
    'and the document is what is on disk now',
  );

  // --- silence ---------------------------------------------------------------------------
  clock.t += 500;
  tab1.port.postMessage({ t: 'ping' });
  clock.t += 600; // 1100 ms since the start, 600 since the ping
  await settle(60);
  assert.ok(reader1.pathOf(a.id), 'a page that pinged lately is still held');
  clock.t += 5000;
  await until(() => reader1.pathOf(a.id) === null, 'a silent page to be let go of');
  assert.strictEqual(reader1.pathOf(b.id), null, 'as is every other that has said nothing');
  const seenBefore = tab1.events.length;
  tab1.port.postMessage({ t: 'ping' }); // a tab whose timers were held back, back at last
  await until(() => reader1.pathOf(a.id), 'the next thing it says to hold its document again');
  await until(() => tab1.events.length > seenBefore, 'and to be told to look again');
  assert.strictEqual((await tab1.backend.doc()).id, a.id, 'and it is answered as before');
  tab2.port.postMessage({ t: 'ping' });
  await until(() => reader1.pathOf(b.id), 'the other tab, the same way');
  tab1.fire('pagehide');

  // --- a reload: what the worker finds when the id is all it has ------------------------------
  // The first worker is gone and a new one starts over the same stores. Only `opened` knows what
  // the id was, and only the handle in `roots` can say whether it may be read.
  for (const p of pages) p.backend.close();
  host1.close();
  const host2 = startHost();
  const reader2 = await host2.reader;
  const open = await openPage(host2, a.id);
  const docAgain = await open.backend.doc();
  assert.strictEqual(docAgain.id, a.id, 'a granted folder opens the document the id names');
  assert.ok(docAgain.history?.length >= 1, 'with the history the store already had');
  assert.ok(reader2.pathOf(a.id), 'and holds it');

  const later = await openPage(host2, a.id); // a second tab on the same reload
  assert.strictEqual((await later.backend.doc()).id, a.id, 'a second tab joins the open document');

  notes.state = 'prompt';
  const asking = await openPage(host2, b.id);
  await rejection(asking.backend.doc(), 'NeedsPermission');
  assert.deepStrictEqual(asking.asked, [{ name: 'notes' }], 'a folder to ask for again says which');
  assert.strictEqual(notes.asked, 0, 'and nothing has asked the user yet');
  asking.watch();
  await until(() => asking.live.length >= 2, 'the watch to say what it waits for');
  assert.deepStrictEqual(
    asking.live.map((l) => l.on),
    [true, false],
    'a watch begun while the document waits is subscribed, and then says it is not live',
  );
  assert.match(asking.live.at(-1).why, /permission/i, 'and what it is waiting for');
  notes.allow = false;
  assert.strictEqual(await asking.backend.reopen(), false, 'a user who says no is not a grant');
  await rejection(asking.backend.doc(), 'NeedsPermission');
  notes.allow = true;
  assert.strictEqual(await asking.backend.reopen(), true, 'one who says yes is');
  assert.strictEqual(notes.asked, 2, 'the page asked, each time from its own click');
  assert.strictEqual((await asking.backend.doc()).id, b.id, 'and the document is there after it');

  // The same id on a worker that has nothing open: only `opened` and `roots` say what it is.
  notes.state = 'denied';
  const hostD = startHost();
  await rejection((await openPage(hostD, a.id)).backend.doc(), 'NoDocument');
  assert.strictEqual(notes.asked, 2, 'a folder that was denied is not asked again');
  notes.state = 'granted';
  const roots = new Map(stores.roots.m);
  await stores.roots.del(root.rootId);
  const hostG = startHost();
  await rejection((await openPage(hostG, a.id)).backend.doc(), 'NoDocument');
  await rejection((await openPage(hostG, 'eeeeeeeeeeee')).backend.doc(), 'NoDocument');
  for (const [k, v] of roots) await stores.roots.put(k, v);
  console.log('✓ a worker holds a tab\'s document from hello to bye or silence, and reloads it');

  // --- #35: a permission taken back mid-session ---------------------------------------------
  {
    await stores.roots.put(root.rootId, { handle: notes, name: 'notes', kind: 'directory' });
    notes.state = 'granted';
    const host3 = startHost();
    const watcher = await openPage(host3, a.id);
    await watcher.backend.doc();
    watcher.watch();
    await until(() => watcher.live.some((l) => l.on), 'the watch to be live');
    watcher.live.length = 0;
    watcher.asked.length = 0;

    notes.state = 'prompt'; // the grant goes; the next read throws NotAllowedError
    await until(() => watcher.live.some((l) => !l.on), 'the watcher to hear it is not live');
    assert.match(watcher.live[0].why, /permission/i, 'and why');
    assert.deepStrictEqual(watcher.asked, [{ name: 'notes' }], 'and what to ask the user for');
    await settle(120);
    assert.strictEqual(watcher.live.length, 1, 'once, and not on every poll after it');
    await rejection(watcher.backend.doc(), 'NeedsPermission');

    const reads = notes.reads;
    assert.strictEqual(await watcher.backend.reopen(), true, 'the user says yes');
    await until(() => watcher.live.at(-1)?.on === true, 'the watcher to go live again');
    edit(notes, 'a.md', '# A\n\nThree.\n');
    const seen = watcher.events.length;
    await until(() => watcher.events.length > seen, 'a change after the grant');
    assert.ok(notes.reads > reads, 'it is reading the file again');
    assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
    console.log('✓ a permission taken back mid-session: not live, then a grant makes it live');
  }

  // --- a reader that cannot be built ---------------------------------------------------------
  {
    const broken = createWebHost({
      stores: newStores(),
      pollMs: 30,
      // Building the reader cannot fail over the web platform, so the failure is put there.
      makeReader: async () => {
        throw new Error('the reader could not be built');
      },
    });
    hosts.push(broken);
    const page = await openPage(broken, 'bbbbbbbbbbbb');
    await assert.rejects(page.backend.doc(), /could not be built/, 'a call says why it failed');
    page.watch();
    await until(() => page.live.length >= 2, 'the watch to say it is not live');
    assert.deepStrictEqual(
      page.live.map((l) => l.on),
      [true, false],
      'a watch on a worker with no reader is subscribed, and then says it is not live',
    );
    assert.match(page.live.at(-1).why, /could not be built/, 'and why');
    await settle(60);
    assert.deepStrictEqual(unhandled, [], 'and no watch was left as a rejection nobody handled');
    console.log('✓ a worker with no reader tells every watch, and leaves no rejection');
  }

  // --- a folder denied under a page that is showing it ---------------------------------------
  {
    notes.state = 'granted';
    const host5 = startHost();
    const reader5 = await host5.reader;
    const page = await openPage(host5, a.id);
    assert.strictEqual((await page.backend.doc()).id, a.id, 'a document from a granted folder');

    notes.state = 'prompt';
    await rejection(page.backend.doc(), 'NeedsPermission');
    assert.ok(reader5.pathOf(a.id), 'a folder that can be asked for again keeps the document held');

    notes.state = 'denied';
    await rejection(page.backend.doc(), 'NoDocument');
    assert.strictEqual(
      reader5.pathOf(a.id),
      null,
      'one that was denied lets go of it, so nothing polls a file the page no longer shows',
    );
    await rejection(page.backend.doc(), 'NoDocument');
    notes.state = 'granted';
    console.log('✓ a denied folder lets go of its document; one to ask again does not');
  }

  // --- a link into a folder whose grant has lapsed -----------------------------------------
  {
    const archive = folder('archive', { 'x.md': '# X\n\nEx.\n' });
    archive.state = 'prompt';
    const host6 = startHost();
    const reader6 = await host6.reader;
    const page = await openPage(host6);
    const arch = await page.backend.addRoot(archive);
    const here = await page.backend.open(`web:${root.rootId}/a.md`);
    page.id = here.id;

    const notesAsked = notes.asked; // what earlier tests asked, which is not this test's
    notes.state = 'prompt';
    await rejection(page.backend.open(`web:${root.rootId}/b.md`), 'NeedsPermission');
    assert.deepStrictEqual(page.asked, [{ name: 'notes' }], 'a lapsed folder is asked for by name');
    assert.ok(reader6.pathOf(here.id), 'and the page is left on the document it had');
    assert.strictEqual(notes.asked, notesAsked, 'with nobody asked yet');

    // The link is into another folder than the one on screen, and the button has to say which.
    page.asked.length = 0;
    await rejection(page.backend.open(`web:${arch.rootId}/x.md`), 'NeedsPermission');
    assert.deepStrictEqual(page.asked, [{ name: 'archive' }], 'the folder the link was into');
    assert.strictEqual(await page.backend.reopen(), true, 'and asking is for that one');
    assert.deepStrictEqual(
      [archive.asked, notes.asked - notesAsked],
      [1, 0],
      'not the one on screen',
    );
    const x = await page.backend.open(`web:${arch.rootId}/x.md`);
    assert.strictEqual(reader6.pathOf(x.id), `web:${arch.rootId}/x.md`, 'which then opens');

    // Not a permission: a file that is not there is still only an error.
    await assert.rejects(page.backend.open(`web:${arch.rootId}/nope.md`), (err: Error) => {
      return err.name !== 'NeedsPermission';
    });
    notes.state = 'granted';
    assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
    console.log('✓ a link into a folder that must be asked for again says which folder to ask');
  }

  // --- a file with no handle ---------------------------------------------------------------
  {
    const host4 = startHost();
    const dropper = await openPage(host4);
    let text = '# Dropped\n\nFirst.\n';
    const file = { name: 'd.md', text: async () => text, lastModified: 1 };
    const p = await dropper.backend.addDrop(file as unknown as DropFile);
    assert.strictEqual(p, 'drop:d.md', 'a drop is a path of its own');
    const sneaky = { name: '../d.md', text: async () => '' };
    await rejection(dropper.backend.addDrop(sneaky as unknown as DropFile), 'BadRequest');
    await rejection(dropper.backend.addDrop({ name: 'd.md' } as unknown as DropFile), 'BadRequest');
    const opened = await dropper.backend.open(p);
    dropper.id = opened.id;
    const dropped = await dropper.backend.doc();
    assert.strictEqual(dropped.pathLabel, 'drop: d.md', 'and says it is one');
    assert.strictEqual(await stores.opened.get(opened.id), undefined, 'it is not remembered');
    dropper.watch();
    await until(() => dropper.live.some((l) => l.on), 'the watch to be live');
    // Dropped again, the file changed: the same name, so the same document, and a change to follow.
    text = '# Dropped\n\nSecond.\n';
    const again = { ...file, text: async () => text, lastModified: 2 };
    const next = await dropper.backend.addDrop(again as unknown as DropFile);
    assert.strictEqual(next, p, 'the same name replaces what was dropped');
    await until(() => dropper.events.some((e) => e.type === 'change'), 'the new file to be read');
    console.log('✓ a dropped file opens as a document of its own, and a drop again replaces it');
  }

  // --- a visit with no `?id=`: the document a tab last showed ---------------------------------
  // The app's bare address -- a bookmark, a new tab -- comes back to where the user was, as a
  // reopened app does, and not to the welcome every time. On stores of its own, so that which
  // document is the last is this test's and not the sum of every test above.
  {
    const own = newStores();
    const hostOn = () => {
      const host = createWebHost({
        stores: own,
        pollMs: 30,
        silentMs: 1000,
        sweepMs: 10,
        now: () => clock.t,
      });
      hosts.push(host);
      return host;
    };
    const desk = folder('desk', { 'one.md': '# One\n\nFirst.\n', 'two.md': '# Two\n\nSecond.\n' });
    const hostL = hostOn();
    const readerL = await hostL.reader;

    const first = await openPage(hostL, null, own);
    await rejection(first.backend.doc(), 'NoDocument'); // nothing was ever shown: the welcome
    const dr = await first.backend.addRoot(desk);
    const one = await first.backend.open(`web:${dr.rootId}/one.md`);
    first.id = one.id;
    assert.strictEqual(await own.opened.get('last'), one.id, 'a file opened is the last shown');

    const bare = await openPage(hostL, null, own);
    const resumed = await bare.backend.doc();
    assert.strictEqual(resumed.id, one.id, 'a page that names none is given the last one');
    assert.match(resumed.text, /First\./, 'with its text');
    bare.id = resumed.id; // what the page's `adopt` does with the id it was given
    const two = await bare.backend.open(`web:${dr.rootId}/two.md`);
    bare.id = two.id;
    assert.strictEqual(await own.opened.get('last'), two.id, 'and the next one opened is');
    assert.strictEqual((await first.backend.doc()).id, one.id, 'which takes no tab along with it');

    // A drop is gone with the worker that had it: never the last, so the one before it stays.
    const dropper = await openPage(hostL, null, own);
    assert.strictEqual((await dropper.backend.doc()).id, two.id, 'a third bare page is given two');
    const loose = { name: 'loose.md', text: async () => '# Loose\n', lastModified: 1 } as DropFile;
    dropper.id = (await dropper.backend.open(await dropper.backend.addDrop(loose))).id;
    assert.strictEqual(await own.opened.get('last'), two.id, 'a drop is not the last');

    // A tab in the background, let go of for its silence and taken back: not the user going
    // anywhere, so it does not take `last` back from the tab in front.
    clock.t += 5000;
    await until(() => readerL.pathOf(one.id) === null, 'the quiet tabs to be let go of');
    first.port.postMessage({ t: 'ping' });
    await until(() => readerL.pathOf(one.id), 'the tab on one to be taken back');
    assert.strictEqual((await first.backend.doc()).id, one.id, 'on the document it had');
    assert.strictEqual(await own.opened.get('last'), two.id, 'and the last is still two');

    // A reload on a document is the user going back to it.
    const reload = await openPage(hostL, one.id, own);
    await reload.backend.doc();
    assert.strictEqual(await own.opened.get('last'), one.id, 'a reload on one makes it last');
    for (const p of [first, bare, dropper, reload]) p.backend.close();
    hostL.close();

    // The browser started again: a worker with nothing open, and the stores.
    const fresh = await openPage(hostOn(), null, own);
    assert.strictEqual((await fresh.backend.doc()).id, one.id, 'a new worker finds the last one');

    desk.state = 'prompt';
    const asking = await openPage(hostOn(), null, own);
    await rejection(asking.backend.doc(), 'NeedsPermission');
    assert.deepStrictEqual(asking.asked, [{ name: 'desk' }], 'a lapsed folder is asked for');
    assert.strictEqual(await asking.backend.reopen(), true, 'from the page, which names no id');
    assert.strictEqual((await asking.backend.doc()).id, one.id, 'and the last one is there after');

    desk.state = 'denied';
    await rejection((await openPage(hostOn(), null, own)).backend.doc(), 'NoDocument');
    assert.strictEqual(desk.asked, 1, 'a denied folder is not asked for: the welcome');
    desk.state = 'granted';
    await own.roots.del(dr.rootId);
    await rejection((await openPage(hostOn(), null, own)).backend.doc(), 'NoDocument');
    await rejection((await openPage(hostOn(), 'last', own)).backend.doc(), 'NoDocument');
    assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
    console.log('✓ a page with no id is given the last document a tab showed, if it can be read');
  }

  // --- W3: the welcome ---------------------------------------------------------------------
  // The page's empty state, driven through the real backend and the real worker. What stands in
  // for the browser is a DOM of only what the welcome touches, file handles, and the pickers.
  // Whether a real `showOpenFilePicker`, a real drop or a real `navigator.storage.persist()`
  // behaves as these do is for a person with a browser. (docs/web-app.md, Opening something)
  {
    const welcomeTsx = fs.readFileSync(rootUrl('public/app/ui/Welcome.tsx'), 'utf8');
    const { LINK_NOTE } = await import('./src/hosts/web/backend.js');
    const { MD_LINK } = await import('./src/core/links.js');

    // A file handle, and what is added to it after it is made: `isSameEntry` by `fileOf`, the rest
    // by `grantable`.
    interface FakeHandle {
      kind: string;
      name: string;
      queryPermission: () => Promise<string>;
      getFile: () => Promise<{ name: string; text: () => Promise<string>; lastModified: number }>;
      isSameEntry?: (other: unknown) => Promise<boolean>;
      requestPermission?: () => Promise<string>;
      state?: string;
      allow?: boolean;
      asked?: number;
    }
    // A file as a handle gives it, and readable only while it is granted.
    const fileOf = (n, text, state = () => 'granted') => {
      const f: FakeHandle = {
        kind: 'file',
        name: n,
        queryPermission: async () => state(),
        getFile: async () => {
          if (state() !== 'granted') throw refusal('NotAllowedError');
          return { name: n, text: async () => text, lastModified: 1000 };
        },
      };
      f.isSameEntry = async (other) => other === f;
      return f;
    };
    /** A file whose grant a test can take away, and that asks the user when a page asks again. */
    const grantable = (n, text) => {
      const f = fileOf(n, text, () => f.state);
      Object.assign(f, { state: 'granted', allow: true, asked: 0 });
      f.requestPermission = async () => {
        f.asked++;
        if (f.allow) f.state = 'granted';
        return f.state;
      };
      return f;
    };
    // A folder, as a drop with a handle gives one. The welcome is not to read it, only to see it is
    // a folder, so it has nothing in it to read.
    const folderOf = (name) => ({ kind: 'directory', name, isSameEntry: async () => false });
    const NOT_A_FOLDER = /opens files, not folders/;

    // --- the welcome, through the real backend and worker ------------------------------------
    // Its doors, without the page: what it says arrives as a view, which ui/Welcome.tsx draws and
    // which is read here instead. The DOM it still touches is the class list on <html>, for a drag.
    const fakeDoc = () => {
      const classes = new Set();
      return {
        classes,
        documentElement: {
          classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
        },
      };
    };

    type Wiring = { hidden?: boolean; hooks?: object };
    /**
     * A tab showing the welcome, with `extra` as what the browser has on `window`. `shows` is the
     * `?id=` it was loaded with, which the worker is told as the page connects. `wiring` is for a
     * page that has a document on screen: `hidden` says the welcome is not showing, as `#welcome`
     * is not then, and `hooks` are the page's own, which a page without a document has no need of.
     * `seen.view` is what the page would be drawing.
     */
    const mount = async (host, extra, shows = null, wiring: Wiring = {}) => {
      const page = await openPage(host, shows);
      const doc = fakeDoc();
      const calls = { opened: [], ids: [], granted: 0, persist: 0 };
      Object.assign(page.win, {
        navigator: { storage: { persist: async () => void calls.persist++ } },
        ...extra,
      });
      // What the page's `openFile` does: ask the backend, and show it if it opens.
      const open = async (path) => {
        try {
          const o = await page.backend.open(path);
          page.id = o.id;
          calls.opened.push(path);
          calls.ids.push(o.id);
          return true;
        } catch {
          return false;
        }
      };
      const granted = async () => void calls.granted++;
      const seen = { view: null, views: 0 };
      const show = (view) => {
        seen.view = view;
        seen.views++;
      };
      const showing = () => !wiring.hidden;
      const hooks = { open, granted, show, showing, doc: doc as any, ...wiring.hooks };
      return { page, doc, calls, seen, w: page.backend.welcome(hooks) };
    };
    const dropOf = (page, items, files = [], types = ['Files']) => {
      const e = Object.assign(new Event('drop', { cancelable: true }), {
        dataTransfer: { types, items, files },
      });
      page.win.dispatchEvent(e);
      return e;
    };
    const dragOf = (page, type, types = ['Files']) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { dataTransfer: { types } });
      page.win.dispatchEvent(e);
      return e;
    };
    const item = (give) => ({ kind: 'file', ...give });
    const copy = (n, text?) => ({ name: n, text, lastModified: 5 });

    const single = fileOf('single.md', '# Single\n\nOn its own.\n');
    const behave = { file: async () => [single] };
    const picks = [];
    const hostW = startHost();

    // --- a file: the one door ---
    {
      const w = await mount(hostW, {
        // A browser that could pick a folder is not offered one: the web app opens files.
        showDirectoryPicker: async () => {
          throw new Error('the welcome picked a folder');
        },
        showOpenFilePicker: (opts) => (picks.push(opts), behave.file()),
      });
      const fileBtn = { click: () => w.w.pickFile() };
      assert.deepStrictEqual(
        w.seen.view,
        { canFile: true, busy: false, status: '', reopen: null, back: false },
        'a browser with a picker is told so as it mounts, with nothing to reopen or go back to',
      );
      assert.match(
        welcomeTsx,
        /<button type="button" class="welcome-primary" onClick=\{pickFile\}>\s*Open file…/,
        'Open file… is the way in, and the primary button',
      );
      // The drawn text, with the comments out of it, which talk about folders to say why not.
      const drawn = welcomeTsx.replace(/\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');
      assert.ok(
        !/folder/i.test(drawn) &&
          !/showDirectoryPicker/.test(fs.readFileSync(rootUrl('src/hosts/web/welcome.ts'), 'utf8')),
        'and nothing offers a folder, even in a browser that could pick one',
      );
      assert.match(welcomeTsx, /<div class="welcome-reopen" hidden=\{!v\.reopen\}>/,
        'the ask to reopen is hidden until there is a file to ask for');
      assert.match(welcomeTsx, /class="welcome-secondary" hidden=\{!v\.back\} onClick=\{back\}/,
        'and Back until there is a document, and goes back to it');

      // What the web app cannot do, said before a user finds it out, with the way to what can.
      const limits = drawn.match(/<p class="welcome-hint welcome-limits">([\s\S]*?)<\/p>/)?.[1];
      assert.ok(limits, 'the limits are said, as a hint');
      assert.match(
        limits.replace(/\s+/g, ' '),
        /one file at a time: its links to other files do not open, and there is no git or PlantUML/,
        'which are the ones a reader coming from the Mac app reaches for',
      );
      assert.match(
        limits,
        /<a href=\{MAC_APP_URL\} target="_blank" rel="noopener">\s*Get the Mac app\s*<\/a>/,
        'with a link to the Mac app, in a tab of its own',
      );
      assert.match(welcomeTsx, /export const MAC_APP_URL = 'https:\/\/redline\.iamtuna\.org\/#get';/,
        "the landing's download");

      await fileBtn.click();
      const opts = picks.at(-1);
      assert.deepStrictEqual(
        [opts.excludeAcceptAllOption, opts.types[0].accept['text/markdown'].includes('.md')],
        [true, true],
        'the file picker is asked for markdown, and only for it',
      );
      assert.ok(opts.types[0].accept['text/plain'].includes('.txt'), 'and text');
      assert.match(w.calls.opened[0], /^web:[^/]+\/single\.md$/, 'a file picked is opened');
      assert.match((await w.page.backend.doc()).text, /On its own\./, 'and is the file');
      assert.strictEqual(w.calls.persist, 1, 'storage is asked to persist once a file opens');
      await fileBtn.click();
      assert.strictEqual(w.calls.opened.length, 2, 'another pick opens again');
      assert.strictEqual(w.calls.persist, 1, 'and storage is not asked again');
      assert.strictEqual(
        await w.page.backend.linkNote(w.calls.opened[0]),
        LINK_NOTE,
        'a link out of it says why it will not open',
      );
      assert.match(LINK_NOTE, /one file at a time[\s\S]*The Mac app follows them/, 'and where');
      for (const [p, why] of [
        [null, 'a page with no document'],
        ['web:nope/x.md', 'a root that is gone'],
        ['/etc/x.md', 'a path of no kind here'],
      ]) {
        assert.strictEqual(await w.page.backend.linkNote(p), null, `says nothing for ${why}`);
      }
      assert.deepStrictEqual(
        [
          ['a.md', 'A.MD', 'b.markdown', 'c.mdown', 'd.mkd', 'e.mdx', 'f.txt'].every((n) =>
            MD_LINK.test(n),
          ),
          ['g.png', 'h.md.bak', 'md', 'i.mdd'].some((n) => MD_LINK.test(n)),
        ],
        [true, false],
        'what it takes is one pattern, the one the page follows links by',
      );

      // Not a failure, and not a message.
      behave.file = async () => {
        throw refusal('AbortError');
      };
      await fileBtn.click();
      assert.strictEqual(w.seen.view.status, '', 'a picker that was cancelled says nothing');
      behave.file = async () => {
        throw refusal('SecurityError');
      };
      await fileBtn.click();
      assert.match(w.seen.view.status, /Could not open that: SecurityError/, 'but a refusal is');
      assert.match(welcomeTsx, /<p class="welcome-status" role="status" hidden=\{!v\.status\}>/,
        'where the page shows it');
      w.w.sync({});
      assert.strictEqual(w.seen.view.status, '', 'until the page says it moved on');

      // One at a time: a second click while a picker is up is not a second picker.
      let release;
      const before = picks.length;
      behave.file = () =>
        new Promise((r) => {
          release = () => r([single]);
        });
      const first = fileBtn.click();
      const second = fileBtn.click();
      assert.strictEqual(picks.length, before + 1, 'a click while one is open opens no other');
      assert.strictEqual(w.seen.view.busy, true, 'and the welcome says it is busy');
      release();
      await Promise.all([first, second]);
      assert.strictEqual(w.seen.view.busy, false, 'until it is not');

      const opened = w.calls.opened.length;
      const roots = stores.roots.m.size;
      behave.file = async () => [fileOf('logo.png', '')];
      await fileBtn.click();
      assert.match(w.seen.view.status, /Redline opens markdown/, 'a picture is refused');
      assert.deepStrictEqual(
        [w.calls.opened.length, stores.roots.m.size],
        [opened, roots],
        'before it is opened, or granted',
      );

      // What the page's Open button and ⌘O call, with a document on screen and the welcome
      // hidden: the picker inside the gesture, before anything is awaited.
      behave.file = async () => [single];
      const picked = picks.length;
      const asked = w.w.pickFile();
      assert.strictEqual(picks.length, picked + 1, 'the page can call the picker itself, at once');
      await asked;
      assert.match(w.calls.opened.at(-1), /^web:[^/]+\/single\.md$/, 'and it opens what is picked');
      // A signal holding the same object would not tell its readers anything had changed.
      const [last, views] = [w.seen.view, w.seen.views];
      w.w.sync({});
      assert.notStrictEqual(w.seen.view, last, 'each view handed over is a new object');
      assert.strictEqual(w.seen.views, views + 1, 'and is handed over once for each change');
      console.log('✓ the welcome opens a file, offers no folder, and says what the Mac app adds');
    }

    // --- a drop ---
    {
      const w = await mount(hostW, { showOpenFilePicker: async () => [single] });
      const dragging = () => w.doc.classes.has('dropping');
      assert.ok(dragOf(w.page, 'dragenter').defaultPrevented, 'a file dragged in is taken');
      assert.ok(dragging(), 'and the page says so');
      dragOf(w.page, 'dragenter');
      dragOf(w.page, 'dragleave');
      assert.ok(dragging(), 'across the elements it passes over');
      dragOf(w.page, 'dragleave');
      assert.ok(!dragging(), 'and says no more when it leaves');
      const text = dragOf(w.page, 'dragenter', ['text/plain']);
      assert.ok(!text.defaultPrevented && !dragging(), 'a dragged selection is not its business');

      const handled = fileOf('dropped.md', '# Dropped\n\nBy handle.\n');
      const e = dropOf(w.page, [item({ getAsFileSystemHandle: async () => handled })]);
      assert.ok(e.defaultPrevented, 'a drop is not left for the browser to open in our place');
      assert.ok(!dragging(), 'and is the end of the dragging');
      await until(() => w.calls.opened.length === 1, 'the dropped file to open');
      assert.match(w.calls.opened[0], /^web:[^/]+\/dropped\.md$/, 'a handle dropped is a grant');
      assert.strictEqual(
        await w.page.backend.linkNote(w.calls.opened[0]),
        LINK_NOTE,
        'of the file alone',
      );

      const roots = stores.roots.m.size;
      dropOf(w.page, [item({ getAsFileSystemHandle: async () => folderOf('proj') })]);
      await until(() => NOT_A_FOLDER.test(w.seen.view.status), 'a dropped folder refused');
      assert.match(w.seen.view.status, /open the folder in the Mac app/, 'with where to');
      assert.deepStrictEqual(
        [w.calls.opened.length, stores.roots.m.size],
        [1, roots],
        'a folder dropped is neither opened nor granted',
      );
      // A browser with no handles gives a folder as a `File` named for it, and only the entry
      // says it is not one: without it the user would be told the folder is not markdown.
      w.w.sync({});
      dropOf(w.page, [
        item({ webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => copy('notes') }),
      ]);
      await until(() => NOT_A_FOLDER.test(w.seen.view.status), 'a folder with no handle');
      assert.strictEqual(w.calls.opened.length, 1, 'is refused as a folder too');

      const fell = copy('fell-back.md', async () => '# Fell\n');
      dropOf(w.page, [
        item({
          getAsFileSystemHandle: async () => {
            throw refusal('NotAllowedError');
          },
          getAsFile: () => fell,
        }),
      ]);
      await until(() => w.calls.opened.length === 2, 'a drop whose handle was refused');
      assert.strictEqual(w.calls.opened[1], 'drop:fell-back.md', 'is read as a copy');
      assert.strictEqual(
        await w.page.backend.linkNote('drop:fell-back.md'),
        LINK_NOTE,
        'which says why it has no links',
      );
      dropOf(w.page, [item({ getAsFile: () => copy('plain.txt', async () => 'text\n') })], []);
      await until(() => w.calls.opened.length === 3, 'a drop from a browser with no handles');
      assert.strictEqual(w.calls.opened[2], 'drop:plain.txt', 'is the same');
      dropOf(w.page, [], [copy('old.md', async () => '# Old\n')]);
      await until(() => w.calls.opened.length === 4, 'a drop that has only a file list');
      assert.strictEqual(w.calls.opened[3], 'drop:old.md', 'is the same again');

      dropOf(w.page, [item({ getAsFile: () => copy('pic.png', async () => '') })]);
      await until(() => /Redline opens markdown/.test(w.seen.view.status), 'a refusal');
      assert.strictEqual(w.calls.opened.length, 4, 'a picture dropped opens nothing');
      assert.deepStrictEqual(unhandled, [], 'and no drop left a rejection nobody handled');
      console.log('✓ a drop is a grant with a handle and a copy without one, and never a folder');
    }

    // --- no File System Access: a copy, and one history for a name ---
    {
      const w = await mount(hostW, {});
      assert.strictEqual(w.w.canFile, false, 'a browser with no picker is told so');
      assert.strictEqual(w.seen.view.canFile, false, 'and so is the page');
      assert.match(
        welcomeTsx.replace(/\s+/g, ' '),
        /\{!v\.canFile && \( <p class="welcome-hint"> This browser cannot keep a link[^<]*reads a copy[^<]*same name[^<]*continues its history/,
        'which says it is a copy, and that a name is a history',
      );
      // The input is the page's: the button is it, and so is the page's own way to the picker.
      assert.match(welcomeTsx, /const pickFile = \(\) => \(doors\.canFile \? doors\.pickFile\(\) : input\.current\?\.click\(\)\);/,
        "with no picker, Open file… is the input's");
      assert.match(welcomeTsx, /\{!v\.canFile && \(\s*<input\s+ref=\{input\}\s+type="file"\s+hidden/,
        'which is not drawn');
      assert.match(welcomeTsx, /const file = field\.files\?\.\[0\];\s*field\.value = '';\s*if \(file\) doors\.openCopy\(file\);/,
        'and is emptied as it is read, so the same file can be chosen again');

      const pick = async (n, body) => {
        const before = w.calls.opened.length;
        await w.w.openCopy({ name: n, text: async () => body, lastModified: 7 } as any);
        await until(() => w.calls.opened.length > before, `${n} to open`);
      };
      await pick('snap.md', '# Snap\n\nFirst.\n');
      await pick('snap.md', '# Snap\n\nSecond.\n');
      assert.deepStrictEqual(w.calls.opened, ['drop:snap.md', 'drop:snap.md'], 'a copy, by name');
      assert.strictEqual(w.calls.ids[0], w.calls.ids[1], 'and a file of that name is one document');
      // The copy is replaced in the worker, and read by the reader in its own time.
      const now = async () => /Second\./.test((await w.page.backend.doc()).text);
      await until(now, 'what it says now');
      assert.strictEqual(w.calls.persist, 1, 'the storage request is made once here too');
      console.log('✓ with no file picker the welcome takes a copy, and a name is one history');
    }

    // --- a grant that lapsed, and the ways out of the welcome ---
    {
      const lapsed = grantable('l.md', '# L\n\nStill here.\n');
      const hostR = startHost();
      const setup = await openPage(hostR);
      const lroot = await setup.backend.addRoot(lapsed);
      const lopen = await setup.backend.open(`web:${lroot.rootId}/l.md`);
      lapsed.state = 'prompt';

      const w = await mount(hostR, {}, lopen.id);
      await rejection(w.page.backend.doc(), 'NeedsPermission');
      assert.deepStrictEqual(w.page.asked, [{ name: 'l.md' }], 'the page is told which file');
      assert.strictEqual(w.seen.view.reopen, null, 'the welcome does not ask until told to');
      w.w.sync({ reopen: 'l.md' });
      assert.strictEqual(w.seen.view.reopen, 'l.md', 'the page says so, and it asks about it');
      assert.match(welcomeTsx, /\{v\.reopen && `Redline needs your permission to read \$\{v\.reopen\} again\.`\}/,
        'by its name');
      assert.match(
        welcomeTsx,
        /onClick=\{\(\) => doors\.reopen\(\)\}>\s*\{v\.reopen && `Reopen \$\{v\.reopen\}`\}/,
        'with a button that names it, and asks',
      );
      const reopen = { click: () => w.w.reopen() };

      lapsed.allow = false;
      await reopen.click();
      assert.strictEqual(lapsed.asked, 1, 'a click asks the user');
      assert.strictEqual(w.seen.view.status, 'Redline was not given l.md.', 'who says no');
      assert.deepStrictEqual([w.calls.granted, w.calls.persist], [0, 0], 'is not a grant');
      w.w.sync({ reopen: 'l.md' });
      assert.strictEqual(w.seen.view.status, '', 'and the page moving on clears what was said');

      lapsed.allow = true;
      await reopen.click();
      assert.strictEqual(lapsed.asked, 2, 'asked again, from the next click');
      assert.deepStrictEqual([w.calls.granted, w.calls.persist], [1, 1], 'who says yes is a grant');
      assert.match((await w.page.backend.doc()).text, /Still here\./, 'and the document is back');

      w.w.sync({});
      assert.strictEqual(w.seen.view.reopen, null, 'a page with nothing to reopen hides it');
      w.w.sync({ back: true });
      assert.strictEqual(w.seen.view.back, true, 'a page with a document to go back to offers it');
      assert.deepStrictEqual(unhandled, [], 'nothing was left unhandled');
      console.log('✓ the welcome asks again for a lapsed file, and offers the way back');
    }

    // --- a drop with a document on screen: the welcome is hidden, and stays so ---
    {
      const said = [];
      const w = await mount(hostW, { showOpenFilePicker: async () => [single] }, null, {
        hidden: true,
        hooks: { notify: (text) => said.push(text) },
      });

      dropOf(w.page, [item({ getAsFileSystemHandle: async () => folderOf('proj') })]);
      await until(() => said.length === 1, 'a folder dropped on a document to be refused');
      assert.match(said[0], NOT_A_FOLDER, 'is told so by the page');
      assert.strictEqual(w.seen.view.status, '', 'and not said where it cannot be read');

      dropOf(w.page, [item({ getAsFile: () => copy('pic.png', async () => '') })]);
      await until(() => said.length === 2, 'a picture dropped on a document to be refused');
      assert.match(said[1], /Redline opens markdown/, 'is said the same way');

      const bad = async () => {
        throw refusal('NotReadableError');
      };
      dropOf(w.page, [item({ getAsFile: () => copy('unreadable.md', bad) })]);
      await until(() => said.length === 3, 'a file that will not open to be refused');
      assert.match(said[2], /^Could not open that/, 'and so is a failure');

      const before = w.calls.opened.length;
      dropOf(w.page, [item({ getAsFile: () => copy('fine.md', async () => '# Fine\n') })]);
      await until(() => w.calls.opened.length === before + 1, 'a markdown file to open');
      assert.deepStrictEqual(
        [said.length, w.seen.view.status],
        [3, ''],
        'a file that opens is just opened: no notice, and nothing for the welcome to say',
      );
      assert.deepStrictEqual(unhandled, [], 'and none of it left a rejection nobody handled');
      console.log('✓ a drop on a document: a notice for a folder or a refusal, never the welcome');
    }

    // --- the open files: what the web app keeps where a window has its shell's tabs ---
    {
      const { createOpenFiles, storageOf, OPEN_KEY } = await import(
        './src/hosts/web/open-files.js'
      );
      // The two calls open-files makes of a Storage, and the Map behind them for a test to read.
      const store = () => {
        const m = new Map();
        return {
          m,
          getItem: (k) => (m.has(k) ? m.get(k) : null),
          setItem: (k, v) => void m.set(k, String(v)),
        } as unknown as Storage & { m: Map<string, string> };
      };
      const entry = (id, rel) => ({
        id,
        path: `web:r/${rel}`,
        name: rel.split('/').pop(),
        dir: 'shelf',
        label: `shelf/${rel}`,
      });
      const shared = store();
      const tabA = store();
      const a = createOpenFiles({ tab: tabA, shared });
      assert.deepStrictEqual(
        [a.list(), a.closedAll()],
        [[], false],
        'a first visit has nothing open, and has not closed everything either',
      );
      assert.ok(a.note(entry('1', 'a.md')) && a.note(entry('2', 'b.md')), 'files join the list');
      assert.ok(a.note(entry('3', 'c.md')), 'in the order they were opened');
      assert.strictEqual(a.note(entry('1', 'a.md')), false, 'one open already is not added twice');
      assert.ok(
        a.note({ ...entry('1', 'a.md'), dir: 'shelf2', label: 'shelf2/a.md' }),
        'but is relabelled, in place',
      );
      assert.deepStrictEqual(
        a.list().map((t) => [t.id, t.dir]),
        [['1', 'shelf2'], ['2', 'shelf'], ['3', 'shelf']],
        'so the list is what was opened, in order, each once',
      );
      a.list()[0].name = 'scribbled';
      assert.strictEqual(a.list()[0].name, 'a.md', 'and what it hands out is a copy');

      const again = createOpenFiles({ tab: tabA, shared });
      assert.deepStrictEqual(again.list(), a.list(), 'a reload of the tab has its list back');
      const tabB = store();
      const b = createOpenFiles({ tab: tabB, shared });
      assert.deepStrictEqual(
        b.list(),
        a.list(),
        'a tab with none of its own starts from the last list any tab kept, as a bare visit does',
      );
      b.note(entry('4', 'd.md'));
      assert.strictEqual(
        createOpenFiles({ tab: tabA, shared }).list().length,
        3,
        'and after that each tab keeps its own',
      );

      assert.strictEqual(a.close('2').id, '3', 'closing one goes to the file after it');
      assert.strictEqual(a.close('3').id, '1', 'or, closing the last, to the one before');
      assert.strictEqual(a.close('nope'), null, 'a file not in the list closes nothing');
      assert.strictEqual(a.closedAll(), false, 'one left is not none');
      assert.strictEqual(a.close('1'), null, 'and the last of them leaves nothing to go to');
      assert.strictEqual(a.closedAll(), true, 'which is every file closed');
      assert.strictEqual(
        createOpenFiles({ tab: tabA, shared }).closedAll(),
        true,
        'and stays so on a reload, so a bare address does not hand the closed one back',
      );

      tabA.m.set(OPEN_KEY, '{not json');
      shared.m.set(OPEN_KEY, JSON.stringify([entry('5', 'e.md'), { id: 6 }, null]));
      assert.deepStrictEqual(
        createOpenFiles({ tab: tabA, shared }).list().map((t) => t.id),
        ['5'],
        'a list that will not parse is no list, and an entry that is not one is dropped',
      );
      const refusing = {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      };
      const mem = createOpenFiles({ tab: refusing as unknown as Storage, shared: null });
      assert.ok(mem.note(entry('7', 'g.md')), 'storage that refuses is not a reason to fail');
      assert.strictEqual(mem.list().length, 1, 'the list lasts as long as the page');
      const blocked = {
        get sessionStorage() {
          throw Object.assign(new Error('blocked'), { name: 'SecurityError' });
        },
      };
      assert.strictEqual(storageOf(blocked, 'sessionStorage'), null, 'nor is storage blocked');

      const page = await openPage(hostW);
      assert.deepStrictEqual(
        page.backend.openFiles.list(),
        [],
        'the web backend has a list, off its window\'s storage, which a test window has none of',
      );
      assert.deepStrictEqual(unhandled, [], 'and none of it left a rejection nobody handled');
      console.log('✓ the web app keeps the files a tab has open, per tab, and what was closed');
    }
  }

  for (const p of pages) p.backend.close();
  for (const h of hosts) h.close();
  process.off('unhandledRejection', onUnhandled);

  // --- wired up ------------------------------------------------------------------------
  const read = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const pageBackend = read('./public/backend.ts');
  assert.ok(
    pageBackend.indexOf('__REDLINE_HOST') < pageBackend.indexOf('__REDLINE_WEB') &&
      /__REDLINE_WEB\)[\s\S]*?import\('\.\/vendor\/backend-web\.js'\)/.test(pageBackend),
    'createBackend picks the web backend, after the shell and before http',
  );
  const buildWeb = read('./scripts/build-web.mts');
  assert.match(buildWeb, /hosts\/web\/backend\.ts.*backend-web\.js/, 'backend-web.js is built');
  assert.match(buildWeb, /hosts\/web\/worker\.ts.*reader-worker\.js/, 'reader-worker.js is built');
  assert.match(
    read('./scripts/stage-page.mts'),
    /web: \{\s*bundles: \['backend-web\.js', 'reader-worker\.js'\]/,
    'and they are the web host\'s, which is what keeps them out of the desktop app (12e)',
  );
  const workerSrc = read('./src/hosts/web/worker.ts');
  assert.match(
    workerSrc,
    /SharedWorkerGlobalScope[\s\S]*onconnect = \(e\) => host\.connect\(e\.ports\[0\]\)/,
    'a SharedWorker connects each port to the host, and only a SharedWorker does',
  );
  const backendSrc = read('./src/hosts/web/backend.ts');
  assert.match(
    backendSrc,
    /new globalThis\.SharedWorker\(WORKER_URL, \{ type: 'module', name: workerName\(\) \}\)/,
    'the page joins the one worker named for its build (12e)',
  );
  assert.ok(
    /inner\.bye\(\)/.test(backendSrc) &&
      /addEventListener\?\.\('pagehide', onPageHide\)/.test(backendSrc) &&
      /if \(!e\.persisted\) return;\s+port\.postMessage\(\{ t: 'hello'/.test(backendSrc) &&
      /addEventListener\?\.\('pageshow', onPageShow\)/.test(backendSrc),
    'the page says bye as it hides, and hello as it comes back from the cache',
  );
  assert.ok(
    /\.requestPermission\(/.test(backendSrc) && !/\.requestPermission\(/.test(workerSrc),
    'only the page asks the user for a permission: it needs a window and a click',
  );
  {
    const code = backendSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.deepStrictEqual(
      code.match(/\b(?:setInterval|setTimeout|Date\.now)\b/g),
      ['setInterval'],
      'the page has one timer in it, and no clock of its own',
    );
    assert.match(
      code,
      /setInterval\(\(\) => port\.postMessage\(\{ t: 'ping' \}\), pingMs\)/,
      'and it is the ping',
    );
  }
  for (const bundle of ['backend-web.js', 'reader-worker.js']) {
    const file = rootUrl(`public/vendor/${bundle}`);
    assert.ok(fs.existsSync(file), `build:web writes ${bundle}`);
    assert.ok(!/node:/.test(fs.readFileSync(file, 'utf8')), `${bundle} imports nothing from node`);
  }
  assert.ok(
    !read('./public/vendor/backend-web.js').includes('unreadable') &&
      read('./public/vendor/reader-worker.js').includes('unreadable'),
    'the page\'s half is not the reader, which is in the worker\'s',
  );
  console.log('✓ the web backend is picked by createBackend, built, and not staged into the app');

  // --- the page's wiring to the welcome and to caps (test #12) -------------------------------
  // The tests above prove the welcome works; none of them runs app.js, which needs a DOM. So the
  // seams are read: a welcome that is correct and unreachable would pass every one of them.
  {
    const main = pageHtml.slice(pageHtml.indexOf('<main'), pageHtml.indexOf('</main>'));
    assert.match(
      main,
      /<section id="welcome" class="welcome" hidden><\/section>/,
      '#welcome is in the page, in main, and starts hidden',
    );
    assert.match(pageHtml, /<div id="notice" class="notice" role="status" hidden><\/div>/);
    // An author `display` beats `[hidden]` (CLAUDE.md, thing 3): each thing that is toggled with
    // the attribute needs its own rule, and the welcome's children share one.
    for (const [sel, rule] of [
      ['#welcome', /\.welcome\[hidden\],\s*\.welcome \[hidden\]\s*\{\s*display: none;/],
      ['#notice', /\.notice\[hidden\]\s*\{\s*display: none;/],
      ['the git option', /\.seg label\[hidden\]\s*\{\s*display: none;/],
      ['the document', /\.markdown-body\[hidden\]\s*\{\s*display: none;/],
    ] as const) {
      assert.match(pageCss, rule, `${sel} has a [hidden] rule of its own`);
    }

    assert.ok(
      /const welcome = backend\.welcome\?\.\(\{/.test(appJs) &&
        /open: \(path\) => openFile\(path\),\s*granted: \(\) => reopened\(\),/.test(appJs) &&
        /show: \(view\) => \(welcomeView\.value = view\),/.test(appJs),
      "the page gives the backend's welcome a way to open what it is handed, and to be drawn",
    );
    assert.match(
      appJs,
      /const pickFile = welcome \? mountWelcome\(welcomeEl, welcome, \(\) => backToDocument\(\)\) : null;/,
      'which ui/Welcome.tsx draws into the section, and only where there is one',
    );
    assert.match(read('./public/app/ui/Welcome.tsx'), /const v = welcomeView\.value;/,
      'from the view the backend last handed over');
    assert.ok(
      /!welcome \|\| !\['NoDocument', 'NeedsPermission'\]\.includes\(err\?\.name\)/.test(appJs) &&
        new RegExp(
          String.raw`if \(err\.name === 'NoDocument'\) \{[^}]*?closeDocument\(\);\s*\} ` +
            String.raw`else \{\s*showWelcome\(\{ reopen: welcomeAsks \?\? 'this file' \}\);`,
        ).test(appJs),
      'a document that is none, or must be asked for again, shows the welcome, and only with one',
    );
    assert.match(
      appJs,
      /backend\.onNeedsPermission\?\.\(\(\{ name \}\) => showWelcome\(\{ reopen: name \}\)\);/,
      'the backend naming a lapsed file shows it, with its name',
    );
    assert.match(appJs, /hideWelcome\(\);\s*(?:\/\/[^\n]*\s*)*paint\((?:\{ reuse: keepScroll \})?\);/,
      'and a document that paints hides it');
    const hooks = appJs.match(/backend\.welcome\?\.\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
    assert.ok(
      /notify: \(text\) => notify\(text\),/.test(hooks) &&
        /showing: \(\) => !welcomeEl\.hidden,/.test(hooks),
      'a drop on a document is answered by the notice, and never puts the welcome up',
    );
    assert.match(
      appJs,
      /doc\.replaceChildren\(\);\s*clearSidebars\(\);/,
      'a document that is none takes Contents and History with it',
    );
    const clearing = appJs.match(/function clearSidebars\(\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
    assert.deepStrictEqual(
      clearing.trim().split('\n').map((l) => l.trim()),
      ['paintToc(null);', 'paintHistory(null);'],
      // Both lists are Preact's, and empty themselves on null; a replaceChildren under either
      // would leave Preact diffing against rows that are no longer there.
      'which resets what they keep and empties their lists',
    );
    assert.ok(
      /\n\.welcome-limits a \{\s*color: var\(--mod\);/.test(pageCss) &&
        !/\.?welcome-(list|folder|files?)\b/.test(
          pageCss + read('./src/hosts/web/welcome.ts') + read('./public/app/ui/Welcome.tsx'),
        ),
      'the way to the Mac app is drawn as a link, and the folder list the welcome had is gone',
    );
    assert.match(
      appJs,
      /const why = await backend\.linkNote\?\.\(state\.data\?\.path\);\s*if \(why\) notify\(why\);/,
      'a link a file cannot follow says why, rather than doing nothing',
    );

    // The way from a document to another file, which only the web app has: Open file… at the
    // foot of the open files, and ⌘O. The bar has no button of its own for it.
    assert.ok(
      ![pageHtml, appJs, pageCss].some((src) => /openBtn/.test(src)),
      'there is no Open button by the name',
    );
    assert.match(
      appJs,
      /e\.key === 'Escape' && prefsOpen\.value === null\) backToDocument\(\);/,
      'Escape goes back to the document, and does not when it is closing Settings',
    );
    assert.match(
      appJs,
      /if \(welcome && e\.code === 'KeyO' && \(e\.metaKey \|\| e\.ctrlKey\)[^{]*\{\s*e\.preventDefault\(\);\s*if \(prefsOpen\.value === null\) pickFile\(\);/,
      '⌘O is the same, in the web app alone: a window has File ▸ Open…',
    );
    assert.ok(
      /welcome: \(hooks\) => mountWelcome\(\{ backend: api, win, \.\.\.hooks \}\)/.test(backendSrc) &&
        ['./src/hosts/tauri/backend.ts', './public/backend.ts', './src/rpc/client.ts'].every(
          (f) => !/welcome|linkNote/.test(read(f)),
        ),
      'only the web backend has a welcome, so the page never shows one in a shell or a server',
    );

    // P7: what the host cannot do is not offered.
    assert.match(
      settingsTsx,
      /\{ value: 'git', text: 'git HEAD', id: 'setBaselineGit', hidden: !git \}/,
      'the git baseline option is in the sheet, hidden but where there is git',
    );
    assert.strictEqual((pageHtml + appJs).match(/value: 'git'|value="git"/g).length, 1,
      'and nothing else offers git');
    assert.match(appJs, /state\.caps = data\.caps \?\? null;/,
      'every payload says what the reader can do');
    assert.match(settingsTsx, /const git = Boolean\(state\.caps\?\.git\);/,
      'the git option is shown on caps.git and on nothing else, and unknown is none',
    );
    assert.match(
      settingsTsx,
      /value=\{s\.baseline === 'git' && git \? 'git' : 'read'\}/,
      'and a saved choice of git is not shown as made where there is none',
    );

    // The shim: what makes this the web app, and what must not.
    assert.strictEqual(
      read('./src/hosts/web/host.js').replace(/\/\/.*$/gm, '').trim(),
      'globalThis.__REDLINE_WEB = true;',
      'the web shim says one thing',
    );
    assert.ok(
      !/__REDLINE_WEB/.test(read('./public/host.js')),
      'and the one the Mac app and the CLI load does not say it',
    );
    assert.ok(
      /^<!doctype html>/i.test(pageHtml) && /src="host\.js"/.test(pageHtml.slice(0, 600)),
      'host.js is the first script in the page, where the shim has to be',
    );
    console.log('✓ the page shows #welcome with no document or a lapsed grant, and hides git');

    // The left column: the files open, the web app's as the desktop app's, and none at all in a
    // CLI tab, which is handed one file and keeps no list. Whether there is a column is known
    // before first paint, so the head script asks it as app.js does; a CLI tab that saved `side`
    // open in a desktop window's origin -- `npm run dev` is one -- would otherwise open on an
    // empty strip.
    const webAt = pageHtml.indexOf('if (globalThis.__REDLINE_WEB) document.documentElement');
    assert.ok(
      webAt > 0 && webAt < pageHtml.indexOf('const sideOn ='),
      'the head script marks the web app before it decides on the left column',
    );
    assert.match(
      pageHtml,
      /const sideOn =\s+document\.documentElement\.matches\("\.native, \.web"\) &&/,
      'and opens it only where there is one',
    );
    assert.match(
      appJs,
      /const leftColumn = document\.documentElement\.matches\('\.native, \.web'\);/,
      'which app.js asks the same way',
    );
    assert.match(
      appJs,
      /if \(e\.altKey\) setTocSide\(!state\.tocSide\);\s+else if \(leftColumn\) setSide/,
      'so that ⌘B in a CLI tab does nothing',
    );
    assert.match(
      pageCss,
      /html:not\(\.native\):not\(\.web\) #side \{\s+display: none;/,
      'and its button is not there',
    );
    const leftAside = pageHtml.slice(
      pageHtml.indexOf('<aside id="files"'),
      pageHtml.indexOf('</aside>', pageHtml.indexOf('<aside id="files"')),
    );
    assert.match(
      leftAside,
      /<section id="filesSec" class="side-sec side-grow">/,
      'Open files is the left column wherever there is one, not only in the desktop app',
    );
    assert.ok(
      !/folderSec|paintFolder|backend\.folder|data-web/.test(pageHtml + appJs + pageCss) &&
        !/async folder\(\)/.test(backendSrc),
      'and the folder list it replaces is gone, all of it',
    );
    assert.match(
      appJs,
      /const openFiles = backend\.openFiles \?\? null;\nif \(openFiles\) state\.tabs = /,
      'the page takes the web backend\'s list as its tabs',
    );
    assert.ok(
      /openFiles: createOpenFiles\(\{\s+tab: storageOf\(win, 'sessionStorage'\),/.test(
        backendSrc,
      ) && /\s+shared: storageOf\(win, 'localStorage'\),\s+\}\),/.test(backendSrc),
      'which keeps it per tab, and the last one for a bare visit',
    );
    const selectFn = appJs.match(/function selectTab\([\s\S]*?\n\}/)?.[0] ?? '';
    const closeTabFn = appJs.match(/function closeTab\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(
      /if \(native\) native\.selectTab\(id\);\s+else switchTo\(id\);/.test(selectFn) &&
        /if \(native\) native\.closeTab\(id\);\s+else closeOpen\(id\);/.test(closeTabFn),
      'a row switches and closes through the shell in a window, and through the page in a tab',
    );
    assert.deepStrictEqual(
      [/native\.selectTab\(/g, /native\.closeTab\(/g].map((re) => appJs.match(re)?.length),
      [1, 1],
      'and nothing calls the shell for it but those two, the rows and the menu included',
    );
    const loadFn = appJs.match(/async function load\([\s\S]*?\n\}/)?.[0] ?? '';
    const noteFn = appJs.match(/function noteOpen\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(
      /paint\((?:\{ reuse: keepScroll \})?\);\s+noteOpen\(\);/.test(loadFn) &&
        /if \(err\.name === 'NoDocument'\) \{[\s\S]*?closeDocument\(\);/.test(loadFn),
      'every document shown is noted, whatever opened it, and one that is gone is put down',
    );
    assert.ok(
      /if \(!openFiles\) return;/.test(noteFn) &&
        /openFiles\.note\(\{\s+id: state\.docId,\s+path: d\.path,/.test(noteFn) &&
        /=== null && state\.tabs\.length > 1\) setSide\(true, false\);/.test(noteFn),
      'into the list, which opens the column at the second file as the desktop app does',
    );
    const switchFn = appJs.match(/async function switchTo\([\s\S]*?\n\}/)?.[0] ?? '';
    const closeFn = appJs.match(/async function closeOpen\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(
      /scrollMemory\.set\(state\.docId, pane\.scrollTop\)/.test(switchFn) &&
        /await openFile\(t\.path, \{ unopened: /.test(switchFn) &&
        /pane\.scrollTo\(0, scrollMemory\.get\(id\) \?\? 0\)/.test(switchFn),
      'a switch opens the file by its path, and keeps the place in each',
    );
    assert.match(appJs, /if \(unopened\) notify\(unopened\);/, 'and says so when it cannot');
    assert.ok(
      /const next = openFiles\.close\(id\);/.test(closeFn) &&
        /if \(id !== state\.docId\) return;/.test(closeFn) &&
        /if \(next && \(await switchTo\(next\.id\)\)\) return;/.test(closeFn) &&
        /\s+closeDocument\(\{ reopen: pendingLink \? welcomeAsks : null \}\);\n\}/.test(closeFn),
      'closing the one on screen goes to its neighbour, and closing the last to the welcome',
    );
    // What the bar draws from the document is drawn by `paint`, not by the sidebars, so a close
    // that empties the sidebars and not the bar leaves a count over the welcome for no file.
    const closeDocFn = appJs.match(/function closeDocument\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(
      // The version read alone is computed from `state.data`, so letting it go is what clears it.
      /state\.data = null;/.test(closeDocFn) &&
        /paintCount\(\);\s+paintRuler\(\);/.test(closeDocFn) &&
        /setLive\(true\);/.test(closeDocFn),
      'and the welcome has no count, arrows, ruler or dropped watch left on the bar from it',
    );
    assert.ok(
      /if \(!t\) return false;/.test(switchFn) &&
        /\.name\}\.` \}\)\)\) return false;/.test(switchFn) &&
        /\n  return true;\n\}$/.test(switchFn) &&
        /showWelcome\(\{ reopen \}\);/.test(appJs),
      'as does a neighbour that will not open, still asking for its folder if that is why',
    );
    assert.match(
      appJs,
      new RegExp(
        String.raw`if \(welcome\) \{[\s\S]{0,600}` +
          String.raw`\$\('newTab'\)\.addEventListener\('click', \(\) => pickFile\(\)\);`,
      ),
      'Open file… at the foot of the list is the file picker too',
    );
    assert.ok(
      /if \(!keepScroll \|\| welcomeAsks\) hideWelcome\(\);\s+(?:\/\/[^\n]*\s+)*paint\((?:\{ reuse: keepScroll \})?\);/.test(loadFn) &&
        (appJs.match(/hideWelcome\(\);/g) ?? []).length === 2,
      'a document opened takes the welcome down, and the one on screen read again does not',
    );
    assert.match(
      appJs,
      new RegExp(
        String.raw`\} else \{[^}]*?` +
          String.raw`if \(!state\.docId && openFiles\?\.closedAll\(\)\) \{` +
          String.raw`[^}]*?showWelcome\(\);\s+\} else if \(await load\(`,
      ),
      'drawn before the first load, and a tab that closed everything is not handed one back',
    );
    console.log('✓ the left column lists the files open in the web app, and is not in a CLI tab');
  }
}

// --- 12e. the web app's build: one page staged per host, and the headers a static host needs ---
// stage-page.mts is the body of build:dist with the host as a parameter, so the desktop app's page
// has to be what it always was, and the web app's the same page with the other reader in it.
// build:webapp adds `_headers`, which is what makes a static host say what the CLI's server says.
// What no test here can say is whether Cloudflare Pages serves Mermaid's .mjs chunks as
// text/javascript, which a module script needs, or whether a browser keeps two builds' workers
// apart by name: those are for the first deploy and a person with a browser to show.
{
  const vm = await import('node:vm');
  const { HOSTS, stagePage, assertSafeDest, bundleHash } = await import('./scripts/stage-page.mjs');
  const { buildWebapp, headersFile } = await import('./scripts/build-webapp.mjs');
  const { createWebappServer } = await import('./scripts/serve-webapp.mjs');
  const { createSiteServer } = await import('./scripts/serve-site.mjs');
  const { workerName, openPort } = await import('./src/hosts/web/backend.js');
  const read = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const version = JSON.parse(read('./package.json')).version;
  const out = fs.mkdtempSync(path.join(tmp, 'stage-'));
  const walk = (dir, rel = '') =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
    );
  /** What running a staged host.js leaves on the window. */
  const shimOf = (dir) => {
    const win = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(dir, 'host.js'), 'utf8'), win);
    return win;
  };

  // --- stage-page: a host gets its own reader and nobody else's -------------------------------
  const stagedTauri = stagePage(path.join(out, 'tauri'), { host: 'tauri' });
  const stagedWeb = stagePage(path.join(out, 'web'), { host: 'web' });
  const [tauri, web] = [stagedTauri.dest, stagedWeb.dest];
  const [inTauri, inWeb] = [walk(tauri), walk(web)];
  const vendorOf = (list) =>
    list.filter((f) => /^vendor\/[^/]+$/.test(f)).map((f) => f.slice('vendor/'.length)).sort();
  const shared = [
    'github-markdown.css',
    'hljs-dark.css',
    'hljs-light.css',
    'render.js',
    'sanitize.js',
  ];
  assert.deepStrictEqual(vendorOf(inTauri), [...shared, 'backend-tauri.js'].sort(),
    'the desktop app gets the Tauri backend, and neither of the web app\'s bundles');
  assert.deepStrictEqual(vendorOf(inWeb), [...shared, 'backend-web.js', 'reader-worker.js'].sort(),
    'the web app gets its page end and its worker, and not the Tauri backend');
  const pageFiles = ['app.js', 'backend.js', 'host.js', 'icon.svg', 'index.html', 'styles.css'];
  for (const list of [inTauri, inWeb]) {
    assert.deepStrictEqual(list.filter((f) => !f.includes(path.sep)).sort(), pageFiles,
      'the page and nothing else sits at the top');
  }
  const mermaidOf = (list) => list.filter((f) => f.startsWith(`vendor${path.sep}mermaid`)).sort();
  assert.ok(mermaidOf(inWeb).length > 10, 'Mermaid\'s tree is there for a document that draws');
  assert.deepStrictEqual(mermaidOf(inWeb), mermaidOf(inTauri), 'and is the same tree in both');
  assert.ok(mermaidOf(inWeb).every((f) => /\.mjs$/.test(f)), 'of modules, and nothing that is not');
  // The three that name other files of the page are the web app's own, with `?v=` in them: see
  // "the web app asks for every file by its build", below, for what is in them.
  const versioned = ['app.js', 'backend.js', 'index.html'];
  const sameInBoth = [
    ...pageFiles.filter((f) => f !== 'host.js' && !versioned.includes(f)),
    ...shared.map((s) => `vendor/${s}`),
  ];
  for (const f of sameInBoth) {
    assert.ok(
      fs.readFileSync(path.join(web, f)).equals(fs.readFileSync(path.join(tauri, f))),
      `${f} is the same bytes in both`,
    );
  }
  for (const f of versioned) {
    const text = (dir) => fs.readFileSync(path.join(dir, f), 'utf8');
    assert.strictEqual(text(web).replace(/\?v=[0-9a-f]{12}/g, ''), text(tauri),
      `${f} is the desktop app's with a query put in, and nothing else`);
    assert.notStrictEqual(text(web), text(tauri), `${f} has the query`);
  }
  assert.strictEqual(stagedTauri.version, null, 'and the desktop app\'s page is not versioned');
  assert.doesNotMatch(
    walk(tauri).filter((f) => /\.(?:js|html)$/.test(f) && !f.includes('mermaid'))
      .map((f) => fs.readFileSync(path.join(tauri, f), 'utf8')).join('\n'),
    /\?v=[0-9a-f]{12}/,
    'no file of it has one',
  );
  assert.ok(
    fs.readFileSync(path.join(tauri, 'host.js')).equals(
      fs.readFileSync(rootUrl('public/host.js')),
    ),
    'the desktop app\'s shim is the repository\'s, which says nothing',
  );
  assert.deepStrictEqual(Object.keys(shimOf(tauri)), [], 'and sets nothing on the window');
  const webWin = shimOf(web);
  assert.strictEqual(webWin.__REDLINE_WEB, true, 'the web app\'s shim says it is the web app');
  assert.ok(webWin.__REDLINE_VERSION.startsWith(`${version}+`), 'and which build');
  fs.writeFileSync(path.join(web, 'stale.txt'), 'a file that stopped being part of the page');
  stagePage(web, { host: 'web' });
  assert.ok(!fs.existsSync(path.join(web, 'stale.txt')), 'restaging empties the directory first');
  assert.throws(
    () => stagePage(path.join(out, 'nowhere'), { host: 'nope' as unknown as HostName }),
    /no host called nope/,
    'and a host that is not one of them is an error, not an empty directory',
  );
  assert.match(read('./scripts/build-dist.mts'), /stagePage\('shell\/dist', \{ host: 'tauri' \}\)/,
    'build:dist is stagePage for the Tauri host');
  assert.match(read('./scripts/build-webapp.mts'), /stagePage\(dest, \{ host: 'web' \}\)/,
    'and build:webapp is stagePage for the web');
  console.log('✓ stage-page gives each host its own reader, and the desktop page is as it was');

  // --- stage-page empties what it is given, so it is not given the repository -----------------
  // The guard is asked about the repository, and `stagePage` never is: were it ever to regress,
  // the test that called `stagePage('.')` would be what deleted the repository, .git and all.
  const repo = ROOT;
  const refused = (dir, root?) => assert.throws(
    () => assertSafeDest(dir, root),
    (err: Error) => err.message.includes(dir) && /refusing to empty/.test(err.message),
    `${dir} is refused, by name`,
  );
  for (const dir of [
    repo,
    path.resolve(repo, ''),
    path.resolve(repo, '.'),
    path.resolve(repo, '..'),
    path.dirname(path.dirname(repo)),
    path.parse(repo).root,
  ]) refused(dir);
  refused('/x', '/x/..foo'); // `..foo` is a name, and the repository is in it: not a way up
  const [shellDist, distWeb] = [path.join(repo, 'shell', 'dist'), path.join(repo, 'dist', 'web')];
  for (const dir of [
    shellDist,
    distWeb,
    path.join(repo, '..foo'),
    path.join(path.dirname(repo), 'beside-the-repository'),
    out,
    web,
  ]) assert.doesNotThrow(() => assertSafeDest(dir), `${dir} is somewhere to put a build`);
  assert.doesNotThrow(() => assertSafeDest('/x/..foo', '/x'), '`..foo` inside it is fine');
  const stageSrc = read('./scripts/stage-page.mts');
  const stageBody = stageSrc.slice(stageSrc.indexOf('export function stagePage'));
  assert.ok(
    stageBody.indexOf('assertSafeDest(out);') > 0 &&
      stageBody.indexOf('assertSafeDest(out);') < stageBody.indexOf('fs.rmSync(out'),
    'and stagePage asks before it removes anything, not after',
  );
  assert.match(
    stageSrc,
    /is missing \$\{file\} — run npm run build:web first/,
    'and a missing file, app.js or a bundle, points at the step that writes it',
  );
  console.log('✓ stagePage will not empty the repository, or anything that holds it');

  // --- _headers: the hash is of what is staged, and the worker may load ----------------------
  const builtApp = buildWebapp(path.join(out, 'app'));
  const built = builtApp.dest;
  const stagedHtml = fs.readFileSync(path.join(built, 'index.html'), 'utf8');
  const headerText = fs.readFileSync(path.join(built, '_headers'), 'utf8');
  const headerLines = headerText.split('\n');
  /** `_headers` as `Map { path => { header: value } }`: a path starts a rule, an indent goes on. */
  const rulesOf = (text) => {
    const rules = new Map();
    let current = null;
    for (const l of text.split('\n')) {
      if (!l.trim() || l.trim().startsWith('#')) continue;
      if (!/^\s/.test(l)) rules.set(l.trim(), (current = {}));
      else current[l.slice(0, l.indexOf(':')).trim()] = l.slice(l.indexOf(':') + 1).trim();
    }
    return rules;
  };
  const headerRules = rulesOf(headerText);
  assert.strictEqual(headerLines[0], '/*', 'the first rule is for every path -- the worker\'s too');
  const rule = headerRules.get('/*');
  assert.deepStrictEqual(
    Object.keys(rule),
    ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy'],
    'a policy, and the two headers that keep a response from being read as something else, and ' +
      'nothing about caching: that is for the paths it is true of',
  );
  assert.strictEqual(rule['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(rule['Referrer-Policy'], 'no-referrer');
  const stagedInline = [...stagedHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(stagedInline.length, 1, 'the staged page has the one inline script');
  const stagedHash = crypto.createHash('sha256').update(stagedInline[0]).digest('base64');
  const webCsp = policy(rule['Content-Security-Policy']);
  assert.deepStrictEqual(webCsp['script-src'], ["'self'", `'sha256-${stagedHash}'`],
    'script from here, and the staged head script by its hash');
  assert.deepStrictEqual(webCsp['worker-src'], ["'self'"],
    'and worker-src, which the reader\'s SharedWorker is governed by');
  const { 'worker-src': _workers, ...theRest } = webCsp;
  assert.deepStrictEqual(theRest, servedCsp, 'every other directive is the CLI\'s, as served');
  assert.notStrictEqual(
    headersFile(stagedHtml.replace('<script>', '<script>/* edited */')),
    headerText,
    'the hash follows the page it is given, so an edit to the head script changes it',
  );
  assert.ok(headerLines.every((l) => l.length <= 2000), 'no line is longer than Pages reads');
  assert.match(read('./scripts/build-webapp.mts'),
    /readFileSync\(path\.join\(staged\.dest, 'index\.html'\)/,
    'and it is read from the staged page, after the shim is over host.js, not from public/');
  assert.ok(/^dist\/$/m.test(read('./.gitignore')), 'dist/web is build output, not source');
  console.log('✓ _headers: the hash is the staged head script\'s, and worker-src is there');

  // --- _headers: index.html is asked about every time, everything else is kept ----------------
  // The page's files are asked for as `?v=<build>`, so each URL is one file for ever and the
  // browser may keep it for as long as it will. The one URL that is the same in every build is
  // the page, and it is what says which build the rest are, so it is asked about each time: if it
  // were kept, no release would be seen, which is the thing all of this is for.
  {
    const held = 'public, max-age=31536000, immutable';
    const topLevel = fs.readdirSync(built, { withFileTypes: true })
      .filter((e) => e.name !== 'index.html' && e.name !== '_headers')
      .map((e) => (e.isDirectory() ? `/${e.name}/*` : `/${e.name}`));
    assert.ok(topLevel.includes('/app.js') && topLevel.includes('/vendor/*'), 'files, and folders');
    assert.deepStrictEqual(headerRules.get('/'), { 'Cache-Control': 'no-cache' },
      'the page, asked for as the bare address, is revalidated each time');
    assert.deepStrictEqual(headerRules.get('/index.html'), { 'Cache-Control': 'no-cache' },
      'and by its name');
    for (const p of topLevel) {
      assert.deepStrictEqual(headerRules.get(p), { 'Cache-Control': held },
        `${p} is kept for a year, and never asked about again`);
    }
    assert.deepStrictEqual(
      [...headerRules.keys()].sort(),
      ['/*', '/', '/index.html', ...topLevel].sort(),
      'and no path has a rule that is not one of those: nothing is held that is not versioned',
    );
    assert.strictEqual(
      [...headerRules.values()].filter((r) => r['Cache-Control'] === held).length,
      topLevel.length,
      'index.html is not one of the paths kept',
    );
    assert.strictEqual(held.match(/max-age=(\d+)/)[1], String(365 * 24 * 60 * 60), 'a year');
    assert.strictEqual(rulesOf(headersFile(stagedHtml)).size, 1,
      'with no paths to keep, there is the one rule and no caching, as there was');
    assert.match(read('./scripts/build-webapp.mts'),
      /headersFile\(html, heldPaths\(staged\.dest\)\)/,
      'and build:webapp gives it what it staged');
    console.log('✓ _headers: index.html is revalidated, and every other path is kept for a year');
  }

  // --- the build is its version and the bundles the reader is made of -------------------------
  // A version alone is the same across every rebuild at that version, and each of those is new
  // reader code that a tab left open would keep alive for the new tabs to join.
  const bundlesOf = (dir) =>
    ['backend-web.js', 'reader-worker.js'].map((f) => fs.readFileSync(path.join(dir, 'vendor', f)));
  const build = `${version}+${bundleHash(bundlesOf(web))}`;
  assert.strictEqual(shimOf(web).__REDLINE_VERSION, build,
    'the staged shim carries the version and the hash of the two staged bundles');
  assert.strictEqual(shimOf(built).__REDLINE_VERSION, build, 'and build:webapp\'s page the same');
  assert.match(build, /^\d+\.\d+\.\d+\S*\+[0-9a-f]{12}$/, 'written 0.7.0+3fa9c2d1e0b4');
  const [first, second] = [Buffer.from('the reader'), Buffer.from('its page end')];
  const hashed = bundleHash([first, second]);
  assert.strictEqual(bundleHash([Buffer.from('the reader'), Buffer.from('its page end')]), hashed,
    'the same bytes are the same name, so a rebuild that changed nothing starts no new worker');
  assert.notStrictEqual(bundleHash([Buffer.from('the reader!'), second]), hashed,
    'a byte of the first bundle changes it');
  assert.notStrictEqual(bundleHash([first, Buffer.from('its page end!')]), hashed,
    'and a byte of the second');
  assert.notStrictEqual(bundleHash([second, first]), hashed, 'and the order they are in');
  assert.notStrictEqual(
    bundleHash([Buffer.from('the reade'), Buffer.from('rits page end')]),
    hashed,
    'and a byte moved over the join, which a bare concatenation would not see',
  );
  assert.deepStrictEqual(HOSTS.web.bundles, ['backend-web.js', 'reader-worker.js'],
    'the two the web app loads are the two that are hashed, in this order');
  console.log('✓ the build is the version and a hash of the bundles the reader is made of');

  // --- the worker is named for the build -------------------------------------------------
  assert.strictEqual(workerName({}), 'redline@dev', 'a page nobody built says dev');
  assert.strictEqual(workerName(webWin), `redline@${build}`,
    'the staged shim is what names it: this build, bundles and all');
  const joined = [];
  globalThis.SharedWorker = class {
    declare port: object;
    constructor(url, opts) {
      joined.push({ url: String(url), opts });
      this.port = {};
    }
  };
  try {
    await openPort();
    globalThis.__REDLINE_VERSION = '9.9.9+0123456789ab';
    await openPort();
  } finally {
    delete globalThis.SharedWorker;
    delete globalThis.__REDLINE_VERSION;
  }
  assert.deepStrictEqual(
    joined.map((j) => j.opts),
    [
      { type: 'module', name: 'redline@dev' },
      { type: 'module', name: 'redline@9.9.9+0123456789ab' },
    ],
    'the page joins the worker of its own build, so a deploy does not hand it an old reader',
  );
  assert.ok(joined.every((j) => j.url.endsWith('/reader-worker.js')), 'at the bundle beside it');
  console.log('✓ the worker is named for the build, by the shim the build stages');

  // --- served from anywhere: nothing in the staged page reaches for the root ----------------
  // The page names its own files relative to itself, and the worker bundle finds its reader by
  // `import.meta.url`, so dist/web works from any directory of any static host and not only from
  // the root of the hostname it is published at. A URL that starts with a slash would break that
  // quietly, on the one host that serves it from a path. The `/api/...` calls in backend.js are
  // the http backend's, which `__REDLINE_WEB` never reaches.
  {
    const staged = (f) => fs.readFileSync(path.join(built, f), 'utf8');
    assert.doesNotMatch(staged('index.html'), /\b(?:src|href|action)="\/[^/]/, 'index.html');
    assert.doesNotMatch(staged('styles.css'), /url\(\s*['"]?\/[^/]/, 'the stylesheet');
    for (const f of ['app.js', 'vendor/backend-web.js', 'vendor/reader-worker.js']) {
      assert.doesNotMatch(
        staged(f),
        /(?:\bimport\(|\bfrom\s+|new URL\(|new (?:Shared)?Worker\()\s*['"]\/[^/]/,
        `${f} imports and loads nothing from the root`,
      );
    }
    // Names are mangled in the bundle, so this is the shape of `sibling` and not its name: a URL
    // made against a base that defaults to the bundle's own, from the one file's name.
    assert.match(
      staged('vendor/backend-web.js'),
      /\w+\(\w+,\w+=import\.meta\.url\)\{let \w+=new URL\(\w+,\w+\);return \w+\.search=/,
      'and finds its reader beside itself',
    );
    assert.match(staged('vendor/backend-web.js'), /=\w+\(["']\.\/reader-worker\.js["']\)/);
    console.log('✓ the staged web app names its files relative to itself, so any path serves it');
  }

  // --- the web app asks for every file by its build, so that it can be kept for a year ---------
  // `?v=<build>` is in the URL of everything the page loads, and the headers say a URL with one is
  // never anything else. A relative import does not take its importer's query, so what is tested
  // is not that `app.js` has one but that nothing it loads is without: the page, the imports of
  // the files that are not bundled, and the worker, whose URL is made inside the bundle.
  {
    const { pageHash } = await import('./scripts/stage-page.mjs');
    const { sibling } = await import('./src/hosts/web/backend.js');
    const { version: v } = builtApp;
    const staged = (f) => fs.readFileSync(path.join(built, f), 'utf8');
    assert.match(v, /^[0-9a-f]{12}$/, 'the build is 12 hex, in the URL as `?v=3fa9c2d1e0b4`');
    assert.strictEqual(v, stagedWeb.version, 'and the same page is the same build, wherever it is');

    // ... the id is of the page, byte by byte and name by name, and not of when it was made
    const probe = fs.mkdtempSync(path.join(tmp, 'hash-'));
    fs.mkdirSync(path.join(probe, 'vendor'));
    fs.writeFileSync(path.join(probe, 'app.js'), 'the page');
    fs.writeFileSync(path.join(probe, 'vendor', 'x.js'), 'a bundle');
    const id = pageHash(probe, '0.7.0');
    assert.strictEqual(pageHash(probe, '0.7.0'), id, 'the same page is the same id');
    assert.notStrictEqual(pageHash(probe, '0.7.1'), id, 'a new version is a new id, by itself');
    fs.writeFileSync(path.join(probe, 'vendor', 'x.js'), 'a bundle!');
    assert.notStrictEqual(pageHash(probe, '0.7.0'), id, 'a byte of any file is a new one');
    fs.writeFileSync(path.join(probe, 'vendor', 'x.js'), 'a bundle');
    assert.strictEqual(pageHash(probe, '0.7.0'), id, 'and putting it back puts the id back');
    fs.renameSync(path.join(probe, 'vendor', 'x.js'), path.join(probe, 'vendor', 'y.js'));
    assert.notStrictEqual(pageHash(probe, '0.7.0'), id, 'as does the same file under another name');
    fs.renameSync(path.join(probe, 'vendor', 'y.js'), path.join(probe, 'vendor', 'x.js'));
    fs.writeFileSync(path.join(probe, 'app.js'), 'the pag');
    fs.writeFileSync(path.join(probe, 'vendor', 'x.js'), 'ea bundle');
    assert.notStrictEqual(pageHash(probe, '0.7.0'), id, 'and a byte moved to the next file');

    // ... every file index.html names is asked for by it, and exists
    const publicHtml = read('./public/index.html');
    const own = (html) =>
      [...html.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)="([^"]*)"/g)]
        .map((m) => m[1]).filter((u) => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u));
    const refs = own(stagedHtml);
    assert.deepStrictEqual(
      refs.map((u) => u.replace(/\?v=.*/, '')).sort(),
      own(publicHtml).sort(),
      'every file the page names is named in the staged one, and none is added',
    );
    assert.ok(refs.length >= 8, 'the script, the icon (twice), four stylesheets and the module');
    for (const u of refs) {
      assert.ok(u.endsWith(`?v=${v}`), `${u} asks for this build`);
      assert.ok(fs.existsSync(path.join(built, u.replace(/\?.*/, ''))), `${u} is a file`);
    }
    assert.doesNotMatch(stagedHtml, /(?:src|href)="(?:[a-z]+:|#)[^"]*\?v=/,
      'and nothing that is not the page\'s is asked for with one');
    const inlineOf = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.deepStrictEqual(inlineOf(stagedHtml), inlineOf(publicHtml),
      'the head script is as it was, so what the policy has hashed is what runs');

    // ... and what the files import, which is not inherited, is asked for the same way
    const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]+)\1/g;
    const loaded = walk(built).filter((f) => /\.js$/.test(f) && !f.includes('mermaid'));
    assert.deepStrictEqual(
      loaded.sort(),
      ['app.js', 'backend.js', 'host.js', 'vendor/backend-web.js', 'vendor/reader-worker.js',
        'vendor/render.js', 'vendor/sanitize.js'].map((f) => f.split('/').join(path.sep)).sort(),
      'these are the modules there are to look in',
    );
    // A filter on `.ts` alone let public/app/ui/History.tsx through: the bundle is what ships.
    assert.deepStrictEqual(walk(built).filter((f) => /\.tsx?$|^app[\\/]/.test(f)), [],
      'and none of the page\'s source is staged beside it');
    const found = {};
    for (const f of loaded) {
      for (const [, , spec] of staged(f).matchAll(specifier)) {
        (found[f] ??= []).push(spec);
        assert.ok(spec.endsWith(`?v=${v}`), `${f} imports ${spec}, which is not this build`);
        // The desktop app's bundle is named by `backend.js` for the branch that is never taken
        // here, and is left out of this staging on purpose (12e above): the one import with no
        // file.
        const there = fs.existsSync(path.join(built, path.dirname(f), spec.replace(/\?.*/, '')));
        assert.strictEqual(there, !spec.includes('backend-tauri.js'), `${spec} is a file, or not`);
      }
    }
    assert.deepStrictEqual(Object.keys(found).sort(), ['app.js', 'backend.js'],
      'only the two that are not bundled import by a path of their own');
    // Files, not statements: esbuild keeps one import per module that wrote it, so the renderer
    // imported by main.ts and by vm/peek.ts is two lines of app.js for one file.
    assert.strictEqual(new Set(found['app.js']).size, 4,
      'app.js: renderer, DOMPurify, backend, Mermaid');
    assert.strictEqual(found['backend.js'].length, 2, 'backend.js: the two readers it may load');

    // ... Mermaid's own chunks are named for their content, so they need no query
    const chunks = walk(built).filter((f) => f.includes(`mermaid${path.sep}chunks`));
    assert.ok(chunks.length > 10 && chunks.every((f) => /-[A-Z0-9]{8}\.mjs$/.test(f)),
      'Mermaid\'s chunks are each named by a hash of what is in them');
    const entryPaths = [
      ...staged('vendor/mermaid/mermaid.esm.min.mjs').matchAll(/(?:from|import\()\s*"(\.[^"]+)"/g),
    ].map((m) => m[1]);
    assert.ok(entryPaths.length > 10 && entryPaths.every((p) => /-[A-Z0-9]{8}\.mjs$/.test(p)),
      'and its entry reaches nothing else by a path of its own');

    // ... the worker's URL is made inside the bundle, and takes the query from the bundle's
    assert.strictEqual(
      sibling('./reader-worker.js', 'https://a.example/vendor/backend-web.js?v=3fa9c2d1e0b4').href,
      'https://a.example/vendor/reader-worker.js?v=3fa9c2d1e0b4',
      'the reader is asked for as the page end was, which a relative URL alone would not',
    );
    assert.strictEqual(
      sibling('./reader-worker.js', 'http://127.0.0.1:8080/vendor/backend-web.js').href,
      'http://127.0.0.1:8080/vendor/reader-worker.js',
      'and where nothing asked for the page end with one, nothing is added',
    );
    assert.match(staged('vendor/backend-web.js'), /\.search=new URL\(\w+\)\.search/,
      'the shipped bundle does it');
    assert.match(read('./src/hosts/web/backend.ts'),
      /const WORKER_URL = sibling\('\.\/reader-worker\.js'\)/,
      'and the SharedWorker and the fallback are both made from that URL');
    console.log('✓ the web app asks for every file by its build: page, imports and worker');
  }

  // --- npm run webapp: the way a static host will serve it ------------------------------
  const server = createWebappServer(built);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const site = `http://127.0.0.1:${portOf(server)}`;
  const rawPath = (p, srv = server) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: portOf(srv), path: p }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  try {
    const chunk = mermaidOf(inWeb).find((f) => f.includes('chunks')).split(path.sep).join('/');
    for (const [url, type] of [
      ['/', 'text/html; charset=utf-8'],
      ['/vendor/reader-worker.js', 'text/javascript; charset=utf-8'],
      // What the page asks for. The query is not part of the path, and the rules for the paths
      // that are kept are not this server's: it holds nothing, and says so on every response.
      [`/app.js?v=${builtApp.version}`, 'text/javascript; charset=utf-8'],
      [`/vendor/reader-worker.js?v=${builtApp.version}`, 'text/javascript; charset=utf-8'],
      ['/vendor/mermaid/mermaid.esm.min.mjs', 'text/javascript; charset=utf-8'],
      [`/${chunk}`, 'text/javascript; charset=utf-8'],
    ]) {
      const res = await fetch(site + url);
      assert.strictEqual(res.status, 200, `${url} is there`);
      assert.strictEqual(res.headers.get('content-type'), type, `${url} is ${type}`);
      assert.strictEqual(res.headers.get('content-security-policy'),
        rule['Content-Security-Policy'], `${url} carries the policy, the worker's script too`);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
      assert.strictEqual(res.headers.get('cache-control'), 'no-store', 'and nothing is held');
      await res.arrayBuffer();
    }
    assert.strictEqual((await fetch(`${site}/_headers`)).status, 404, 'the rules are not served');
    assert.strictEqual((await fetch(`${site}/nope.js`)).status, 404);
    // `%2f` is the one that gets past the URL parser, which resolves `..` and `%2e%2e` itself:
    // it reaches the path as a slash only once it has been decoded.
    assert.strictEqual(await rawPath('/..%2fpackage.json'), 403, 'and nothing outside the app');
    assert.strictEqual(await rawPath('/%2e%2e/package.json'), 404, 'however `..` is spelt');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  const serveSrc = read('./scripts/serve-webapp.mts');
  assert.match(serveSrc, /'127\.0\.0\.1'/, 'on the loopback and nowhere else');
  assert.match(serveSrc, /relative\(root, file\)\.startsWith\('\.\.'\)/, 'serving only the app');
  assert.match(serveSrc, /EADDRINUSE[\s\S]*process\.exit\(1\)/,
    'and a taken port is an error, not another origin with no history in it');
  const npmScripts = JSON.parse(read('./package.json')).scripts;
  assert.strictEqual(
    npmScripts['build:webapp'],
    'npm run build:ts && node out/scripts/build-webapp.mjs',
    'npm run build:webapp',
  );
  assert.strictEqual(npmScripts.webapp, 'node out/scripts/serve-webapp.mjs', 'npm run webapp');
  assert.strictEqual(npmScripts.prewebapp, 'npm run build:web && npm run build:webapp',
    'which builds the bundles and the app first, so there is one command');
  console.log('✓ npm run webapp serves dist/web with its headers, .mjs as script, and no more');

  // --- a request that does not parse is that request's problem, not the server's --------------
  // A throw in a request handler is an uncaught exception, so one `GET /100%` ended the process
  // and the page with it. Both static servers, since they are the same twenty lines.
  for (const [name, serve] of [
    ['webapp', () => createWebappServer(built)],
    ['site', () => createSiteServer()],
  ] as [string, () => http.Server][]) {
    const srv = serve();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${portOf(srv)}`;
    try {
      // `/%E0%A4%A` is half of a three-byte character and `/100%` is a bare `%`: neither
      // decodes. `//` is a protocol-relative URL with no host, which does not parse at all.
      for (const bad of ['/%E0%A4%A', '/100%', '/%', '//', '///']) {
        assert.strictEqual(await rawPath(bad, srv), 400, `${name}: ${bad} is a bad request`);
      }
      const res = await fetch(`${base}/%E0%A4%A`);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(await res.text(), 'Bad request');
      assert.strictEqual(res.headers.get('cache-control'), 'no-store',
        `${name}: it is answered like anything else, nothing held`);
      if (name === 'webapp') {
        assert.strictEqual(res.headers.get('content-security-policy'),
          rule['Content-Security-Policy'], 'with the policy, which is on every response');
      }
      assert.strictEqual((await fetch(`${base}/`)).status, 200, `${name}: and is still serving`);
    } finally {
      srv.closeAllConnections?.();
      srv.close();
    }
  }
  console.log('✓ a request that does not parse is a 400, and both static servers stay up');

  fs.rmSync(out, { recursive: true, force: true });
}

// --- 12f. docs/web-app.md says what the code does -------------------------------------------
// It is what a person reads before they trust a file to a browser, so a number or a name in it
// that the code has since changed is worse than no page: the next reader believes it. These are
// the things in it that a person would act on, held to the code they describe, and that it is
// reachable from the two indexes, since a page nobody links to is one nobody reads.
{
  const read = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const doc = read('./docs/web-app.md');
  assert.match(read('./docs/README.md'), /\]\(web-app\.md\)/, 'docs/README.md links it');
  assert.match(read('./README.md'), /\]\(docs\/web-app\.md\)/, 'and so does the README');

  // Where the data lives: the database, and every store in it, by the name the code gives it.
  const { STORES } = await import('./src/hosts/web/idb.js');
  assert.match(read('./src/hosts/web/idb.ts'), /^const DB_NAME = 'redline';$/m);
  assert.match(doc, /database called `redline`/, 'the database is named as the code names it');
  assert.deepStrictEqual(
    [...doc.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]),
    STORES,
    'every store, in the order the code makes them, and none that it does not',
  );

  // What a person would count on: what the web app opens, where the rest is, and how long an
  // edit takes to show. Read from the code that holds the number, the one place it is written.
  const MAC_APP_URL = read('./public/app/ui/Welcome.tsx').match(
    /^export const MAC_APP_URL = '([^']+)';$/m,
  )?.[1];
  assert.ok(MAC_APP_URL, 'the Mac app link is read from where the welcome draws it');
  assert.ok(
    !/Open folder|folders down/.test(doc) && /files, not folders/.test(doc),
    'it opens files, and the doc offers no folder',
  );
  assert.ok(doc.includes(`](${MAC_APP_URL})`), 'and links the Mac app where the welcome does');
  assert.match(read('./src/reader/reader.ts'), /^const POLL_MS = 1500;$/m);
  assert.ok(doc.includes('within about a second and a half'), 'a poll of 1500 ms');
  assert.match(read('./scripts/serve-webapp.mts'), /^const DEFAULT_PORT = 8081;$/m);
  assert.ok(doc.includes('http://127.0.0.1:8081'), 'and the address the server answers on');

  // The open files, under the key the code keeps them by. And the way to another file as the page
  // has it: the bar once had a folder button for the welcome, and a doc that still offers it sends
  // a person looking for something that is not there.
  const { OPEN_KEY } = await import('./src/hosts/web/open-files.js');
  assert.ok(doc.includes(`under \`${OPEN_KEY}\``), 'the open files are kept where it says');
  assert.ok(!/folder button/.test(doc), 'and no button in the bar puts the welcome up');

  // The plan this was built to was kept out of the repository, so anything here that cites it
  // cites a document a reader of the repository cannot open. What it decided is in docs/. The
  // needle is built in two so that this file is not the match.
  //
  // `skills/` and CLAUDE.md are the author's own and are gitignored, so a checkout -- CI's --
  // has neither: they are read where they are and passed over where they are not.
  const plan = new RegExp(['web-and', 'vscode'].join('-'));
  const skip = new Set(['node_modules', 'vendor', 'dist', 'target', '.git']);
  const here = (f) => rootUrl(`${f}`);
  const files = (dir) =>
    !fs.existsSync(here(dir))
      ? []
      : fs.readdirSync(here(`${dir}/`), { withFileTypes: true }).flatMap((e) =>
        skip.has(e.name) ? [] : e.isDirectory() ? files(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
  const dirs = ['src', 'public', 'scripts', 'shell/src', 'docs', 'site', '.github', 'skills'];
  const cited = [
    ...dirs.flatMap(files),
    'README.md',
    'CLAUDE.md',
    'test-smoke.ts',
  ].filter((f) => fs.existsSync(here(f)) && plan.test(read(`./${f}`)));
  assert.deepStrictEqual(cited, [], 'nothing cites the plan, which only the author can read');
  console.log('✓ docs/web-app.md agrees with the code it describes, is linked, cites no plan');
}

// --- 13. the store followed the app's name --------------------------------
// It holds every snapshot of every file ever read, and a rename of the app is
// no reason to start that again from nothing — nor to leave two stores lying
// about, which is what reading the old one where it lay would have meant.
const { storeRoot } = await import('./src/reader/store.js');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-home-'));
const legacyStore = path.join(fakeHome, '.md-reader');
const newStore = path.join(fakeHome, '.redline');
fs.mkdirSync(path.join(legacyStore, 'objects'), { recursive: true });
fs.writeFileSync(path.join(legacyStore, 'objects', 'abc.md'), '# kept\n');

const realHome = process.env.HOME;
const realStore = process.env.REDLINE_HOME;
// The override wins over everything, this test included.
delete process.env.REDLINE_HOME;
process.env.HOME = fakeHome;
try {
  assert.strictEqual(await storeRoot(nodePlatform), newStore, 'the store is under the new name');
  assert.ok(!fs.existsSync(legacyStore), 'and the old directory is not left behind as a second copy');
  assert.strictEqual(
    fs.readFileSync(path.join(newStore, 'objects', 'abc.md'), 'utf8'),
    '# kept\n',
    'every snapshot came across with it',
  );
  // Once there is a store under the new name it is the store, whatever turns up
  // beside it later: nothing is merged in, and nothing is moved over it.
  fs.mkdirSync(legacyStore);
  fs.writeFileSync(path.join(legacyStore, 'stray.json'), '{}');
  assert.strictEqual(await storeRoot(nodePlatform), newStore, 'the existing store wins');
  assert.ok(fs.existsSync(path.join(legacyStore, 'stray.json')), 'and is not written into');
} finally {
  process.env.HOME = realHome;
  process.env.REDLINE_HOME = realStore;
}
assert.strictEqual(await storeRoot(nodePlatform), realStore, 'an explicit REDLINE_HOME still overrides both');
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('✓ the history store follows the app name');

// --- 14. a double-clicked document survives the launch it arrives during ---
// Set Redline as the handler for `.md` and every double-click, and every `open
// doc.md` on an app that was not already running, killed it: macOS delivers
// `application:openURLs:` from inside `-[NSApplication finishLaunching]`, which
// is *before* the did-finish-launching notification Tauri runs its setup hook
// on. So the open landed on an app with no managed state, `State::get` panicked
// and `panic = "abort"` turned that into SIGABRT before a window ever existed.
// Nothing to see from the outside -- `open` returns 0 either way -- which is
// why this is asserted here rather than left to be noticed.
//
// Grepped rather than run, because the route is an Apple Event into a bundle
// and there is no bundle in a `node` process. Three parts, and the first is the
// one that was missing: the guard has to come before anything in `arrive` that
// reads state, the files have to be kept rather than dropped, and the hook has
// to go looking for them.
const mainRs = fs.readFileSync(rootUrl('shell/src/main.rs'), 'utf8');
const arriveBody = mainRs.slice(mainRs.indexOf('fn arrive('));
assert.ok(
  arriveBody.indexOf('try_state::<win::Shell>()') <
    arriveBody.indexOf('if files.is_empty()'),
  'nothing in arrive() reads the shell before checking there is one',
);
assert.match(mainRs, /static PENDING: Mutex<Vec<PathBuf>>/, 'files that arrive too early wait');
assert.match(mainRs, /PENDING\.lock\(\)\.unwrap\(\)\.extend/, 'rather than being dropped');
assert.match(mainRs, /PENDING\.lock\(\)\.unwrap\(\)\.drain\(\.\.\)/, 'and setup takes them');
// A second process exits with only its arguments, so what Finder gave it is left in
// the inbox for the first, which looks there when told of a launch with no files.
assert.match(mainRs, /inbox_put\(app, files\)/, 'a process that may exit leaves its files');
assert.match(mainRs, /left = inbox_take\(app\)/, 'a bare launch looks for them');
assert.match(mainRs, /RunEvent::Opened \{ urls \}/, 'from the event a Finder open comes as');
// And the association itself, since a double-click that never reaches the app
// is the same bug from the reader's side.
const tauriConf = JSON.parse(
  fs.readFileSync(rootUrl('shell/tauri.conf.json'), 'utf8'),
);
const assoc = tauriConf.bundle.fileAssociations ?? [];
assert.ok(
  assoc.some((a) => a.ext?.includes('md')),
  'the app claims .md, so Finder can hand it one in the first place',
);
console.log('✓ a document opened from Finder outlives the launch it arrives during');

// --- 15. CI runs the suite on every change, and builds the dmg ------------
// The same reason everything above greps `public/` for its wiring: a check that
// exists and is never reached is worse than no check, because it reads as
// coverage. A workflow is exactly that shape. So this file asserts what runs,
// on what, and where it leaves the thing you would hand somebody.
const ci = fs.readFileSync(rootUrl('.github/workflows/ci.yml'), 'utf8');
const pagesYml = fs.readFileSync(
  rootUrl('.github/workflows/pages.yml'),
  'utf8',
);
assert.match(ci, /path: dist\/\*\.dmg/, 'the dmg is kept where bundle.mts leaves it');
assert.match(ci, /if-no-files-found: error/, 'loudly, rather than uploading nothing');

const workflows = fs.readdirSync(rootUrl('.github/workflows/'));
assert.deepStrictEqual(
  workflows.sort(),
  ['ci.yml', 'pages.yml', 'webapp.yml'],
  'three workflows, no more',
);
const triggers = (yml) => yml.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1] ?? '';
const onEvents = (yml) => triggers(yml).match(/^ {2}[a-z_]+:/gm);
// Every change is tested, because a check that runs only when somebody thinks
// to start it is the check that did not run on the change that broke things.
assert.deepStrictEqual(
  onEvents(ci),
  ['  push:', '  pull_request:', '  workflow_dispatch:'],
  'ci.yml runs on a push, a pull request, and by hand',
);
assert.match(triggers(ci), /branches: \[main\]/, 'a push to main');
assert.match(triggers(ci), /tags: \['v\*'\]/, 'or of a version tag');
// The one trigger that must never appear: `pull_request_target` runs a fork's
// code with the repository's secrets and a write token. Comments may name it.
const ciCode = ci.replace(/^\s*#.*$/gm, '');
const pagesCode = pagesYml.replace(/^\s*#.*$/gm, '');
const webappYml = fs.readFileSync(
  rootUrl('.github/workflows/webapp.yml'),
  'utf8',
);
const webappCode = webappYml.replace(/^\s*#.*$/gm, '');
for (const [name, code] of [
  ['ci.yml', ciCode],
  ['pages.yml', pagesCode],
  ['webapp.yml', webappCode],
]) {
  assert.doesNotMatch(code, /pull_request_target/, `${name} never hands a fork the secrets`);
}

assert.deepStrictEqual(
  ci.slice(ci.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
  ['  test:', '  bundle:', '  release:'],
  'the suite, the dmg, and the release',
);
const testJob = ciCode.slice(ciCode.indexOf('\n  test:'), ciCode.indexOf('\n  bundle:'));
const bundleJob = ciCode.slice(ciCode.indexOf('\n  bundle:'), ciCode.indexOf('\n  release:'));
const releaseJob = ciCode.slice(ciCode.indexOf('\n  release:'));
// Both platforms: the font checks only really run on the Mac, and the Linux leg
// is what notices a macOS assumption in code meant to be portable.
assert.match(testJob, /os: \[ubuntu-latest, macos-latest\]/, 'the suite runs on Linux and macOS');
assert.match(testJob, /fail-fast: false/, 'and one leg failing does not hide the other');
assert.match(testJob, /run: npm test/, 'it is the suite');
assert.match(testJob, /run: cargo test --locked/, "and the shell's own tests");
// generate_context! will not compile without shell/dist, and a runner starts
// with none, so the page is staged before the shell's tests are built.
const stageDist = testJob.indexOf('run: npm run build:dist');
assert.ok(
  stageDist > testJob.indexOf('run: npm test') && stageDist < testJob.indexOf('run: cargo test'),
  'shell/dist is built after the suite (which builds vendor/) and before cargo test',
);
assert.match(testJob, /working-directory: shell/, 'run where the shell is');
assert.doesNotMatch(testJob, /secrets\./, 'with no secret in reach of the code under test');
assert.deepStrictEqual(
  ciCode.match(/needs: .*/g),
  ['needs: test', 'needs: bundle'],
  'a dmg only from a reader that passed, a release only from that dmg',
);

// A pull request from a fork runs a stranger's code. GitHub withholds secrets
// from it anyway, but the workflow should not be relying on that: no step a
// pull request can reach is handed the Apple credentials.
const steps = (job) => job.split(/\n {6}- /).slice(1);
const bundleSteps = steps(bundleJob);
assert.doesNotMatch(
  bundleJob.slice(0, bundleJob.indexOf('\n    steps:')),
  /secrets\./,
  'the bundle job puts no secret in its own env, where every step would see it',
);
const signed = bundleSteps.filter((step) => /secrets\.APPLE_/.test(step));
assert.ok(signed.length, 'some step signs');
for (const step of signed) {
  assert.match(
    step,
    /if: github\.event_name != 'pull_request'/,
    'and only off a pull request',
  );
}
const adhoc = bundleSteps.filter((step) => /if: github\.event_name == 'pull_request'/.test(step));
assert.strictEqual(adhoc.length, 1, 'a pull request gets a dmg of its own');
assert.doesNotMatch(adhoc[0], /secrets\./, 'signed ad hoc, with nothing to sign with');
assert.strictEqual(
  ci.match(/^\s+run: npm run bundle \$\{\{ env\.BUNDLE_ARGS \}\}$/gm).length,
  2,
  'the two are one command, and the arch is a variable both read',
);
// Universal for anything that is not a hand-started run: the artifact has to
// run on whichever Mac it lands on, and a release's filename says universal.
// By hand it is off unless ticked -- one arch is half the compile and proves
// the same two things, the release profile builds and the bundle assembles.
const universal = ci.match(/BUNDLE_ARGS: >-\n([\s\S]*?)\n {4}steps:/);
assert.ok(universal, 'set once at the job level, where the condition can be read');
assert.match(universal[1], /github\.event_name != 'workflow_dispatch'/, 'universal unless by hand');
assert.match(universal[1], /inputs\.deploy/, 'or for a release by hand');
assert.match(universal[1], /inputs\.universal/, 'or when the run asked for it');
assert.match(universal[1], /'-- --universal' \|\| ''/, 'and one architecture otherwise');
assert.match(ci, /universal:\n(\s+[^\n]*\n)*?\s+type: boolean\n\s+default: false/, 'unticked');
assert.match(ci, /key: cargo-release-/, 'the release build is cached');
assert.match(ci, /key: cargo-test-/, 'and the test build, apart from it');

// The landing page never deploys on a push. Its download button names
// package.json's version, which is ahead of every release from the moment a
// bump merges, so a push to site/ in that window -- or one alongside the tag --
// would publish a link to a dmg that is not up yet. A release deploys it as its
// last step; anything else is somebody choosing Run workflow.
assert.deepStrictEqual(
  onEvents(pagesYml),
  ['  workflow_dispatch:'],
  'pages.yml runs by hand, and on nothing else',
);
const releaseSteps = steps(releaseJob);
assert.match(
  releaseSteps[releaseSteps.length - 1],
  /run: gh workflow run pages\.yml --ref main/,
  'or as the last step of a release, after the dmg, the cask and Latest',
);
assert.strictEqual(
  ciCode.match(/gh workflow run pages\.yml/g).length,
  1,
  'and from nowhere else in ci.yml',
);

// Signing, which is a thing that fails quietly in the direction of looking
// fine: an app signed and not notarized is refused by Gatekeeper exactly like
// an unsigned one, and the only place the difference shows is a dialog on
// somebody else's Mac. So the identity has to reach the build, and it has to
// reach it as a `--config` patch -- tauri.conf.json has the ad hoc `-` in it,
// and a patch is the one route whose precedence is documented rather than
// guessed at.
const bundleJs = fs.readFileSync(rootUrl('scripts/bundle.mts'), 'utf8');
assert.match(bundleJs, /APPLE_SIGNING_IDENTITY/, 'the bundle takes an identity from the env');
assert.match(bundleJs, /signingIdentity: identity/, 'and patches it over the ad hoc one');
assert.match(bundleJs, /'--config'/, 'through the flag that merges last over first');
// Signed and notarized are told apart off a *whole* set of credentials. Half a
// set notarizes nothing, and `APPLE_ID` on its own is a variable people have
// exported for other reasons -- on this machine, as it happens, which is how
// the loose version of this check was caught saying "notarized" over a build
// that was not. That is the one error here only discovered on another Mac.
assert.ok(
  bundleJs.includes("env('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID')"),
  'notarized means the whole Apple ID set was there',
);
assert.ok(
  bundleJs.includes("env('APPLE_API_KEY', 'APPLE_API_ISSUER')"),
  'or the whole App Store Connect one',
);
for (const secret of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID']) {
  assert.ok(ci.includes(`secrets.${secret}`), `CI hands the build ${secret}`);
}
console.log('✓ CI tests every change on two OSes, and signs only what a fork cannot reach');

// The web app is published by a workflow of its own, and the things that go wrong with it go
// wrong quietly: a deploy to the landing page's project replaces the landing page with the app and
// reports success, a token in a job that has run `npm ci` is in reach of every dependency's
// install script, and a trigger on a push puts out every merge. None of it fails a build, so each
// is a line here. That the workflow runs at all, and that Pages takes what it sends, is for the
// first deploy to say (docs/building.md, Publishing the web app).
{
  assert.deepStrictEqual(
    onEvents(webappYml),
    ['  push:', '  workflow_dispatch:'],
    'webapp.yml runs on a push and by hand, and on no pull request',
  );
  assert.match(triggers(webappYml), /tags: \['v\*'\]/, 'the push is of a version tag');
  assert.doesNotMatch(triggers(webappYml), /branches:/, 'and never of a branch, main included');
  assert.doesNotMatch(webappCode, /\bwrite\b/, 'it can write nothing to the repository');
  assert.match(webappCode, /^permissions:\n {2}contents: read$/m, 'only read it');
  assert.match(webappCode, /cancel-in-progress: false/, 'and a deploy is never cut off halfway');

  assert.deepStrictEqual(
    webappCode.slice(webappCode.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
    ['  build:', '  deploy:'],
    'a job that builds, and a job that deploys what it built',
  );
  const buildJob = webappCode.slice(
    webappCode.indexOf('\n  build:'),
    webappCode.indexOf('\n  deploy:'),
  );
  const deployJob = webappCode.slice(webappCode.indexOf('\n  deploy:'));
  assert.match(deployJob, /needs: build/, 'the deploy waits for the build');

  // The token is in one job, and it is the one that runs nothing of the repository's.
  assert.doesNotMatch(buildJob, /secrets\./, 'the job that runs npm ci holds no secret');
  assert.match(deployJob, /apiToken: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'the token');
  assert.match(deployJob, /accountId: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'the account');
  assert.doesNotMatch(deployJob, /actions\/checkout/, 'with no checkout, so no wrangler.toml');
  assert.doesNotMatch(deployJob, /\bnpm\b|\bnpx\b/, 'and no npm to run a dependency with');
  assert.strictEqual(deployJob.match(/^ {6}- /gm).length, 3, 'a node, the artifact, the deploy');

  // The project is named on the command line, and is not the landing page's.
  const project = deployJob.match(/--project-name=(\S+)/)?.[1];
  const landingPage = fs.readFileSync(rootUrl('wrangler.toml'), 'utf8');
  assert.strictEqual(project, 'redline-app', 'into the web app\'s project');
  assert.notStrictEqual(
    project,
    landingPage.match(/^name = "(.+)"$/m)[1],
    'which is not the one wrangler.toml names, whose page it would replace',
  );
  assert.match(deployJob, /command: pages deploy web --project-name=redline-app --branch=main/);

  // What is built is what is uploaded: the one directory, by the one name, and an empty one is
  // an error.
  assert.match(buildJob, /run: npm run build:web\b[\s\S]*run: npm run build:webapp\b/,
    'the bundles, then the page staged around them');
  assert.match(buildJob, /path: dist\/web\n\s+if-no-files-found: error/, 'dist/web, or nothing');
  assert.match(buildJob, /name: redline-app/, 'under a name');
  assert.match(deployJob, /name: redline-app\n\s+path: web/, 'which the deploy downloads to web/');
  assert.match(
    buildJob,
    /if: github\.ref_type == 'tag'[\s\S]*?GITHUB_REF_NAME#v[\s\S]*?package\.json/,
    'and a tag that disagrees with package.json is refused, as ci.yml refuses it',
  );

  // Independent of the release, so that neither can hold the other up.
  assert.doesNotMatch(ciCode, /webapp\.yml/, 'ci.yml does not start it');
  assert.doesNotMatch(webappCode, /workflow_run|needs: .*(test|bundle|release)/, 'or waits on it');
  console.log('✓ webapp.yml deploys dist/web on a tag, to its own project, token in one job');
}

// The dev loop, which is the one piece of tooling here whose failure mode is
// that it quietly stops saving you anything. `npm run dev` is worth having only
// because the page comes out of the binary: `tauri dev` serves shell/dist over
// a static server of its own, so a page edit is a restage and a ⌘R instead of a
// relink. Four things hold that up, and three of them break silently.
const devJs = fs.readFileSync(rootUrl('scripts/dev.mts'), 'utf8');
const devScripts = JSON.parse(
  fs.readFileSync(rootUrl('package.json'), 'utf8'),
).scripts;
assert.strictEqual(
  devScripts.dev,
  'npm run build:ts && node out/scripts/dev.mjs',
  'the dev loop is one command',
);
assert.match(devJs, /'tauri', 'dev'/, 'and it is `tauri dev`, not a cargo run');
// Staged from in here rather than from a `predev` hook, the same way the bundle
// does its own: there is to be no way to ask for this and get a stale page.
assert.match(devJs, /build-web\.mjs/, 'the page is bundled before the window opens');
assert.match(devJs, /build-dist\.mjs/, 'and staged, or the window shows the last run');
// `tauri dev -- [runnerArgs] -- [appArgs]`: one `--` short and `sample.md` is
// handed to cargo, which fails in a way that looks nothing like the cause.
assert.match(devJs, /'--', '--', \.\.\.appArgs/, 'a file to open reaches the app, not cargo');
// tsc emits nothing for public/app/, so skipping a `.ts` there would be waiting forever.
assert.match(devJs, /const page = !src && file\?\.startsWith\(`app\$\{path\.sep\}`\);/,
  'an edit to the page\'s source is noticed');
assert.match(devJs, /touchedSrc \|\|= src \|\| page;/, 'and rebundles it, as a src/ edit does');

// The load-bearing one. Tauri's dev watcher honours .gitignore, and shell/dist
// being ignored is the only reason restaging the page does not trip the Rust
// rebuild the whole exercise exists to avoid. Un-ignore it and `npm run dev`
// still works -- it just silently costs what `npm run app` costs.
const devIgnore = fs.readFileSync(rootUrl('.gitignore'), 'utf8');
assert.match(
  devIgnore,
  /^(shell\/)?dist\/$/m,
  'shell/dist is ignored, so a restage is not a rebuild',
);

// public/vendor/ is build:web's output, not source. Without the filter a src/
// edit restages twice: once for the module, once for the bundle it produced.
assert.match(devJs, /vendor\$\{path\.sep\}/, 'the watcher ignores what build:web just wrote');

// The page is TypeScript, and the window loads what tsc emits beside it: an edit to a `.ts` is
// worth a restage only once the compile has landed. Restaging on the edit stages the previous
// compile and then again on the emit, which is the quiet kind of wrong -- the window is one
// save behind and nothing says so.
assert.ok(
  /spawn\('npx', \['tsc', '-b', '--watch'/.test(devJs),
  'npm run dev compiles the page as you edit it',
);
assert.ok(
  /file\.endsWith\('\.ts'\)/.test(devJs),
  'and restages on what tsc emitted, not on the edit that caused it',
);

// And it has to die when told. A watcher left behind has no window and is not
// idle: two of them restaging one shell/dist race, because build:dist empties
// the directory before it refills it, and the loser fails inside the mermaid
// tree. Found by leaving one.
assert.match(devJs, /tauri\.kill\(sig\)/, 'ctrl-c reaches the window');
assert.match(devJs, /tauri\.kill\('SIGKILL'\)/, 'and a child that ignores it gets no third chance');
assert.ok(/tsc\?\.kill\(sig\)/.test(devJs), 'and takes the compiler down with the window');
assert.match(devJs, /tsc\?\.kill\(\)/, 'and when the window is closed instead of interrupted');
console.log('✓ the dev loop serves the page instead of embedding it, and shuts down');

// A run started on a `vN.N.N` tag, or with Deploy ticked, is a release: the
// upload-artifact above needs a GitHub login to fetch, which a Homebrew cask
// can't do. So the dmg goes onto a GitHub release, which `curl` can reach
// without credentials -- and only then, never from a branch somebody wanted a
// dmg of.
assert.match(
  releaseJob,
  /if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| inputs\.deploy/,
  'the release job only runs for a tag or a ticked Deploy',
);
assert.match(releaseJob, /gh release create "v\$\{VERSION\}"/, 'and attaches the dmg to a release');
assert.match(releaseJob, /--clobber/, 'or replaces it on one that is already there');
assert.match(releaseJob, /sha256sum/, 'and the hash a cask formula needs is computed in the open');
assert.match(releaseJob, /GITHUB_REPOSITORY" != tuanchauict\/redlineapp/, 'from redlineapp only');
// It is the one job that writes, so it is the one that may: the bundle job runs
// `npm ci` beside the Apple credentials, and a write token there would be in
// reach of every install script in the tree.
assert.match(releaseJob, /permissions:\n\s+contents: write/, 'the release job may write');
assert.strictEqual(ciCode.match(/contents: write/g).length, 1, 'and no other job may');
assert.match(releaseJob, /runs-on: ubuntu-latest/, 'and needs no Mac to');
assert.doesNotMatch(bundleJob, /contents: write|TAP_REPO_TOKEN/, 'the bundle job holds neither');
assert.doesNotMatch(ci, /R2_|r2\.cloudflarestorage|dl\.iamtuna\.org/, 'and nothing goes to R2');
console.log('✓ a run on a version tag publishes the dmg where a cask formula can reach it');

// The cask itself lives outside this repository, so the only way this build
// can update what `brew install` reads is a cross-repo push -- which only a
// tagged release should ever make.
assert.match(ci, /github\.com\/tuanchauict\/homebrew-tap\.git/, 'the tap repo is cloned by URL');
assert.match(ci, /tap\/Casks\/redline\.rb/, 'and the cask file in it is edited in place');
assert.match(ci, /secrets\.TAP_REPO_TOKEN/, 'authenticated with a token scoped to that repo');
assert.match(ci, /dmg_sha256/, 'reusing the hash the staging step computed, not recomputing it');
assert.ok(
  ci.includes('/v#{version}/Redline-#{version}-universal.dmg'),
  'and the url line pointed at the release, so the cask cannot go on naming R2',
);
console.log('✓ and also updates the Homebrew cask with the new version and hash');

// And, last, says so to the copies already out there. Order is the point: the
// app reads the manifest on whichever release is marked Latest, so marking it is
// the claim that a release exists, and it happens only once the dmg it names
// and the cask a Homebrew copy will be told to upgrade from are both in place.
// Marked first, a copy could be sent after a version nobody has yet.
const cmdsRs = fs.readFileSync(rootUrl('shell/src/cmds.rs'), 'utf8');
assert.match(ci, /--latest=false/, 'the release is published without being marked Latest');
assert.ok(
  ci.indexOf('gh release edit "v${VERSION}" --latest') > ci.indexOf('git -C tap push'),
  'and is marked only after the cask is pushed',
);
// The landing page links this version's dmg, so it is redeployed from here,
// once the dmg is up and Latest -- not on the version bump, which comes first.
assert.ok(
  ci.indexOf('gh workflow run pages.yml') > ci.indexOf('gh release edit "v${VERSION}" --latest'),
  'and the landing page is redeployed only after that',
);
assert.match(releaseJob, /actions: write/, 'which the release job is allowed to start');
assert.match(ci, /latest\.json --clobber/, 'with a latest.json attached to every release');
assert.match(ci, /printf '\{"version":"%s","url":"%s"\}\\n' "\$VERSION" "\$url"/,
  'naming the version and the dmg it can be fetched from');
assert.ok(
  ci.includes('url="https://github.com/tuanchauict/redlineapp/releases/download/v${VERSION}/'),
  'which is the dmg on the same release',
);
const latestUrl = cmdsRs.match(/const LATEST: &str = "([^"]+)"/)?.[1];
assert.strictEqual(
  latestUrl,
  'https://github.com/tuanchauict/redlineapp/releases/latest/download/latest.json',
  'and the app reads it from whichever release is Latest',
);
assert.match(cmdsRs, /"--location"/, 'following the redirect GitHub answers that URL with');
console.log('✓ a release announces itself in a manifest the app can read');

// The check itself: only ever asked for, and answered where the version is.
// Every piece is a way for it to be built and unreachable — a command not in
// the handler list is refused silently, an event the page never listens for
// is a menu item that does nothing, and a row nobody fills reads "Redline".
assert.match(cmdsRs, /pub async fn check_update/,
  'the check is async, so a slow network cannot freeze the main thread');
assert.match(mainRs, /cmds::check_update,/, 'and registered, or the page is refused');
assert.match(menuRs, /with_id\("checkupdate", "Check for Updates…"\)/, 'the menu offers it');
assert.match(menuRs, /"checkupdate" => win::to_front\(app, "md:check-update"/,
  'and hands it to the window in front');
assert.match(seamJs, /onCheckUpdate: \(cb\b.*?\) => on\('md:check-update'/, 'which listens for it');
assert.match(pageJs, /native\.onCheckUpdate\(/, 'and answers it');
assert.match(settingsTsx, /<section id="aboutSec" data-shell="">/,
  'in a section only the desktop app shows');
assert.match(pageJs, /mountSettings\(\$\('prefsSlot'\), native\?\.version \?\? '',/,
  'which says what this is');
assert.match(settingsTsx, /<span id="setVersion">\{version\}<\/span>/, 'by its version');
assert.match(hostRs, /version: app\.package_info\(\)\.version\.to_string\(\)/,
  'from the bundle the app was built as');
assert.match(pageJs, /\n  check: checkUpdate,\n/, 'with a button that asks');
assert.match(settingsTsx, /id="checkUpdate"[\s\S]{0,120}?onClick=\{actions\.check\}/,
  'and the button is wired to it');
// Counted rather than looked for: the promise is that *nothing else* calls it,
// so the one call there is has to be the menu's.
assert.deepStrictEqual(
  pageJs.match(/(?<![.\w])checkUpdate\(\);/g),
  ['checkUpdate();'],
  'and nothing but the menu calls it — not a timer, not launch',
);
assert.match(
  pageJs,
  /native\.onCheckUpdate\(\(\) => \{[\s\S]{0,200}?checkUpdate\(\);/,
  'that one is the menu',
);
// The advice depends on how this copy got here. A cask moves the app into
// /Applications, so the bundle's own path cannot tell; the Caskroom can.
assert.match(cmdsRs, /Caskroom\/redline/, 'a Homebrew copy is told apart from a dragged one');
assert.match(pageJs, /const BREW_UPGRADE = 'brew upgrade --cask redline'/,
  'and told to upgrade through Homebrew');
console.log('✓ check for updates is wired from the menu to the settings sheet');

// The version is written in three places, and nothing but this keeps them in
// step: package.json is what the tag and the landing page's download link are
// built from, tauri.conf.json is what the dmg is named and what the About row
// shows, and Cargo.toml is the crate. A mismatch is otherwise only noticed by
// whoever downloads the result — or now, by a copy told it is out of date
// against a version it already is.
// (JSON.parse is handed a Buffer and reads its text; only its `string` parameter type objects.)
const pkgVersion = JSON.parse(
  fs.readFileSync(rootUrl('package.json')) as unknown as string,
).version;
const confVersion = JSON.parse(
  fs.readFileSync(rootUrl('shell/tauri.conf.json')) as unknown as string,
).version;
const cargoVersion = fs
  .readFileSync(rootUrl('shell/Cargo.toml'), 'utf8')
  .match(/^version = "([^"]+)"/m)?.[1];
assert.strictEqual(confVersion, pkgVersion, 'tauri.conf.json has the version package.json has');
assert.strictEqual(cargoVersion, pkgVersion, 'and so does shell/Cargo.toml');
console.log(`✓ the version agrees in all three places (${pkgVersion})`);

// --- the license, and everyone else's ---------------------------------------
//
// The Apache text is a legal document and has to be the one apache.org
// publishes, to the byte: a retyped copy that differs is a copy of something
// else. This is the digest of LICENSE-2.0.txt as published.
const fromRoot = (name) => fs.readFileSync(rootUrl(`${name}`));
assert.strictEqual(
  crypto.createHash('sha256').update(fromRoot('LICENSE')).digest('hex'),
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  'LICENSE is the Apache 2.0 text, unaltered',
);
assert.match(String(fromRoot('NOTICE')), /^Redline\nCopyright 2026 Tuan Chau\n/, 'NOTICE');
const pkgJson = JSON.parse(fromRoot('package.json') as unknown as string);
assert.strictEqual(pkgJson.license, 'Apache-2.0', 'package.json names the license');
assert.match(
  String(fromRoot('shell/Cargo.toml')),
  /^license = "Apache-2.0"$/m,
  'and so does the crate',
);
const bundleConf = JSON.parse(
  fromRoot('shell/tauri.conf.json') as unknown as string,
).bundle;
assert.strictEqual(bundleConf.license, 'Apache-2.0', 'and the bundle');
assert.strictEqual(bundleConf.copyright, 'Copyright 2026 Tuan Chau', 'with the copyright');
// What goes into Contents/Resources: the license, the notice, and everyone
// else's. tauri-build refuses a resource that is not there, so a rename shows
// up as a failed bundle -- but only on the machine that bundles.
assert.deepStrictEqual(
  Object.entries(bundleConf.resources).sort(),
  [
    ['../LICENSE', 'LICENSE'],
    ['../NOTICE', 'NOTICE'],
    ['../THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
  ],
  'the app carries its license and the third-party notices',
);
for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'SECURITY.md']) {
  assert.ok(fs.existsSync(rootUrl(`${name}`)), `${name} is there`);
}
const readmeMd = String(fromRoot('README.md'));
assert.match(readmeMd, /^## License\n[\s\S]*\(LICENSE\)[\s\S]*\(THIRD-PARTY-NOTICES\.md\)/m,
  'the README says what the license is and where the others are');

// The notices are generated, and a dependency added without regenerating them
// would ship without its notice. The file records a digest of both lockfiles'
// dependency lists; recomputed here from the lockfiles alone, so the check
// needs no cargo.
const notices = String(fromRoot('THIRD-PARTY-NOTICES.md'));
const { inputsDigest } = await import('./scripts/notices.mjs');
assert.strictEqual(
  notices.match(/<!-- inputs: ([0-9a-f]{64}) -->/)?.[1],
  inputsDigest(),
  'THIRD-PARTY-NOTICES.md is current -- run `npm run notices`',
);
assert.match(notices, /^\| elkjs \| [^|]+ \| EPL-2\.0 \| https:\/\/github\.com\/kieler\/elkjs \|$/m,
  'elkjs is named, with where its source is');
assert.match(notices, /^\| dompurify \| [^|]+ \| \(MPL-2\.0 OR Apache-2\.0\) \|/m,
  'and DOMPurify');
assert.match(notices, /^\| tauri \| /m, 'and the crates are in it as well as the page');
assert.strictEqual(
  pkgJson.scripts.notices,
  'npm run build:ts && node out/scripts/notices.mjs',
  'npm run notices',
);
// Kept by build:web, so the notices that sit with their code still do.
assert.match(String(fromRoot('scripts/build-web.mts')), /legalComments: 'eof'/,
  "the bundles keep their license comments");
assert.match(String(fromRoot('public/vendor/sanitize.js')), /@license DOMPurify/,
  'and DOMPurify\'s is in the bundle');

// The bundle identifier. Everything the app remembers apart from the snapshot
// store -- window.json, and the webview's storage under ~/Library/WebKit -- is
// filed under it, so changing it would make an upgrade look like a fresh install.
const shellConfig = JSON.parse(fromRoot('shell/tauri.conf.json') as unknown as string);
assert.strictEqual(shellConfig.identifier, 'com.redline.reader', 'the bundle identifier');
console.log('✓ the license, the notices, and the bundle identifier');

// --- 16. the landing page -------------------------------------------------
// site/ is hand-written HTML with no browser in this repository to open it in,
// so what can be asserted is what can be read: that it parses, that the things
// the script reaches for exist in the stylesheet, and that the picture it draws
// of the product is drawn in the product's own colours. The same reasoning as
// every other grep here -- a demo whose phases mean nothing in CSS is an
// animation that silently does nothing, and it would look exactly like the
// page working.
const siteHtml = fs.readFileSync(rootUrl('site/index.html'), 'utf8');
const siteCss = fs.readFileSync(rootUrl('site/landing.css'), 'utf8');
const siteJs = fs.readFileSync(rootUrl('site/landing.ts'), 'utf8');

// Comments go first: `unbalanced` does not know about them, and the page's own
// prose mentions <html> while explaining why the theme script is where it is.
const siteBody = siteHtml.replace(/<!--[\s\S]*?-->/g, '');
const siteTag = unbalanced(siteBody);
assert.strictEqual(siteTag, null, `the landing page is balanced: ${siteTag}`);

let depth = 0;
for (const ch of siteCss.replace(/\/\*[\s\S]*?\*\//g, '')) {
  if (ch === '{') depth++;
  else if (ch === '}') depth--;
}
assert.strictEqual(depth, 0, 'the landing stylesheet closes every rule it opens');

// The install command is one unbroken line (`white-space: pre`, so the
// shown command is copy-pasteable verbatim) in a pill that goes full-width
// on a narrow phone -- without `min-width: 0` a flex item's automatic
// minimum is its content's own width, so the line would push the pill past
// the edge of the screen instead of scrolling inside it.
assert.match(
  siteCss,
  /\.copy code \{[^}]*min-width: 0[^}]*overflow-x: auto/,
  'the install command scrolls inside its pill on a narrow phone',
);

// The same rule the reader's own page lives by: anything that decides what the
// first frame looks like is applied by an inline script in the head, not by the
// module. Read the theme in landing.js instead and every open flashes white.
const siteHead = siteHtml.slice(0, siteHtml.indexOf('</head>'));
assert.match(siteHead, /redline:site-theme/, 'the theme is applied before first paint');
assert.match(siteHead, /classList\.add\('js'\)/, 'and the scroll reveal is armed there too');
// Which is what makes the page whole with the module blocked: the sections are
// only hidden once something has said it can show them again.
assert.match(siteCss, /\.js \.reveal \{/, 'so a reveal with no script is not an invisible page');

// `marked` is the markup's own state -- the demo is written out finished, and
// the other two phases are what take it away. That is why the page is correct
// with no JavaScript at all, so the default being that one is load-bearing.
assert.match(siteHtml, /data-phase="marked"/, 'the demo starts finished, not empty');
for (const phase of ['clean', 'reload']) {
  assert.ok(siteJs.includes(`'${phase}'`), `the demo loop moves through ${phase}`);
  assert.ok(siteCss.includes(`[data-phase="${phase}"]`), `and the stylesheet draws ${phase}`);
}
// The removed block and the removed words are out of the flow while the
// document is clean, so the marked state is the taller one and the hero would
// change height on every lap without this.
assert.match(siteJs, /offsetHeight/, 'the demo holds the height of its tallest phase');
assert.match(siteCss, /\[data-measuring\]/, 'and re-measures with the transitions cut');

// The demo is a picture of the product, so the three change colours are the
// product's own rather than approximations of them. Light mode is the set both
// files state literally, at the top, in a `:root` that comes first in each.
const appCss = fs.readFileSync(rootUrl('public/styles.css'), 'utf8');
const colourOf = (css, name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
for (const name of ['add', 'del', 'mod']) {
  assert.strictEqual(
    colourOf(siteCss, name),
    colourOf(appCss, name),
    `the site's --${name} is the reader's --${name}`,
  );
}

// Below the hero the page shows no screenshots at all: each feature is played
// out live, in markup the stylesheet animates. Same bargain as the demo, so the
// same exposure -- a scene whose state nothing draws is a control that does
// nothing, and from here that reads exactly like the page working.
for (const attr of ['view', 'tone']) {
  assert.match(siteHtml, new RegExp(`id="sim-${attr}"`), `the page has the ${attr} scene`);
  assert.match(siteHtml, new RegExp(`data-${attr}="`), `in a state it names on the scene's root`);
  assert.match(siteCss, new RegExp(`\\[data-${attr}="`), `and the stylesheet draws that state`);
}
// Both of those are one driver: a pair of buttons, one attribute, and the
// markup saying which attribute rather than the script knowing.
assert.ok(siteJs.includes('.sim-view, .sim-tone'), 'one driver runs the two that are alike');
assert.match(siteHtml, /data-set="view"/, 'because each control names what it sets');
assert.match(siteCss, /\.seg button\.is-on/, 'and the pressed one of the pair is drawn pressed');

// The tone scene keeps its own palette, and that is the one thing on this page
// custom properties do not do by themselves: `body` resolves `var(--fg)` once,
// and what everything under it inherits is the answer, not the question.
// Redefining `--fg` on the scene turns the diagram, which asks for the property
// by name, and leaves the heading and the filename -- which ask for nothing --
// painted in the theme the scene exists to contradict. Dark on dark, with no
// browser here to see it.
const tone = siteCss.slice(siteCss.indexOf('.sim-tone {'));
assert.match(
  tone.slice(0, tone.indexOf('}')),
  /color: var\(--fg\)/,
  'the tone scene states its text colour, so its palette reaches what inherits',
);
for (const t of ['light', 'dark']) {
  assert.match(
    siteCss,
    new RegExp(`\\.sim-tone\\[data-tone="${t}"\\] \\{[^}]*--fg:`),
    `and the ${t} tone gives that colour something to be`,
  );
}

// The two that are not alike. Both move `is-marked`, which is the inverse of
// the demo's convention -- a scene starts clean and marks are turned on -- so
// the class has to mean something in all three files or nothing happens twice.
for (const id of ['sim-jump', 'sim-history']) {
  assert.match(siteHtml, new RegExp(`id="${id}"`), `the page has the ${id} scene`);
  assert.ok(siteJs.includes(`getElementById('${id}')`), `and a driver that finds it`);
}
assert.match(siteHtml, /class="chg[^"]*is-marked"/, 'a scene can start with a mark already on');
assert.match(siteCss, /\.sim \.chg:not\(\.is-marked\)/, 'and without one is the clean paragraph');
assert.match(siteJs, /'is-marked'/, 'which is what choosing a baseline turns on and off');
for (const key of ['p', 'n', 'c']) {
  assert.match(siteHtml, new RegExp(`data-key="${key}"`), `jumping offers ${key}, as the app does`);
}
assert.match(siteJs, /translateY/, 'and moves the document under its window to get there');
assert.match(siteCss, /\.sim \.chg\.is-at/, 'the change arrived at is the one tinted');
assert.match(siteCss, /\.sim \.chg\.is-off/, 'and a checked-off one is drawn spent, not gone');
assert.match(siteHtml, /data-counts="/, 'each baseline states the count it leaves on the bar');
assert.match(siteJs, /data-left|\[data-c=/, 'and the bar is written from what is outstanding');

// A scene that changes height moves the page under it, and both of these sit in
// a `.split` that is `align-items: center`, so the copy beside them moves too --
// twice a lap, unasked. So neither one may change state by taking anything out
// of the flow. The panes share a grid cell, which makes the box the taller of
// the two at every width with no number for anybody to maintain; the removed
// paragraph keeps its space; and the block that comes and goes with the chosen
// baseline carries no `w-del`, because one word leaving the flow can cost the
// paragraph a line. Asserted here because the failure is a pulse, and a pulse is
// exactly what cannot be seen from a repository with no browser in it.
assert.match(siteCss, /\.sim-view \.sim-body \{\s*display: grid/, 'the two views share a cell');
assert.match(
  siteCss,
  /\.sim-view\[data-view="raw"\] \.pane-rendered \{\s*visibility: hidden/,
  'so swapping them is a visibility change and not a reflow',
);
assert.match(
  siteCss,
  /\.sim \.chg-del:not\(\.is-marked\) \{\s*visibility: hidden/,
  'and a removed paragraph outside this baseline is hidden where it stands',
);
const history = siteHtml.slice(siteHtml.indexOf('id="sim-history"'));
const picks = [...history.matchAll(/data-in="([^"]+)"([\s\S]*?)<\/div>/g)];
assert.ok(picks.length >= 3, 'the history scene has blocks to pick between');
for (const [, baselines, block] of picks) {
  // Three baselines means the block is in all of them and never toggles, so
  // what it does to the flow does not matter.
  if (baselines.split(' ').length === 3) continue;
  assert.ok(!block.includes('w-del'), `the ${baselines} block has no word that leaves the flow`);
}

// Nothing on the page draws a scene for someone who asked for stillness, and
// nothing keeps playing under the hand that reached for it.
assert.match(siteJs, /reduced\.matches/, 'a scene that plays itself respects reduced motion');
assert.match(siteJs, /pointerdown/, 'and stops for good the first time it is touched');

// And it has to be openable from here, which `file://` does not do: a module
// script from that origin is refused by every browser, so the page renders
// while every one of the things asserted above is silently dead. `npm run site`
// is the answer to that, and `presite` is why it is one command -- an unstaged
// site/ served from here is the page with no icon, which is the same trap one
// step earlier.
const serveSite = fs.readFileSync(rootUrl('scripts/serve-site.mts'), 'utf8');
const scripts = JSON.parse(
  fs.readFileSync(rootUrl('package.json'), 'utf8'),
).scripts;
assert.strictEqual(
  scripts.site,
  'node out/scripts/serve-site.mjs',
  'the page can be served from here',
);
assert.strictEqual(scripts.presite, 'npm run build:site', 'and is staged before it is');
assert.match(serveSite, /'127\.0\.0\.1'/, 'on the loopback and nowhere else');
assert.match(serveSite, /'cache-control': 'no-store'/, 'holding nothing between edits');
// A static server over a directory in a repository full of things that are not
// the landing page. `..` has to stop at site/, however it was spelt.
assert.match(serveSite, /relative\(root, file\)\.startsWith\('\.\.'\)/, 'and serving only site/');
assert.match(serveSite, /createSiteServer\(\);[\s\S]*server\.listen/,
  'npm run site is the server this tests, not another one beside it');

// The icon is copied in rather than committed, so the deploy has to run the
// script that copies it -- an unbuilt site/ is a page with no icon and no link
// preview, and it would deploy perfectly happily.
const pages = fs.readFileSync(rootUrl('.github/workflows/pages.yml'), 'utf8');
const wrangler = fs.readFileSync(rootUrl('wrangler.toml'), 'utf8');
const ignore = fs.readFileSync(rootUrl('.gitignore'), 'utf8');
assert.match(pages, /npm run build:site/, 'the deploy stages the icon and the og:image');
assert.match(pages, /command: pages deploy/, 'before uploading anything');
assert.match(wrangler, /pages_build_output_dir = "site"/, 'from the directory wrangler.toml names');
assert.match(wrangler, /^name = "redline"$/m, 'into the project it names');
// Two jobs, for the reason the web app's deploy is two: building the page compiles a script, so
// it needs `npm ci`, which runs every dependency's install scripts, and the job that has done
// that must not hold the Cloudflare token.
{
  assert.deepStrictEqual(
    pagesCode.slice(pagesCode.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
    ['  build:', '  deploy:'],
    'a job that builds the page, and a job that deploys what it built',
  );
  const buildJob = pagesCode.slice(
    pagesCode.indexOf('\n  build:'),
    pagesCode.indexOf('\n  deploy:'),
  );
  const deployJob = pagesCode.slice(pagesCode.indexOf('\n  deploy:'));
  assert.match(deployJob, /needs: build/, 'the deploy waits for the build');
  assert.match(
    buildJob,
    /run: npm ci\b[\s\S]*run: npm run build:site\b/,
    'built from a clean install',
  );
  assert.doesNotMatch(buildJob, /secrets\./, 'the job that runs npm ci holds no secret');
  assert.match(deployJob, /apiToken: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'the token');
  assert.match(deployJob, /accountId: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'the account');
  assert.doesNotMatch(deployJob, /actions\/checkout/, 'with no checkout, so no wrangler.toml');
  assert.doesNotMatch(deployJob, /\bnpm\b|\bnpx\b/, 'and no npm to run a dependency with');
  assert.strictEqual(deployJob.match(/^ {6}- /gm).length, 3, 'a node, the artifact, the deploy');
  // wrangler.toml is not there to be read, so the project and the directory are named here, and
  // they are the ones wrangler.toml names.
  assert.strictEqual(
    deployJob.match(/--project-name=(\S+)/)?.[1],
    wrangler.match(/^name = "(.+)"$/m)[1],
    "into the landing page's project",
  );
  assert.strictEqual(
    deployJob.match(/pages deploy (\S+) /)?.[1],
    wrangler.match(/^pages_build_output_dir = "(.+)"$/m)[1],
    'and the directory wrangler.toml names',
  );
  assert.match(deployJob, /command: pages deploy site --project-name=redline --branch=main/);
  // What is uploaded is what was built: the one directory, by the one name, and an empty one is
  // an error.
  assert.match(
    buildJob,
    /name: redline-site\n\s+path: \|\n\s+site\n\s+!site\/\*\.ts\n\s+if-no-files-found: error/,
    'site/ without the TypeScript beside its compiled script, or nothing',
  );
  assert.match(
    deployJob,
    /name: redline-site\n\s+path: site/,
    'which the deploy downloads to site/',
  );
  console.log('✓ pages.yml builds in one job and deploys from another, token in one');
}
assert.match(ignore, /^site\/icon\.svg$/m, 'the copied icon is build output, not source');
assert.match(ignore, /^site\/icon\.png$/m, 'and so is the png of it');
// Absolute, because a link preview does not resolve a relative og:image against
// the page -- Slack drew an empty card for `images/hero.png` -- but still on
// this site's own origin, so it is the file build:site copies in. The icon and
// not a screenshot, which went stale with every change to the reader; a png,
// because no unfurler draws an svg.
assert.match(
  siteHtml,
  /property="og:image" content="https:\/\/redline\.iamtuna\.org\/icon\.png"/,
  'the card image is the app icon, as an absolute URL to a local file',
);
// The size a preview lays the card out at before it has the image, so it has to
// be the png's own -- read out of its IHDR rather than written down twice.
const iconPng = fs.readFileSync(rootUrl('assets/icon.png'));
const ogSize = (k) => Number(siteHtml.match(new RegExp(`og:image:${k}" content="(\\d+)"`))?.[1]);
assert.strictEqual(ogSize('width'), iconPng.readUInt32BE(16), 'at the width of the icon');
assert.strictEqual(ogSize('height'), iconPng.readUInt32BE(20), 'and its height');
assert.match(siteHtml, /name="twitter:card" content="summary"/, 'on a square card, not a wide one');

// Nothing the page loads carries a content hash, and the HTML sends no
// Cache-Control at all -- so it revalidates while anything held by max-age
// does not, and a returning reader gets this deploy's markup against the last
// one's stylesheet. For an image that is a stale picture; for these two it is
// the page with its styling and its scenes missing, which is what it looked
// like. Either the filenames start carrying a version or these stay no-cache
// (still cached, just revalidated -- the usual answer is a 304), and asserting
// the pair means the day somebody adds the version, this line says so.
const headers = fs.readFileSync(rootUrl('site/_headers'), 'utf8');
for (const ext of ['css', 'js']) {
  const block = headers.match(new RegExp(`^/\\*\\.${ext}\\n((?:  .+\\n)+)`, 'm'));
  assert.ok(block, `_headers has a rule for ${ext}`);
  assert.match(block[1], /Cache-Control: no-cache/, `and revalidates the ${ext}`);
  assert.match(
    siteHtml,
    new RegExp(`(?:href|src)="landing\\.${ext}"`),
    `which is what lets landing.${ext} be named without a version`,
  );
}

// The page sells a download, and the project is open source, so GitHub is
// linked twice over: the dmg on a release, and the repository itself -- from the
// nav and from the footer, which is where the license is named. Nothing deeper:
// a link into a file or a branch is one a rename or a force-push breaks quietly.
const REPO = 'github.com/tuanchauict/redlineapp';
const githubLinks = siteHtml.match(/github\.com[^"\s<]*/g) ?? [];
assert.ok(
  githubLinks.every((u) => u === REPO || u.startsWith(`${REPO}/releases/download/v`)),
  'the page links nowhere on GitHub but the repository and the release dmg',
);
assert.ok(
  githubLinks.filter((u) => u === REPO).length >= 2,
  'and the repository from the nav and from the footer',
);
assert.match(siteHtml, /<p class="eyebrow">.*open-source/, 'the hero says it is open source');
assert.match(siteHtml, /Open source, Apache 2\.0/, 'and the footer which license');
assert.match(siteCss, /\.icon-btn \.i-gh \{\s*fill: currentColor/, 'the GitHub mark is filled');
assert.ok(!/npm (install|start|run)/.test(siteHtml), 'and offers no install from a checkout');

// And it quotes no count of its own parts. A strip of big numbers stood under
// the hero saying 0 files written, 0 requests, 50 commits read in, 6 vendored
// dependencies; the two zeros are the promise this product makes and already
// have a sentence at the foot of Get it, and the other two are the repository
// talking about itself on a page that sells the app. Counted as a figure a
// `0` invites the reader to work out what large would have meant. The numbers
// that remain are all the product's own -- a version, a p99, a keystroke -- so
// what this looks for is the shape the strip had: a standalone figure as the
// whole of its element.
const figures = [...siteHtml.matchAll(/<(b|strong)>\s*(\d[\d,.]*)\s*<\/\1>/g)];
assert.deepStrictEqual(
  figures.map((m) => m[2]),
  [],
  'the page quotes no count of its own parts',
);

// The full-bleed band keeps its content in the page's column with padding, not
// with `margin-inline: auto` on each child. The margin form is one `margin`
// shorthand away from collapsing: a child that sets its own top gap that way --
// `.sim-wrap` does -- resets the inline margins to 0 without mentioning them,
// and lands against the left edge of the window while its siblings stay centred.
// Nothing here can see that, and on a window the width of the one it was found
// on the two were 400px apart.
const alt = siteCss.slice(siteCss.indexOf('.band-alt {'));
assert.match(
  alt.slice(0, alt.indexOf('}')),
  /padding-inline: calc\(.*max\(0px,/s,
  'the full-bleed band centres its column with padding',
);
assert.ok(
  !/\.band-alt > \*/.test(siteCss),
  'and not with a margin on each child, which a child can overwrite',
);

// The card's prose rules are the card's own. As a descendant selector they also
// reached into the illustration, overriding the size it asks for and adding a
// top margin inside a box that is padded evenly.
assert.match(siteCss, /\n\.card > p \{/, "the card's prose rules stop at its own children");
assert.ok(!/\n\.card p \{/.test(siteCss), 'and do not reach the illustration under it');

// A group of four cards in a grid that fits three is three and an orphan, which
// reads as a card that did not fit. The count has to be stated, because it is
// derived from a width that is a clamp -- and a stated count cannot notice it
// has run out of room, so the narrow case has to be taken back by hand.
const wide = siteHtml.match(/class="cards[^"]*cards-wide[^"]*"([\s\S]*?)\n {8}<\/div>/);
assert.ok(wide, 'the four-card group states its column count');
assert.strictEqual(
  (wide[1].match(/<article class="card/g) || []).length,
  4,
  'and is still the group with four in it',
);
assert.match(siteCss, /\.cards-wide \{\s*grid-template-columns: repeat\(2, 1fr\)/, 'two across');
const narrow = siteCss.slice(siteCss.indexOf('@media (max-width: 560px)'));
assert.match(
  narrow,
  /\.cards-wide \{\s*grid-template-columns: minmax\(0, 1fr\)/,
  'and one across where two no longer fit',
);

// Cards in a row are stretched to the tallest, and where the slack lands is the
// difference between three illustrations on one floor and three at three
// heights over one line of prose. It goes above the illustration, not below it.
assert.match(
  siteCss,
  /\.card > p:last-of-type \{\s*margin-bottom: auto/,
  'the slack in a stretched card opens above the illustration',
);

// A kbd is an inline-block, so a line may break in front of one and leave the
// `(` of `(⌘B)` at the end of the line above its cap. That reads as a typo.
assert.match(siteCss, /\.nb \{\s*white-space: nowrap/, 'a bracketed key cap is one word');
for (const key of ['⌘B', '⌥⌘B']) {
  assert.ok(
    siteHtml.includes(`<span class="nb">(<kbd>${key}</kbd>)</span>`),
    `and ${key} is written as one`,
  );
}

// The dmg is published under a versioned filename, built from the tag -- so the
// one thing on this page that goes stale on its own is the version it offers.
// build:site is what refuses to stage a page naming a dmg that was never built;
// this is the check that it still does.
//
// Not that the page as committed names package.json's version: build:site
// overwrites it on every deploy, so holding the source to it would only make
// every bump touch site/ for nothing. What the source must have is a link
// build:site can find.
const buildSite = fs.readFileSync(rootUrl('scripts/build-site.mts'), 'utf8');
const RELEASE_DOWNLOADS = 'https://github.com/tuanchauict/redlineapp/releases/download';
const dmgHref = siteHtml.match(/href="(https:\/\/[^"]+\/v(.+?)\/Redline-(.+?)-universal\.dmg)"/);
assert.ok(dmgHref, 'the page offers the dmg over plain https');
assert.strictEqual(dmgHref[2], dmgHref[3], 'from the release for the version it names');
assert.ok(
  ci.includes(`Redline-\${VERSION}-universal.dmg`),
  'under the name the release step uploads',
);
assert.ok(dmgHref[1].startsWith(`${RELEASE_DOWNLOADS}/v`), 'on a GitHub release of this repo');
assert.match(buildSite, new RegExp(RELEASE_DOWNLOADS.replaceAll('.', '\\.')), 'the one build:site rewrites');
assert.match(siteHtml, /<span class="dl-ver">[^<]+<\/span>/, 'with the version on the button');
assert.ok(ci.includes(new URL(dmgHref[1]).host), 'from the host the release step prints');
assert.match(buildSite, /pkg\.version/, 'and build:site writes the current one in rather than');
assert.match(buildSite, /TAP\/redline/, 'trusting it, though it still refuses the tap placeholder');
// The og:image is a reference no browser would ever report broken, so build:site
// checking content= is the only thing that would notice the card image being
// renamed in assets/ -- and copying the png is what puts it there to find.
assert.match(buildSite, /src\|href\|content/, 'and checks content= alongside src= and href=');
assert.match(buildSite, /\['icon\.svg', 'icon\.png'\]/, 'after copying in both icons');
console.log('✓ the landing page parses, is wired up, and deploys what it builds');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
console.log('\nall smoke tests passed');
process.exit(0);
