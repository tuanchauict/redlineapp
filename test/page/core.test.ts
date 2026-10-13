import { test } from 'node:test';
import assert from 'node:assert';
import { fakeWindow, loadPage, plain, spy } from '../support.js';

// vm/core.ts asks for the document, takes the payload as the page's, draws it and keeps it
// current. The renderer is real, so what lands in `#doc` is the markdown's; everything that draws
// *around* the document is a stand-in that keeps what it was asked, as are the sanitizer (whose
// own tests are src/page's) and the backend.
const DOC = {
  id: 'd1',
  name: 'notes.md',
  path: '/Users/me/notes.md',
  dirLabel: '~',
  pathLabel: '~/notes.md',
  baseline: 'read',
  history: [],
  text: '# Notes\n\n<details><summary>More</summary>\n\nInside.\n\n</details>\n\nA line.\n',
  base: null,
};

async function coreIn({ welcome = null as object | null, welcomeAsks = null as string | null,
  search = '', openFiles = undefined as any } = {}) {
  const win = fakeWindow({ search });
  let payload: any = { ...DOC };
  const unwatch = spy();
  const backend = {
    doc: spy(async () => (typeof payload === 'function' ? payload() : { ...payload })),
    watch: spy(() => unwatch),
    openFiles,
  };
  const s = {
    peek: { hidePeek: spy() },
    diagrams: { drawDiagrams: spy() },
    find: { findOpen: { value: false }, refind: spy() },
    changes: { paintCount: spy(), paintRuler: spy(), forgetHover: spy() },
    acks: { applyAcks: spy() },
    contents: { paintToc: spy() },
    sidebars: { setSide: spy(), clearSidebars: spy() },
    settings: { keptBaseline: spy(() => 'kept') },
    view: { applyMarks: spy() },
    history: { paintHistory: spy() },
    welcome: { welcome, welcomeAsks, showWelcome: spy(), hideWelcome: spy() },
  };
  const m = await loadPage(['state', 'vm/core'], {
    win,
    stubs: {
      '../vendor/sanitize': { sanitizeDocument: (h: string) => h },
      backend: { backend },
      ...Object.fromEntries(Object.entries(s).map(([k, v]) => [`vm/${k}`, v])),
    },
  });
  return {
    win, backend, unwatch, s,
    set payload(p: any) { payload = p; },
    pane: win.document.querySelector('main'),
    doc: win.$('doc'),
    ...m.state,
    ...m['vm/core'],
  };
}

test('a document loaded: the id in the address, the payload taken, the page drawn', async () => {
  const c = await coreIn({ search: '?id=old&x=1' });
  assert.strictEqual(c.setDocId(''), false, 'no id is no change');
  assert.strictEqual(c.setDocId('a'), true);
  assert.strictEqual(c.win.location.search, '?id=a&x=1', 'the address names it, the rest kept');
  assert.strictEqual(c.setDocId('a'), false, 'and the same id again is nothing to write');

  c.state.baseline = 'snap:x';
  c.pane.scrollTop = 50;
  assert.strictEqual(await c.load({ keepScroll: false }), true, 'it says it painted');
  assert.deepStrictEqual(plain(c.backend.doc.calls), [['snap:x']], 'asking with the baseline held');
  assert.strictEqual(c.state.docId, 'd1', 'the reader\'s id is the page\'s');
  assert.strictEqual(c.win.location.search, '?id=d1&x=1');
  assert.strictEqual(c.state.baseline, 'read', 'and the baseline it could honour is the one kept');
  assert.match(c.doc.innerHTML, /<h1[^>]*>Notes<\/h1>/, 'the markdown is in #doc');
  assert.deepStrictEqual([c.win.document.title, plain(c.barName.value)],
    ['Notes', { name: 'Notes', dir: '~/notes.md', path: '/Users/me/notes.md' }],
    'a document with a title is called by it, the file\'s name moved into the path');
  for (const [k, f] of [['applyMarks', c.s.view], ['applyAcks', c.s.acks],
    ['paintToc', c.s.contents], ['paintCount', c.s.changes], ['paintRuler', c.s.changes],
    ['drawDiagrams', c.s.diagrams]] as [string, any][]) {
    assert.strictEqual(f[k].calls.length, 1, `and ${k} drew around it`);
  }
  assert.strictEqual(c.s.history.paintHistory.calls[0][0], c.state.data, 'the history from it');
  assert.strictEqual(c.s.welcome.hideWelcome.calls.length, 1, 'a document opened takes the welcome down');

  c.state.data = { ...c.state.data, title: '' };
  c.paint();
  assert.deepStrictEqual([c.win.document.title, c.barName.value.dir], ['notes.md', '~'],
    'with no title, the file\'s name and its directory, not the name twice');
});

test('a load that cannot paint: nothing there, a grant lapsed, a reader failing, a tab left', async () => {
  const fail = (name: string) => () => { throw Object.assign(new Error(name), { name }); };
  const c = await coreIn({ welcome: {}, search: '?id=d1' });
  c.payload = fail('NoDocument');
  assert.strictEqual(await c.load(), false);
  assert.strictEqual(c.win.location.search, '', 'nothing to show takes the id out of the address');
  assert.deepStrictEqual(plain(c.s.welcome.showWelcome.calls), [[{ reopen: null }]],
    'and puts the welcome up, asking for nothing');

  c.payload = fail('NeedsPermission');
  c.setDocId('d1');
  assert.strictEqual(await c.load(), false);
  assert.strictEqual(c.win.location.search, '?id=d1', 'a lapsed grant keeps it, to ask again');
  assert.deepStrictEqual(plain(c.s.welcome.showWelcome.calls[1]), [{ reopen: 'this file' }],
    'and the welcome asks, for "this file" when no one has said which');
  const named = await coreIn({ welcome: {}, welcomeAsks: 'b.md' });
  named.payload = fail('NeedsPermission');
  await named.load();
  assert.deepStrictEqual(plain(named.s.welcome.showWelcome.calls), [[{ reopen: 'b.md' }]],
    'and keeps a name already given rather than replace it with a guess');

  c.payload = fail('Broken');
  await assert.rejects(c.load(), /Broken/, 'anything else is the reader failing, and says so');
  const cli = await coreIn();
  cli.payload = fail('NoDocument');
  await assert.rejects(cli.load(), /NoDocument/, 'and with no welcome, even nothing there is');

  // Two loads in flight: the one for the tab already left must not paint.
  const t = await coreIn();
  t.state.docId = 'd1';
  let answer: (v: object) => void;
  t.payload = () => new Promise((r) => (answer = r));
  const late = t.load();
  t.state.docId = 'd2';
  answer!({ ...DOC });
  assert.strictEqual(await late, false, 'an answer for a tab since left is dropped');
  assert.strictEqual(t.state.data, null, 'unadopted');
  assert.strictEqual(t.doc.innerHTML, '', 'and unpainted');
});

test('a reload keeps what the reader did, and the place', async () => {
  const c = await coreIn();
  await c.load({ keepScroll: false });
  const details = () => c.doc.querySelector('details');
  const first = details();
  first.open = true;
  c.pane.scrollTop = 80;
  await c.load({ keepScroll: true });
  assert.strictEqual(details(), first, 'the same markup again leaves the article standing');
  assert.strictEqual(c.pane.scrollTop, 80, 'at the same place');
  assert.strictEqual(c.s.peek.hidePeek.calls.length, 1, 'with the peek left up, its link still there');
  assert.strictEqual(c.s.welcome.hideWelcome.calls.length, 1,
    'and a reread does not take the welcome down by itself');

  c.payload = { ...DOC, text: DOC.text + '\nAnother line.\n' };
  await c.load({ keepScroll: true });
  assert.notStrictEqual(details(), first, 'new markup is a new article');
  assert.strictEqual(details().open, true, 'with the disclosure opened still open');
  assert.strictEqual(c.s.peek.hidePeek.calls.length, 2, 'and the peek of a link now gone put away');
  assert.strictEqual(c.s.find.refind.calls.length, 0, 'with no find open, nothing to redo');

  c.s.find.findOpen.value = true;
  details().open = true;
  c.paint();
  assert.strictEqual(c.s.find.refind.calls.length, 1, 'a find open is redone over the new article');
  assert.strictEqual(details().open, true, 'and the disclosure survives a plain repaint too');

  c.state.docId = 'other';
  c.paint();
  assert.strictEqual(details().open, false, 'another file\'s disclosures are not this one\'s');

  c.state.view = 'raw';
  c.paint({ reuse: true });
  assert.ok(c.doc.classList.contains('raw-view'), 'the raw view is the source, drawn so');
  assert.doesNotMatch(c.doc.innerHTML, /<h1/, 'and not the rendered markup');
});

test('reading one version alone draws it from the payload held', async () => {
  const c = await coreIn();
  c.payload = { ...DOC, text: '# Notes\n\nNew.\n', base: '# Notes\n\nOld.\n' };
  await c.load({ keepScroll: false });
  c.state.diff = true;
  c.state.solo = true;
  c.pane.scrollTop = 30;
  c.rerender();
  assert.match(c.doc.innerHTML, /Old\./, 'the version compared against is what is on the page');
  assert.doesNotMatch(c.doc.innerHTML, /New\./);
  assert.strictEqual(c.state.data.title, 'Notes', 'titled as the file is');
  assert.strictEqual(c.pane.scrollTop, 30, 'at the same offset');
  c.state.diff = false;
  c.rerender();
  assert.match(c.doc.innerHTML, /New\./, 'with the marks off, the version alone is the file');
  assert.strictEqual(c.backend.doc.calls.length, 1, 'and none of it asks the reader again');
  c.state.data = null;
  c.rerender();
  assert.strictEqual(c.s.history.paintHistory.calls.length, 3, 'with nothing held, nothing redraws');
});

test('the web app\'s open files, the watch, and closing the document', async () => {
  let list: object[] = [];
  const openFiles = {
    list: spy(() => list),
    note: spy((t: object) => (list.some((o: any) => o.id === (t as any).id) ? false
      : (list = [...list, t], true))),
  };
  list = [{ id: 'x' }];
  const c = await coreIn({ welcome: {}, openFiles });
  assert.deepStrictEqual(plain(c.state.tabs), [{ id: 'x' }], 'the open files are listed at once');
  await c.load({ keepScroll: false });
  assert.deepStrictEqual(plain(openFiles.note.calls),
    [[{ id: 'd1', path: '/Users/me/notes.md', name: 'notes.md', dir: '~', label: '~/notes.md' }]],
    'a document shown joins them');
  assert.deepStrictEqual(plain(c.s.sidebars.setSide.calls), [[true, false]],
    'and with two to choose between, the column shows itself, unremembered');
  await c.load({ keepScroll: true });
  assert.strictEqual(c.s.sidebars.setSide.calls.length, 1, 'one already listed changes nothing');
  const chose = await coreIn({ openFiles: { list: () => [{ id: 'x' }], note: () => true } });
  chose.win.__REDLINE_PREFS.setItem('redline:side', '0');
  await chose.load({ keepScroll: false });
  assert.strictEqual(chose.s.sidebars.setSide.calls.length, 0, 'nor once the toggle has been used');

  c.connect();
  const w = c.backend.watch.calls[0][0];
  w.onLive(false, 'offline');
  assert.strictEqual(c.liveWhy.value, 'offline', 'a dropped watch says why');
  w.onLive(true);
  assert.strictEqual(c.liveWhy.value, null, 'and stops once it is back');
  c.pane.scrollTop = 64;
  await w.onEvent({ type: 'change' });
  assert.strictEqual(c.pane.scrollTop, 64, 'an edit is read again in place');
  await w.onEvent({ type: 'history' });
  assert.strictEqual(c.backend.doc.calls.length, 4, 'as are versions arriving');
  c.state.baseline = 'snap:z';
  await w.onEvent({ type: 'file' });
  assert.strictEqual(c.backend.doc.calls.at(-1)[0], 'kept',
    'another file is asked for as that file is kept, not as this one was');
  await w.onEvent({ type: 'other' });
  assert.strictEqual(c.backend.doc.calls.length, 5, 'and nothing else loads');
  c.connect();
  assert.strictEqual(c.unwatch.calls.length, 1, 'one watch at a time');

  w.onLive(false, 'offline');
  c.closeDocument({ reopen: 'b.md' });
  assert.deepStrictEqual([c.state.data, c.doc.innerHTML, c.win.location.search], [null, '', ''],
    'closing it leaves nothing on screen, or in the address');
  assert.strictEqual(c.unwatch.calls.length, 2, 'nothing watched');
  assert.strictEqual(c.liveWhy.value, null, 'and no complaint of a watch on nothing');
  assert.strictEqual(c.s.sidebars.clearSidebars.calls.length, 1, 'the columns emptied');
  assert.deepStrictEqual(plain(c.s.welcome.showWelcome.calls.at(-1)), [{ reopen: 'b.md' }],
    'and the welcome up, asking for what it was told to');
  await c.load({ keepScroll: true });
  assert.match(c.doc.innerHTML, /Notes/, 'the same file again is drawn, not taken for still there');
});
