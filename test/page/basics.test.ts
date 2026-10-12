import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import path from 'node:path';
import { rootUrl } from '../../src/hosts/node/root.js';
import { pageCss, pageHead, pageHtml, pageJs, scratch, serve } from '../support.js';

// The sample, copied, so that nothing a check does can reach the one in the repository.
const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
const { base } = await serve(file);

test('the page is relative, and reads its preferences through one name', async () => {
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
  const headScripts = [...pageHead.matchAll(/<script\b[^>]*>/g)];
  assert.strictEqual(headScripts[0]?.[0], '<script src="host.js">', 'host.js is the first script');
  assert.ok(!/type="module"/.test(headScripts[0][0]), 'and not a module');
  assert.strictEqual((await fetch(base + '/host.js')).status, 200, 'and it is served');
});

// The link peek is spread over the same three files, and its failure is silent
// in both directions: no element and hovering says nothing, no `pointer-events:
// none` and it eats the clicks aimed at the last paragraph of the document.
test('link peek wired end to end', async () => {
  assert.match(pageHtml, /id="peek"/, 'the peek has somewhere to go');
  assert.match(pageJs, /addEventListener\('pointerover'/, 'and something to fill it');
  assert.match(pageCss, /\.peek \{[^}]*pointer-events: none/, 'and never takes a click');
});

// The bar is the window's title bar in the app, and there is nothing else to
// drag the window by — no OS title bar is drawn. It went once already: the
// rules said `-webkit-app-region`, which is Chromium's and does nothing in the
// WebKit the shell uses, so the window could not be moved at all. The attribute
// is what the shell looks for; "deep" is what makes the whole strip count.
test('the bar can move the native window', async () => {
  assert.match(
    pageHtml,
    /<header class="bar" data-tauri-drag-region="deep">/,
    'the bar is the window\'s drag region',
  );
  assert.ok(
    !/-webkit-app-region\s*:/.test(pageCss),
    'and not by a Chromium property this webview does not have',
  );
});

// The app's icon, at the bar's left edge in a browser tab: the web app's and the CLI's. The
// file is the favicon's, which every host serves beside the page (`/icon.svg` above,
// `stage-page.mts` for the other two), so a relative src holds under any base URL.
test('a browser tab starts its bar with the app icon', async () => {
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
});

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
test('long inline code in a table cell wraps', async () => {
  assert.match(
    pageCss,
    /\.markdown-body table code,\s*\.markdown-body table a \{[^}]*overflow-wrap: anywhere/,
    'a path in a table cell wraps instead of hiding the row',
  );
  assert.ok(
    !/table th,\s*\.markdown-body table td \{[^}]*overflow-wrap: anywhere/.test(pageCss),
    'and not on the cell, which would break ordinary words',
  );
});

// `doc` in the client is the <article>, not a document, and an element has no
// getElementById — the call parses, ships, and throws only once the line runs.
// It cost a contents list, a diagram and an honest change count the last time:
// the throw was inside paintToc, and paint() calls that before it draws either.
test('no element/document confusion in the client', async () => {
  assert.ok(
    !/\bdoc\.getElementById\(/.test(pageJs),
    'an element is asked for a node with querySelector, not getElementById',
  );

});
