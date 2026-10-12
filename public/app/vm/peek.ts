// The link peek: where a link goes, while the pointer is on it.
//
// Over the rendered document, so imperative: it is filled and measured in the same moment, to
// step aside from the link it would cover, and that is a read of the layout no render can wait
// for. `paint` takes it down before `#doc` is replaced; the link click in main.ts resolves a
// destination with `linkTarget`.
import { walkPath, shorten, MD_LINK } from '../../vendor/render.js';
import { state } from '../state.js';
import { $, doc, pane } from '../dom.js';

// Where a link goes, while the pointer is on it. Link text is written to read
// well — "the design doc", "see below" — and says nothing about where it
// lands; a browser answers that in the bottom-left corner, and a window with
// no address bar needs the answer more, not less.

const peek = $('peek');

/** Percent-escapes are for the wire, not for reading. Malformed ones stay. */
const readable = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// A scheme, or the `//host` form that borrows the page's own.
export const HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:|^\/\//i;

/**
 * A destination written the way the document's author would recognise it: a URL
 * in full, an in-page jump as the anchor it lands on, and a link to a file
 * beside this one as that file's path.
 *
 * The last two are where a browser's own answer would be no help. Both are
 * served over loopback, so Chrome would show `http://127.0.0.1:53219/?id=8f2…`
 * — the port this reader happens to have started on, and never what was
 * written or where it goes.
 */
function linkLabel(a) {
  const href = (a.getAttribute('href') || '').trim();
  if (!href) return '';
  if (href.startsWith('#')) return readable(href);

  if (HAS_SCHEME.test(href)) {
    // Resolved, so a protocol-relative link reads as the address it fetches.
    try {
      return new URL(href, location.href).href;
    } catch {
      return href; // not a URL this browser can parse; say what the page says
    }
  }

  // A path, then, with a place in it to land — that part is the file's own
  // business, so it is kept but not resolved.
  const cut = href.indexOf('#');
  const hash = cut < 0 ? '' : href.slice(cut);
  const bare = (cut < 0 ? href : href.slice(0, cut)).split('?')[0];
  if (!bare) return readable(href);

  const d = state.data;
  // Rooted already, or nothing to resolve against yet: say what the page says.
  if (!d?.dir || bare.startsWith('/')) return readable(bare) + readable(hash);
  return readable(shorten(walkPath(d.dir, bare), d)) + readable(hash);
}

/**
 * The file a link points at, as an absolute path — or null if it does not
 * point at one this app opens.
 *
 * A markdown file's links to its neighbours are written the way its author
 * filed them: `./api.md`, `../adr/0004.md`, `notes/todo.md`. None of those
 * mean anything on their own, and the only thing that gives them a meaning is
 * the directory the document being read is sitting in — so that is what they
 * are resolved against, not the page's own address, which is a loopback port.
 *
 * Decoded first: markdown-it percent-escapes a destination on the way into the
 * html, so a file whose name has a space or a character outside ASCII arrives
 * here as `%E5%9B%B3.md`. The disk has never heard of that spelling, and a
 * path built from it silently opens nothing.
 */
export function linkTarget(href) {
  if (!href || href.startsWith('#') || HAS_SCHEME.test(href)) return null;
  const bare = readable(href.split('#')[0].split('?')[0]);
  const dir = state.data?.dir;
  if (!bare || !dir) return null;
  const abs = bare.startsWith('/') ? bare : walkPath(dir, bare);
  return MD_LINK.test(abs) ? abs : null;
}

/** The pointer lands on the text inside a link, not on the link. */
const linkAt = (node) => (node instanceof Element ? node.closest('a[href]') : null);

function showPeek(a) {
  const text = a && linkLabel(a);
  if (!text) return hidePeek();

  peek.textContent = text;
  peek.classList.remove('away');
  peek.hidden = false;

  // Measured rather than assumed: it moves aside only for a link it would
  // actually be covering, which is a handful of lines at the foot of the page.
  const box = peek.getBoundingClientRect();
  const link = a.getBoundingClientRect();
  const behind =
    link.bottom > box.top && link.top < box.bottom && link.left < box.right && link.right > box.left;
  peek.classList.toggle('away', behind);
}

export function hidePeek() {
  if (peek.hidden) return;
  peek.hidden = true;
  peek.textContent = '';
}

doc.addEventListener('pointerover', (e) => showPeek(linkAt(e.target)));
doc.addEventListener('pointerout', (e) => {
  // Crossing between the pieces of one link — a bold word inside it, a line
  // break — fires out and then over again. Only leaving the link clears it.
  if (!linkAt(e.relatedTarget)) hidePeek();
});

// Tab to a link and the same question wants the same answer.
doc.addEventListener('focusin', (e) => showPeek(linkAt(e.target)));
doc.addEventListener('focusout', () => hidePeek());

// Scrolling moves it. It goes because the pointer has not moved and nothing else will say the
// link left it: under the pointer after a scroll is whatever scrolled into that spot.
pane.addEventListener('scroll', hidePeek);
// An external link that has just taken the focus to a browser is behind us.
addEventListener('blur', hidePeek);
