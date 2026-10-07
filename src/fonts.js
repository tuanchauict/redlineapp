// The typefaces installed on this machine.
//
// A browser will not tell you. `queryLocalFonts()` is Chromium's alone and sits
// behind a permission prompt, and measuring a name only answers about a name
// you already thought of — which is how you end up offering a fixed catalogue
// that has Iowan Old Style, which this machine does not have, and not Bookerly,
// which it does. So the question goes to the OS, through the same platform
// (src/platform.js) as everything else, and both shells get the one answer:
// the server route for a browser tab, the reader directly for the desktop app.

/**
 * Ask AppKit. `availableFontFamilies` is the list a font panel is built from —
 * family names spelled the way a person writes them, including anything
 * activated from Font Book, which a scan of the font folders would miss.
 *
 * JXA rather than a Rust dependency: this has to work in the CLI too, where
 * there is no Rust at all, and it costs about a third of a second — against
 * five and a half for `system_profiler SPFontsDataType`.
 *
 * Exported for the test that holds shell/src/host.rs to the same text: the
 * desktop shell runs osascript with this script and refuses any other, so the
 * two copies have to agree to the byte.
 */
export const LIST_FAMILIES =
  'ObjC.import("AppKit");' +
  '$.NSFontManager.sharedFontManager.availableFontFamilies.js.map(s => s.js).join("\\n")';

/** Long enough that a cold osascript is never the reason this comes back empty. */
const TIMEOUT_MS = 10_000;

/**
 * Families that are installed but are not typefaces — dingbats, ornaments,
 * emoji, Braille. They would render the document as a wall of symbols, so
 * offering them is offering a mistake.
 */
const NOT_FOR_READING = /emoji|braille|dingbat|wingding|webding|ornament|^symbol$/i;

/** Asked once a launch: the set does not change under a running app in practice. */
let cached = null;

/**
 * Every font family worth reading a document in, sorted, or `[]` where there
 * is no way to ask.
 *
 * Empty is a real answer and the caller has to have something to show for it:
 * this is macOS-only, and even there an `osascript` that will not run is not
 * worth failing a settings sheet over.
 *
 * @param {import('./platform.js').Platform} platform
 * @returns {Promise<string[]>}
 */
export async function systemFonts(platform) {
  if (cached) return cached;
  if (platform.os !== 'darwin') return [];

  let out;
  try {
    out = await platform.spawn('osascript', ['-l', 'JavaScript', '-e', LIST_FAMILIES], {
      timeout: TIMEOUT_MS,
    });
  } catch {
    return [];
  }
  if (out.code !== 0) return [];

  const families = out.stdout
    .split('\n')
    .map((name) => name.trim())
    // A leading dot is a system face nobody is meant to name (".SF NS").
    .filter((name) => name && !name.startsWith('.') && !NOT_FOR_READING.test(name))
    .sort((a, b) => a.localeCompare(b));

  // Only a real answer is kept: a machine that answered nothing may just have
  // been busy, and caching that would mean an empty popup until the next launch.
  if (families.length) cached = families;
  return families;
}
