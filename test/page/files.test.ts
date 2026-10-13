import { test } from 'node:test';
import assert from 'node:assert';
import { fakeWindow, loadPage, plain, spy } from '../support.js';

// vm/files.ts decides which document the page shows -- a row picked, a row closed, a link out of
// the document, a file the welcome was handed -- and leaves loading and drawing it to vm/core.ts.
// So core is a stand-in that keeps what it was asked, as are the backend, the shell and the
// notice; vm/welcome.ts and vm/peek.ts are real, because which link is pending and where a link
// resolves are part of what is being said here.
const DIR = { dir: '/Users/me/notes', dirLabel: '~/notes' };
const TABS = [
  { id: 1, path: '/Users/me/notes/a.md', name: 'a.md' },
  { id: 2, path: '/Users/me/notes/b.md', name: 'b.md' },
];
const tick = () => new Promise((r) => setTimeout(r, 0));

async function filesIn({ native = undefined as any, open = null as any } = {}) {
  const win = fakeWindow();
  const doors: any = {};
  const welcome = { sync: spy() };
  const opened = { list: spy(() => TABS.slice(1)), close: spy(() => TABS[1]) };
  const backend = {
    open: spy(open ?? (async (path: string) => ({ id: TABS.find((t) => t.path === path)?.id ?? 9 }))),
    linkNote: spy(async () => null),
    welcome: (d: object) => (Object.assign(doors, d), welcome),
  };
  const core = {
    openFiles: opened,
    setDocId: spy(),
    load: spy(async () => true),
    closeDocument: spy(),
    connect: spy(),
    stopWatch: spy(),
  };
  const notice = { notify: spy() };
  const m = await loadPage(['state', 'vm/welcome', 'vm/files'], {
    win,
    stubs: {
      backend: { backend },
      'layout/native': { native },
      'vm/notice': notice,
      'vm/settings': { keptBaseline: spy(() => 'read') },
      'vm/core': core,
    },
  });
  const pane = win.document.querySelector('main');
  const doc = win.$('doc');
  // vm/welcome.ts is kept whole rather than spread, because `pendingLink` is a live binding and a
  // spread would read it once.
  const welcomed = m['vm/welcome'];
  return { win, doors, backend, core, opened, notice, pane, doc, welcomed, ...m.state,
    ...m['vm/files'] };
}

test('a row picked in a browser tab goes to its file, the place in each kept', async () => {
  const f = await filesIn();
  f.state.tabs = TABS;
  f.state.docId = 1;
  f.state.data = { ...DIR };
  f.pane.scrollTop = 300;
  f.win.$('fileList').focus();
  f.selectTab(2);
  await tick();
  assert.deepStrictEqual(plain(f.backend.open.calls), [['/Users/me/notes/b.md']], 'opens its path');
  assert.deepStrictEqual(plain(f.core.setDocId.calls), [[2]], 'by the id the reader gives back');
  assert.strictEqual(f.state.baseline, 'read', 'compared as that file is kept, not as the last');
  assert.deepStrictEqual(plain(f.core.load.calls), [[{ keepScroll: false }]], 'loads it fresh');
  assert.strictEqual(f.scrollMemory.get(1), 300, 'remembers where the one left was');
  assert.strictEqual(f.pane.scrollTop, 0, 'and starts a file not seen yet at the top');
  assert.strictEqual(f.core.stopWatch.calls.length, 1, 'with the watch stood down for the swap');
  assert.strictEqual(f.core.connect.calls.length, 1, 'and stood back up after');

  f.state.docId = 2;
  f.scrollMemory.set(1, 300);
  f.selectTab(1);
  await tick();
  assert.strictEqual(f.pane.scrollTop, 300, 'going back is going back to the place');
  assert.strictEqual(f.win.document.activeElement, f.pane,
    'and the keys are the document\'s again, not the row\'s');

  f.selectTab(7);
  f.state.docId = 1;
  f.selectTab(1);
  await tick();
  assert.strictEqual(f.backend.open.calls.length, 2, 'a row that is no file, or the one on screen, '
    + 'opens nothing');
});

test('a row whose file will not open stays put and says so', async () => {
  const err = Object.assign(new Error('gone'), { name: 'NotFound' });
  const f = await filesIn({ open: async () => { throw err; } });
  const quiet = f.win.console = { error: spy() } as any;
  f.state.tabs = TABS;
  f.state.docId = 1;
  f.state.data = { ...DIR };
  f.pane.scrollTop = 120;
  f.selectTab(2);
  await tick();
  assert.deepStrictEqual(plain(f.notice.notify.calls), [['Could not open b.md.']],
    'a file asked for by name is said not to have opened');
  assert.strictEqual(f.pane.scrollTop, 120, 'and the page is where it was');
  assert.strictEqual(f.core.connect.calls.length, 1, 'still watching what it was reading');
  assert.strictEqual(quiet.error.calls.length, 1, 'the reason is the console\'s');

  // A link that goes nowhere is the document out of date: the console's alone.
  assert.strictEqual(await f.openFile('/nowhere.md'), false);
  assert.strictEqual(f.notice.notify.calls.length, 1, 'a dead link is not announced');

  const ask = Object.assign(new Error('ask'), { name: 'NeedsPermission' });
  const g = await filesIn({ open: async () => { throw ask; } });
  assert.strictEqual(await g.openFile('/Users/me/notes/b.md'), false);
  assert.strictEqual(g.welcomed.pendingLink, '/Users/me/notes/b.md',
    'a file that has to be asked for again is remembered, to open when it is granted');
  assert.strictEqual(g.notice.notify.calls.length, 0, 'and the welcome, not a notice, says so');
  assert.strictEqual(g.core.connect.calls.length, 0, 'with no document, there is nothing to watch');
});

test('closing a row: behind the document, on screen, and the last', async () => {
  const f = await filesIn();
  f.state.tabs = TABS;
  f.state.docId = 1;
  f.state.data = { ...DIR };
  f.closeTab(2);
  await tick();
  assert.deepStrictEqual(plain(f.opened.close.calls), [[2]], 'the row leaves the open files');
  assert.deepStrictEqual(plain(f.state.tabs), plain(TABS.slice(1)), 'and the list is what is left');
  assert.strictEqual(f.backend.open.calls.length, 0, 'one behind the document changes nothing else');

  f.state.tabs = TABS;
  f.closeTab(1);
  await tick();
  assert.deepStrictEqual(plain(f.backend.open.calls), [['/Users/me/notes/b.md']],
    'the one on screen gives way to its neighbour');
  assert.strictEqual(f.core.closeDocument.calls.length, 0);

  f.opened.close = spy(() => null);
  f.closeTab(2);
  await tick();
  f.state.docId = 2;
  f.closeTab(2);
  await tick();
  assert.deepStrictEqual(plain(f.core.closeDocument.calls), [[{ reopen: null }]],
    'and the last leaves the welcome, with nothing to ask for');
});

test('the welcome\'s doors, and a grant', async () => {
  const f = await filesIn();
  f.state.tabs = TABS;
  assert.strictEqual(await f.doors.open('/Users/me/notes/a.md'), true, 'a file picked is opened');
  assert.deepStrictEqual(plain(f.backend.open.calls), [['/Users/me/notes/a.md']]);

  f.welcomed.setPendingLink('/Users/me/notes/b.md');
  await f.doors.granted();
  assert.deepStrictEqual(plain(f.backend.open.calls[1]), ['/Users/me/notes/b.md'],
    'granted, the link that had to be asked for is what opens');
  assert.strictEqual(f.welcomed.pendingLink, null, 'once');
  const loads = f.core.load.calls.length;
  await f.doors.granted();
  assert.strictEqual(f.backend.open.calls.length, 2, 'with no link pending, nothing is opened');
  assert.deepStrictEqual(plain(f.core.load.calls.slice(loads)), [[{ keepScroll: false }]],
    'but the document that was refused is loaded again');
  assert.strictEqual(f.core.connect.calls.at(-1).length, 0, 'and watched');
});

test('a link out of the document, in a browser tab and in the app', async () => {
  const click = (f: any, href: string) => {
    f.doc.innerHTML = `<p><a href="${href}"><em>here</em></a></p>`;
    const e = new f.win.Event('click', { bubbles: true });
    f.doc.querySelector('em').dispatchEvent(e);
    return e;
  };
  const f = await filesIn();
  f.state.data = { ...DIR, path: '/Users/me/notes/a.md' };
  f.state.tabs = TABS;
  for (const href of ['#intro', 'https://example.com', '']) {
    assert.strictEqual(click(f, href).defaultPrevented, false, `a tab leaves "${href}" to itself`);
  }
  const held = click(f, './pic.png');
  assert.strictEqual(held.defaultPrevented, true, 'a relative link the reader cannot open is held');
  click(f, './b.md');
  await tick();
  assert.deepStrictEqual(plain(f.backend.linkNote.calls), [['/Users/me/notes/a.md']],
    'a markdown link asks whether links can be followed from this file');
  assert.deepStrictEqual(plain(f.backend.open.calls), [['/Users/me/notes/b.md']],
    'and opens the file, resolved against the document\'s directory');

  f.backend.linkNote = spy(async () => 'Open the folder to follow links.');
  click(f, '../b.md');
  await tick();
  assert.deepStrictEqual(plain(f.notice.notify.calls), [['Open the folder to follow links.']],
    'where it cannot be, it says why instead');
  assert.strictEqual(f.backend.open.calls.length, 1);

  const shell = { openExternal: spy(), openPaths: spy(), selectTab: spy(), closeTab: spy() };
  const n = await filesIn({ native: shell });
  n.state.data = { ...DIR };
  for (const href of ['https://example.com', 'mailto:me@example.com', 'javascript:alert(1)']) {
    assert.strictEqual(click(n, href).defaultPrevented, true, `the app holds "${href}"`);
  }
  assert.deepStrictEqual(plain(shell.openExternal.calls),
    [['https://example.com'], ['mailto:me@example.com']],
    'and hands the browser the web and mail, and nothing else');
  click(n, 'b.md#top');
  assert.deepStrictEqual(plain(shell.openPaths.calls), [[['/Users/me/notes/b.md']]],
    'a markdown file is a window of its own');
  n.selectTab(4);
  n.closeTab(5);
  assert.deepStrictEqual([plain(shell.selectTab.calls), plain(shell.closeTab.calls)], [[[4]], [[5]]],
    'and the app\'s tabs are the shell\'s to switch and close');
  assert.strictEqual(n.backend.open.calls.length, 0);
});
