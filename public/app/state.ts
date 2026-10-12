// What the page knows, in one place, and what it has to remember.
//
// `state` is read and written as a plain object — `state.diff = false` — the way the page has
// always used it, but every field is a signal underneath. A component that reads one in its
// render is re-rendered when it changes, and nothing has to call it; code that is not a
// component sees no difference. That is what lets the page become components a panel at a time
// without rewriting the 3k lines that read and write these fields.
//
// A field is a signal of its value, not of what is inside it: `state.acked.add(key)` mutates a
// Set the signal still holds, and tells no one. Assign a new one where a component has to see
// it. Nothing here imports the rest of the page, so every module can import this.
import { signal } from '@preact/signals';

// Where preferences live. A host that has no usable localStorage (a VS Code webview's is
// per-panel and not kept) fills this in synchronously from host.js; the head script in
// index.html does the same, so the two have to read the same store.
export const prefs = globalThis.__REDLINE_PREFS ?? localStorage;

const initial = {
  // Which of the server's open documents this page is showing. One server
  // backs every window, so every request has to say which document it means;
  // a lone browser tab can leave it empty and get the only one.
  docId: new URLSearchParams(location.search).get('id') || '',
  view: prefs.getItem('redline:view') || 'rendered',
  // Show the change marks, or just read the document. Hiding them is a page
  // concern only: the baseline keeps tracking, so turning them back on costs
  // no round trip and nothing is forgotten in between.
  diff: prefs.getItem('redline:diff') !== '0',
  // Read the chosen version by itself rather than the file marked against it.
  // A mode rather than a click, so stepping down the history reads each row in
  // turn until it is switched off. Not remembered across a restart, on purpose:
  // a window that opened on last week's text with no marks would look exactly
  // like the file as it is now.
  solo: false,
  baseline: 'read',
  data: null,
  // What the reader behind this page can do — `{ git, plantuml }` — as the last payload said.
  // Null until one has come, which is also the answer on the welcome, where nothing is open.
  caps: null,
  changeIndex: -1,
  // The changes ticked off in this document, by the server's name for each.
  // Kept per document rather than per page, so closing the tab does not undo an
  // afternoon of reading through a long set of edits.
  acked: new Set(),
  // The contents rows and the headings they stand for, paired up at paint time:
  // the scroll spy runs on every frame the document moves and cannot be asking
  // the sidebar what is in it each time.
  toc: [],
  tocAt: -1,
  // The open files: a native window's tabs, as the shell pushes them, or the
  // web app's, as it keeps them itself (`openFiles`). A CLI tab has none.
  tabs: [],
  // Whether each sidebar is showing — the files down the left, the contents and
  // versions down the right. Read back from the classes the inline script set
  // before first paint, so neither flashes.
  side: document.documentElement.classList.contains('side-open'),
  tocSide: document.documentElement.classList.contains('toc-open'),
  // The version whose "forget everything older" is waiting to be confirmed.
  // Deleting is the one thing in the sidebar that cannot be undone, so it asks
  // in the row itself rather than throwing a dialog over the window.
  pruneAsk: null,
};

type State = typeof initial;

export const state = {} as State;
for (const key of Object.keys(initial) as (keyof State)[]) {
  const value = signal(initial[key]);
  Object.defineProperty(state, key, {
    enumerable: true,
    get: () => value.value,
    set: (v) => {
      value.value = v;
    },
  });
}

// The History list's own state, which nothing outside the sidebar reads.

/**
 * The payload History lists, as `paintHistory` was last handed it — not `state.data`, which
 * outlives what is on screen: the welcome put up over a document leaves the document loaded
 * and the sidebars emptied. Null is the empty list of a page with no document.
 */
export const shownHistory = signal(null);

/**
 * The version whose row menu is open, by hash. Its row stays lit (`held`) while the pointer is
 * on the menu, and its "…" says it is expanded.
 */
export const menuFor = signal<string | null>(null);

/**
 * The version a Forget is being pointed at from, by hash: the menu's Forget item, or Clear
 * history under the list. That row and every row below it go grey, off `.ver.cutting ~ .ver`.
 */
export const cutFrom = signal<string | null>(null);
