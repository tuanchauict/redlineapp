// Files: which one this page is showing, and the ways to another -- a row of the open files, a
// link out of the document, the file the welcome was asked for. vm/core.ts loads and draws a
// document; this is what decides which.
//
// The welcome's doors that open a file are handed to it from here (`bindWelcome`), because the
// welcome is drawn by vm/core.ts and an import back from it would be a loop.
import { state } from '../state.js';
import { doc, pane } from '../dom.js';
import { backend } from '../backend.js';
import { native } from '../layout/native.js';
import { notify } from './notice.js';
import { linkTarget, HAS_SCHEME } from './peek.js';
import { keptBaseline } from './settings.js';
import {
  bindWelcome,
  welcomeEl,
  pendingLink,
  setPendingLink,
  welcomeAsks,
  backToDocument,
} from './welcome.js';
import { openFiles, setDocId, load, closeDocument, connect, stopWatch } from './core.js';

/** Where each document was left, so switching back does not lose the place. */
export const scrollMemory = new Map();

// vm/welcome.ts, handed the two of its doors that open a file, which are this module's.
bindWelcome({ open: (path) => openFile(path), granted: () => reopened() });

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
export function selectTab(id) {
  if (native) native.selectTab(id);
  else switchTo(id);
}

export function closeTab(id) {
  if (native) native.closeTab(id);
  else closeOpen(id);
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
  if (!href || href.startsWith('#')) return; // in-page jumps are vm/contents.ts's

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
export async function openFile(path, { unopened = null } = {}) {
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
