// History: what the list in the right-hand column does -- picking a version to compare against,
// the menu on a row, marking a version read, forgetting some -- and reading one version alone.
//
// ui/History.tsx draws the rows from `shownHistory` and hands each click back here. The heading's
// count, Clear history and the switch for reading alone are markup in index.html, which
// ui/chrome.ts keeps to the same signals, so nothing here has to remember to repaint them. The
// row menu (`#verMenu`) is still drawn by hand: it lights its row and dims what Forget would take
// through `menuFor` and `cutFrom`, never through the row's classes, because Preact owns those.
import { computed } from '@preact/signals';
import { state, shownHistory, menuFor, cutFrom, tabMenuAt } from '../state.js';
import { $, pane } from '../dom.js';
import { backend } from '../backend.js';
import { load, adopt, paint, rerender } from './document.js';
import { setMarks } from './view.js';

// ---------- naming a version ----------

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATE_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A name for a version nobody named.
 *
 * "9 hours ago" cannot be one. It is a different string every time you look at
 * it, so the row you meant to come back to is not called what it was called;
 * and an evening of saves says it four times over, so it does not pick out a
 * row either. A clock time does both: it holds still, and two versions of one
 * file rarely land in the same minute.
 */
function clockName(ts) {
  const then = new Date(ts);
  const now = new Date();
  const days = Math.round((midnight(now) - midnight(then)) / 86400000);
  const at = CLOCK.format(then);
  if (days <= 1) return `${capital(rtf.format(-days || 0, 'day'))} ${at}`;
  if (then.getFullYear() === now.getFullYear()) return `${DATE.format(then)}, ${at}`;
  return `${DATE_YEAR.format(then)}, ${at}`;
}

/**
 * A committed version is better named by its commit than by our hash of its
 * bytes: the subject is what the person who wrote it chose to call it. One that
 * was only ever saved has no such name, so it is called when it was.
 */
export const versionName = (v) => (v.git ? v.git.subject || 'Commit' : clockName(v.ts));

/**
 * Whether this row is what the document is being compared against — which is a
 * version whether it was picked by name or reached through the "last read"
 * pointer, and the list should say so either way.
 *
 * The newest row is the other end of the same question: comparing the file
 * against itself is the plain document, which is the marks put away.
 */
export function isBaseline(d, v) {
  if (v.current) return !state.diff;
  if (!state.diff) return false;
  if (d.baseline === `snap:${v.hash}`) return true;
  if (d.baseline === 'read') return v.baseline;
  // git HEAD has no row of its own, and needs none: the newest version carrying
  // a commit is the newest commit that touched this file, which is exactly what
  // HEAD holds of it. Reached only through the Settings default.
  if (d.baseline === 'git:HEAD') return v.hash === d.history.find((h) => h.git)?.hash;
  return false;
}

// ---------- the list ----------

/** Hand the list a payload to draw, or null for a page with no document. */
export function paintHistory(d) {
  // A row's menu is about a row that is about to be replaced, and possibly
  // with different numbers in it — a save has arrived, or a version has gone.
  closeVerMenu();
  // The list draws itself from this, and the heading keeps to it (ui/chrome.ts), and both again
  // whenever anything else they read changes.
  shownHistory.value = d;
}

/** What a click on a row does: History hands it the version, and this decides what that means. */
export function pickVersion(v) {
  state.pruneAsk = null;
  if (v.current) {
    setMarks(false);
    return;
  }
  // Marks on first: picking a version to compare against and seeing nothing
  // marked would look like the click missed. It also keeps the scroll anchored
  // across the blocks that hiding the marks had collapsed. Reading versions
  // by themselves, it is what says "an older one" rather than the file — but
  // not redrawn yet, or the version being left would flash up before the
  // load below brings the one clicked.
  setMarks(true, { redraw: false });
  // Named outright, which is also how the choice sticks: the reader keeps
  // the baseline it was asked for by name, and hands it back the next time
  // this document is opened. Nothing to store here.
  //
  // The row carrying the read mark is named as `read` rather than by its
  // hash, because that is what the row means: the version counted as read,
  // which moves as you read rather than staying where it is now. It is also
  // the way back — a choice is kept from now on, so naming that row by hash
  // would pin the document to it with nothing in the list to unpin it.
  state.baseline = v.baseline ? 'read' : `snap:${v.hash}`;
  load({ keepScroll: true });
}

// ---------- reading one version alone ----------

/**
 * The older version on the page, while reading versions by themselves — null
 * when what is on the page is the file as it is. The filled row is the one,
 * so this asks the same question the row does rather than a second one that
 * could disagree with it.
 */
function soloVersion(d) {
  if (!state.solo || !state.diff || d?.base == null || d.base === d.text) return null;
  return d.history?.find((v) => !v.current && isBaseline(d, v)) ?? null;
}

/**
 * The name on the bar of the version on the page, or null while the page compares. The bar says
 * it because nothing else would: with no marks and the sidebar shut, last week's text and this
 * morning's look exactly alike. Worked out of what it depends on, so a switch, a load or a page
 * with no document each move it without being told to.
 */
export const soloName = computed(() => {
  const v = soloVersion(state.data);
  return v ? versionName(v) : null;
});

/**
 * On or off. Off, the version that was being read becomes the one compared
 * against — it is already the baseline — so the way out of reading an old
 * version is to see what has happened to it since.
 */
export function setSolo(on) {
  if (on === state.solo) return;
  state.solo = on;
  rerender();
}

export const toggleSolo = () => setSolo(!state.solo);
$('histSolo').addEventListener('click', toggleSolo);

// ---------- the read mark ----------

/**
 * Whether the read mark is already on the version on disk, and so whether
 * there is anything left for `m` to do.
 */
function readDone(d) {
  const at = d?.history?.find((v) => v.baseline);
  return !at || at.current;
}

/**
 * Move the read mark: to `at`, a version in the list, or without it to the
 * version on disk. It is about the stored pointer rather than what is on
 * screen, so it works just as well while looking at an older version or with
 * the marks off.
 *
 * The version on disk is the usual one, and the one with keys — `m`, ⇧⌘M and
 * the View menu — because saying "I have seen this" should not need the
 * sidebar open. Any row can say it from its menu, where an older one means "I
 * have read up to here". That one turns the marks on as well: the point of it
 * is the changes that came after, and with the marks off the click would look
 * like it had missed — the same reason picking a row turns them on.
 */
async function markRead(at?) {
  const y = pane.scrollTop;
  state.pruneAsk = null;
  if (at) setMarks(true, { redraw: false });
  adopt(await backend.markRead(at));
  paint();
  pane.scrollTo(0, y);
}

/**
 * `m` and the menu item, and nothing when the mark is already on the version on
 * disk: pressing it twice should not cost a round trip and a repaint to leave
 * the document exactly as it was.
 */
export function tapMarkRead() {
  if (!readDone(state.data)) markRead();
}

// ---------- the row menu ----------

const el = (tag, className?, text?) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

// The "…" of the row the menu is open for, to put the keyboard back on. Kept rather than
// looked up, because the list can be repainted under an open menu — a save arrives. Which row
// is lit is `menuFor`, by hash, which outlives the node.
const verMenu = { more: null };

/**
 * One menu for every row, filled for the row it is opened on. `n` is how many
 * versions forgetting this one would take.
 *
 * Drawn by the page in every host, the desktop app included. A native menu
 * there would be a round trip through the shell for each item, and could not
 * do the thing this one is for: pointing at Forget greys the rows that would
 * go, the same preview the list has always given, before anything is asked.
 *
 * Under the "…" it was opened from, or at the pointer for a right-click;
 * turned upward or leftward when it would hang off the window. From the
 * keyboard the first item is focused, and from a pointer the menu itself is —
 * so the arrows and Escape work either way, with no focus ring for a click.
 */
export function openVerMenu(row, v, n, { from, keyboard = false, x = 0, y = 0 }) {
  closeVerMenu();
  // The chevron's list, which is one menu too many to have open.
  tabMenuAt.value = null;
  const menu = $('verMenu');

  const read = el('button', null, 'Mark as read');
  read.type = 'button';
  read.role = 'menuitem';
  // The mark is already here. Left in rather than taken out, so the menu has
  // the same shape on every row and the item is where it was last time.
  read.disabled = !!v.baseline;
  read.title = v.current
    ? 'Count the file as it is now as read, which clears the marks (m)'
    : 'Count this version as read: the marks then show what changed since it';
  read.addEventListener('click', () => {
    closeVerMenu();
    markRead(v.current ? undefined : v.hash);
  });
  const items = [read];

  // Never the version on disk: everything else is compared against it.
  if (!v.current) {
    const one = n === 1;
    const forget = el('button', null, one ? 'Forget this version…' : 'Forget this and older…');
    forget.type = 'button';
    forget.role = 'menuitem';
    forget.title = one
      ? 'Forget this version'
      : `Forget these ${n} versions — this one and everything older`;
    // On the row rather than on the list, so the stylesheet can take it from
    // there with `~`: what goes is this row and every row below it, which is
    // exactly what a sibling combinator says.
    const mark = (on) => (cutFrom.value = on ? v.hash : null);
    forget.addEventListener('pointerenter', () => mark(true));
    forget.addEventListener('pointerleave', () => mark(false));
    forget.addEventListener('focus', () => mark(true));
    forget.addEventListener('blur', () => mark(false));
    forget.addEventListener('click', () => {
      closeVerMenu();
      askPrune(v.hash);
    });
    items.push(forget);
  }

  menu.replaceChildren(...items);
  menu.hidden = false;
  verMenu.more = row.querySelector('.ver-more');
  menuFor.value = v.hash;

  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = x;
  let top = y;
  if (from) {
    const r = from.getBoundingClientRect();
    left = r.right - w;
    top = r.bottom + 2;
    if (top + h > innerHeight - 6) top = r.top - 2 - h;
  } else {
    if (left + w > innerWidth - 6) left -= w;
    if (top + h > innerHeight - 6) top -= h;
  }
  menu.style.left = `${Math.max(6, Math.min(left, innerWidth - w - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(top, innerHeight - h - 6))}px`;

  const first = items.find((b) => !b.disabled);
  if (keyboard && first) first.focus();
  else menu.focus({ preventScroll: true });
}

/** `refocus` puts the keyboard back on the "…", for a menu left with Escape. */
export function closeVerMenu({ refocus = false } = {}) {
  const menu = $('verMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  // Taken off here and not only on the item's blur: Escape with the pointer
  // still on Forget leaves the menu without the pointer ever leaving it.
  menuFor.value = null;
  cutFrom.value = null;
  if (refocus && verMenu.more?.isConnected) verMenu.more.focus();
  verMenu.more = null;
}

$('verMenu').addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return closeVerMenu();
  // The menu's keys and no one else's while it has them: an arrow here moves
  // between items rather than scrolling the document, and a letter is not a
  // command to the page behind it — `m` would mark the newest version read.
  e.stopPropagation();
  const items = [...$('verMenu').querySelectorAll<HTMLElement>('button:not(:disabled)')];
  // Safe as a cast because `indexOf` only compares identity: anything else is simply -1.
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : at + step;
    items[(next + items.length) % items.length]?.focus();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    e.preventDefault();
    closeVerMenu({ refocus: true });
  }
});
// A click in the menu that is not on an item — its padding, a disabled one —
// leaves it open, the way a native menu stays up for a click on its edge.
$('verMenu').addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeVerMenu());
document.addEventListener('contextmenu', () => closeVerMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeVerMenu());
// Fixed to the window, so anything that moves the row out from under it
// leaves it pointing at nothing.
$('histList').addEventListener('scroll', () => closeVerMenu());
addEventListener('resize', () => closeVerMenu());
addEventListener('blur', () => closeVerMenu());

// ---------- forgetting ----------

/**
 * Set by `askPrune` and spent by the confirmation it puts up (ui/History.tsx). Not every
 * confirmation that mounts was just asked for: opening the column on one left waiting mounts it
 * too, and that is no reason to take the keyboard from wherever it was.
 */
export const pruneFocus = { asked: false };

/** Turn a row into its own question, and put the keyboard on the answer. */
function askPrune(hash: string) {
  pruneFocus.asked = true;
  state.pruneAsk = hash;
}

export async function prune(upto) {
  const y = pane.scrollTop;
  state.pruneAsk = null;
  // The version being compared against may be one of the ones just forgotten;
  // the payload says what it fell back to.
  adopt(await backend.prune(upto, state.baseline));
  paint();
  pane.scrollTo(0, y);
}

$('histClear').addEventListener('click', () => {
  // "Clear" is the same act as forgetting everything below the current
  // version, so it asks in the same place, on that row.
  const second = state.data?.history?.[1];
  if (second) askPrune(second.hash);
});

// And it previews the same way Forget in a row's menu does, from the row it
// would cut at — everything but the version on disk. A button under the list
// says what it acts on far less plainly than the list going dim does.
// Pairs, not arrays of either: without the cast `when` is `string | boolean` to addEventListener.
for (const [on, when] of [
  [true, 'pointerenter'],
  [false, 'pointerleave'],
  [true, 'focus'],
  [false, 'blur'],
] as [boolean, string][]) {
  $('histClear').addEventListener(when, () => {
    cutFrom.value = on ? (shownHistory.value?.history?.[1]?.hash ?? null) : null;
  });
}
