// What a document is allowed to put on the page.
//
// A markdown file is someone else's text, and markdown-it is set up with
// `html: true` because real documents lean on it -- a `<details>`, an `<img
// width>`, a `<kbd>`. That same switch lets a `<script>`, an `onerror=` or a
// `javascript:` link through as written, and in the desktop app the page that
// draws the document is also the page that can ask the shell to run git and
// write the store. So everything that came out of a document is passed through
// here on its way into the DOM, and nothing that runs does.
//
// At insertion, in the page, rather than in render.js: the renderer also runs
// on the server, where there is no DOM to sanitize against, and doing it last
// means the diff, the inline word marks and the raw view are all covered by the
// one call that cannot be forgotten on the way in. The diff's own markup -- the
// change tags, the "before" disclosure, the tick -- is plain HTML that the
// defaults already allow, which is what makes sanitizing after it safe.
//
// Bundled on its own by build:web rather than into render.js for the same
// reason: render.js is imported by Node, and DOMPurify without a window does
// not sanitize, it hands the input back.
import DOMPurify from 'dompurify';

const DOCUMENT = {
  // Off, because it strips any `id` or `name` that is also a property of
  // `document`, and heading ids are slugs of their headings: "Images",
  // "Title", "Links" and "Forms" would all lose their anchors, and with them
  // their entries in Contents. What it guards against is a document's element
  // standing in for `document.something` -- which only a `name` can do for the
  // elements that survive the defaults, so `name` goes instead.
  SANITIZE_DOM: false,
  FORBID_ATTR: ['name'],
  // A `<style>` applies to the whole page, not the document: it could restyle
  // the window around it, or hide the change marks that are this reader's
  // reason to exist. A `<form>` is the one element left that can navigate the
  // page somewhere on a click, and the link handler never sees it.
  FORBID_TAGS: ['style', 'form'],
};

/** A rendered document, or its raw view, made safe to assign to innerHTML. */
export const sanitizeDocument = (html) => DOMPurify.sanitize(html, DOCUMENT);

/**
 * A PlantUML diagram. The jar draws from source the document supplied, so its
 * SVG is no more trusted than the document is; the SVG profile keeps what a
 * drawing needs and drops what a page would run.
 */
export const sanitizeSvg = (svg) =>
  DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
