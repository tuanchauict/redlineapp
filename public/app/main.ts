import { createMarkdown, renderDocument, titleOf } from '../vendor/render.js';
import { sanitizeDocument } from '../vendor/sanitize.js';
import {
  prefs,
  state,
  barName,
  tabMenuAt,
  liveWhy,
  shut,
  prefsOpen,
  update,
  welcomeView,
} from './state.js';
import { mountHistory } from './ui/History.js';
import { mountContents } from './ui/Contents.js';
import { mountRuler } from './ui/Ruler.js';
import { mountFiles } from './ui/Files.js';
import { mountTabMenu } from './ui/TabMenu.js';
import { mountName } from './ui/Name.js';
import { mountChanges } from './ui/Changes.js';
import { bindChrome } from './ui/chrome.js';
import { mountWelcome } from './ui/Welcome.js';
import { mountSettings } from './ui/Settings.js';
import { $, doc, pane } from './dom.js';
import { applyWidths } from './layout/widths.js';
import './layout/toc-height.js';
import { bindKeys } from './layout/keys.js';
import { native, firstTabShown, bindNative } from './layout/native.js';
import { listFonts } from './layout/fonts.js';
import { backend } from './backend.js';
import { notify } from './vm/notice.js';
import { hidePeek, linkTarget, HAS_SCHEME } from './vm/peek.js';
import { drawDiagrams } from './vm/diagrams.js';
import { findOpen, refind, openFind } from './vm/find.js';
import {
  changeNodes,
  paintCount,
  paintRuler,
  hoverMarks,
  forgetHover,
  goToNode,
  goToChange,
} from './vm/changes.js';
import { applyAcks, clearAcks, tapCheck } from './vm/acks.js';
import { paintToc, spyToc, scrollToNode } from './vm/contents.js';
import { bindDocument } from './vm/document.js';
import {
  settings,
  defaultBaseline,
  keptBaseline,
  writeSettings,
  stepSize,
  openPrefs,
  initSettings,
} from './vm/settings.js';
import { applyMarks, toggleDiff, toggleView } from './vm/view.js';
import {
  paintHistory,
  pickVersion,
  setSolo,
  toggleSolo,
  tapMarkRead,
  openVerMenu,
  closeVerMenu,
  prune,
} from './vm/history.js';

// The document core is still here, and the viewmodels that redraw it reach it through
// vm/document.ts. Bound first, before anything that could call it can run: every one of these
// is a function declaration, so it is already defined.
bindDocument({ load, adopt, paint, rerender });

/** Where each document was left, so switching back does not lose the place. */
const scrollMemory = new Map();

// ---------- fetching & rendering ----------

// A browser tab has no shell to keep its open files, so the web app keeps them itself, and the
// left column lists them as the desktop app lists its tabs. A CLI tab is handed one file and
// has no list at all.
const openFiles = backend.openFiles ?? null;
if (openFiles) state.tabs = openFiles.list();

/** Keep the id in the address too, so a reload comes back to this document. */
function setDocId(id) {
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

// ---------- the welcome ----------

// What the page shows when it has nothing to read. Only a backend that has to be given
// something has one -- the web app's -- so a window shown a document by a shell, or a server told
// one on a command line, never reaches any of this and nothing here has to ask which it is.
// The backend has the doors and ui/Welcome.tsx draws them, with this in between: what the
// welcome says goes from one to the other by `welcomeView`.
const welcomeEl = $('welcome');
const welcome = backend.welcome?.({
  open: (path) => openFile(path),
  granted: () => reopened(),
  show: (view) => (welcomeView.value = view),
  showing: () => !welcomeEl.hidden,
  // What it has to say while it is hidden (a folder, a file that is not markdown, one that would
  // not open) goes where the user is looking instead of onto a screen they have not been taken to.
  notify: (text) => notify(text),
});
// The browser's file picker, or the input that stands in for one: Open file…, and the page's own
// ways to it with a document on screen.
const pickFile = welcome ? mountWelcome(welcomeEl, welcome, () => backToDocument()) : null;

// The file the user went to when it turned out to need asking for again: asked for, it is the
// thing they wanted, and the document they were reading is not.
let pendingLink = null;
// What the welcome is showing now, as `showWelcome` was last told, so that being told the same
// again -- a load, the watch and the backend's listener each report one lapsed grant -- does not
// wipe a message the user is looking at.
let welcomeSeen = null;
// The file it is offering to ask for again, if it is. A load that is refused after the
// backend's listener has already said which file says only *that* it was, and must not
// replace the name with a guess.
let welcomeAsks = null;

function showWelcome({ reopen = null } = {}) {
  if (!welcome) return;
  // A document that is still held is one the user can go back to; one that is gone is not.
  const back = Boolean(state.data);
  const seen = `${reopen}|${back}`;
  document.documentElement.classList.add('welcoming');
  welcomeEl.hidden = false;
  doc.hidden = true;
  if (seen === welcomeSeen) return;
  welcomeSeen = seen;
  welcomeAsks = reopen;
  welcome.sync({ reopen, back });
  if (!back) {
    document.title = 'Redline';
    barName.value = { name: 'Redline', dir: '', path: '' };
  }
}

function hideWelcome() {
  if (!welcome) return;
  welcomeSeen = null;
  welcomeAsks = null;
  document.documentElement.classList.remove('welcoming');
  welcomeEl.hidden = true;
  doc.hidden = false;
}

/** Back to the document the welcome was put up over. Whether there was one to go back to. */
function backToDocument() {
  if (welcomeEl.hidden || !state.data) return false;
  pendingLink = null;
  hideWelcome();
  return true;
}

if (welcome) {
  // The way to another file with one on screen, as ⌘O is: straight to the browser's file picker,
  // and not the welcome over the document. What is picked joins the open files, and the one being
  // read stays a click away in them.
  $('newTab').title = 'Open a file (⌘O)';
  $('newTab').addEventListener('click', () => pickFile());
  // A step away from the document, and Escape is the step back. Not while Settings is up: the
  // Escape is the dialog's, and closes it alone.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && prefsOpen.value === null) backToDocument();
  });
}

// The backend says which file; the load that hit the lapse says only that it did.
backend.onNeedsPermission?.(({ name }) => showWelcome({ reopen: name }));

/**
 * The user said yes to the file. What they were doing when it was refused is what to do now:
 * the link they clicked if it was a link, otherwise the document the page was loading or
 * watching.
 */
async function reopened() {
  const link = pendingLink;
  pendingLink = null;
  if (link && (await openFile(link))) return;
  if (await load({ keepScroll: false })) connect();
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
function adopt(data) {
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
async function load({ keepScroll = true } = {}) {
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
function closeDocument({ reopen = null } = {}) {
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
  unwatch?.();
  unwatch = null;
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
function rerender() {
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
function paint({ reuse = false } = {}) {
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

/** What a row does. The desktop app's tabs are the shell's to switch and close. */
function selectTab(id) {
  if (native) native.selectTab(id);
  else switchTo(id);
}

function closeTab(id) {
  if (native) native.closeTab(id);
  else closeOpen(id);
}

// The rows are drawn wherever the list is, the column open or shut, so opening it has nothing to
// fill in: the list is already the files open.
mountFiles($('fileList'), { select: selectTab, close: closeTab });

/**
 * Whether there is a left column at all. Both apps fill it with the files
 * open; a CLI tab is handed one file and has no list, so there its button is
 * gone (styles.css) and ⌘B does nothing, rather than open an empty strip. The
 * head script asks the same question before first paint.
 */
const leftColumn = document.documentElement.matches('.native, .web');

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

/**
 * Go to another of the web app's open files: the file it was opened by, the
 * place in each kept as switching tabs keeps it. The one on screen is already
 * there, unless the welcome is over it. Answers whether it is on screen now.
 */
async function switchTo(id) {
  const t = state.tabs.find((o) => o.id === id);
  if (!t) return false;
  if (id === state.docId && state.data) {
    backToDocument();
    return true;
  }
  // Not with the welcome over it: the pane is scrolled through the welcome then.
  if (state.data && welcomeEl.hidden) scrollMemory.set(state.docId, pane.scrollTop);
  if (!(await openFile(t.path, { unopened: `Could not open ${t.name}.` }))) return false;
  pane.scrollTo(0, scrollMemory.get(id) ?? 0);
  // Picking a row leaves focus on it, or on a menu that has just shut, and
  // either way the arrow keys would stop scrolling the document.
  const held = document.activeElement;
  if (held === document.body || held?.closest('.side, .menu')) {
    pane.focus({ preventScroll: true });
  }
  return true;
}

/**
 * Close one of the web app's open files. One behind the document just leaves
 * the list; the one on screen gives way to its neighbour, as closing a tab
 * does, and the last of them leaves the welcome with nothing behind it.
 */
async function closeOpen(id) {
  const next = openFiles.close(id);
  state.tabs = openFiles.list();
  if (id !== state.docId) return;
  if (next && (await switchTo(next.id))) return;
  // A neighbour that would not open leaves the welcome too, not the file just
  // closed on screen with no row of its own -- still asking for the
  // neighbour if that is why (the path `openFile` keeps for it), so that
  // granting it opens the file.
  closeDocument({ reopen: pendingLink ? welcomeAsks : null });
}

/** Remembered, because it is the kind of thing you set once and keep. */
function setSide(on, remember = true) {
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
function setTocSide(on, remember = true) {
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

// The sidebar widths and the contents height are layout/widths.ts and layout/toc-height.ts,
// which wire their grips as they load.

// ---------- sidebar disclosures ----------

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
function toggleTabMenu(left) {
  if (tabMenuAt.value !== null) return closeTabMenu();
  closeVerMenu();
  tabMenuAt.value = left;
}

function closeTabMenu() {
  tabMenuAt.value = null;
}

mountTabMenu($('tabMenuSlot'), $('tabListSlot'), {
  toggle: toggleTabMenu,
  select(id) {
    closeTabMenu();
    selectTab(id);
  },
});
document.addEventListener('click', () => closeTabMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeTabMenu());

// ---------- contents ----------

// vm/contents.ts, which follows the scroll and takes the document's own links to its headings.
mountContents($('tocList'), { go: (node) => scrollToNode(node) });

/**
 * A link that leaves the document.
 *
 * Neither shell can let the browser have this one. A relative link is written
 * against the directory the file is filed in — `./api.md`, `../adr/0004.md` —
 * and that is not where either shell is serving from: a browser tab is a
 * loopback port that answers `./api.md` with 404, and the desktop app is a
 * webview with no address to resolve against and no Back to return from. Both
 * do know which directory the document came out of, which is the only fact
 * the link was ever missing.
 *
 * Where it goes once resolved is the one real difference between the two. The
 * app has windows, so a referenced file gets one of its own and the document
 * you came from stays open behind it. A tab has no windows to give, so it goes
 * where a link goes in a browser: in place, with the address updated, so
 * Reload comes back to what is on screen. The web app's tab adds it to the
 * files it has open, so the one you came from is still a click away.
 */
doc.addEventListener('click', (e) => {
  // Inside #doc the target is always an Element; the `?.` is the JavaScript's own guard, kept
  // so that the conversion changes no behaviour.
  const a = (e.target as Element).closest?.('a[href]');
  const href = a?.getAttribute('href')?.trim();
  if (!href || href.startsWith('#')) return; // in-page jumps are handled above

  // Something with a scheme is the browser's business, and in a window that
  // has no browser it is the real browser's business.
  if (HAS_SCHEME.test(href)) {
    if (!native) return;
    e.preventDefault();
    // Anything else — a scheme this app has no business following.
    if (/^(https?:|mailto:)/i.test(href)) native.openExternal(href);
    return;
  }

  // Held either way, even when nothing comes of it: a relative link to an
  // image, a directory, or a file this reader does not open would otherwise
  // navigate the page off the document, and going nowhere beats going wrong.
  e.preventDefault();
  const abs = linkTarget(href);
  if (!abs) return;
  if (native) native.openPaths([abs]);
  else followLink(abs);
});

/**
 * A link out of the document, in a browser tab. Where the reader can say that it will not open
 * -- a file given on its own has nothing around it to resolve the link against -- the user is
 * told, because the alternative is a click that does nothing and gives no reason.
 */
async function followLink(abs) {
  const why = await backend.linkNote?.(state.data?.path);
  if (why) notify(why);
  else openFile(abs);
}

// ---------- history ----------

// The list is ui/History.tsx, and what it does is vm/history.ts. It is mounted here, because a
// viewmodel does not import the components that draw it.

/**
 * The two sidebars for a page with no document. The welcome hides `#doc`, but Contents and
 * History are not inside it: left alone they go on listing the headings and versions of a file
 * the reader has let go of, and a row clicked would scroll to a node that is no longer there.
 * Painting them with null resets the counts and empties both lists, which draw nothing for
 * null: "No headings in this document" would be a claim about one.
 */
function clearSidebars() {
  paintToc(null);
  paintHistory(null);
}

mountHistory($('histList'), {
  pick: pickVersion,
  menu: openVerMenu,
  closeMenu: () => closeVerMenu(),
  prune,
});

// ---------- changes ----------

// The count, `n`/`p`, the ruler and check-offs are vm/changes.ts and vm/acks.ts. The ruler's
// marks are mounted here, because a viewmodel does not import the components that draw it.
mountRuler($('ruler'), {
  go: (node) => {
    state.changeIndex = changeNodes().indexOf(node);
    goToNode(node);
  },
  hover: hoverMarks,
});

// ---------- events ----------

mountChanges($('changesSlot'), {
  unsolo: () => setSolo(false),
  go: goToChange,
  unack: () => clearAcks(),
});

// Both columns and their keys work in the web app as much as in the desktop
// app, each filling the left one with a list of its own; a CLI tab has only
// the right one (see `leftColumn`).
$('side').addEventListener('click', () => setSide(!state.side));
$('tocBtn').addEventListener('click', () => setTocSide(!state.tocSide));

// The buttons keep to the signals from here on (ui/chrome.ts), already showing what the inline
// script and the prefs say.
bindChrome();
mountName($('nameSlot'));

// Run once with `remember` off, to set the widths from the classes the
// inline script put on the root before first paint. Nothing is
// being chosen here, so nothing is written back.
setSide(state.side, false);
setTocSide(state.tocSide, false);

// The view and the marks are vm/view.ts; the bar's button for the view is wired there.

// The letters, the scrolling and the ⌘ shortcuts: layout/keys.ts.
bindKeys({
  toggleView,
  toggleDiff,
  toggleSolo,
  goToChange,
  tapMarkRead,
  clearAcks,
  tapCheck,
  openPrefs,
  openFind,
  setSide,
  setTocSide,
  leftColumn,
  welcome,
  pickFile,
});

// ---------- native shell ----------

// layout/native.ts, bound here because this is where the block used to run: after the handlers
// it hands on exist, and before the settings and the first load are awaited below.
bindNative({
  toggleView,
  toggleDiff,
  goToChange,
  tapMarkRead,
  openFind,
  setSide,
  setTocSide,
  setDocId,
  connect,
  keptBaseline,
  load,
  scrollMemory,
});

// ---------- settings ----------

// vm/settings.ts, and the sheet ui/Settings.tsx, mounted below with the update check it shares.

// ---------- about, and updates ----------

// What this copy is, and whether there is a newer one. Only ever on request —
// the button here or Check for Updates… in the app menu — because it is the
// one time the app reaches off the machine, and that should be something
// somebody chose. A browser tab has neither: run from a checkout, upgrading
// is `git pull`, and the section is `data-shell`.

/** Homebrew's own word for it: replacing a cask's app any other way leaves
 *  the cask believing the old version is still installed. */
const BREW_UPGRADE = 'brew upgrade --cask redline';

/** Where Download goes, when the button is a download; empty when it copies. */
let updateUrl = '';

async function checkUpdate() {
  updateUrl = '';
  update.value = { note: 'Checking…', checking: true };
  try {
    const u = await native.checkUpdate();
    if (!u.newer) {
      update.value = { note: `${u.current} is the newest version` };
    } else if (u.brew) {
      update.value = {
        note: `${u.latest} is out — installed with Homebrew, so upgrade there`,
        cmd: BREW_UPGRADE,
        go: 'Copy',
      };
    } else {
      updateUrl = u.url;
      // The file, so the button says what it fetches before it is pressed.
      update.value = {
        note: `${u.latest} is out`,
        cmd: u.url.split('/').pop(),
        go: u.url ? 'Download' : null,
      };
    }
  } catch {
    update.value = { note: 'Could not reach the update server — try again later' };
  }
}

mountSettings($('prefsSlot'), native?.version ?? '', {
  write: writeSettings,
  step: stepSize,
  baseline: (v) => {
    writeSettings({ baseline: v });
    // It says what to compare against from now on, and "now" includes the
    // document in front of you — otherwise the setting looks like it did nothing.
    state.baseline = defaultBaseline();
    load({ keepScroll: true });
  },
  reveal: () => native?.revealStore(),
  check: checkUpdate,
  go: (cmd) => {
    if (updateUrl) {
      native.openExternal(updateUrl);
      return;
    }
    // A clipboard refused is not worth a message: the command is on screen
    // and selectable, so select it and let ⌘C do the rest.
    navigator.clipboard.writeText(BREW_UPGRADE).catch(() => {
      getSelection().selectAllChildren(cmd);
    });
  },
});

// The menu sends this in the desktop app; the sheet scrolls to About itself,
// once it is up.
if (native) {
  native.onCheckUpdate(() => {
    prefsOpen.value = 'aboutSec';
    checkUpdate();
  });
}

// ---------- live reload ----------

// The dot is ui/chrome.ts's to draw, from this.
function setLive(on, why?) {
  liveWhy.value = on ? null : why;
}

// One watch at a time: switching tabs re-points this at the new document, and
// the old one's events would load the wrong file over the top of it.
let unwatch = null;

// Staying connected is the backend's problem — what a dropped watch means, and
// whether one can drop at all, is a thing only it knows. Here there is just
// what each event does to the screen.
function connect() {
  unwatch?.();
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

/**
 * Show a different file in this tab, following a link out of the document.
 *
 * The watch is closed first and reopened after, rather than left running. The
 * reader announces the switch from inside the request that caused it, before
 * that request has answered — so a stream still listening would hear "file",
 * ask for the document by the id this page is still holding, and be told that
 * one has closed. Standing the watch down for the length of the swap costs a
 * moment of not following a file that is about to be replaced anyway.
 *
 * A path that will not open throws before anything is released, so the old
 * document is still there: reconnecting in `finally` leaves the page exactly
 * as it was, reading what it was reading. `unopened` is what to tell the user
 * when it does not: a link that goes nowhere is the document being out of
 * date, but a file picked from the open files is one they asked for by name.
 */
async function openFile(path, { unopened = null } = {}) {
  pendingLink = null;
  unwatch?.();
  unwatch = null;
  try {
    const { id } = await backend.open(path);
    setDocId(id);
    // Whatever the file we came from was compared against says nothing about
    // this one, which has a comparison of its own to be put back on.
    state.baseline = keptBaseline();
    return await load({ keepScroll: false });
  } catch (err) {
    if (err?.name === 'NeedsPermission') {
      // The backend has told the welcome, which is asking for that file. Opening it once it is
      // granted is ours to remember.
      pendingLink = path;
    } else {
      // A link to a file that is not there is the document being out of date,
      // not the reader breaking. Staying put is the answer, and the console is
      // where the reason goes.
      console.error('could not open', path, err);
      if (unopened) notify(unopened);
    }
    return false;
  } finally {
    // With no document there is nothing to watch: the welcome is up and a pick will connect.
    if (state.data) connect();
  }
}

// Before the first load: the text size, the width and the marks all have to be
// right on the first paint, and the baseline decides what that paint shows.
await initSettings();
// Started now rather than when the sheet opens: asking the OS costs a third
// of a second, and a popup that fills in after you have looked at it is a
// popup you saw the wrong answer in. Nothing waits on it.
listFonts(backend, () => settings);
if (native) {
  // Which document that is comes from `onTabs`'s first event instead -- see
  // `firstTabShown` above.
  await firstTabShown;
} else {
  // The web app's list is there before its document: a file that has to be
  // asked for again holds the load up, and the other files need not wait on it.
  if (!state.docId && openFiles?.closedAll()) {
    // Every file this tab had was closed, and a bare address would be handed the
    // document a tab last showed -- the one just closed, back as if it had not been.
    showWelcome();
  } else if (await load({ keepScroll: false })) {
    connect();
  }
}
// There is a document on screen, so the window can be shown. It was built
// hidden: a window that appears empty and fills in a moment later reads as a
// slow app even when it is not.
native?.ready();
// So the arrow keys and the space bar scroll the document straight away,
// without a click in it first — but never stealing a control's focus.
if (document.activeElement === document.body) pane.focus({ preventScroll: true });
