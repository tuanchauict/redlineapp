import { test } from 'node:test';
import assert from 'node:assert';
import { fakeWindow, loadPage } from '../support.js';

// The link peek says where a link goes, written the way the document's author would know it, and
// `linkTarget` is what a click on one opens. Both read the directory of the document on screen,
// so each is run here against a payload's `dir` and the `~` label the reader gives it.
const DIR = { dir: '/Users/me/notes', dirLabel: '~/notes' };

async function peekIn(data: object | null = DIR) {
  const win = fakeWindow();
  const { state: { state }, 'vm/peek': peek } = await loadPage(['state', 'vm/peek'], { win });
  state.data = data;
  const doc = win.$('doc');
  const box = win.$('peek');
  /** What the peek says over a link to `href`, or null when it is down. */
  const over = (href: string | null) => {
    doc.innerHTML = href === null ? '<a>x</a>' : `<a href="${href}">x <strong>y</strong></a>`;
    win.fire(doc.querySelector('strong') ?? doc.querySelector('a'), 'pointerover');
    return box.hidden ? null : box.textContent;
  };
  return { win, state, peek, doc, box, over };
}

test('the peek names a link the way its document would', async () => {
  const p = await peekIn();
  for (const [href, want, why] of [
    ['#Sec%20two', '#Sec two', 'an in-page jump is its anchor, unescaped'],
    ['https://example.com/a', 'https://example.com/a', 'a URL is itself'],
    ['//cdn.example/x', 'http://cdn.example/x', 'and a protocol-relative one the address it fetches'],
    ['http://[nope', 'http://[nope', 'one the browser cannot parse is what the page says'],
    ['./api.md#Setup', '~/notes/api.md#Setup', 'a neighbour is its path, from home, with its place'],
    ['../%E5%9B%B3.md', '~/図.md', 'decoded, and climbing out of the directory'],
    ['/etc/x.md', '/etc/x.md', 'a rooted path is left as written'],
    ['?q=1', '?q=1', 'a query on nothing is what the page says'],
    ['bad%E0%A4%A.md', '~/notes/bad%E0%A4%A.md', 'a malformed escape is kept rather than lost'],
    [' ', null, 'a link to nowhere says nothing'],
    [null, null, 'and an anchor with no href is no link'],
  ] as [string | null, string | null, string][]) {
    assert.strictEqual(p.over(href), want, `${JSON.stringify(href)}: ${why}`);
  }
  const bare = await peekIn(null);
  assert.strictEqual(bare.over('api.md'), 'api.md', 'with no document to resolve against, as written');
});

test('the peek follows the pointer and the keyboard, and steps aside from what it covers', async () => {
  const p = await peekIn();
  p.doc.innerHTML = '<p><a href="a.md">one <strong>two</strong></a> and <em>not a link</em></p>';
  const [a, strong, em] = ['a', 'strong', 'em'].map((s) => p.doc.querySelector(s));
  p.win.fire(strong, 'pointerover');
  assert.strictEqual(p.box.textContent, '~/notes/a.md', 'the text inside a link is the link');
  p.win.fire(strong, 'pointerout', { relatedTarget: a });
  assert.strictEqual(p.box.hidden, false, 'crossing between the pieces of one link keeps it up');
  p.win.fire(a, 'pointerout', { relatedTarget: em });
  assert.deepStrictEqual([p.box.hidden, p.box.textContent], [true, ''], 'leaving it takes it down');

  p.win.fire(a, 'focusin');
  assert.strictEqual(p.box.hidden, false, 'tabbing to a link asks the same question');
  p.win.fire(a, 'focusout');
  assert.strictEqual(p.box.hidden, true, 'and tabbing away answers it');
  for (const [at, type] of [[p.win.document.querySelector('main'), 'scroll'], [p.win.__target, 'blur']]) {
    p.win.fire(a, 'pointerover');
    p.win.fire(at, type, { bubbles: false });
    assert.strictEqual(p.box.hidden, true, `a ${type} takes it down`);
  }

  // In the corner unless the link is under that corner: measured, both boxes.
  p.box.rect = { top: 760, bottom: 780, left: 0, right: 300 };
  a.rect = { top: 100, bottom: 120, left: 20, right: 80 };
  p.win.fire(a, 'pointerover');
  assert.strictEqual(p.box.classList.contains('away'), false, 'a link elsewhere leaves it be');
  a.rect = { top: 765, bottom: 785, left: 20, right: 80 };
  p.win.fire(a, 'pointerover');
  assert.strictEqual(p.box.classList.contains('away'), true, 'a link it would cover moves it');
  a.rect = { top: 765, bottom: 785, left: 400, right: 480 };
  p.win.fire(a, 'pointerover');
  assert.strictEqual(p.box.classList.contains('away'), false, 'and only one it would cover');
});

test('a link opens a file only when it names one this reader opens', async () => {
  const p = await peekIn();
  const { linkTarget } = p.peek;
  for (const [href, want] of [
    ['./api.md', '/Users/me/notes/api.md'],
    ['../adr/0004.markdown', '/Users/me/adr/0004.markdown'],
    ['a%20b.md?x=1#y', '/Users/me/notes/a b.md'],
    ['/abs/x.md', '/abs/x.md'],
    ['notes.TXT', '/Users/me/notes/notes.TXT'],
    ['img.png', null],
    ['dir/', null],
    ['https://example.com/a.md', null],
    ['//cdn/a.md', null],
    ['#a.md', null],
    ['', null],
    ['?only', null],
  ] as [string, string | null][]) {
    assert.strictEqual(linkTarget(href), want, `${JSON.stringify(href)} opens ${want}`);
  }
  p.state.data = null;
  assert.strictEqual(linkTarget('./api.md'), null, 'nothing, with no document to resolve against');
});
