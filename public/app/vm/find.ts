// Find: the bar's query, the matches it marks in `#doc`, and stepping through them.
//
// A viewmodel: what the bar shows is a signal here -- whether it is up, and what its count says --
// and ui/chrome.ts keeps the bar's markup to them. The rest is work over the rendered document,
// which no component draws, so it stays imperative: the marks are `<mark>`s spliced into the
// article's own text nodes.
import { signal } from '@preact/signals';
import { $, doc, pane } from '../dom.js';

/** Whether the find bar is up. The bar's button shows it pressed. */
export const findOpen = signal(false);

/** What the bar's count says: which match of how many, "No results", or nothing. */
export const findCount = signal('');

// Find in the current document only -- there is no filename filter and no
// cross-document index here. `#doc` is replaced whole on every paint (see
// `paint`), so matches are never kept across one: they are found fresh each
// time the bar opens, the query changes, or the document repaints under it.
const find = { query: '', matches: [], index: -1 };

/** Every text node under `doc`, in document order -- what a match can touch. */
function textNodesIn(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n; (n = walker.nextNode()); ) nodes.push(n);
  return nodes;
}

// What a match is allowed to run across: the whole of one paragraph, heading,
// list item, table cell or code block -- however many inline tags are nested
// inside it -- and no further. Without a boundary here, concatenating every
// text node in the document with nothing between them would let a query match
// across two blocks that just happen to be adjacent in the markup, with no
// word break between them to say they were never one piece of text.
const FIND_BLOCK = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th,dt,dd,caption,.raw-line';
const blockOf = (node) => node.parentElement?.closest(FIND_BLOCK) ?? doc;

/**
 * Wrap every case-insensitive occurrence of `query` in `<mark class="search-hit">`
 * and return one array of marks per match, in document order.
 *
 * The search runs over the text nodes' content concatenated together, because
 * a match can cross the boundary between two of them -- a search for "release
 * notes" crosses the node boundary where `**release**` ends. A match found
 * that way is then rebuilt one touched node at a time rather than spliced
 * into a single element: nodes on either side of a tag boundary are not
 * siblings, so the match becomes more than one `<mark>` when it crosses one --
 * the same highlighted run to the eye, each piece kept in its own parent.
 */
function markMatches(query) {
  clearMatches();
  if (!query) return [];
  const nodes = textNodesIn(doc);
  const starts = [];
  let total = 0;
  for (const node of nodes) {
    starts.push(total);
    total += node.nodeValue.length;
  }
  const hay = nodes.map((n) => n.nodeValue).join('').toLowerCase();
  const needle = query.toLowerCase();

  // Where a block ends and the next begins, as an offset into `hay` -- a
  // match that straddles one of these is rejected rather than highlighted.
  const cuts = [];
  for (let i = 1; i < nodes.length; i++) {
    if (blockOf(nodes[i]) !== blockOf(nodes[i - 1])) cuts.push(starts[i]);
  }
  const crossesBlock = (start, end) => cuts.some((c) => c > start && c < end);

  const ranges = [];
  let from = 0;
  let at;
  while ((at = hay.indexOf(needle, from)) !== -1) {
    const end = at + needle.length;
    if (crossesBlock(at, end)) {
      from = at + 1;
      continue;
    }
    ranges.push({ start: at, end, marks: [] });
    from = end;
  }
  if (!ranges.length) return [];

  // One pass, one replacement per node: splitting a node for every match that
  // touches it (as `Node.splitText` would, called match by match) invalidates
  // the offsets of whichever match comes next in the same node. Slicing the
  // node's own text against every range that overlaps it, once, has no such
  // ordering problem.
  let r = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeStart = starts[i];
    const nodeEnd = nodeStart + node.nodeValue.length;
    while (r < ranges.length && ranges[r].end <= nodeStart) r++;
    const text = node.nodeValue;
    const parts = [];
    let cursor = 0;
    let touched = false;
    for (let j = r; j < ranges.length && ranges[j].start < nodeEnd; j++) {
      const range = ranges[j];
      const from = Math.max(range.start - nodeStart, 0);
      const to = Math.min(range.end - nodeStart, text.length);
      if (from > cursor) parts.push(document.createTextNode(text.slice(cursor, from)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.appendChild(document.createTextNode(text.slice(from, to)));
      parts.push(mark);
      range.marks.push(mark);
      cursor = to;
      touched = true;
    }
    if (!touched) continue;
    if (cursor < text.length) parts.push(document.createTextNode(text.slice(cursor)));
    node.replaceWith(...parts);
  }
  return ranges.map((range) => range.marks);
}

/** Undo `markMatches`, leaving the text exactly as `paint` last set it. */
function clearMatches() {
  for (const mark of doc.querySelectorAll('mark.search-hit')) mark.replaceWith(mark.firstChild);
  doc.normalize();
}

function paintFindCount() {
  findCount.value = find.matches.length
    ? `${find.index + 1} of ${find.matches.length}`
    : find.query
      ? 'No results'
      : '';
}

/** Mark which match is current without moving the page -- what a repaint needs. */
function highlightCurrent() {
  for (const marks of find.matches) for (const m of marks) m.classList.remove('current');
  const current = find.matches[find.index];
  if (!current) return;
  for (const m of current) m.classList.add('current');
}

/** And actually go there -- what opening the bar and stepping through it need. */
function revealCurrent() {
  highlightCurrent();
  find.matches[find.index]?.[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * Find again over a document `paint` has just rebuilt. The marks drawn before are gone with the
 * rest of `#doc`'s old markup, so the search is redone against what is on screen now and the
 * place in it kept -- not scrolled to again, because the repaint is not something the reader
 * asked for.
 */
export function refind() {
  find.matches = markMatches(find.query);
  const last = find.matches.length - 1;
  find.index = last < 0 ? -1 : Math.max(0, Math.min(find.index, last));
  paintFindCount();
  highlightCurrent();
}

function runFind(query) {
  find.query = query;
  find.matches = markMatches(query);
  find.index = find.matches.length ? 0 : -1;
  paintFindCount();
  revealCurrent();
}

function stepFind(step) {
  if (!find.matches.length) return;
  find.index = (find.index + step + find.matches.length) % find.matches.length;
  paintFindCount();
  revealCurrent();
}

export function openFind() {
  findOpen.value = true;
  const input = $<HTMLInputElement>('findInput');
  input.focus();
  input.select();
  if (input.value) runFind(input.value);
}

export function closeFind() {
  if (!findOpen.value) return;
  findOpen.value = false;
  clearMatches();
  find.matches = [];
  find.index = -1;
  pane.focus({ preventScroll: true });
}

export const toggleFind = () => (findOpen.value ? closeFind() : openFind());

$('find').addEventListener('click', toggleFind);
$('findClose').addEventListener('click', closeFind);
$('findNext').addEventListener('click', () => stepFind(1));
$('findPrev').addEventListener('click', () => stepFind(-1));
$('findInput').addEventListener('input', (e) => runFind((e.target as HTMLInputElement).value));
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeFind());
