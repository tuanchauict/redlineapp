// ---------- keys ----------

// The page's own keys: the letters that drive the reader, the ones that scroll the pane from
// wherever focus is, and the ⌘ shortcuts a browser tab has to catch itself because it has no
// menu to send them. What each key does is main.ts's, handed in to `bindKeys`.

import { prefsOpen, state } from '../state.js';
import { pane } from '../dom.js';
import { native } from './native.js';

/**
 * The document pane is the scroll area rather than the page, so the keys that
 * scroll have to be aimed at it: whatever holds focus — a toolbar button, the
 * body — is not inside it, and the browser scrolls the page instead of it.
 * Returns whether the key was one of them.
 */
function scrollByKey(e) {
  const page = pane.clientHeight * 0.9;
  const step =
    { ArrowDown: 64, ArrowUp: -64, PageDown: page, PageUp: -page }[e.key] ??
    // Space pages down, shift-space up — unless a button has focus, where the
    // space bar belongs to the button.
    (e.key === ' ' && e.target === document.body ? (e.shiftKey ? -page : page) : null);

  if (step != null) {
    pane.scrollBy({ top: step, behavior: Math.abs(step) > 100 ? 'smooth' : 'instant' });
    return true;
  }
  if (e.key === 'Home' || e.key === 'End') {
    pane.scrollTo({ top: e.key === 'Home' ? 0 : pane.scrollHeight, behavior: 'smooth' });
    return true;
  }
  return false;
}

export function bindKeys({
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
}) {
  document.addEventListener('keydown', (e) => {
    // Settings is modal: the letters belong to it while it is up.
    if (prefsOpen.value !== null) return;
    if (
      e.metaKey || e.ctrlKey || e.altKey ||
      /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as Element).tagName)
    ) return;
    if (scrollByKey(e)) return e.preventDefault();
    const key = e.key.toLowerCase();
    if (key === 'r') toggleView();
    else if (key === 'd') toggleDiff();
    else if (key === 'v') toggleSolo();
    else if (key === 'n' || key === 'j') goToChange(1);
    else if (key === 'p' || key === 'k') goToChange(-1);
    else if (key === 'm') tapMarkRead();
    // Next to n and p on purpose: working through a set of edits is n, c, n, c.
    else if (key === 'c') e.shiftKey ? clearAcks() : tapCheck();
    else return;
    e.preventDefault();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openPrefs();
    }
    // ⌘B and ⌥⌘B come from the View menu in the desktop app; here they have to
    // be caught. By `code` rather than by `key`: ⌥B on a Mac keyboard arrives as
    // `∫`, so the letter is no use for the one with Option in it.
    if (!native && e.code === 'KeyB' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.altKey) setTocSide(!state.tocSide);
      else if (leftColumn) setSide(!state.side);
    }
    // ⌘F comes from the Edit menu in the desktop app; in a browser tab it would
    // otherwise open the browser's own find, which cannot see into `#doc` the
    // way this one needs to for the diff marks and the rendered/raw split.
    if (!native && e.code === 'KeyF' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openFind();
    }
    // ⌘O is the web app's alone: a window has File ▸ Open…, and a CLI tab is handed its file.
    // It is the file picker, as Open file… is, from the welcome too. Caught even with Settings
    // up, because the browser's own would open the file as a page of its own, outside Redline.
    if (welcome && e.code === 'KeyO' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (prefsOpen.value === null) pickFile();
    }
  });
}
