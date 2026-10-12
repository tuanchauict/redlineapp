import { test } from 'node:test';
import assert from 'node:assert';
import { fakeWindow, loadPage, pageCss, pageHtml, pageJs, plain, spy } from '../support.js';

// History moved columns, and three places still had to agree where it lives
// now: the paint function must not skip itself because the *other* column is
// shut, opening the right column must be what fills a list that was never
// built while it was closed, and the counter that answers "changed since
// what?" must open the column the answer is actually in.
test('History paints, opens and is reached through the right column', async () => {
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
});

// The remembered comparison. The reader keeps it, but only if the page asks in
// the form that means "show me this document" rather than "compare it against
// this": every site that *shows* one has to send `last:`, and the one that
// changes the setting must not, or changing it would look like it did nothing.
test('remembered comparison wired end to end', async () => {
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
});

// Reading one version by itself is a mode in the History heading. Each half is
// silent when dropped: no switch and it cannot be reached, no render branch and
// the switch lights up over a diff, no tag and an old version passes for the file.
test('reading one version by itself wired end to end', async () => {
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
});

// ---------- vm/history.ts, run ----------

// The greps above say History is wired; these load vm/history.ts over the real index.html and
// say what each of its doors does, with the document core and the backend as stand-ins that keep
// what they were asked. The row list itself is ui/History.tsx's and is not drawn here: what it
// hands back -- a version, a row, a count -- is handed in directly.
const ROWS = [
  { hash: 'c', current: true, ts: Date.now() },
  { hash: 'b', baseline: true, ts: Date.now() - 3600e3 },
  { hash: 'a', git: { subject: 'First draft' }, ts: Date.now() - 86400e3 },
];

async function historyIn() {
  const win = fakeWindow();
  const core = { load: spy(), adopt: spy(), paint: spy(), rerender: spy() };
  const view = { setMarks: spy() };
  const payload = { history: ROWS, baseline: 'read', text: 'now', base: 'then' };
  const backend = {
    markRead: spy(async () => payload),
    prune: spy(async () => payload),
  };
  const m = await loadPage(['state', 'vm/history'], {
    win,
    stubs: { backend: { backend }, 'vm/document': core, 'vm/view': view },
  });
  const pane = win.document.querySelector('main');
  return { win, core, view, backend, pane, payload, ...m.state, ...m['vm/history'] };
}

test('a version is named by its commit, or by when it was saved', async () => {
  const h = await historyIn();
  // The page's own formats, rather than English spelled out here: the runner's locale is the
  // page's, and a test that only passed in en-US would be a test of the machine.
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const rel = (n: number) => cap(new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    .format(n, 'day'));
  const clock = (d: Date) =>
    new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  const day = (d: Date, year = false) => new Intl.DateTimeFormat(undefined, {
    ...(year ? { year: 'numeric' } : {}), month: 'short', day: 'numeric',
  }).format(d);

  assert.strictEqual(h.versionName({ git: { subject: 'Fix the intro' } }), 'Fix the intro',
    'a commit is its subject');
  assert.strictEqual(h.versionName({ git: { subject: '' } }), 'Commit', 'or says it is one');
  const now = new Date();
  assert.strictEqual(h.versionName({ ts: +now }), `${rel(0)} ${clock(now)}`,
    'a save today is today, at a clock time that holds still');
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 30);
  assert.strictEqual(h.versionName({ ts: +yesterday }), `${rel(-1)} ${clock(yesterday)}`,
    'yesterday is yesterday');
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 9, 30);
  assert.strictEqual(h.versionName({ ts: +week }),
    `${day(week, week.getFullYear() !== now.getFullYear())}, ${clock(week)}`,
    'older is a date, with its year only when it is not this one');
  const old = new Date(now.getFullYear() - 2, 2, 3, 9, 30);
  assert.strictEqual(h.versionName({ ts: +old }), `${day(old, true)}, ${clock(old)}`,
    'and another year names it');
});

test('History says which row is compared against, and a pick changes it', async () => {
  const h = await historyIn();
  const d = (baseline: string) => ({ baseline, history: ROWS });
  const rows = (baseline: string) => ROWS.filter((v) => h.isBaseline(d(baseline), v))
    .map((v) => v.hash).join('');
  h.state.diff = true;
  assert.strictEqual(rows('read'), 'b', 'the last-read pointer is the row carrying it');
  assert.strictEqual(rows('snap:a'), 'a', 'a version named is that row');
  assert.strictEqual(rows('git:HEAD'), 'a', 'HEAD is the newest row carrying a commit');
  assert.strictEqual(rows('snap:gone'), '', 'a version since forgotten is no row');
  h.state.diff = false;
  assert.strictEqual(rows('read'), 'c', 'with the marks off, the file is compared with itself');

  h.state.pruneAsk = 'a';
  h.pickVersion(ROWS[0]);
  assert.deepStrictEqual(plain(h.view.setMarks.calls), [[false]], 'the newest row puts the marks away');
  assert.strictEqual(h.core.load.calls.length, 0, 'and costs no load');
  assert.strictEqual(h.state.pruneAsk, null, 'and a pick answers a question left open');

  h.pickVersion(ROWS[2]);
  assert.deepStrictEqual(plain(h.view.setMarks.calls[1]), [true, { redraw: false }],
    'an older row turns the marks on, without drawing the version being left');
  assert.strictEqual(h.state.baseline, 'snap:a', 'is named outright, which is how it sticks');
  assert.deepStrictEqual(plain(h.core.load.calls), [[{ keepScroll: true }]], 'and loads, in place');
  h.pickVersion(ROWS[1]);
  assert.strictEqual(h.state.baseline, 'read',
    'the row carrying the read mark is named as the mark, so it moves as reading does');
});

test('reading one version alone, and marking one read', async () => {
  const h = await historyIn();
  h.state.diff = true;
  h.state.data = { baseline: 'snap:a', history: ROWS, text: 'now', base: 'then' };
  assert.strictEqual(h.soloName.value, null, 'comparing, the bar names no version');
  h.win.$('histSolo').click();
  assert.strictEqual(h.state.solo, true, 'the switch reads the version alone');
  assert.strictEqual(h.core.rerender.calls.length, 1, 'from the payload already held');
  assert.strictEqual(h.soloName.value, 'First draft', 'and the bar names the version on the page');
  h.setSolo(true);
  assert.strictEqual(h.core.rerender.calls.length, 1, 'setting it to what it is costs nothing');
  h.state.data = { ...h.state.data, base: 'now' };
  assert.strictEqual(h.soloName.value, null, 'a version the same as the file is the file');
  h.toggleSolo();
  assert.strictEqual(h.state.solo, false, 'and the toggle turns it off');

  // `m`: nothing to do when the mark is already on the version on disk.
  h.state.data = { history: [{ hash: 'c', current: true, baseline: true }] };
  h.tapMarkRead();
  h.state.data = { history: [{ hash: 'c', current: true }] };
  h.tapMarkRead();
  assert.strictEqual(h.backend.markRead.calls.length, 0, 'on the newest, or with no mark at all');
  h.state.data = { history: ROWS };
  h.pane.scrollTop = 420;
  h.tapMarkRead();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(plain(h.backend.markRead.calls), [[null]], 'otherwise it marks the file');
  assert.strictEqual(h.core.adopt.calls[0][0], h.payload, 'takes what the reader answers');
  assert.strictEqual(h.core.paint.calls.length, 1, 'draws it');
  assert.strictEqual(h.pane.scrollTop, 420, 'and leaves the page where it was');
  assert.strictEqual(h.view.setMarks.calls.length, 0, 'without touching the marks');
});

test('a row\'s menu: what it offers, where it opens, the keys, and forgetting', async () => {
  const h = await historyIn();
  const menu = h.win.$('verMenu');
  const row = h.win.document.createElement('div');
  row.innerHTML = '<button class="ver-more">…</button>';
  h.win.$('histList').appendChild(row);
  const more = row.querySelector('.ver-more');
  const items = () => menu.querySelectorAll('button').map((b) => [b.textContent, b.disabled]);
  Object.assign(h.win, { innerWidth: 800, innerHeight: 600 });
  Object.assign(menu, { offsetWidth: 200, offsetHeight: 80 });

  h.state.tabs = [];
  h.openVerMenu(row, ROWS[0], 3, { from: null, x: 10, y: 10 });
  assert.deepStrictEqual(plain(items()), [['Mark as read', false]],
    'the version on disk can be marked read and never forgotten');
  assert.match(menu.querySelector('button').title, /clears the marks \(m\)/, 'it says what m says');
  assert.strictEqual(h.menuFor.value, 'c', 'its row is lit, by hash');
  assert.strictEqual(h.win.document.activeElement, menu, 'from a pointer, the menu has the keys');

  h.tabMenuAt.value = 3;
  h.openVerMenu(row, ROWS[1], 1, { from: null, keyboard: true, x: 700, y: 560 });
  assert.strictEqual(h.tabMenuAt.value, null, 'it closes the chevron\'s list');
  assert.deepStrictEqual(plain(items()), [['Mark as read', true], ['Forget this version…', false]],
    'the row already marked says so, and one version is "this version"');
  assert.deepStrictEqual([menu.style.left, menu.style.top], ['500px', '480px'],
    'at the pointer, turned left and up where it would hang off the window');
  assert.strictEqual(h.win.document.activeElement.textContent, 'Forget this version…',
    'and from the keyboard the first item that can be used has it');

  more.rect = { top: 100, bottom: 120, left: 300, right: 320 };
  h.openVerMenu(row, ROWS[2], 2, { from: more });
  assert.strictEqual(menu.querySelectorAll('button')[1].textContent, 'Forget this and older…',
    'two or more is "this and older"');
  assert.deepStrictEqual([menu.style.left, menu.style.top], ['120px', '122px'],
    'under the "…" it came from, right edges lined up');

  // The keys are the menu's while it has them: arrows wrap, Escape gives the "…" back.
  const key = (k: string, more = {}) => h.win.fire(menu, 'keydown', { key: k, ...more });
  const page = spy();
  h.win.document.addEventListener('keydown', page);
  key('ArrowDown');
  assert.strictEqual(h.win.document.activeElement.textContent, 'Mark as read', 'down from none is the first');
  key('ArrowUp');
  assert.strictEqual(h.win.document.activeElement.textContent, 'Forget this and older…', 'and up wraps');
  assert.strictEqual(page.calls.length, 0, 'none of it reaches the page behind');

  // Forget: pointing at it greys what would go; choosing it asks, in the row.
  const forget = menu.querySelectorAll('button')[1];
  h.win.fire(forget, 'pointerenter');
  assert.strictEqual(h.cutFrom.value, 'a', 'pointing at Forget previews the cut');
  h.win.fire(forget, 'pointerleave');
  assert.strictEqual(h.cutFrom.value, null, 'and leaving it takes the preview back');
  h.win.fire(forget, 'focus');
  forget.click();
  assert.deepStrictEqual([menu.hidden, h.menuFor.value, h.cutFrom.value], [true, null, null],
    'choosing it closes the menu, preview and all');
  assert.deepStrictEqual([h.state.pruneAsk, h.pruneFocus.asked], ['a', true],
    'and puts the question on the row, with the keyboard to go to it');

  h.openVerMenu(row, ROWS[2], 2, { from: more });
  key('Escape');
  assert.deepStrictEqual([menu.hidden, h.win.document.activeElement], [true, more],
    'Escape closes it and gives the keyboard back to the "…"');
  for (const [what, act] of [
    ['a click elsewhere', () => h.win.fire(h.win.document, 'click')],
    ['a right-click elsewhere', () => h.win.fire(h.win.document, 'contextmenu')],
    ['the list scrolling', () => h.win.fire(h.win.$('histList'), 'scroll', { bubbles: false })],
    ['the window resizing', () => h.win.fire(h.win.__target, 'resize')],
    ['the window losing focus', () => h.win.fire(h.win.__target, 'blur')],
    ['a modifier chord', () => key('m', { metaKey: true })],
    ['a repaint of the list', () => h.paintHistory(h.payload)],
  ] as [string, () => void][]) {
    h.openVerMenu(row, ROWS[2], 2, { from: more });
    act();
    assert.strictEqual(menu.hidden, true, `${what} closes it`);
  }
  assert.strictEqual(h.shownHistory.value, h.payload, 'and the list is handed what to draw');
  h.openVerMenu(row, ROWS[2], 2, { from: more });
  menu.click();
  assert.strictEqual(menu.hidden, false, 'a click on its own padding leaves it up');

  // Mark as read from a row: the version named, the marks on.
  menu.querySelector('button').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepStrictEqual(plain(h.backend.markRead.calls), [['a']], 'an older row marks itself read');
  assert.deepStrictEqual(plain(h.view.setMarks.calls), [[true, { redraw: false }]],
    'and turns the marks on, since the point is what came after it');
});

test('Forget and Clear history', async () => {
  const h = await historyIn();
  h.state.baseline = 'snap:a';
  h.state.pruneAsk = 'b';
  h.pane.scrollTop = 99;
  await h.prune('b');
  assert.deepStrictEqual(plain(h.backend.prune.calls), [['b', 'snap:a']],
    'forgetting says what it cuts at and what is being compared against');
  assert.deepStrictEqual([h.state.pruneAsk, h.core.paint.calls.length, h.pane.scrollTop],
    [null, 1, 99], 'the question is answered, the result drawn, and the place kept');

  const clear = h.win.$('histClear');
  h.state.data = { history: [ROWS[0]] };
  clear.click();
  assert.strictEqual(h.state.pruneAsk, null, 'with nothing older, Clear has nothing to ask');
  h.state.data = { history: ROWS };
  h.shownHistory.value = { history: ROWS };
  clear.click();
  assert.strictEqual(h.state.pruneAsk, 'b', 'Clear asks on the row under the version on disk');
  for (const [type, want] of [['pointerenter', 'b'], ['pointerleave', null], ['focus', 'b'],
    ['blur', null]] as [string, string | null][]) {
    h.win.fire(clear, type, { bubbles: false });
    assert.strictEqual(h.cutFrom.value, want, `and previews the cut on ${type}`);
  }
});
