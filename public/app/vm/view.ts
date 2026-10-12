// The view: rendered or raw, and the marks on or off -- the two ways of drawing the same payload
// that the reader switches between as they read, and the place in the file kept across each.
//
// The marks are a setting as well as a switch, so this module writes them to vm/settings.ts and
// hears them back: an effect on `shownSettings` turns them on or off whenever settings are
// applied -- at start-up, from the sheet, from another window. Settings does not call in here,
// which is what keeps the two from importing each other.
import { effect, untracked } from '@preact/signals';
import { prefs, state, shownSettings } from '../state.js';
import { $, doc, pane, paneTop } from '../dom.js';
import { paintCount, paintRuler, keepAnchored } from './changes.js';
import { drawDiagrams } from './diagrams.js';
import { paint, rerender } from './document.js';
import { writeSettings } from './settings.js';

/**
 * The marks on or off. There is no button for this: the choice is the far end
 * of "what am I comparing against", so it is made where that is made — the
 * newest row in the history, which is the file against itself. The class does
 * the hiding, so the baseline underneath is not given up and turning the marks
 * back on costs no round trip.
 */
export function applyMarks() {
  document.documentElement.classList.toggle('no-diff', !state.diff);
}

function setDiff(on, { redraw = true } = {}) {
  if (on === state.diff) return;
  // Reading versions by themselves there are no marks to hide: the switch is
  // which text is on the page, the version picked or the file — so it is a
  // render, not a class. `redraw: false` is for a caller about to load anyway.
  if (state.solo) {
    state.diff = on;
    prefs.setItem('redline:diff', on ? '1' : '0');
    applyMarks();
    if (redraw) rerender();
    return;
  }
  keepAnchored(() => {
    state.diff = on;
    // The pre-paint mirror, so the marks never flash on for someone who
    // turned them off — see the inline script in index.html.
    prefs.setItem('redline:diff', on ? '1' : '0');
    applyMarks();
    // The history says what is being compared against, and with the marks off the answer is
    // "nothing" — the newest row. It reads `state.diff` itself, so it redraws on its own; the
    // count is worked out of the document's classes, which have just moved under it.
    if (state.data) paintCount();
  });
  // Turning the marks off takes the removed text out of the page, so the
  // document is a different height and every mark is somewhere else.
  paintRuler();
  drawDiagrams(); // diagrams in blocks that were hidden could not be measured
}

// Settings applied are the marks applied. Null until the stored settings are read, so nothing
// is switched at import; `untracked`, so that the switch is heard on a new `shownSettings` and
// not on `state.diff`, which `setDiff` reads and writes.
effect(() => {
  const s = shownSettings.value;
  if (s) untracked(() => setDiff(s.marks));
});

/**
 * The one switch for the marks, wherever it is thrown: the newest row in the
 * history, `d`, ⇧⌘D, or the Settings checkbox. It is remembered, so a document
 * opens the way you left the last one.
 */
export function setMarks(on, opts?) {
  if (on === state.diff) return;
  setDiff(on, opts);
  writeSettings({ marks: on });
}

export const toggleDiff = () => setMarks(!state.diff);

function setView(view) {
  // Keep the place, not the pixel: the two views agree on the file, and on
  // nothing else (see `sourceAt`).
  const at = sourceAt();
  state.view = view;
  prefs.setItem('redline:view', view);
  paint();
  scrollToSource(at);
}

export const toggleView = () => setView(state.view === 'raw' ? 'rendered' : 'raw');

// Switching views should leave you looking at the sentence you were looking at.
// The scroll offset cannot say that — the same paragraph is one height as prose
// and another as the lines of markdown it was written as, so the same number of
// pixels down is a different part of the document. What the two views do share
// is the file: every block of the render and every line of the source carries
// the line it came from (`data-line`, from `sourceLines` and `renderRawDiff`).
// So the place is read off as a line of the file — with the fraction, because a
// block can be a screen tall — and put back by the same measure on the far side.

/**
 * The last index where `holds` is true, given it is true for a prefix and false
 * after. A binary search rather than a scan because the blocks are siblings in
 * document order, so both the lines and the offsets only ever go up, and a long
 * file is thousands of them to measure on a keypress.
 */
function lastWhere(n, holds) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (holds(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Everything on screen that knows where it is in the file, in file order.
 *
 * Whichever view is up answers: lines in the raw one, top-level blocks in the
 * rendered one. What is not the file is not in here — a deleted block, the
 * "before" inside a rewrite — which is the point, since neither is a place the
 * other view could show you.
 */
const anchors = () => doc.querySelectorAll<HTMLElement>('[data-line]');

/** Where the top edge of the pane is, as a line of the file, fractionally. */
function sourceAt() {
  const nodes = anchors();
  if (!nodes.length) return null;
  const edge = paneTop();
  const i = lastWhere(nodes.length, (k) => nodes[k].getBoundingClientRect().top <= edge);
  const box = nodes[i].getBoundingClientRect();
  const line = +nodes[i].dataset.line;
  // How far into the block the edge has cut, as a share of the lines it spans:
  // half way down a ten-line paragraph is line five, and that is a place the
  // other view has too — where "half way down the paragraph" is some other
  // number of pixels entirely.
  const span = spanOf(nodes, i, line);
  const into = box.height ? clamp((edge - box.top) / box.height, 0, 1) : 0;
  return line + into * span;
}

/** Put line `at` back at the top edge, as near as the other view can manage. */
function scrollToSource(at) {
  if (at == null) return;
  const nodes = anchors();
  if (!nodes.length) return;
  // The line may be one this view does not have a block for — the raw view has
  // every line of the file and the rendered one has a block per several — so
  // the block that holds it is the last one that starts at or before it.
  const i = lastWhere(nodes.length, (k) => +nodes[k].dataset.line <= at);
  const line = +nodes[i].dataset.line;
  const box = nodes[i].getBoundingClientRect();
  const span = spanOf(nodes, i, line);
  const into = clamp(at - line, 0, span) / span;
  pane.scrollBy(0, box.top - paneTop() + into * box.height);
}

/**
 * How many lines of the file a block covers: up to where the next one starts.
 * The last block has nothing after it to measure against and is taken as one
 * line, which costs nothing — the end of the document is already on screen.
 */
function spanOf(nodes, i, line) {
  const next = nodes[i + 1];
  return next ? Math.max(+next.dataset.line - line, 1) : 1;
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// The bar's button. ui/chrome.ts keeps its icon and its title to `state.view`.
$('view').addEventListener('click', () => toggleView());
