// Smoke test: boot the server on a sample file, edit the file, verify the
// paragraph diff, live-reload event, version history and mark-read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { createServer } from './src/server.js';
import { createMarkdown } from './src/render.js';
import { renderDocument } from './src/document.js';
import { nodePlatform } from './src/platform-node.js';
import { LIST_FAMILIES } from './src/fonts.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-'));
process.env.REDLINE_HOME = path.join(tmp, 'home');

const file = path.join(tmp, 'sample.md');
fs.copyFileSync(new URL('./sample.md', import.meta.url), file);

const { server } = await createServer({ file });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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
const clientFor = (origin) => async (p, init) => render(await (await fetch(origin + p, init)).json());
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
const { createPlantumlRenderer } = await import('./src/plantuml.js');
const puml = await createPlantumlRenderer({}, nodePlatform);
const pumlRes = await fetch(base + '/api/plantuml', { method: 'POST', body: 'Alice -> Bob: hi' });
assert.strictEqual(pumlRes.status, 200, 'the render endpoint answers');
const pumlOut = await pumlRes.json();
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
// is already finished. Without the handler in platform-node.js this line does
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
assert.strictEqual(await raw('/api/fonts', { host: `localhost:${server.address().port}` }), 200,
  'localhost is this server too');
assert.strictEqual(await raw('/', { host: `evil.example:${server.address().port}` }), 403,
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

const indexHtml = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
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
const shellConf = JSON.parse(fs.readFileSync(new URL('./shell/tauri.conf.json', import.meta.url)));
const appCsp = Object.fromEntries(
  Object.entries(shellConf.app.security.csp).map(([k, v]) => [k, v.split(/\s+/)]),
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
// two that carry what a document said go through DOMPurify, and the rest are
// the page's own constant markup. A new one has to be one or the other.
const appJs = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
assert.match(appJs, /import \{ sanitizeDocument, sanitizeSvg \} from '\.\/vendor\/sanitize\.js';/,
  'the page loads the sanitizer');
assert.match(appJs, /doc\.innerHTML = sanitizeDocument\(raw \? d\.rawHtml : d\.html\);/,
  'the document, rendered or raw, is sanitized on its way into the page');
assert.match(appJs, /closest\('\.diagram'\)\.innerHTML = sanitizeSvg\(out\.svg\);/,
  'and so is a PlantUML drawing, which the jar made from the document');
assert.deepStrictEqual(
  [...appJs.matchAll(/([\w$]+)(?:\([^)]*\))?\.innerHTML =/g)].map((m) => m[1]).sort(),
  ['ack', 'closest', 'count', 'cut', 'doc', 'x'],
  'no innerHTML the page does not know is safe',
);
const sanitizeJs = fs.readFileSync(new URL('./src/sanitize.js', import.meta.url), 'utf8');
assert.match(sanitizeJs, /FORBID_TAGS: \['style', 'form'\]/,
  'a document cannot restyle the window or hide its own marks');
assert.match(sanitizeJs, /SANITIZE_DOM: false,\n\s*FORBID_ATTR: \['name'\]/,
  'heading ids keep their anchors, and name is what goes instead');
assert.ok(fs.readFileSync(new URL('./public/vendor/sanitize.js', import.meta.url), 'utf8')
  .includes('DOMPurify'), 'build:web bundles DOMPurify into it');
assert.match(fs.readFileSync(new URL('./scripts/build-dist.mjs', import.meta.url), 'utf8'),
  /'vendor\/sanitize\.js'/, 'and the app refuses to build without it');

// The shell runs only the command lines the reader builds. Each spawn in src/
// is one arm of `may_spawn`, and the arguments it is matched against are
// copied from these files -- so the two are compared here, not trusted.
const hostRsCheck = fs.readFileSync(new URL('./shell/src/host.rs', import.meta.url), 'utf8');
const srcSpawns = fs.readdirSync(new URL('./src/', import.meta.url))
  .filter((f) => f.endsWith('.js') && !f.startsWith('platform'))
  .flatMap((f) => {
    const js = fs.readFileSync(new URL(`./src/${f}`, import.meta.url), 'utf8');
    return [...js.matchAll(/platform\.spawn\(([^,]+),/g)].map((m) => `${f}: ${m[1]}`);
  })
  .sort();
assert.deepStrictEqual(srcSpawns,
  ["fonts.js: 'osascript'", 'git.js: \'git\'', 'plantuml.js: found.cmd'],
  'every program the reader runs is one host.rs allows -- a new one needs an arm there');
const rustFamilies = hostRsCheck.match(/const LIST_FAMILIES: &str = r#"(.*)"#;/)?.[1];
assert.strictEqual(rustFamilies, LIST_FAMILIES,
  'the one osascript the shell runs is the one src/fonts.js asks for');
const gitJs = fs.readFileSync(new URL('./src/git.js', import.meta.url), 'utf8');
const rustList = (js) => js.replaceAll("'", '"');
for (const call of [
  "'ls-files', '--full-name', '--error-unmatch', '--'",
  "'rev-parse', '--show-toplevel'",
  "'--follow',\n          '--name-only',",
]) {
  assert.ok(gitJs.includes(call), `src/git.js still runs ${call}`);
  assert.ok(hostRsCheck.includes(rustList(call.replace(/,\n\s*/g, ', '))),
    `and host.rs allows ${call}`);
}
assert.ok(gitJs.includes('`--format=%x00%H${SEP}%at${SEP}%s`') && gitJs.includes("SEP = '\\x1f'")
  && hostRsCheck.includes('"--format=%x00%H\\x1f%at\\x1f%s"'), 'the log format, separator and all');
const pumlJs = fs.readFileSync(new URL('./src/plantuml.js', import.meta.url), 'utf8');
assert.ok(pumlJs.includes("'-tsvg', '-pipe', '-charset', 'UTF-8'")
  && hostRsCheck.includes('["-tsvg", "-pipe", "-charset", "UTF-8"]'), 'the PlantUML arguments');
assert.ok(pumlJs.includes("platform.join(root, 'plantuml.jar')")
  && hostRsCheck.includes('f == "plantuml.jar"'), 'and the jar the store can hold');

// Writing is held to the store's own layout -- the four calls in src/store.js.
for (const cmd of ['write_text', 'mkdirp', 'remove', 'rename']) {
  assert.match(hostRsCheck, new RegExp(`pub fn ${cmd}\\(app: AppHandle,`),
    `${cmd} knows where home is, to know where the store is`);
}
const storeJs = fs.readFileSync(new URL('./src/store.js', import.meta.url), 'utf8');
assert.ok(storeJs.includes("join(root, 'objects')") && storeJs.includes("hash + '.md'")
  && hostRsCheck.includes('*dir == "objects" && name.ends_with(".md")'), 'snapshots');
assert.ok(storeJs.includes("join(root, 'docs')") && storeJs.includes("docKey(absPath) + '.json'")
  && hostRsCheck.includes('*dir == "docs" && name.ends_with(".json")'), 'and the index per file');
assert.ok(storeJs.includes("join(home, '.md-reader')")
  && hostRsCheck.includes('home.join(".md-reader") || Path::new(&to) != home.join(".redline")'),
  'and the one move the store ever makes');
console.log('✓ a document cannot run, and the shell does only what the reader asks');

// The show/hide-changes switch is spread over three files; if one half is
// dropped it silently stops doing anything, which nothing else catches. It has
// no button of its own — the newest row in the history is where it is thrown
// from, so the bar carries no version list and it has to be in the sidebar.
const [pageHtml, pageCss, pageJs] = await Promise.all(
  ['/', '/styles.css', '/app.js'].map(async (p) => (await fetch(base + p)).text()),
);
assert.match(pageHtml, /id="histList"/, 'the history list is in the sidebar');
assert.ok(!pageHtml.includes('id="baseline"'), 'no version dropdown on the bar');
assert.ok(!pageHtml.includes('id="markRead"'), 'no "Mark read" button on the bar');
assert.match(pageHtml, /no-diff/, 'marks suppressed before first paint');
assert.match(pageJs, /classList\.toggle\('no-diff'/, 'the switch drives the class');
assert.match(pageJs, /v\.current\) return !state\.diff/, 'the newest row shows that state');
// Moving the read mark has no control in the list: the row it would have sat
// on is the one you click to compare against that version, and from an inch
// apart the two did nearly the same thing. What is left is the part the list
// cannot do — saying "I have seen this" with the sidebar shut.
assert.ok(!pageJs.includes('readAction') && !pageCss.includes('.ver-act'), 'no control on the row');
assert.match(pageJs, /function markRead/, 'but the key still moves the mark');
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
assert.match(pageJs, /'ver-name', name/, 'and that name is the row title');
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

// The contents list and the checked-off marks are each spread over the same
// three files, and each fails quietly if one part goes: a list with no rows, or
// a tag you can click that never changes.
assert.match(pageHtml, /id="tocList"/, 'the contents list has somewhere to go');
assert.match(pageJs, /function paintToc/, 'and something to fill it');
assert.match(pageJs, /function spyToc/, 'and it follows where you are reading');
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
assert.match(pageJs, /localStorage\.setItem\(SHUT_KEY/, 'and write that back');
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
assert.match(pageHtml, /localStorage\.removeItem\("redline:panel"\)/, 'the old key is retired');
assert.ok(!pageJs.includes('redline:panel'), 'and nothing else reads it');
// A document whose only heading is its title has no contents. The column says
// so rather than closing itself — whether it is open is the reader's standing
// choice, and the payload that would decide it arrives after first paint.
assert.match(pageJs, /No headings in this document/, 'an empty contents list says so');

// Forgetting versions is the only destructive thing in the sidebar, and it does
// not stop at the row it sits on. A bin said otherwise — a bin on a row offers
// to remove that row — so it cuts a list at a point instead, and pointing at
// it dims every row that would go. That preview is pure CSS off a sibling
// combinator, which holds only while the list is rows in one order.
assert.ok(!pageJs.includes('M3 5h10'), 'the bin is no longer a bin');
assert.match(
  pageJs,
  /closest\('\.ver'\)\?\.classList\.toggle\('cutting'/,
  'the cut icon says what it would take',
);
assert.ok(pageCss.includes('.ver.cutting ~ .ver'), 'and the stylesheet dims that far down');
// `.ver:hover .ver-cut` is a class heavier than a bare `.ver-cut:hover`, so the
// hover state has to be qualified or it never applies and the control you are
// pointing at sits at the same hint as the one you are not.
assert.ok(pageCss.includes('.ver .ver-cut:hover'), 'the cut icon lights fully when pointed at');
assert.match(pageJs, /'ver ask cutting'/, 'the confirmation keeps the dim it was reached from');
assert.match(
  pageJs,
  /children\[1\]\?\.classList\.toggle\('cutting'/,
  'and Clear history previews the same act the same way',
);

assert.match(pageHtml, /id="ackCount"/, 'the checked changes are countable');
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
  /function goToChange\(step\)[\s\S]*?goToNode\(/,
  'the key path lands through the same function a ruler click will',
);
assert.match(pageCss, /\.ruler-current \{/, 'and the stylesheet gives that mark its own look');
// `highlightRulerCurrent` flips the class on marks already drawn instead of
// asking `paintRuler` to rebuild them, since a freshly rebuilt element has no
// "before" state for `.ruler-mark`'s opacity transition to fade from.
assert.match(
  pageJs,
  /function highlightRulerCurrent/,
  'the mark is relit without rebuilding the ruler',
);
assert.match(pageJs, /mark\._nodes = nodes/, 'each mark remembers what it stands for');
assert.match(pageCss, /\.ruler-mark \{[^}]*transition: opacity/, 'so losing current can fade');
// The same highlight on hover, not only on `n`/`p` -- delegated, since the
// marked blocks are replaced whole on every paint and a listener bound to one
// would go with it.
assert.match(pageJs, /doc\.addEventListener\('pointerover'/, 'hovering a block is also caught');
assert.match(pageJs, /doc\.addEventListener\('pointerout'/, 'and leaving it is too');
assert.match(pageJs, /hoverNode = null/, 'cleared when the document it points into is gone');
// A mark is also something to point at, not only something to read: a click
// lands on the change it stands for, and hovering it tints the block(s) back,
// the reverse of the doc-to-ruler hover above.
assert.match(pageJs, /ruler\.addEventListener\('click'/, 'a mark can be clicked');
assert.match(
  pageJs,
  /ruler\.addEventListener\('click'[\s\S]*?goToNode\(/,
  'and lands the same way n\\/p do',
);
assert.match(pageJs, /ruler\.addEventListener\('pointerover'/, 'and hovering one is caught too');
assert.match(pageJs, /ruler\.addEventListener\('pointerout'/, 'and leaving it is too');
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
assert.match(pageJs, /localStorage\.setItem\(key, String\(clampSideW/, 'and both write back');
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
  /localStorage\.setItem\(TOC_H_KEY, String\(clampTocH/,
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
  /function paintHistory[\s\S]*?if \(!state\.tocSide\) return;/,
  'History paints against the column it is actually in',
);
assert.match(
  pageJs,
  /function setTocSide[\s\S]*?paintToc\(state\.data\);\s*paintHistory\(state\.data\);/,
  'opening that column fills both of its lists',
);
assert.match(
  pageJs,
  /\$\('count'\)\.addEventListener\('click', \(\) => setTocSide/,
  'and the counter opens the column history is in, not the one it left',
);
assert.match(pageHtml, /id="count"[^>]*title="[^"]*⌥⌘B/, 'its tooltip agrees');
console.log('✓ History paints, opens and is reached through the right column');

// A menu item reaches the page over an event, through the seam, and every one
// of the three is a separate file that can be right on its own: the menu item
// that emits an event nobody listens for is greyed out by nothing and does
// nothing when picked. ⌘B and ⌥⌘B are checked as a pair because the second was
// added by copying the first, which is exactly how one of the three gets
// missed. The browser tab has no menu, so the key is the page's to catch.
const menuRs = fs.readFileSync(new URL('./shell/src/menu.rs', import.meta.url), 'utf8');
const seamJs = fs.readFileSync(new URL('./src/native-tauri.js', import.meta.url), 'utf8');
for (const [item, accel, event, hook] of [
  ['side', 'CmdOrCtrl+B', 'md:toggle-side', 'onToggleSide'],
  ['sidetoc', 'Alt+CmdOrCtrl+B', 'md:toggle-toc', 'onToggleToc'],
  ['find', 'CmdOrCtrl+F', 'md:find', 'onFind'],
]) {
  assert.ok(menuRs.includes(`with_id("${item}"`), `View has an item for ${item}`);
  assert.ok(menuRs.includes(`accelerator("${accel}")`), `under ${accel}`);
  assert.ok(menuRs.includes(`"${item}" => win::to_front(app, "${event}"`), `sending ${event}`);
  assert.ok(seamJs.includes(`${hook}: (cb) => on('${event}'`), `the seam hears it as ${hook}`);
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
  /if \(native\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*await firstTabShown;\s*\} else \{\s*await load\(\{ keepScroll: false \}\);\s*connect\(\);\s*\}/,
  'a native window waits for that answer instead of calling load() itself',
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
assert.match(pageJs, /!\$\('findBar'\)\.hidden/, 'and paint redoes it after #doc is replaced');
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
const hostRs = fs.readFileSync(new URL('./shell/src/host.rs', import.meta.url), 'utf8');
const winRs = fs.readFileSync(new URL('./shell/src/win.rs', import.meta.url), 'utf8');
assert.strictEqual(
  (seamJs.match(/\blisten\(/g) ?? []).length,
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
assert.ok(!pageHtml.includes('type="range"'), 'no slider for a size counted in whole pixels');
assert.ok(!pageHtml.includes('id="setFontName"'), 'and no font to spell by hand');
assert.match(pageHtml, /id="setSizeDown"/, 'text size steps down');
assert.match(pageHtml, /id="setSizeUp"/, 'and up');
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
assert.match(pageHtml, /class="popup"/, 'on the wrapper that can hold one');
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
const { fonts } = await (await fetch(base + '/api/fonts')).json();
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
const prefsRs = fs.readFileSync(new URL('./shell/src/prefs.rs', import.meta.url), 'utf8');
assert.match(pageHtml, /name="pAppearance" value="sepia"/, 'sepia can be chosen');
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
const { renderDiff } = await import('./src/diff.js');
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
  const at = (tag) => +new RegExp(`<${tag} data-line="(\\d+)"`).exec(renderDocument(mdLines, src).html)[1];
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

const { outline, slugify } = await import('./src/render.js');
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
const ackRes = await (await fetch(`${base}/api/ack?key=${oneKey}`, { method: 'POST' })).json();
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
const clearedAcks = await (await fetch(`${base}/api/ack?clear=1`, { method: 'POST' })).json();
assert.deepStrictEqual(clearedAcks.acked, [], 'and cleared in one call');
// Naming no change is a mistake, not an empty instruction to carry out.
assert.strictEqual((await fetch(`${base}/api/ack`, { method: 'POST' })).status, 400, 'a change must be named');
console.log('✓ check a change off');

// --- 5b'. a checked-off change becomes that block's own baseline ---------
// Check a block off, have it edited, and what comes back is what moved since
// you checked it — not the whole block replayed against the baseline, which is
// still where everything else is measured from. See docs/changes.md.
{
  const { blockId } = await import('./src/diff.js');
  const { hashContent } = await import('./src/hash.js');
  const mdAck = createMarkdown();
  const added = (html) => [...html.matchAll(/<ins class="w-add">([\s\S]*?)<\/ins>/g)].map((m) => m[1]);
  const read = 'The release paragraph, written for the team.';
  const now = 'The release paragraph, written for the whole team today.';
  const from = (text) => [{ text: `# Doc\n\n${text}\n`, blocks: [blockId(text)] }];

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
  const { createReader } = await import('./src/reader.js');
  const { DocStore } = await import('./src/store.js');
  const ackFile = path.join(tmp, 'acked.md');
  fs.writeFileSync(ackFile, '# Doc\n');
  const reader = await createReader({ platform: nodePlatform });
  const id = await reader.retain(ackFile);
  const edit = (text) =>
    new Promise((resolve) => {
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
  await reader.prune(id, v1.hash, 'read');
  assert.ok(!fs.existsSync(path.join(objects, v0.hash + '.md')), 'gc ran');
  assert.ok(fs.existsSync(v1Object), 'and kept the version a check-off reads back from');

  // "All of this is seen" subsumes every "that bit is seen".
  const marked = render(await reader.markRead(id));
  assert.deepStrictEqual([marked.acked, marked.ackedFrom], [[], []], 'marking read clears the check-offs');
  reader.closeAll();

  // Check-offs written before they carried a version are kept, as keys.
  const legacy = await DocStore.open(path.join(tmp, 'legacy.md'), nodePlatform);
  legacy.data.acked = ['addold0000001', 'mod0000000002'];
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
const serverJsSrc = fs.readFileSync(new URL('./src/server.js', import.meta.url), 'utf8');
assert.match(serverJsSrc, /at: param\('at'\)/, 'the server passes the version a change was checked in');
assert.match(pageJs, /backend\.ack\(\{ key, on, at: state\.data\?\.hash, block \}\)/, 'and the page sends it');
assert.match(pageJs, /from: data\.ackedFrom/, 'and renders against what came back');
console.log('✓ a checked-off change becomes that block\'s own baseline');

// --- 5c. the `---` header block ------------------------------------------
// Front matter, which markdown-it has no idea about: left to it, the opening
// `---` is a thematic break and the closing one turns everything above it into
// a setext heading, so the whole header lands as one enormous `<h2>` — and that
// `<h2>` then takes the top row of the contents list. Read as a block instead,
// it is a card of fields, it contributes no heading, and it is one unit to the
// diff like any other block.
const { parseFrontMatter, looksLikeFrontMatter } = await import('./src/front-matter.js');
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
await new Promise((r) => fmServer.server.listen(0, '127.0.0.1', r));
const fmDoc = await clientFor(`http://127.0.0.1:${fmServer.server.address().port}`)('/api/doc');
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

// `.name` grows to fill the bar's spare width, so a button placed after it in
// the markup sits wherever that grown box happens to end, not next to the
// (short, left-aligned) title it hangs off -- empty space the whole way
// there. Before it, the chevron is at a fixed point by the dot and the gap
// never opens.
assert.ok(
  pageHtml.indexOf('id="tabMenu"') < pageHtml.indexOf('id="nameBox"'),
  'the all-open-files chevron sits before the name, not adrift after it',
);

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
await new Promise((r) => second.server.listen(0, '127.0.0.1', r));
const base2 = `http://127.0.0.1:${second.server.address().port}`;
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
const pruned = await (
  await fetch(base2 + '/api/prune?upto=' + cutAt.hash, { method: 'POST' })
).json();
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
const noop = await (
  await fetch(base2 + '/api/prune?upto=' + head.hash, { method: 'POST' })
).json();
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
await new Promise((r) => wobble.server.listen(0, '127.0.0.1', r));
const getW = clientFor(`http://127.0.0.1:${wobble.server.address().port}`);
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
await new Promise((r) => wobble2.server.listen(0, '127.0.0.1', r));
const getW2 = clientFor(`http://127.0.0.1:${wobble2.server.address().port}`);
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
await new Promise((r) => third.server.listen(0, '127.0.0.1', r));
const gitDoc = await clientFor(`http://127.0.0.1:${third.server.address().port}`)(
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
await new Promise((r) => fourth.server.listen(0, '127.0.0.1', r));
const looseDoc = await (
  await fetch(`http://127.0.0.1:${fourth.server.address().port}/api/doc?baseline=git:HEAD`)
).json();
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
await new Promise((r) => gitSrv.server.listen(0, '127.0.0.1', r));
const baseG = `http://127.0.0.1:${gitSrv.server.address().port}`;
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
await new Promise((r) => gitSrv2.server.listen(0, '127.0.0.1', r));
const baseG2 = `http://127.0.0.1:${gitSrv2.server.address().port}`;
const caught = await until(
  async () => {
    const d = await (await fetch(baseG2 + '/api/doc')).json();
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
await new Promise((r) => fifth.server.listen(0, '127.0.0.1', r));
const base5 = `http://127.0.0.1:${fifth.server.address().port}`;

const events5 = [];
const es5 = await fetch(base5 + '/events');
const reader5 = es5.body.getReader();
(async () => {
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader5.read().catch(() => ({ done: true }));
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
const opened = await (
  await fetch(`${base5}/api/open?path=${encodeURIComponent(docA)}`, { method: 'POST' })
).json();
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
await new Promise((r) => sixth.server.listen(0, '127.0.0.1', r));
const base6 = `http://127.0.0.1:${sixth.server.address().port}`;

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
  fetch(`${base6}/api/doc?id=${idC}`).then((r) => r.json()),
  fetch(`${base6}/api/doc?id=${idD}`).then((r) => r.json()),
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
      const { value, done } = await rd.read().catch(() => ({ done: true }));
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
const unnamed = await (await fetch(`${base6}/api/doc`)).json();
assert.strictEqual(unnamed.name, 'c.md', 'a request with no id still gets the open document');
console.log('✓ several documents open at once');
await Promise.all([lC.rd.cancel().catch(() => {}), lD.rd.cancel().catch(() => {})]);
sixth.server.close();

// --- 13. the store followed the app's name --------------------------------
// It holds every snapshot of every file ever read, and a rename of the app is
// no reason to start that again from nothing — nor to leave two stores lying
// about, which is what reading the old one where it lay would have meant.
const { storeRoot } = await import('./src/store.js');
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
const mainRs = fs.readFileSync(new URL('./shell/src/main.rs', import.meta.url), 'utf8');
const arriveBody = mainRs.slice(mainRs.indexOf('fn arrive('));
assert.ok(
  arriveBody.indexOf('try_state::<win::Shell>()') <
    arriveBody.indexOf('if files.is_empty()'),
  'nothing in arrive() reads the shell before checking there is one',
);
assert.match(mainRs, /static PENDING: Mutex<Vec<PathBuf>>/, 'files that arrive too early wait');
assert.match(mainRs, /PENDING\.lock\(\)\.unwrap\(\)\.extend/, 'rather than being dropped');
assert.match(mainRs, /PENDING\.lock\(\)\.unwrap\(\)\.drain\(\.\.\)/, 'and setup takes them');
assert.match(mainRs, /RunEvent::Opened \{ urls \}/, 'from the event a Finder open comes as');
// And the association itself, since a double-click that never reaches the app
// is the same bug from the reader's side.
const tauriConf = JSON.parse(
  fs.readFileSync(new URL('./shell/tauri.conf.json', import.meta.url), 'utf8'),
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
const ci = fs.readFileSync(new URL('./.github/workflows/ci.yml', import.meta.url), 'utf8');
const pagesYml = fs.readFileSync(
  new URL('./.github/workflows/pages.yml', import.meta.url),
  'utf8',
);
assert.match(ci, /path: dist\/\*\.dmg/, 'the dmg is kept where bundle.mjs leaves it');
assert.match(ci, /if-no-files-found: error/, 'loudly, rather than uploading nothing');

const workflows = fs.readdirSync(new URL('./.github/workflows/', import.meta.url));
assert.deepStrictEqual(workflows.sort(), ['ci.yml', 'pages.yml'], 'two workflows, no more');
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
for (const [name, code] of [['ci.yml', ciCode], ['pages.yml', pagesCode]]) {
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

// The landing page deploys on its own, and only from what it is built from.
const pagesOn = triggers(pagesYml);
assert.deepStrictEqual(
  onEvents(pagesYml),
  ['  push:', '  workflow_dispatch:'],
  'pages.yml runs on a push or by hand',
);
assert.match(pagesOn, /branches: \[main\]/, 'to main');
assert.match(pagesOn, /paths:\n\s+- 'site\/\*\*'/, 'that touches site/');
assert.match(pagesOn, /- 'docs\/images\/\*\*'/, 'or the screenshots it copies in');
// Not on the version bump: the download button would name a dmg the release
// job has not uploaded yet. That job starts the deploy itself, once it has.
assert.doesNotMatch(pagesOn, /package\.json/, 'but not on a version bump');

// Signing, which is a thing that fails quietly in the direction of looking
// fine: an app signed and not notarized is refused by Gatekeeper exactly like
// an unsigned one, and the only place the difference shows is a dialog on
// somebody else's Mac. So the identity has to reach the build, and it has to
// reach it as a `--config` patch -- tauri.conf.json has the ad hoc `-` in it,
// and a patch is the one route whose precedence is documented rather than
// guessed at.
const bundleJs = fs.readFileSync(new URL('./scripts/bundle.mjs', import.meta.url), 'utf8');
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

// The dev loop, which is the one piece of tooling here whose failure mode is
// that it quietly stops saving you anything. `npm run dev` is worth having only
// because the page comes out of the binary: `tauri dev` serves shell/dist over
// a static server of its own, so a page edit is a restage and a ⌘R instead of a
// relink. Four things hold that up, and three of them break silently.
const devJs = fs.readFileSync(new URL('./scripts/dev.mjs', import.meta.url), 'utf8');
const devScripts = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).scripts;
assert.strictEqual(devScripts.dev, 'node scripts/dev.mjs', 'the dev loop is one command');
assert.match(devJs, /'tauri', 'dev'/, 'and it is `tauri dev`, not a cargo run');
// Staged from in here rather than from a `predev` hook, the same way the bundle
// does its own: there is to be no way to ask for this and get a stale page.
assert.match(devJs, /build-web\.mjs/, 'the page is bundled before the window opens');
assert.match(devJs, /build-dist\.mjs/, 'and staged, or the window shows the last run');
// `tauri dev -- [runnerArgs] -- [appArgs]`: one `--` short and `sample.md` is
// handed to cargo, which fails in a way that looks nothing like the cause.
assert.match(devJs, /'--', '--', \.\.\.appArgs/, 'a file to open reaches the app, not cargo');

// The load-bearing one. Tauri's dev watcher honours .gitignore, and shell/dist
// being ignored is the only reason restaging the page does not trip the Rust
// rebuild the whole exercise exists to avoid. Un-ignore it and `npm run dev`
// still works -- it just silently costs what `npm run app` costs.
const devIgnore = fs.readFileSync(new URL('./.gitignore', import.meta.url), 'utf8');
assert.match(
  devIgnore,
  /^(shell\/)?dist\/$/m,
  'shell/dist is ignored, so a restage is not a rebuild',
);

// public/vendor/ is build:web's output, not source. Without the filter a src/
// edit restages twice: once for the module, once for the bundle it produced.
assert.match(devJs, /vendor\$\{path\.sep\}/, 'the watcher ignores what build:web just wrote');

// And it has to die when told. A watcher left behind has no window and is not
// idle: two of them restaging one shell/dist race, because build:dist empties
// the directory before it refills it, and the loser fails inside the mermaid
// tree. Found by leaving one.
assert.match(devJs, /tauri\.kill\(sig\)/, 'ctrl-c reaches the window');
assert.match(devJs, /tauri\.kill\('SIGKILL'\)/, 'and a child that ignores it gets no third chance');
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
const cmdsRs = fs.readFileSync(new URL('./shell/src/cmds.rs', import.meta.url), 'utf8');
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
assert.match(seamJs, /onCheckUpdate: \(cb\) => on\('md:check-update'/, 'which listens for it');
assert.match(pageJs, /native\.onCheckUpdate\(/, 'and answers it');
assert.match(pageHtml, /<section id="aboutSec" data-shell>/,
  'in a section only the desktop app shows');
assert.match(pageJs, /\$\('setVersion'\)\.textContent = native\.version/,
  'which says what this is');
assert.match(hostRs, /version: app\.package_info\(\)\.version\.to_string\(\)/,
  'from the bundle the app was built as');
assert.match(pageJs, /\$\('checkUpdate'\)\.addEventListener\('click', checkUpdate\)/,
  'with a button that asks');
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
const pkgVersion = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url))).version;
const confVersion = JSON.parse(
  fs.readFileSync(new URL('./shell/tauri.conf.json', import.meta.url)),
).version;
const cargoVersion = fs
  .readFileSync(new URL('./shell/Cargo.toml', import.meta.url), 'utf8')
  .match(/^version = "([^"]+)"/m)?.[1];
assert.strictEqual(confVersion, pkgVersion, 'tauri.conf.json has the version package.json has');
assert.strictEqual(cargoVersion, pkgVersion, 'and so does shell/Cargo.toml');
console.log(`✓ the version agrees in all three places (${pkgVersion})`);

// --- the license, and everyone else's ---------------------------------------
//
// The Apache text is a legal document and has to be the one apache.org
// publishes, to the byte: a retyped copy that differs is a copy of something
// else. This is the digest of LICENSE-2.0.txt as published.
const fromRoot = (name) => fs.readFileSync(new URL(`./${name}`, import.meta.url));
assert.strictEqual(
  crypto.createHash('sha256').update(fromRoot('LICENSE')).digest('hex'),
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
  'LICENSE is the Apache 2.0 text, unaltered',
);
assert.match(String(fromRoot('NOTICE')), /^Redline\nCopyright 2026 Tuan Chau\n/, 'NOTICE');
const pkgJson = JSON.parse(fromRoot('package.json'));
assert.strictEqual(pkgJson.license, 'Apache-2.0', 'package.json names the license');
assert.match(
  String(fromRoot('shell/Cargo.toml')),
  /^license = "Apache-2.0"$/m,
  'and so does the crate',
);
const bundleConf = JSON.parse(fromRoot('shell/tauri.conf.json')).bundle;
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
  assert.ok(fs.existsSync(new URL(`./${name}`, import.meta.url)), `${name} is there`);
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
assert.strictEqual(pkgJson.scripts.notices, 'node scripts/notices.mjs', 'npm run notices');
// Kept by build:web, so the notices that sit with their code still do.
assert.match(String(fromRoot('scripts/build-web.mjs')), /legalComments: 'eof'/,
  "the bundles keep their license comments");
assert.match(String(fromRoot('public/vendor/sanitize.js')), /@license DOMPurify/,
  'and DOMPurify\'s is in the bundle');

// The bundle identifier. Everything the app remembers apart from the snapshot
// store -- window.json, and the webview's storage under ~/Library/WebKit -- is
// filed under it, so changing it would make an upgrade look like a fresh install.
const shellConfig = JSON.parse(fromRoot('shell/tauri.conf.json'));
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
const siteHtml = fs.readFileSync(new URL('./site/index.html', import.meta.url), 'utf8');
const siteCss = fs.readFileSync(new URL('./site/landing.css', import.meta.url), 'utf8');
const siteJs = fs.readFileSync(new URL('./site/landing.js', import.meta.url), 'utf8');

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
const appCss = fs.readFileSync(new URL('./public/styles.css', import.meta.url), 'utf8');
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
const serveSite = fs.readFileSync(new URL('./scripts/serve-site.mjs', import.meta.url), 'utf8');
const scripts = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).scripts;
assert.strictEqual(scripts.site, 'node scripts/serve-site.mjs', 'the page can be served from here');
assert.strictEqual(scripts.presite, 'npm run build:site', 'and is staged before it is');
assert.match(serveSite, /'127\.0\.0\.1'/, 'on the loopback and nowhere else');
assert.match(serveSite, /'cache-control': 'no-store'/, 'holding nothing between edits');
// A static server over a directory in a repository full of things that are not
// the landing page. `..` has to stop at site/, however it was spelt.
assert.match(serveSite, /relative\(SITE, file\)\.startsWith\('\.\.'\)/, 'and serving only site/');

// The one image left is copied in rather than committed, so the deploy has to
// run the script that copies it -- an unbuilt site/ is a page with no icon and
// no link preview, and it would deploy perfectly happily.
const pages = fs.readFileSync(new URL('./.github/workflows/pages.yml', import.meta.url), 'utf8');
const wrangler = fs.readFileSync(new URL('./wrangler.toml', import.meta.url), 'utf8');
const ignore = fs.readFileSync(new URL('./.gitignore', import.meta.url), 'utf8');
assert.match(pages, /npm run build:site/, 'the deploy stages the icon and the og:image');
assert.match(pages, /command: pages deploy/, 'before uploading anything');
assert.match(wrangler, /pages_build_output_dir = "site"/, 'from the directory wrangler.toml names');
assert.match(wrangler, /^name = "redline"$/m, 'into the project it names');
assert.match(ignore, /^site\/images\/$/m, 'the copied image is build output, not source');
// Absolute, because a link preview does not resolve a relative og:image against
// the page -- Slack drew an empty card for `images/hero.png` -- but still on
// this site's own origin, so it is the file build:site copies in.
assert.match(
  siteHtml,
  /property="og:image" content="https:\/\/redline\.iamtuna\.org\/images\//,
  'the card image is an absolute URL to a local file',
);

// Nothing the page loads carries a content hash, and the HTML sends no
// Cache-Control at all -- so it revalidates while anything held by max-age
// does not, and a returning reader gets this deploy's markup against the last
// one's stylesheet. For an image that is a stale picture; for these two it is
// the page with its styling and its scenes missing, which is what it looked
// like. Either the filenames start carrying a version or these stay no-cache
// (still cached, just revalidated -- the usual answer is a 304), and asserting
// the pair means the day somebody adds the version, this line says so.
const headers = fs.readFileSync(new URL('./site/_headers', import.meta.url), 'utf8');
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
// overwrites it on every deploy, and holding the source to it would make every
// bump touch site/ -- which deploys the page on merge, linking a dmg the release
// job has not uploaded yet, the very thing pages.yml not watching package.json
// is there to prevent. What the source must have is a link build:site can find.
const buildSite = fs.readFileSync(new URL('./scripts/build-site.mjs', import.meta.url), 'utf8');
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
// The og:image is copied by name, from what the page points at -- which is a
// reference no browser would ever report broken, so this is the only thing that
// would notice the card image having been renamed in docs/.
assert.match(buildSite, /src\|href\|content/, 'and checks content= alongside src= and href=');
console.log('✓ the landing page parses, is wired up, and deploys what it builds');

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(repo, { recursive: true, force: true });
console.log('\nall smoke tests passed');
process.exit(0);
