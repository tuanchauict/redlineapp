import { state } from './state.js';
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
import { linkTarget, HAS_SCHEME } from './vm/peek.js';
import { openFind } from './vm/find.js';
import { changeNodes, hoverMarks, goToNode, goToChange } from './vm/changes.js';
import { clearAcks, tapCheck } from './vm/acks.js';
import { scrollToNode } from './vm/contents.js';
import { leftColumn, setSide, setTocSide, toggleTabMenu, closeTabMenu } from './vm/sidebars.js';
import {
  settings,
  keptBaseline,
  chooseBaseline,
  writeSettings,
  stepSize,
  openPrefs,
  initSettings,
} from './vm/settings.js';
import { toggleDiff, toggleView } from './vm/view.js';
import { checkUpdate, getUpdate } from './vm/about.js';
import {
  bindWelcome,
  welcome,
  welcomeEl,
  pendingLink,
  setPendingLink,
  welcomeAsks,
  showWelcome,
  backToDocument,
} from './vm/welcome.js';
import {
  pickVersion,
  setSolo,
  toggleSolo,
  tapMarkRead,
  openVerMenu,
  closeVerMenu,
  prune,
} from './vm/history.js';
import { openFiles, setDocId, load, closeDocument, connect, stopWatch } from './vm/core.js';

/** Where each document was left, so switching back does not lose the place. */
const scrollMemory = new Map();

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
  stopWatch();
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
