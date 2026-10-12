// Contents: the document's own headings, down the side. A long file is not navigable by
// scrolling, and the shape of one — what it covers, how deep it goes — is not visible from any
// one screen of it. The list answers both, and it is the document's own structure rather than
// anything this app invented: the server walks the source once and sends the headings with the
// render (see `outline`).
//
// Rows indent by heading level, capped: a document nested six deep would otherwise spend the
// whole column on whitespace. ui/Contents.tsx draws them, from `state.toc` and `state.tocAt`.
import { state } from '../state.js';
import { $, doc, pane, paneTop } from '../dom.js';

/**
 * The element a heading row points at.
 *
 * Two views, two ways to find it. The rendered view has ids on its headings, so
 * the link a document writes itself (`[see below](#notes)`) and a row here both
 * land the same way. The raw view is the file's lines and has no ids at all, so
 * the row finds the line the heading is on instead.
 *
 * Looked up inside the document rather than with `document.getElementById`,
 * which would also answer with the app's own furniture: a heading called
 * "Name" slugs to `name`, and so does the filename in the toolbar.
 */
function headingNode(h) {
  if (state.view === 'raw') return doc.querySelector(`.raw-line[data-line="${h.line}"]`);
  return byId(h.id);
}

/** A node in the document by its id, for an id that came from the document. */
const byId = (id) => (id ? doc.querySelector(`#${CSS.escape(id)}`) : null);

/** Put a node at the top of the pane, where a heading you just jumped to belongs. */
export function scrollToNode(node, smooth = true) {
  if (!node) return;
  const top = pane.scrollTop + node.getBoundingClientRect().top - paneTop() - 8;
  pane.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'instant' });
}

/**
 * Pair each heading with its node, for the list in ui/Contents.tsx to draw. `d` is null when no
 * document is open, which leaves the list with nothing to say, not "No headings".
 */
export function paintToc(d) {
  const heads = d?.toc ?? [];
  // Dropped before anything else: the rows point at nodes in a document that
  // has just been replaced, and whatever follows must not be able to read them.
  state.toc = null;
  state.tocAt = -1;

  // A document whose only heading is its title has no contents — a list of one
  // row saying what the toolbar already says. The column stays and says so,
  // rather than taking itself away: whether it is open is the reader's
  // standing choice, and a column that shut itself on one document and came
  // back on the next would be the window rearranging itself as you read.
  const has = heads.length > 1;
  $('tocCount').textContent = has ? String(heads.length) : '';
  // Neither a shut column nor no document has a list; a document with one heading has an
  // empty one, which the list says out loud.
  if (!d || !state.tocSide) return;
  // Resolved here and kept, not looked up per click or per scroll: the whole
  // document is replaced on every paint and this runs with it, so the node is
  // never staler than the list itself.
  state.toc = has ? heads.map((h) => ({ h, node: headingNode(h) })) : [];
  spyToc();
}

/**
 * Mark the heading you are reading under: the last one whose top has gone past
 * the top of the pane. Only `state.tocAt` is set here; the list lights the row
 * and scrolls it into view when that changes.
 */
export function spyToc() {
  if (!state.toc?.length) return;
  const limit = paneTop() + 8;
  let at = 0;
  for (let i = 0; i < state.toc.length; i++) {
    // A heading only in the baseline has no node in this view; it keeps its row
    // — the list is the document's shape — but there is nowhere to go to.
    const { node } = state.toc[i];
    if (node && node.getBoundingClientRect().top <= limit) at = i;
  }
  state.tocAt = at;
}

// Coalesced to one a frame: scroll fires far more often than the list can
// usefully change, and every call measures every heading.
let spying = false;
function queueSpy() {
  if (spying) return;
  spying = true;
  requestAnimationFrame(() => {
    spying = false;
    spyToc();
  });
}

// Scrolling moves where you are in the document, which is what the contents list is for. (The
// link peek has its own listener, in vm/peek.ts.)
pane.addEventListener('scroll', queueSpy);

/**
 * A link into the document itself. The browser would handle it, but only in the
 * rendered view and only by putting the heading wherever it happens to land;
 * this puts it at the top of the pane in either view, and leaves the address
 * alone — a fragment in the URL would be one more thing a reload has to undo.
 */
doc.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a[href^="#"]');
  const id = a && decodeURIComponent(a.getAttribute('href').slice(1));
  if (!id) return;
  const head = (state.data?.toc ?? []).find((h) => h.id === id);
  // A link to something that is not a heading — an anchor the author wrote
  // themselves — is still a link into the document.
  const node = head ? headingNode(head) : byId(id);
  if (!node) return;
  e.preventDefault();
  scrollToNode(node);
});
