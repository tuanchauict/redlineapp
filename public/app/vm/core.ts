// The document on screen: asking the backend for it, taking the payload as it, drawing it into
// `#doc` and everything around it, putting it away, and the watch that keeps it current.
//
// The viewmodels that redraw the document -- History, the view, Settings -- are themselves drawn
// by `paint`, so they cannot import this module without a circle. They reach it through
// vm/document.ts instead, which this fills as it is imported, before anything can call it.
import { createMarkdown, renderDocument, titleOf } from '../../vendor/render.js';
import { sanitizeDocument } from '../../vendor/sanitize.js';
import { prefs, state, barName, liveWhy } from '../state.js';
import { doc, pane } from '../dom.js';
import { backend } from '../backend.js';
import { hidePeek } from './peek.js';
import { drawDiagrams } from './diagrams.js';
import { findOpen, refind } from './find.js';
import { paintCount, paintRuler, forgetHover } from './changes.js';
import { applyAcks } from './acks.js';
import { paintToc } from './contents.js';
import { setSide, clearSidebars } from './sidebars.js';
import { bindDocument } from './document.js';
import { keptBaseline } from './settings.js';
import { applyMarks } from './view.js';
import { paintHistory } from './history.js';
import { welcome, welcomeAsks, showWelcome, hideWelcome } from './welcome.js';

// Every one of these is a function declaration, so it is defined before this line runs.
bindDocument({ load, adopt, paint, rerender });

// A browser tab has no shell to keep its open files, so the web app keeps them itself, and the
// left column lists them as the desktop app lists its tabs. A CLI tab is handed one file and
// has no list at all.
export const openFiles = backend.openFiles ?? null;
if (openFiles) state.tabs = openFiles.list();

/** Keep the id in the address too, so a reload comes back to this document. */
export function setDocId(id) {
  if (!id || id === state.docId) return false;
  state.docId = id;
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  history.replaceState(null, '', url);
  return true;
}

/** The other half of `setDocId`: this page has no document, so a reload should not look for one. */
function clearDocId() {
  state.docId = '';
  const url = new URL(location.href);
  url.searchParams.delete('id');
  history.replaceState(null, '', url);
}

// One markdown renderer for the life of the page. Building it is not free and
// it holds no per-document state -- what varies between documents is passed in
// (see `renderDocument`), because the diff renders a single document twice and
// two renderers would be two sets of plugin rules to keep in step.
const md = createMarkdown();

/**
 * Take a document payload as the one this page is showing, however it arrived —
 * a load, a read mark, a pruned history. Everything the page holds about the
 * document that the payload is authoritative on is re-read from it here, so
 * there is one place for it rather than one per endpoint.
 *
 * The payload is the two versions of the text; the HTML, the marks and the
 * contents list are worked out here. That is where it has to happen for the
 * desktop app — a webview with no server behind it — and doing it here for the
 * browser too is what keeps there being one diff rather than two.
 */
export function adopt(data) {
  const checked = { keys: data.acked, from: data.ackedFrom };
  // Reading one version by itself is the same payload rendered differently:
  // the version chosen in the history is already here as `base`, so it costs
  // no request and the reader keeps no second notion of what is chosen.
  const rendered = state.solo
    ? { ...renderDocument(md, soloText(data), null), title: titleOf(md, data.text) }
    : renderDocument(md, data.text, data.base, checked);
  state.data = Object.assign(data, rendered);
  state.caps = data.caps ?? null;
  // The id is assigned by the reader when this page did not name one.
  setDocId(data.id);
  // The baseline asked for is not always the one that could be honoured — a
  // default of git HEAD means nothing outside a repo, and a version can have
  // been forgotten. The payload says which was used, and the document in it is
  // built from that one, so its answer is the one to keep.
  state.baseline = data.baseline;
  state.acked = new Set(data.acked ?? []);
}

/** Whether it painted a document. Not painting is not an error where there is a welcome. */
export async function load({ keepScroll = true } = {}) {
  const y = pane.scrollTop;
  const want = state.docId;
  let data;
  try {
    data = await backend.doc(state.baseline);
  } catch (err) {
    // The two things a page with nothing handed to it is told: there is no document, or there
    // is one that has to be asked for again. Anything else is the reader failing.
    if (!welcome || !['NoDocument', 'NeedsPermission'].includes(err?.name)) throw err;
    if (err.name === 'NoDocument') {
      // The id in the address is for a document that cannot be shown, and a reload would only
      // be told so again. (A lapsed permission keeps it: asking again is what brings it back.)
      closeDocument();
    } else {
      showWelcome({ reopen: welcomeAsks ?? 'this file' });
    }
    return false;
  }
  // Switch tabs faster than the answer arrives and two loads are in flight;
  // the one you have already left must not paint over the one you are on.
  if (want && want !== state.docId) return false;
  adopt(data);
  // A document opened takes the welcome down. The one on screen read again -- an edit, a version
  // arriving, a baseline chosen, all `keepScroll` -- takes it down only if it was asking for a
  // grant, which a read that worked says is no longer needed.
  if (!keepScroll || welcomeAsks) hideWelcome();
  // `keepScroll` is the same document read again, which is the one case where what is on
  // screen may already be what the payload says -- see `paint`.
  paint({ reuse: keepScroll });
  noteOpen();
  if (keepScroll) pane.scrollTo(0, y);
  return true;
}

/**
 * Nothing on screen, and the welcome over the space where it was. The web app's alone.
 * `reopen` is the file it is to go on asking for, if it is asking.
 */
export function closeDocument({ reopen = null } = {}) {
  clearDocId();
  state.data = null;
  // Nothing on screen is what `painted` says any more: the same file opened again, with the
  // same markup, would otherwise be taken for the article still standing.
  painted = { id: '', source: null };
  doc.replaceChildren();
  clearSidebars();
  // The bar's half of the document, as `paint` draws it: the count, the arrows and the ruler
  // would otherwise stay over the welcome, telling of a file no longer open. Each reads
  // `state.data`, so with none they put themselves away. (The version being read is a computed
  // over `state.data`, and goes by itself.)
  paintCount();
  paintRuler();
  state.changeIndex = -1;
  stopWatch();
  // A watch that had dropped is not one to complain of with nothing being watched.
  setLive(true);
  showWelcome({ reopen });
}

/**
 * The text on the page while reading one version by itself: the version the
 * history has filled in. With the marks off that is the newest row — the file
 * as it is — so the filled row is always the text on screen. A baseline that
 * could not be read leaves nothing older to show, and the file is shown.
 */
const soloText = (data) => (state.diff ? (data.base ?? data.text) : data.text);

/**
 * Draw the payload already held over again, for a switch that changes what is
 * drawn from it rather than what it is. The pixel offset is kept, as `load`
 * keeps it: the text being swapped in is another version, so no node in the old
 * one is there to anchor on.
 */
export function rerender() {
  if (!state.data) return;
  const y = pane.scrollTop;
  adopt(state.data);
  paint();
  pane.scrollTo(0, y);
}

// What `#doc` was last built from, and whose it is. A reload of the same document that comes
// out as the same markup leaves the article standing (see `paint`), and this is what it is
// compared with. Anything else that rewrites `#doc` has to reset it, or that compare lies.
let painted = { id: '', source: null };

/**
 * What the reader has done to the article that the markup does not say, and a rebuild would
 * therefore undo. Each kind names the elements it is about, what to call one so that the same
 * element can be found in the next build, and how to read and put back what was done to it.
 *
 * A name comes from what the element *says*, never from where it is: a paragraph added at the top
 * moves everything under it, and a position would hand the state to its neighbour. The price is
 * that an element whose own text is edited is a new one and starts over, which is right, because
 * it is something else to read.
 *
 * A task-list checkbox is one more entry here when there is one: name it by its item's text.
 */
const kept = [
  {
    name: 'details',
    selector: 'details',
    // A "before" is named by its change, whose key is already content-addressed (and is the
    // one a check-off uses). Any other disclosure is the author's, named by its summary -- or,
    // with none, by how its text begins. `null` is a "before" in no keyed block: nothing to
    // name it by, so it starts closed as it was built.
    key: (el) =>
      el.classList.contains('chg-before')
        ? (el.closest('.chg[data-key]')?.dataset.key ?? null)
        : (el.querySelector(':scope > summary') ?? el).textContent.trim().slice(0, 80),
    read: (el) => el.open,
    write: (el, open) => {
      el.open = open;
    },
  },
];

/**
 * Every element of `#doc` a kind keeps state for, with its name. Two with the same text are told
 * apart by which of them it is in reading order, which is the one place position is used: they
 * are the same to the reader, so no other answer is any better.
 */
function* keptElements(): Generator<[(typeof kept)[number], Element, string]> {
  for (const kind of kept) {
    const seen = new Map();
    for (const el of doc.querySelectorAll(kind.selector)) {
      const base = kind.key(el);
      if (base === null) continue;
      const nth = seen.get(base) ?? 0;
      seen.set(base, nth + 1);
      yield [kind, el, `${kind.name}:${base}#${nth}`];
    }
  }
}

/** The state to carry over, read before the nodes it is on go. */
const readKept = () =>
  new Map([...keptElements()].map(([kind, el, name]) => [name, kind.read(el)]));

/** Put back what `readKept` took, onto whichever of the new nodes are the same elements. */
function writeKept(saved) {
  for (const [kind, el, name] of keptElements()) {
    if (saved.has(name)) kind.write(el, saved.get(name));
  }
}

/**
 * `reuse` is for a reload of the document already on screen. If it comes out as the same markup
 * -- the history arriving, another window marking a version read -- there is nothing for the
 * article to say, and rebuilding it would throw away what the reader has done to it: a "before"
 * opened, a selection, the marks of a find. Everything drawn around it is still redrawn.
 * Left off for anything that changes how the same markup is *drawn* (the theme, a diagram's
 * colours), which has to rebuild.
 */
export function paint({ reuse = false } = {}) {
  const d = state.data;
  if (!d) return;

  // A document that names itself in its header gets called that. `SKILL.md`,
  // `README.md`, `CLAUDE.md` -- the filename is the convention the tool reading
  // the file insists on, not what the document is, and three windows of them
  // are three windows with the same title. The file's name is not lost: it
  // moves into the path underneath, which is set rtl, so the name is the part
  // that stays visible when there is not room for all of it.
  //
  // Only when there is a title to show, or the bar would say the filename twice.
  document.title = d.title || d.name;
  barName.value = {
    name: d.title || d.name,
    dir: d.title ? d.pathLabel : d.dirLabel,
    path: d.path,
  };

  const raw = state.view === 'raw';
  const source = raw ? d.rawHtml : d.html;
  const stay = reuse && painted.id === state.docId && painted.source === source;
  if (!stay) {
    // The link that was under the pointer is about to stop existing, and a node
    // that is gone never reports the pointer leaving it.
    hidePeek();
    forgetHover();
    // Read before the nodes go, and only for this document: what was done to the one on screen
    // was done to that text, and another file's elements are not these however they are named.
    const saved = painted.id === state.docId ? readKept() : null;
    // The document's own HTML is let through by the renderer, so this is where
    // what would run in it is taken out -- see src/page/sanitize.ts.
    doc.innerHTML = sanitizeDocument(source);
    painted = { id: state.docId, source };
    // Put back before anything is measured or drawn: a Mermaid block inside a "before" is drawn
    // only once it is open, and the scroll the caller restores is of the height it had.
    if (saved?.size) writeKept(saved);
  }
  doc.classList.toggle('raw-view', raw);

  applyMarks();
  applyAcks();
  paintHistory(d);
  paintToc(d);
  paintCount();
  paintRuler();
  state.changeIndex = -1;
  drawDiagrams();
  // The marks just drawn over are gone with the rest of `#doc`'s old markup;
  // a find still open has to be redone against the document now on screen,
  // not scrolled to again -- the repaint is not something the reader asked for.
  // Not when the article stood: its marks are where they were.
  if (!stay && findOpen.value) refind();
}

/**
 * The web app's open files, brought up to date with the document just shown.
 * Every way one arrives comes through `load` -- a pick in the welcome, a drop,
 * a link, a reload, the document a bare visit resumes -- so this is the one
 * place that keeps the list true to what is on screen, and a file it does not
 * have joins it at the end.
 */
function noteOpen() {
  if (!openFiles) return;
  const d = state.data;
  const changed = openFiles.note({
    id: state.docId,
    path: d.path,
    name: d.name,
    dir: d.dirLabel,
    label: d.pathLabel,
  });
  if (!changed) return;
  state.tabs = openFiles.list();
  // As in the desktop app: the column shows itself once there is a second
  // file to choose between, until the toggle has been used either way.
  if (prefs.getItem('redline:side') === null && state.tabs.length > 1) setSide(true, false);
}

// ---------- live reload ----------

// The dot is ui/chrome.ts's to draw, from this.
function setLive(on, why?) {
  liveWhy.value = on ? null : why;
}

// One watch at a time: switching tabs re-points this at the new document, and
// the old one's events would load the wrong file over the top of it.
let unwatch = null;

/** No watch, for the length of a swap or with nothing on screen to follow. */
export function stopWatch() {
  unwatch?.();
  unwatch = null;
}

// Staying connected is the backend's problem — what a dropped watch means, and
// whether one can drop at all, is a thing only it knows. Here there is just
// what each event does to the screen.
export function connect() {
  stopWatch();
  unwatch = backend.watch({
    onLive: setLive,
    onEvent(msg) {
      if (msg.type === 'file') {
        // A different document was opened (File > Open, drag and drop).
        state.baseline = keptBaseline();
        return load({ keepScroll: false });
      }
      // Earlier versions arrived — the file's commits, read in the background
      // after it opened. Nothing on screen changes, only the list of them.
      if (msg.type === 'history') return load({ keepScroll: true });
      if (msg.type === 'change') return load({ keepScroll: true });
    },
  });
}

