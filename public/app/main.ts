import { createMarkdown, renderDocument, titleOf } from '../vendor/render.js';
import { sanitizeDocument } from '../vendor/sanitize.js';
import {
  prefs,
  state,
  barName,
  liveWhy,
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
import './layout/widths.js';
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
import { paintToc, scrollToNode } from './vm/contents.js';
import {
  leftColumn,
  setSide,
  setTocSide,
  clearSidebars,
  toggleTabMenu,
  closeTabMenu,
} from './vm/sidebars.js';
import { bindDocument } from './vm/document.js';
import {
  settings,
  keptBaseline,
  chooseBaseline,
  writeSettings,
  stepSize,
  openPrefs,
  initSettings,
} from './vm/settings.js';
import { applyMarks, toggleDiff, toggleView } from './vm/view.js';
import { checkUpdate, getUpdate } from './vm/about.js';
import {
  bindWelcome,
  welcome,
  welcomeEl,
  pendingLink,
  setPendingLink,
  welcomeAsks,
  showWelcome,
  hideWelcome,
  backToDocument,
} from './vm/welcome.js';
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

// vm/welcome.ts, handed the two of its doors that open a file, which are this module's.
bindWelcome({ open: (path) => openFile(path), granted: () => reopened() });

// The browser's file picker, or the input that stands in for one: Open file…, and the page's own
// ways to it with a document on screen.
const pickFile = welcome ? mountWelcome(welcomeEl, welcome, () => backToDocument()) : null;

if (welcome) {
  // The way to another file with one on screen, as ⌘O is: straight to the browser's file picker,
  // and not the welcome over the document. What is picked joins the open files, and the one being
  // read stays a click away in them.
  $('newTab').title = 'Open a file (⌘O)';
  $('newTab').addEventListener('click', () => pickFile());
}

/**
 * The user said yes to the file. What they were doing when it was refused is what to do now:
 * the link they clicked if it was a link, otherwise the document the page was loading or
 * watching.
 */
async function reopened() {
  const link = pendingLink;
  setPendingLink(null);
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

// The columns, their disclosures and the chevron's list are vm/sidebars.ts; their widths and the
// contents height are layout/widths.ts and layout/toc-height.ts, which wire their grips as they
// load.
mountTabMenu($('tabMenuSlot'), $('tabListSlot'), {
  toggle: toggleTabMenu,
  select(id) {
    closeTabMenu();
    selectTab(id);
  },
});

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

// vm/settings.ts, and the sheet ui/Settings.tsx, which shares the update check of vm/about.ts.
mountSettings($('prefsSlot'), native?.version ?? '', {
  write: writeSettings,
  step: stepSize,
  baseline: chooseBaseline,
  reveal: () => native?.revealStore(),
  check: checkUpdate,
  go: getUpdate,
});

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
  setPendingLink(null);
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
      setPendingLink(path);
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
