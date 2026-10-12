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
import type { Heading } from '../../src/core/render.js';
import type { WelcomeView } from '../../src/hosts/web/welcome.js';

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
  // The headings and the nodes they stand for, paired up at paint time: the
  // scroll spy runs on every frame the document moves and cannot be asking the
  // document where they are each time. Null when there is no list to draw — the
  // column shut, or no document — and empty for a document with nothing to list.
  toc: null as { h: Heading; node: Element | null }[] | null,
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

// The bar's own state: what main.ts knows about the document and the window, left here for the
// components on the bar to draw. Each is written in one place, named on each.

/**
 * The name on the bar and the path that hovering it brings forward, `ltrPath`'d by the bar
 * rather than here. "…" until a document or the welcome says otherwise, which is what the bar
 * said before there was a page to ask. Written by `paint` and `showWelcome`.
 */
export const barName = signal({ name: '…', dir: '', path: '' });

/** The name of the version being read by itself, or null while the page compares. `paintSolo`. */
export const soloName = signal<string | null>(null);

/**
 * The chevron's menu, open: where the chevron's left edge was when it was pressed, which the
 * list is put under. Null while it is shut.
 */
export const tabMenuAt = signal<number | null>(null);

/** Why the watch on the file dropped, or null while it is up. `setLive`. */
export const liveWhy = signal<string | null>(null);

/**
 * The sidebar sections folded away, by their `data-shut`. Read back from the classes the inline
 * script set before first paint, like `side` and `tocSide`; `redline:shut` remembers it.
 */
export const shut = signal(
  ['files', 'toc', 'hist'].filter((k) => document.documentElement.classList.contains(`shut-${k}`)),
);

// The Settings sheet's own state. main.ts keeps the settings themselves -- it is what applies
// them to the window, stores them and hears them changed in another window -- and leaves here
// what the sheet shows of them. ui/Settings.tsx draws it.

/** What a setting can be. `DEFAULT_SETTINGS` in main.ts says what each one starts as. */
export interface Settings {
  appearance: string;
  reopenLast: boolean;
  finderOpensIn: string;
  font: string;
  fontName: string;
  textSize: number;
  width: string;
  marks: boolean;
  baseline: string;
}

/** The settings as `applySettings` last applied them. */
export const shownSettings = signal<Settings | null>(null);

/**
 * How wide a line of the document is, as `--doc-width` reads after `applySettings` set a width.
 * Measured, so that what the sheet says a width is can never drift from what the document is.
 */
export const docMeasure = signal('');

/**
 * The typefaces on offer beyond the three built in, as `listFonts` found them: groups of names,
 * labelled. Empty until it has looked, which takes a third of a second on a Mac.
 */
export const fontGroups = signal<[string, string[]][]>([]);

/**
 * Whether the sheet is up. Null while it is shut; otherwise the id of a section to bring into
 * view, or '' for none. The sheet clears the id once it has scrolled, so asking twice scrolls
 * twice.
 */
export const prefsOpen = signal<string | null>(null);

/** Where the versions are kept on disk, which the desktop app says once it is asked. */
export const storeRoot = signal('');

/**
 * The last check for a newer copy, as `checkUpdate` left it: what to say, whether it is still
 * asking, and, when there is something to do about it, the command or file and the button's word
 * for doing it. Null until somebody asks.
 */
export const update = signal<{
  note: string;
  checking?: boolean;
  cmd?: string;
  go?: 'Copy' | 'Download' | null;
} | null>(null);

/**
 * What the web app's welcome says, as its backend last handed it over: whether there is a picker,
 * what the last attempt came to, and whether to ask again or offer the way back. Null in every
 * other host, which has no welcome. ui/Welcome.tsx draws it.
 */
export const welcomeView = signal<WelcomeView | null>(null);
