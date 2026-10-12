// ---------- fonts ----------

// The typefaces the Settings popup offers beyond the three built in.

import { fontGroups, type Settings } from '../state.js';
import { cleanFontName } from '../vm/settings.js';

/**
 * Whether a named font resolves on this machine, rather than quietly falling
 * back. Measured, not asked: a name the browser does not know renders in the
 * generic it is listed against, so the same string against two different
 * generics comes out two different widths only when the name really took.
 */
function fontInstalled(name) {
  const probe = 'mmmmmmmmmmlliWWWWWW0123456789';
  const ctx = document.createElement('canvas').getContext('2d');
  const widthIn = (stack) => {
    ctx.font = `72px ${stack}`;
    return ctx.measureText(probe).width;
  };
  return ['monospace', 'serif', 'sans-serif'].some(
    (generic) => widthIn(`${JSON.stringify(name)}, ${generic}`) !== widthIn(generic),
  );
}

/**
 * The fallback, for when the host cannot enumerate: a catalogue of faces worth
 * reading a document in, grouped by what the face is, with every name measured
 * against this machine before it is offered.
 *
 * Guesswork, which is why it is second. It cannot know about a font it was not
 * written with — but it is better than an empty popup on a machine where
 * asking the OS is not a thing you can do (src/reader/fonts.ts is macOS only).
 */
const FONT_CHOICES = Object.entries({
  'Sans-serif': `Avenir Next, Charter, Futura, Geist, Gill Sans, Helvetica Neue, IBM Plex Sans,
    Inter, Lato, Lucida Grande, Manrope, Nunito Sans, Open Sans, Optima, PT Sans, Public Sans,
    Roboto, Seravek, Source Sans 3, Trebuchet MS, Verdana, Work Sans`,
  Serif: `Athelas, Baskerville, Bitter, Cambria, Cochin, Crimson Text, EB Garamond, Georgia,
    Hoefler Text, Iowan Old Style, Libre Baskerville, Literata, Lora, Merriweather, New York,
    Palatino, PT Serif, Source Serif 4, Spectral, Times New Roman`,
  Monospace: `Andale Mono, Berkeley Mono, Cascadia Code, Consolas, Courier New, DejaVu Sans Mono,
    Fira Code, Geist Mono, Hack, IBM Plex Mono, Inconsolata, Iosevka, JetBrains Mono, Menlo,
    Monaco, PT Mono, Roboto Mono, SF Mono, Source Code Pro, Space Mono, Victor Mono`,
  Japanese: `Hiragino Maru Gothic ProN, Hiragino Mincho ProN, Hiragino Sans, Noto Sans JP,
    Noto Serif JP, Yu Gothic, Yu Mincho`,
  // A comma never appears in a font's name, so the list can be written as one.
}).map(([label, names]): [string, string[]] => [label, names.split(',').map((n) => n.trim())]);

let fontsListed = false;

/**
 * Fill the typeface popup, once, with the fonts this machine actually has.
 *
 * The host is asked first and believed: it is the only one that can name a
 * font nobody thought to write down. What comes back is one flat alphabetical
 * list, the way a font menu has always been — there is nothing in a family
 * name that says whether it is a serif, and guessing would file half of them
 * wrong. The catalogue above is the fallback, and only then are the names
 * measured, because a guessed list is the only kind that can be wrong.
 *
 * ui/Settings.tsx draws what this finds.
 */
export async function listFonts(backend, current: () => Settings) {
  if (fontsListed) return;
  fontsListed = true;
  const installed = await backend.fonts().catch(() => []);
  const groups: [string, string[]][] = installed.length
    ? [['On this machine', installed]]
    : FONT_CHOICES.map(([label, names]) => [label, names.filter(fontInstalled)]);

  const listed = groups.filter(([, names]) => names.length);

  // Read after the wait, not before: another window may have changed it in the meantime.
  const settings = current();

  // Set on a machine that had the font, opened on one that does not: say so
  // rather than showing the popup as blank and losing what it is set to.
  const named = settings.font === 'custom' && cleanFontName(settings.fontName);
  if (named && !listed.some(([, names]) => names.includes(named))) {
    listed.push(['Not on this machine', [named]]);
  }
  fontGroups.value = listed;
}
