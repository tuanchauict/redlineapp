import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createReader } from '../../src/reader/reader.js';
import { createSession } from '../../src/reader/session.js';
import { webviewHtml, webviewPolicy } from '../../src/hosts/vscode/html.js';
import { attachPanel } from '../../src/hosts/vscode/panel.js';
import type { PrefsStore } from '../../src/hosts/vscode/panel.js';
import {
  createVscodePlatform,
  fromUri,
  isRemoteAddress,
} from '../../src/hosts/vscode/platform.js';
import { HOSTS } from '../../scripts/stage-page.mjs';
import { ROOT } from '../../src/hosts/node/root.js';
import { pageHtml, read, scratch } from '../support.js';

const tmp = scratch('redline-vscode-');

// The VS Code extension. There is no editor here, so `vscode` is a stand-in over node:fs that is
// as small as what platform.ts reaches for, and the webview is two arrays. What these hold is the
// extension's own logic -- the page's policy, which document a panel is on, where preferences
// go -- and that the pieces are wired together; that the editor accepts any of it is not
// something this suite can say.

class FakeUri {
  constructor(
    readonly scheme: string,
    readonly path: string,
    private readonly raw: string,
  ) {}
  static file = (p: string) => new FakeUri('file', p, `file://${p}`);
  static parse = (s: string) => new FakeUri(s.split(':')[0], s.replace(/^[^:]+:\/\/[^/]*/, ''), s);
  static joinPath = (b: FakeUri, ...parts: string[]) => FakeUri.file(path.join(b.path, ...parts));
  get fsPath() {
    return this.path;
  }
  toString() {
    return this.raw;
  }
}

const fake = {
  Uri: FakeUri,
  RelativePattern: class {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  },
  workspace: {
    fs: {
      stat: async (u: FakeUri) => {
        const s = fs.statSync(u.fsPath);
        return { type: s.isDirectory() ? 2 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      },
      readDirectory: async (u: FakeUri) =>
        fs.readdirSync(u.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? 2 : 1]),
      createDirectory: async (u: FakeUri) => void fs.mkdirSync(u.fsPath, { recursive: true }),
      readFile: async (u: FakeUri) => new Uint8Array(fs.readFileSync(u.fsPath)),
      writeFile: async (u: FakeUri, b: Uint8Array) => void fs.writeFileSync(u.fsPath, b),
      delete: async (u: FakeUri) => void fs.rmSync(u.fsPath, { recursive: true }),
      rename: async (a: FakeUri, b: FakeUri) => void fs.renameSync(a.fsPath, b.fsPath),
    },
    createFileSystemWatcher: () => {
      const never = () => ({ dispose() {} });
      return { onDidChange: never, onDidCreate: never, onDidDelete: never, dispose() {} };
    },
  },
} as any;

const bits = {
  homeDir: async () => tmp,
  env: (n: string) => process.env[n],
  os: process.platform,
};

/** A webview as the panel sees it: what the extension said, and a way to speak as the page. */
function fakePanel() {
  const posted: any[] = [];
  const heard: ((m: any) => void)[] = [];
  const gone: (() => void)[] = [];
  const panel: any = {
    title: '',
    webview: {
      html: '',
      cspSource: 'https://file+.vscode-resource.test',
      postMessage: async (m: unknown) => (posted.push(m), true),
      onDidReceiveMessage: (fn: (m: any) => void) => (heard.push(fn), { dispose: () => void heard.splice(heard.indexOf(fn), 1) }),
    },
    onDidDispose: (fn: () => void) => (gone.push(fn), { dispose() {} }),
  };
  let n = 0;
  const call = async (m: string, ...a: unknown[]) => {
    const id = ++n;
    for (const h of [...heard]) h({ t: 'call', id, m, a });
    for (let i = 0; i < 200; i++) {
      const r = posted.find((x) => x.id === id);
      if (r) {
        if (r.t === 'err') throw new Error(r.e?.message);
        return r.v;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no answer to ${m}`);
  };
  return { panel, posted, heard, call, close: () => gone.forEach((f) => f()), say: (m: any) => heard.forEach((h) => h(m)) };
}

const memoryPrefs = (): PrefsStore & { store: Record<string, string> } => {
  const store: Record<string, string> = {};
  return {
    store,
    all: () => ({ ...store }),
    set(k, v) {
      if (v === null) delete store[k];
      else store[k] = v;
    },
  };
};

test('the webview page carries a policy of its own, and its files are named by the editor', () => {
  const html = pageHtml;
  const csp = 'https://file+.vscode-resource.test';
  const policy = webviewPolicy(html, csp);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, new RegExp(`script-src ${csp.replace(/[+.]/g, '\\$&')} 'sha256-`), 'the head script by hash');
  assert.match(policy, /connect-src 'none'/, 'the page talks to the extension host, not the network');
  assert.doesNotMatch(policy, /'self'/, "'self' is the editor's origin, not where the page is");

  const out = webviewHtml({
    html,
    base: 'https://file+.vscode-resource.test/ext/page',
    cspSource: csp,
    prefs: { 'redline:side': '"x"' },
    dark: true,
    path: '/a/"b".md',
  });
  assert.match(out, /<head>\s*<meta http-equiv="Content-Security-Policy"/, 'the policy comes first');
  assert.match(out, /name="redline-scheme" content="dark"/);
  assert.match(out, /name="redline-path" content="\/a\/&quot;b&quot;\.md"/, 'an attribute is escaped');
  const prefs = /name="redline-prefs" content="([^"]*)"/.exec(out)![1];
  assert.deepStrictEqual(JSON.parse(prefs.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&')), {
    'redline:side': '"x"',
  });
  assert.match(out, /<script[^>]*src="https:\/\/file\+\.vscode-resource\.test\/ext\/page\/(?:host|app)\.js"/);
  assert.doesNotMatch(out, /(?:src|href)="(?!https:|data:|#)[^"]*"/, 'no file is left relative');
  assert.throws(() => webviewHtml({ html: '<html></html>', base: 'x', cspSource: csp, prefs: {}, dark: false }), /no <head>/);
});

test('the platform is the contract over the editor\'s file system', async () => {
  const p = createVscodePlatform(fake, bits);
  const dir = path.join(tmp, 'plat');
  await p.mkdirp(dir);
  const f = path.join(dir, 'a.md');
  assert.strictEqual(await p.readText(f), null, 'a missing file reads as null');
  await p.writeText(f, 'one');
  await p.writeText(f, 'two');
  assert.strictEqual(await p.readText(f), 'two');
  assert.deepStrictEqual(await p.readDir(dir), ['a.md'], 'and no temp file is left beside it');
  assert.strictEqual(await p.exists(f), true);
  await p.remove(f);
  await p.remove(f);
  assert.strictEqual(await p.exists(f), false, 'removing what is not there is not an error');
  assert.strictEqual(p.join('vscode-vfs://github/o/r', 'a', 'b.md'), 'vscode-vfs://github/o/r/a/b.md', 'an address joins as posix');
  assert.strictEqual(p.resolve('vscode-vfs://github/o/r/a/../b.md'), 'vscode-vfs://github/o/r/b.md');
  assert.strictEqual(p.dirname('vscode-vfs://github/o/r/a.md'), 'vscode-vfs://github/o/r');
  assert.strictEqual(p.dirname('vscode-vfs://github/a.md'), 'vscode-vfs://github/', 'and `..` does not pop the host');
  assert.ok(isRemoteAddress('vscode-vfs://github/o'));
  assert.ok(!isRemoteAddress('/home/me/a.md') && !isRemoteAddress('C:\\a.md'));
  assert.strictEqual(fromUri(FakeUri.file('/x/y.md') as any), '/x/y.md', 'a local file goes by its path');
  assert.strictEqual(fromUri(FakeUri.parse('vscode-vfs://github/o/y.md') as any), 'vscode-vfs://github/o/y.md');
});

test('a panel is pinned to its own document, takes its preferences, and lets go on close', async () => {
  const docs = path.join(tmp, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  const a = path.join(docs, 'a.md');
  const b = path.join(docs, 'b.md');
  const c = path.join(docs, 'c.md');
  fs.writeFileSync(a, '# Alpha\n\nfirst\n');
  fs.writeFileSync(b, '# Beta\n\nsecond\n');
  fs.writeFileSync(c, '# Gamma\n\nthird\n');

  const reader = await createReader({ platform: createVscodePlatform(fake, bits) });
  const session = createSession(reader);
  const prefs = memoryPrefs();
  prefs.store['redline:toc'] = '1';
  const deps = (panel: any) => ({
    panel,
    reader,
    session,
    page: { html: pageHtml, base: 'https://x.test/page' },
    prefs,
    dark: () => false,
  });

  const one = fakePanel();
  const two = fakePanel();
  const p1 = await attachPanel(deps(one.panel), a);
  const p2 = await attachPanel(deps(two.panel), b);

  assert.strictEqual(one.panel.title, 'a.md');
  assert.match(one.panel.webview.html, /name="redline-prefs"[^>]*redline:toc/, 'the page is seeded with the preferences');
  assert.match(one.panel.webview.html, new RegExp(`name="redline-path" content="${a.replace(/[/.]/g, '\\$&')}"`));

  // Both pages ask with no id at all, which the reader would answer with the first document it
  // opened. Each is answered with its own.
  assert.strictEqual((await one.call('doc', null, '')).name, 'a.md');
  assert.strictEqual((await two.call('doc', null, '')).name, 'b.md', 'the second panel is not shown the first file');
  assert.strictEqual((await two.call('doc', 'a-stale-id', '')).name, 'b.md', 'and an id it makes up is ignored');

  // A preference write is the extension's, and the reader never hears of it.
  const before = one.posted.length;
  one.say({ t: 'pref', k: 'redline:side', v: '0' });
  one.say({ t: 'pref', k: 'redline:toc', v: null });
  one.say({ t: 'pref', k: 7, v: 1 });
  assert.deepStrictEqual(prefs.store, { 'redline:side': '0' }, 'set, removed, and a malformed one refused');
  assert.strictEqual(one.posted.length, before, 'none of it is answered as a call');

  // Following a link moves the panel, and what it asks after goes to the new file.
  const opened = await one.call('open', null, c);
  assert.strictEqual(opened.path, c);
  assert.strictEqual(p1.path, c);
  assert.strictEqual(one.panel.title, 'c.md');
  assert.strictEqual((await one.call('doc', null, '')).name, 'c.md');
  assert.strictEqual(reader.pathOf(opened.id), c);

  // The theme is told to the page, not asked of it.
  p2.setDark(true);
  assert.deepStrictEqual(two.posted.at(-1), { t: 'scheme', dark: true });

  // Closing the panel lets go of its document, and only its own.
  const idB = (await two.call('doc', null, '')).id;
  two.close();
  assert.strictEqual(reader.pathOf(idB), null, 'the document nobody shows is closed');
  assert.strictEqual((await one.call('doc', null, '')).name, 'c.md', 'and the other panel is undisturbed');
  one.close();
  one.close();
  assert.strictEqual(reader.pathOf(opened.id), null);
  reader.closeAll();
});

test('a file that cannot be read leaves the panel untouched', async () => {
  const reader = await createReader({ platform: createVscodePlatform(fake, bits) });
  const w = fakePanel();
  await assert.rejects(
    attachPanel(
      { panel: w.panel, reader, session: createSession(reader), page: { html: pageHtml, base: 'x' }, prefs: memoryPrefs(), dark: () => false },
      path.join(tmp, 'nothing.md'),
    ),
    /cannot read/,
  );
  assert.strictEqual(w.panel.webview.html, '', 'no page was written');
  assert.strictEqual(w.heard.length, 0, 'and nothing is listening');
  reader.closeAll();
});

test('a callout is not left to the editor\'s own blockquote style', () => {
  // The webview injects `blockquote { background: <the theme's> }`; a light page on it is dark
  // text on dark. The page has to say its own.
  assert.match(read('public/styles.css'), /\.markdown-body blockquote \{[^}]*background: transparent/);
});

test('the bar sits at the bottom, without the title, and the scrollbar is not the editor\'s', () => {
  const css = read('public/styles.css');
  // The class is how every rule below finds the extension; without it they are dead.
  assert.match(read('src/hosts/vscode/host.js'), /classList\.add\('vscode'\)/);
  assert.match(css, /\.vscode \.bar \{[^}]*inset: auto 0 0 0/);
  assert.match(css, /\.vscode #nameSlot[^{]*\{[^}]*display: none/);
  assert.match(css, /\.vscode \{[^}]*scrollbar-color: var\(--line\) transparent/);
  // The bar's height is spoken for in three places, and this is the one in each.
  assert.match(read('public/app/layout/toc-height.ts'), /contains\('vscode'\) \? 30/);
  assert.match(read('public/index.html'), /contains\("vscode"\) \? 30/);
});

test('the extension can be published: a publisher, an icon that ships, and a workflow of its own', () => {
  const manifest = JSON.parse(read('vscode/package.json'));
  assert.strictEqual(manifest.publisher, 'tuanchauict');
  assert.strictEqual(manifest.icon, 'icon.png');
  assert.ok(fs.existsSync(path.join(ROOT, 'vscode', manifest.icon)), 'the icon is in the repository');
  assert.match(read('scripts/build-vscode.mts'), /'README\.md', 'icon\.png'/);
  assert.ok(!/vscode|vsce/.test(read('.github/workflows/ci.yml')), "the app's CI is the app's");
  const wf = read('.github/workflows/vscode.yml');
  const code = wf.replace(/^\s*#.*$/gm, '');
  // `v*` would match `vscode-v1` and cut a Mac release; the extension's tag must not start with v.
  assert.match(code, /tags: \['ext-v\*'\]/);
  assert.match(code, /vsce package/);
  assert.match(code, /vsce publish --pre-release[^\n]*--packagePath/, 'an alpha is a pre-release');
  assert.match(code, /vsce package --pre-release/, 'packaged the same way it is published');
  assert.strictEqual(code.match(/secrets\./g)?.length, 1, 'one use of one secret');
  assert.match(code, /if: startsWith\(github\.ref, 'refs\/tags\/ext-v'\)\n\s+env:\n\s+VSCE_PAT/);
  assert.match(code, /GITHUB_REF_NAME#ext-v/, 'the tag is checked against the manifest');
  assert.doesNotMatch(code, /pull_request_target/);
});

test('the extension is wired: staged, bundled, declared, and loaded only by its own flag', () => {
  assert.deepStrictEqual(HOSTS.vscode.bundles, ['backend-vscode.js']);
  assert.strictEqual(HOSTS.vscode.shim, 'src/hosts/vscode/host.js');
  assert.match(read('scripts/build-web.mts'), /src\/hosts\/vscode\/backend\.ts[^}]*backend-vscode\.js/);
  assert.match(read('public/backend.ts'), /__REDLINE_VSCODE\)[\s\S]*import\('\.\/vendor\/backend-vscode\.js'\)/);
  assert.match(read('src/hosts/vscode/host.js'), /^globalThis\.__REDLINE_VSCODE = true;$/m);
  assert.match(read('scripts/build-vscode.mts'), /host: 'vscode'/);
  assert.match(read('package.json'), /"build:vscode": "[^"]*build-vscode\.mjs"/);

  const manifest = JSON.parse(read('vscode/package.json'));
  assert.strictEqual(manifest.main, './extension.js');
  assert.ok(manifest.contributes.commands.some((c: any) => c.command === 'redline.open'));
  assert.ok(manifest.activationEvents.includes('onWebviewPanel:redline.preview'), 'a restored panel wakes it');
  const extension = read('src/hosts/vscode/extension.ts');
  assert.match(extension, /registerCommand\('redline\.open'/, 'the command is registered');
  assert.match(extension, /registerWebviewPanelSerializer\(VIEW_TYPE/, 'and a restored panel is picked up');
  assert.match(extension, /onDidChangeActiveColorTheme/, 'and the theme is followed');
  assert.match(read('src/hosts/vscode/extension-node.ts'), /export function activate\(/, 'the entry exports activate');
  assert.match(read('src/hosts/vscode/host.js'), /setState\(\{ path \}\)/, 'and a panel keeps its file for a restart');
});

test('a Markdown file another extension gave its own language is still offered the preview', () => {
  // SKILL.md is "Skill" in the status bar when an agent extension claims it, and a menu gated on
  // the language alone never appeared for it.
  const manifest = JSON.parse(read('vscode/package.json'));
  const menus = manifest.contributes.menus;
  for (const when of [
    menus['editor/title'][0].when,
    menus['explorer/context'][0].when,
    menus.commandPalette[0].when,
  ]) {
    assert.match(when, /resourceExtname =~ \/\\\.\(md\|markdown\)\$\//, `${when} matches by name`);
  }
  assert.match(read('src/hosts/vscode/extension.ts'), /\\\.\(md\|markdown\)\$\/i\.test\(doc\.uri\.path\)/);
});
