import { test } from 'node:test';
import assert from 'node:assert';
import { fakeWindow, loadPage } from '../support.js';

// Find splices `<mark>`s into the article's own text nodes, so what it does is only seen by doing
// it: vm/find.ts is loaded here over the real index.html, and driven through the bar's controls
// as a reader drives it.
const ARTICLE = [
  '<h1>Release notes</h1>',
  '<p>The <strong>release</strong> notes say what a release is.</p>',
  '<p>Release</p><p>notes</p>',
  '<ul><li>RELEASE <em>no</em>tes</li></ul>',
].join('');

async function findIn(html = ARTICLE) {
  const win = fakeWindow();
  const { 'vm/find': find } = await loadPage(['vm/find'], { win });
  const doc = win.$('doc');
  doc.innerHTML = html;
  const input = win.$('findInput');
  const type = (q) => {
    input.value = q;
    win.fire(input, 'input');
  };
  const hits = () => doc.querySelectorAll('mark.search-hit').map((m) => m.textContent);
  const current = () => doc.querySelectorAll('mark.current').map((m) => m.textContent).join('');
  return { win, find, doc, input, type, hits, current };
}

test('find marks every match, across inline tags and never across blocks', async () => {
  const f = await findIn();
  const before = f.doc.innerHTML;
  f.win.$('find').click();
  assert.strictEqual(f.find.findOpen.value, true, 'the bar button opens it');
  assert.strictEqual(f.win.document.activeElement, f.input, 'with the keyboard in the query');

  f.type('release notes');
  // The heading, "The release notes" across </strong>, and the list item across <em> -- in any
  // case -- but not "Release" / "notes", two paragraphs that only touch in the markup.
  assert.strictEqual(f.find.findCount.value, '1 of 3', 'three matches, the first one current');
  assert.deepStrictEqual(
    [...f.hits()],
    ['Release notes', 'release', ' notes', 'RELEASE ', 'no', 'tes'],
    'a match crossing a tag is one mark per piece, each in its own parent',
  );
  assert.strictEqual(f.current(), 'Release notes', 'the first match is the current one');
  assert.ok(f.doc.querySelector('mark.current').scrolledIntoView, 'and is scrolled to');
  assert.match(f.doc.innerHTML, /<strong><mark class="search-hit">release<\/mark><\/strong>/,
    'the mark is inside the tag it crossed, not around it');

  // Stepping: Enter goes on, ⇧Enter back, both wrap, and the buttons do the same.
  f.win.fire(f.input, 'keydown', { key: 'Enter' });
  assert.strictEqual(f.find.findCount.value, '2 of 3', 'Enter steps to the next');
  assert.strictEqual(f.current(), 'release notes', 'which is the one across </strong>');
  f.win.$('findNext').click();
  f.win.$('findNext').click();
  assert.strictEqual(f.find.findCount.value, '1 of 3', 'and past the last wraps to the first');
  f.win.fire(f.input, 'keydown', { key: 'Enter', shiftKey: true });
  assert.strictEqual(f.find.findCount.value, '3 of 3', '⇧Enter wraps backwards');
  f.win.$('findPrev').click();
  assert.strictEqual(f.find.findCount.value, '2 of 3', 'as Previous does');

  // Two blocks meet in the text with nothing between them: "Release" ends one paragraph and
  // "notes" starts the next, so the joined text says "Releasenotes", which nobody wrote.
  f.type('releasenotes');
  assert.strictEqual(f.find.findCount.value, 'No results', 'a match may not run across two blocks');
  f.type('se no');
  assert.strictEqual(f.find.findCount.value, '1 of 3', 'though one may run across inline tags');

  f.type('nothing like it');
  assert.strictEqual(f.find.findCount.value, 'No results', 'a query with no match says so');
  assert.strictEqual(f.hits().length, 0, 'and the last query\'s marks are gone');
  f.win.$('findNext').click();
  assert.strictEqual(f.find.findCount.value, 'No results', 'with nothing to step through');
  f.type('');
  assert.strictEqual(f.find.findCount.value, '', 'an empty query says nothing at all');

  f.type('notes');
  assert.notStrictEqual(f.doc.innerHTML, before, 'marked, the markup has changed');
  f.win.fire(f.win.document, 'keydown', { key: 'Escape' });
  assert.strictEqual(f.find.findOpen.value, false, 'Escape closes it');
  assert.strictEqual(f.doc.innerHTML, before, 'and the text is exactly what paint left');
  assert.strictEqual(f.doc.querySelector('p').childNodes.length, 3,
    'with the pieces a mark split joined back into one text node each');
  assert.strictEqual(f.win.document.activeElement, f.win.document.querySelector('main'),
    'and the keyboard goes back to the document');
});

test('find opens on the last query, and refind keeps its place over a new document', async () => {
  const f = await findIn('<p>one a</p><p>two a</p><p>three a</p>');
  f.input.value = ' a';
  f.find.openFind();
  assert.strictEqual(f.find.findCount.value, '1 of 3', 'reopened, it runs what the bar still says');
  f.find.toggleFind();
  assert.strictEqual(f.find.findOpen.value, false, 'the toggle closes an open bar');
  f.find.toggleFind();
  f.win.$('findNext').click();
  f.win.$('findNext').click();
  assert.strictEqual(f.find.findCount.value, '3 of 3', 'on the third');

  // A repaint replaces `#doc`, and the marks with it. `refind` finds again where it stood --
  // the third, clamped if there are fewer now -- and scrolls nowhere, since nobody asked it to.
  f.doc.innerHTML = '<p>one a</p><p>two a</p><p>three a</p><p>four a</p>';
  f.find.refind();
  assert.strictEqual(f.find.findCount.value, '3 of 4', 'the same place in the new document');
  assert.strictEqual(f.current(), ' a', 'marked current');
  assert.strictEqual(f.doc.querySelector('mark.current').scrolledIntoView, null, 'not scrolled to');
  f.doc.innerHTML = '<p>one a</p>';
  f.find.refind();
  assert.strictEqual(f.find.findCount.value, '1 of 1', 'clamped to what is left');
  f.doc.innerHTML = '<p>none</p>';
  f.find.refind();
  assert.strictEqual(f.find.findCount.value, 'No results', 'or nothing');

  f.find.closeFind();
  f.find.closeFind();
  assert.strictEqual(f.find.findOpen.value, false, 'closing a closed bar is nothing');
  f.win.$('findClose').click();
  assert.strictEqual(f.find.findOpen.value, false, 'and its own close button is the same');
});
