// Settings: what they are, applying them to the window, storing them, and hearing them changed
// in another window. ui/Settings.tsx draws the sheet from what is left in `shownSettings`.
//
// What is worth a setting: the things you decide once and want kept — how the
// app looks, what it does when it starts, how the document reads, and what
// "changed" is measured against. Everything else stays on the toolbar, where
// it is one click away and belongs to the moment rather than to you.
//
// The desktop app keeps them beside the window state, so every window agrees
// and the shell can act on the ones that are its own (launch, Finder, and the
// window's theme, which is the chrome's and is what System is read from);
// a browser tab keeps its own copy and never shows the rows for launch and
// Finder. Appearance it does show: the page draws the scheme (`applyScheme`).
//
// The marks are a setting too, and the one this module does not apply: they are the view's,
// which writes them here and hears them back from `shownSettings` (see vm/view.ts). Applying
// them from here would be the view and Settings each calling the other.
import { prefs, state, shownSettings, docMeasure, prefsOpen, storeRoot } from '../state.js';
import { $ } from '../dom.js';
import { native } from '../layout/native.js';
import { sepia, retheme } from './diagrams.js';
import { paint } from './document.js';

/** How far the document's own text is allowed to go, in px. */
export const SIZE_MIN = 11;
export const SIZE_MAX = 24;

/** A font name goes into a stylesheet, so keep it to what a name can be. */
export const cleanFontName = (s) =>
  String(s ?? '')
    .replace(/[\p{C}"'\\;{}]/gu, '')
    .trim();

export const DEFAULT_SETTINGS = {
  appearance: 'system', // 'system' | 'light' | 'sepia' | 'dark'
  reopenLast: true, // start with the files you left open, or ask
  finderOpensIn: 'tab', // where a file from Finder lands: 'tab' | 'window'
  font: 'sans', // the document's typeface: 'sans' | 'serif' | 'mono' | 'custom'
  fontName: '', // the one you picked, when font is 'custom'
  textSize: 15, // the document's own text, in px
  width: 'medium', // 'narrow' | 'medium' | 'wide'
  marks: true, // show the change marks
  baseline: 'read', // 'read' | 'git'
};

/** The settings as they are. Live for an importer, and assigned only here. */
export let settings = { ...DEFAULT_SETTINGS };

const darkMode = matchMedia('(prefers-color-scheme: dark)');

/** What **Compare against** in the settings sheet names, as a baseline id. */
export const defaultBaseline = () => (settings.baseline === 'git' ? 'git:HEAD' : 'read');

/**
 * What to ask for when a document is *shown* rather than when a baseline is
 * *chosen*: the one it was last compared against, and the setting above only
 * for a document that has never been compared against anything.
 *
 * The reader resolves the pair, because only it knows the file's history — see
 * `validBaseline` in src/reader/reader.ts. Asking it that way instead of looking the
 * answer up here is what keeps the first paint right: this page does not learn
 * which file it is showing until the document arrives.
 */
export const keptBaseline = () => `last:${defaultBaseline()}`;

/**
 * Light or dark, from the setting, onto <html> and the two highlight.js
 * stylesheets — what the head script in index.html does before first paint,
 * and the two must agree. Dark is on screen only, as every dark palette is, so
 * that print stays light. Sepia is drawn on light. Answers whether the scheme
 * moved, for the callers that have diagrams to redraw if it did.
 */
export function applyScheme() {
  const root = document.documentElement;
  const was = root.dataset.scheme;
  const look = settings.appearance;
  const scheme = look === 'dark' || (look === 'system' && darkMode.matches) ? 'dark' : 'light';
  root.dataset.scheme = scheme;
  $<HTMLLinkElement>('hljsLight').media = scheme === 'dark' ? 'print' : 'all';
  $<HTMLLinkElement>('hljsDark').media = scheme === 'dark' ? 'screen' : 'not all';
  return scheme !== was;
}

// Heard on System, which follows it, and also when the shell pins or unpins the
// window, which moves what it reports: a scheme picked by name does not move
// with it, so only a scheme that did gets the repaint.
darkMode.addEventListener('change', () => {
  if (!applyScheme()) return;
  retheme();
  paint(); // re-paints from source, so diagrams redraw in the new theme
});

/** Everything a setting changes in this page. Safe to run again at any time. */
function applySettings() {
  const root = document.documentElement;
  root.dataset.font = settings.font;
  const named = settings.font === 'custom' && cleanFontName(settings.fontName);
  // The three built-in families are stylesheet rules; a font picked by name
  // can only be an inline value. Clearing it puts those rules back in charge.
  if (named) root.style.setProperty('--doc-font', `${JSON.stringify(named)}, var(--font-sans)`);
  else root.style.removeProperty('--doc-font');
  root.style.setProperty('--doc-size', `${settings.textSize}px`);
  root.dataset.width = settings.width;
  // The cream is the stylesheet's, keyed off the tint, over the light scheme.
  // Diagrams are drawn with their colours baked in, so a change of tint or of
  // scheme has to redraw them — but only a change: this runs on every setting,
  // and at boot. On System, the scheme read here is the one the window had: the
  // shell unpins it after this, and the listener on `darkMode` catches that.
  const wasSepia = sepia();
  if (settings.appearance === 'sepia') root.dataset.tint = 'sepia';
  else delete root.dataset.tint;
  const schemeMoved = applyScheme();
  if ((sepia() !== wasSepia || schemeMoved) && retheme()) paint();
  // Mirrored for the inline script in index.html, which runs before first
  // paint — and, in a browser tab, this is the store rather than a mirror.
  prefs.setItem('redline:settings', JSON.stringify(settings));
  // What the sheet shows, and what the view takes the marks from. The measure comes off the
  // variable the document reads, so what Settings says a width is can never drift from what it
  // is. Always a new object, so every apply is heard -- `settings` is never patched in place.
  shownSettings.value = settings;
  docMeasure.value = getComputedStyle(root).getPropertyValue('--doc-width').trim();
}

/** Take a change here first, so the window answers at once, then store it. */
export function writeSettings(patch) {
  settings = { ...settings, ...patch };
  applySettings();
  native?.setSettings(patch);
}

export const stepSize = (by) =>
  writeSettings({ textSize: Math.min(Math.max(settings.textSize + by, SIZE_MIN), SIZE_MAX) });

export function openPrefs() {
  if (prefsOpen.value === null) prefsOpen.value = '';
}

$('prefsBtn').addEventListener('click', openPrefs);

// The menu sends this in the desktop app; in a browser tab the page has to
// catch the key itself.
native?.onOpenSettings(() => openPrefs());

/**
 * The stored settings, read and applied. Before the first load: the text size, the width and
 * the marks all have to be right on the first paint, and the baseline decides what it shows.
 */
export async function initSettings() {
  let stored = {};
  try {
    stored = native
      ? await native.settings()
      : JSON.parse(prefs.getItem('redline:settings') || '{}');
  } catch {
    /* a corrupt or unreadable copy just means the defaults */
  }
  settings = { ...DEFAULT_SETTINGS, ...stored };
  applySettings();
  state.baseline = keptBaseline();

  // Changed in another window, or from the menu.
  native?.onSettings((s) => {
    settings = { ...DEFAULT_SETTINGS, ...s };
    applySettings();
  });

  if (native) storeRoot.value = await native.storeRoot();
}
