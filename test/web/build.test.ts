import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';
import http from 'node:http';
import { rootUrl, ROOT } from '../../src/hosts/node/root.js';
import type { HostName } from '../../scripts/stage-page.mjs';
import { policy, portOf, scratch, serve } from '../support.js';

const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
// What the CLI's server sends as its policy, which the web app's _headers is measured against.
const { base } = await serve(file);
const servedCsp = policy((await fetch(base + '/')).headers.get('content-security-policy') ?? '');

// The web app's build: one page staged per host, and the headers a static host needs.
// stage-page.mts is the body of build:dist with the host as a parameter, so the desktop app's page
// has to be what it always was, and the web app's the same page with the other reader in it.
// build:webapp adds `_headers`, which is what makes a static host say what the CLI's server says.
// What no test here can say is whether Cloudflare Pages serves Mermaid's .mjs chunks as
// text/javascript, which a module script needs, or whether a browser keeps two builds' workers
// apart by name: those are for the first deploy and a person with a browser to show.
test('the web app\'s build: one page staged per host, and the headers a static host needs', async (t) => {
  let out, shimOf, stagedWeb, tauri, web, inTauri, inWeb, webWin;
  const { HOSTS, stagePage, assertSafeDest, bundleHash } = await import('../../scripts/stage-page.mjs');
  const { buildWebapp, headersFile } = await import('../../scripts/build-webapp.mjs');
  const { createWebappServer } = await import('../../scripts/serve-webapp.mjs');
  const { createSiteServer } = await import('../../scripts/serve-site.mjs');
  const { workerName, openPort } = await import('../../src/hosts/web/backend.js');
  const read = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const version = JSON.parse(read('./package.json')).version;
  const walk = (dir, rel = '') =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(dir, path.join(rel, e.name)) : [path.join(rel, e.name)],
    );
  const mermaidOf = (list) => list.filter((f) => f.startsWith(`vendor${path.sep}mermaid`)).sort();

  await t.test('stage-page gives each host its own reader, and the desktop page is as it was', async () => {
    const vm = await import('node:vm');
    out = fs.mkdtempSync(path.join(tmp, 'stage-'));
    /** What running a staged host.js leaves on the window. */
    shimOf = (dir) => {
      const win = vm.createContext({});
      vm.runInContext(fs.readFileSync(path.join(dir, 'host.js'), 'utf8'), win);
      return win;
    };

    // stage-page: a host gets its own reader and nobody else's.
    const stagedTauri = stagePage(path.join(out, 'tauri'), { host: 'tauri' });
    stagedWeb = stagePage(path.join(out, 'web'), { host: 'web' });
    [tauri, web] = [stagedTauri.dest, stagedWeb.dest];
    [inTauri, inWeb] = [walk(tauri), walk(web)];
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
    assert.ok(mermaidOf(inWeb).length > 10, 'Mermaid\'s tree is there for a document that draws');
    assert.deepStrictEqual(mermaidOf(inWeb), mermaidOf(inTauri), 'and is the same tree in both');
    assert.ok(mermaidOf(inWeb).every((f) => /\.mjs$/.test(f)),
      'of modules, and nothing that is not');
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
    webWin = shimOf(web);
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
  });

  // stage-page empties what it is given, so it is not given the repository.
  // The guard is asked about the repository, and `stagePage` never is: were it ever to regress,
  // the test that called `stagePage('.')` would be what deleted the repository, .git and all.
  await t.test('stagePage will not empty the repository, or anything that holds it', async () => {
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
    refused('/x', '/x/..foo');
                               // `..foo` is a name, and the repository is in it: not a way up
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
  });

  // _headers: the hash is of what is staged, and the worker may load.
  let builtApp, built, stagedHtml, headerRules, rule;
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

  await t.test('_headers: the hash is the staged head script\'s, and worker-src is there', async () => {
    builtApp = buildWebapp(path.join(out, 'app'));
    built = builtApp.dest;
    stagedHtml = fs.readFileSync(path.join(built, 'index.html'), 'utf8');
    const headerText = fs.readFileSync(path.join(built, '_headers'), 'utf8');
    const headerLines = headerText.split('\n');
    headerRules = rulesOf(headerText);
    assert.strictEqual(headerLines[0], '/*',
      'the first rule is for every path -- the worker\'s too');
    rule = headerRules.get('/*');
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
  });

  // _headers: index.html is asked about every time, everything else is kept.
  // The page's files are asked for as `?v=<build>`, so each URL is one file for ever and the
  // browser may keep it for as long as it will. The one URL that is the same in every build is
  // the page, and it is what says which build the rest are, so it is asked about each time: if it
  // were kept, no release would be seen, which is the thing all of this is for.
  await t.test('_headers: index.html is revalidated, and every other path is kept for a year', async () => {
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
  });

  // The build is its version and the bundles the reader is made of.
  // A version alone is the same across every rebuild at that version, and each of those is new
  // reader code that a tab left open would keep alive for the new tabs to join.
  let build;
  await t.test('the build is the version and a hash of the bundles the reader is made of', async () => {
    const bundlesOf = (dir) =>
      ['backend-web.js', 'reader-worker.js'].map((f) => fs.readFileSync(path.join(dir, 'vendor', f)));
    build = `${version}+${bundleHash(bundlesOf(web))}`;
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
  });

  // The worker is named for the build.
  await t.test('the worker is named for the build, by the shim the build stages', async () => {
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
  });

  // Served from anywhere: nothing in the staged page reaches for the root.
  // The page names its own files relative to itself, and the worker bundle finds its reader by
  // `import.meta.url`, so dist/web works from any directory of any static host and not only from
  // the root of the hostname it is published at. A URL that starts with a slash would break that
  // quietly, on the one host that serves it from a path. The `/api/...` calls in backend.js are
  // the http backend's, which `__REDLINE_WEB` never reaches.
  await t.test('the staged web app names its files relative to itself, so any path serves it', async () => {
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
  });

  // The web app asks for every file by its build, so that it can be kept for a year.
  // `?v=<build>` is in the URL of everything the page loads, and the headers say a URL with one is
  // never anything else. A relative import does not take its importer's query, so what is tested
  // is not that `app.js` has one but that nothing it loads is without: the page, the imports of
  // the files that are not bundled, and the worker, whose URL is made inside the bundle.
  await t.test('the web app asks for every file by its build: page, imports and worker', async () => {
    const { pageHash } = await import('../../scripts/stage-page.mjs');
    const { sibling } = await import('../../src/hosts/web/backend.js');
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
  });

  // `npm run webapp`: the way a static host will serve it.
  let rawPath;
  await t.test('npm run webapp serves dist/web with its headers, .mjs as script, and no more', async () => {
    const server = createWebappServer(built);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const site = `http://127.0.0.1:${portOf(server)}`;
    rawPath = (p, srv = server) =>
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
  });

  // A request that does not parse is that request's problem, not the server's.
  // A throw in a request handler is an uncaught exception, so one `GET /100%` ended the process
  // and the page with it. Both static servers, since they are the same twenty lines.
  await t.test('a request that does not parse is a 400, and both static servers stay up', async () => {
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
  });

  fs.rmSync(out, { recursive: true, force: true });
});
