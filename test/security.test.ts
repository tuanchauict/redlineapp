import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { rootUrl } from '../src/hosts/node/root.js';
import { LIST_FAMILIES } from '../src/reader/fonts.js';
import { inlineScriptHashes, serialize, directives } from '../src/core/csp.js';
import { pageJs as appJs, policy, portOf, scratch, serve } from './support.js';

// The sample, copied, so that nothing a check does can reach the one in the repository.
const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
const { server, base } = await serve(file);

// What a document may do, and who may ask.
// A document is someone else's text and markdown-it lets its HTML through, so
// the page sanitizes at insertion, a CSP stands under that, and in the app the
// shell refuses what the reader never asks for. None of it can be watched
// working here -- there is no DOM to sanitize in and no window to run a hostile
// document through -- so what is asserted is that each layer exists, is wired
// to the place it guards, and agrees with the code it mirrors.

/** A request with headers fetch will not let a caller set, Host among them. */
let headHash, served;
test('a document cannot run, and the shell does only what the reader asks', async () => {
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
  headHash = crypto.createHash('sha256').update(inline[0]).digest('base64');
  served = (await fetch(base + '/')).headers.get('content-security-policy') ?? '';
  const servedCsp = policy(served);
  assert.deepStrictEqual(servedCsp['script-src'], ["'self'", `'sha256-${headHash}'`],
    'index.html is served with a CSP: script from here, plus the head script by its hash');
  assert.ok(!(await fetch(base + '/app.js')).headers.get('content-security-policy'),
    'on the page, not on every asset');

  // The app's copy is in tauri.conf.json, where the bundler adds the hash itself
  // And must be kept off style-src, where a nonce would switch off the.
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
});

// core/csp.js: the header the server sends for the current index.html, written out the long
// way -- a literal directive list and node's own hash -- so that a change to the list in
// csp.js has to be made here too, on purpose. The Tauri copy is compared with the same list
// above; the web build's `_headers` and the extension's <meta> are made from this one.
test('core/csp.js builds the served header', async () => {
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
});
