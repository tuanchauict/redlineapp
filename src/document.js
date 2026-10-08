// Turning a document into what the reader draws.
//
// This is the whole of the rendering side of `/api/doc`, with nothing of the
// machine in it: no fs, no path, no store, no server. It takes the two versions
// of the text and hands back the HTML, the marks and the contents list.
//
// Split out because it has two callers that have nothing else in common. In the
// desktop app it runs inside the webview, where none of node: exists; in the
// CLI it runs on the server, which reads the file and looks after the store.
// Keeping it in one place is what stops the app and the browser disagreeing
// about what a document looks like -- the diff is the product, and two
// implementations of it would be two products.
import { createMarkdown, documentTitle, renderPlain, outline } from './render.js';
import { renderDiff, renderRawDiff } from './diff.js';

export { createMarkdown };

const NO_CHANGES = { added: 0, removed: 0, modified: 0 };

/**
 * Render `current`, marked up against `base`.
 *
 * `base` is null when there is nothing to compare against -- the newest
 * version, or a document opened for the first time -- and then the document
 * renders plainly rather than as a diff of everything against nothing.
 *
 * Returns { html, rawHtml, stats, changes, toc, title }. `changes` names every
 * marked block in document order, so the counter can subtract the ones checked
 * off: a change checked off is still a change, it is just not one you are being
 * asked to look at. `title` is what the document calls itself -- its header's,
 * or its lone `<h1>`'s -- and `''` if it does not say, which is what tells the
 * bar to fall back to the file's name.
 *
 * `checked` is the payload's `acked` and `ackedFrom` -- the keys checked off and
 * the versions they were checked against -- so that a checked block edited
 * since is marked against what was read rather than against `base`. See
 * `renderDiff`.
 */
export function renderDocument(md, current, base, checked = {}) {
  const changed = base != null && base !== current;

  // The headings, worked out once: they are the contents list down the side,
  // and the ids the render hands to the headings themselves so that a link
  // written `[see below](#notes)` has somewhere to land.
  const toc = outline(md, current);
  const slugs = toc.map((h) => h.id);

  const rendered = changed
    ? renderDiff(md, base, current, slugs, checked)
    : { html: renderPlain(md, current, { slugs }), stats: NO_CHANGES, changes: [] };

  return {
    html: rendered.html,
    rawHtml: renderRawDiff(changed ? base : null, current),
    stats: rendered.stats,
    changes: rendered.changes,
    toc,
    // From `current`, never from `base`: the bar says what the file is now.
    // The outline goes in because the lone-`<h1>` rule is a question about it.
    title: documentTitle(md, current, toc),
  };
}

/**
 * What `src` calls itself, on its own. For the page reading one version by
 * itself: the article is that version, but the bar still names the file as it
 * is now, so a window does not change its title under you as you step back
 * through its history.
 */
export function titleOf(md, src) {
  return documentTitle(md, src, outline(md, src));
}
