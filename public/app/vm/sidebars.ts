// The two columns either side of the document: whether each is open, the disclosures at the top
// of each, the chevron's list that stands in for the left one when it is shut, and what the
// pair show with no document. Their widths and the Contents / History split are layout/'s.
import { prefs, state, shut, tabMenuAt } from '../state.js';
import { $ } from '../dom.js';
import { applyWidths } from '../layout/widths.js';
import { paintToc, spyToc } from './contents.js';
import { paintHistory, closeVerMenu } from './history.js';

/**
 * Whether there is a left column at all. Both apps fill it with the files
 * open; a CLI tab is handed one file and has no list, so there its button is
 * gone (styles.css) and ⌘B does nothing, rather than open an empty strip. The
 * head script asks the same question before first paint.
 */
export const leftColumn = document.documentElement.matches('.native, .web');

/** Remembered, because it is the kind of thing you set once and keep. */
export function setSide(on, remember = true) {
  state.side = on;
  if (remember) prefs.setItem('redline:side', on ? '1' : '0');
  document.documentElement.classList.toggle('side-open', on);
  // Opening a column changes what the window has left for the other one and
  // for the document, so both widths are worked out again from scratch.
  applyWidths();
}

/**
 * The contents, down the right, with a switch and a remembered state of its
 * own. Which is the whole point of its being a second column rather than a
 * second tab: where am I in this and what has changed since when are different
 * questions, and a reader following a long document through a review is asking
 * both of them at once.
 */
export function setTocSide(on, remember = true) {
  state.tocSide = on;
  if (remember) prefs.setItem('redline:toc', on ? '1' : '0');
  document.documentElement.classList.toggle('toc-open', on);
  applyWidths();
  // Neither list is built while the column is shut — there is nothing to
  // build it into — so opening it is what fills both.
  if (state.data) {
    paintToc(state.data);
    paintHistory(state.data);
  }
}

// Both columns and their keys work in the web app as much as in the desktop
// app, each filling the left one with a list of its own; a CLI tab has only
// the right one (see `leftColumn`).
$('side').addEventListener('click', () => setSide(!state.side));
$('tocBtn').addEventListener('click', () => setTocSide(!state.tocSide));

/**
 * The two sidebars for a page with no document. The welcome hides `#doc`, but Contents and
 * History are not inside it: left alone they go on listing the headings and versions of a file
 * the reader has let go of, and a row clicked would scroll to a node that is no longer there.
 * Painting them with null resets the counts and empties both lists, which draw nothing for
 * null: "No headings in this document" would be a claim about one.
 */
export function clearSidebars() {
  paintToc(null);
  paintHistory(null);
}

// Open files and Contents each keep a disclosure: both sit at the top of
// their column, where you start, but both are also the thing you stop
// needing once a file is chosen or a document's shape is learned — and
// putting either away hands the whole column to the panel below it.
// Remembered, and applied before first paint (see the inline script in
// index.html), so nothing unfolds and folds again on open.

const SHUT_KEY = 'redline:shut';

for (const twist of document.querySelectorAll<HTMLElement>('.side-twist')) {
  twist.addEventListener('click', () => {
    const key = twist.dataset.shut;
    const opening = shut.value.includes(key);
    shut.value = opening ? shut.value.filter((k) => k !== key) : [...shut.value, key];
    prefs.setItem(SHUT_KEY, JSON.stringify(shut.value));
    // A list coming back should open already pointing at where you are in the
    // document, not at the top of it.
    if (opening) spyToc();
  });
}

/** The chevron's list — the sidebar's rows, for when the sidebar is closed. ui/TabMenu.tsx. */
export function toggleTabMenu(left) {
  if (tabMenuAt.value !== null) return closeTabMenu();
  closeVerMenu();
  tabMenuAt.value = left;
}

export function closeTabMenu() {
  tabMenuAt.value = null;
}

document.addEventListener('click', () => closeTabMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeTabMenu());
