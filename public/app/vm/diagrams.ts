// Diagrams: Mermaid drawn in the page, PlantUML asked of the backend, into the blocks the render
// left for them.
//
// Over the rendered document, so imperative, and after `paint` has written it: a diagram is drawn
// into a node that has to be there and be measurable. A block inside a closed "before" is drawn
// when it opens. The colours are baked in as it draws, which is why a change of scheme or tint
// has to `retheme` and repaint.
import { sanitizeSvg } from '../../vendor/sanitize.js';
import { backend } from '../backend.js';
import { doc } from '../dom.js';

// The scheme and the tint are both the page's to say, as `data-scheme` and
// `data-tint` on <html>, set by the head script and then by `applySettings`.
// No media query knows about either: sepia is not a scheme a window can
// report, and a browser tab set to Dark on a light system is still told light.
export const sepia = () => document.documentElement.dataset.tint === 'sepia';
const dark = () => document.documentElement.dataset.scheme === 'dark';

const mermaidConfig = () => ({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  ...(sepia()
    ? // `base` is the one theme that takes its colours as given; `default`
      // would put lavender boxes on cream. The rest derive from these.
      {
        theme: 'base',
        themeVariables: {
          background: '#f5ecd9',
          primaryColor: '#ece0c8',
          primaryBorderColor: '#a8916f',
          primaryTextColor: '#3d3024',
          lineColor: '#76664f',
        },
      }
    : { theme: dark() ? 'dark' : 'default' }),
});

// Loaded on first use only: it is a multi-megabyte bundle, and a document
// without diagrams should not pay for it — nor should a failure to load it
// take the reader down.
let mermaid = null;
let mermaidBroken = false;
async function getMermaid() {
  if (mermaid || mermaidBroken) return mermaid;
  try {
    mermaid = (await import('../../vendor/mermaid/mermaid.esm.min.mjs')).default;
    mermaid.initialize(mermaidConfig());
  } catch (err) {
    console.error('mermaid failed to load', err);
    mermaidBroken = true;
  }
  return mermaid;
}

/**
 * Take up the scheme and tint now on <html>, for the diagrams drawn from here on. Whether there
 * is a Mermaid to tell: one never loaded has nothing drawn in the old colours, and nothing to
 * repaint for.
 */
export function retheme() {
  if (!mermaid) return false;
  mermaid.initialize(mermaidConfig());
  return true;
}

/** Blocks worth drawing: not already done, and not hidden inside a disclosure. */
const pending = (root, selector) =>
  [...root.querySelectorAll(selector)].filter(
    (n) => !n.dataset.processed && !n.closest('details:not([open])'),
  );

/**
 * Render mermaid blocks. Blocks inside a collapsed "before" disclosure are
 * skipped — they cannot be measured while hidden, and are drawn on open.
 */
async function drawMermaid(root) {
  const nodes = pending(root, 'pre.mermaid');
  if (!nodes.length) return;

  const m = await getMermaid();
  if (!m) {
    for (const n of nodes) n.classList.add('mermaid-failed');
    return;
  }
  try {
    await m.run({ nodes, suppressErrors: true });
  } catch {
    /* a bad diagram must not take the page down */
  }
  for (const n of nodes) {
    if (!n.dataset.processed) n.classList.add('mermaid-failed');
  }
}

// Diagrams already drawn, by source. The diff shows the same fence twice when a
// block around it changed, a redraw on theme change asks for every diagram in
// the document again, and switching back to a file asks again for all of it --
// so this saves far more round trips than it costs memory.
const pumlCache = new Map();

/**
 * Fill in PlantUML blocks.
 *
 * Unlike mermaid there is no renderer in the page: the jar runs outside, so
 * each block is a request. They go out together rather than one after another
 * because a document of diagrams would otherwise take as long as the sum of
 * them, and the jar is the slow part.
 *
 * A diagram that will not draw says so where it should have been, keeping its
 * source visible — a diagram is written to be read either way, and a blank space
 * where one belongs tells the reader nothing about why.
 */
async function drawPlantuml(root) {
  const nodes = pending(root, 'pre.plantuml');
  if (!nodes.length) return;

  await Promise.all(
    nodes.map(async (n) => {
      // Claimed before the request goes out: a second call arriving while this
      // one is in flight must not ask for the same diagram again.
      n.dataset.processed = '1';
      const code = n.textContent;
      try {
        if (!pumlCache.has(code)) pumlCache.set(code, backend.plantumlSvg(code));
        const out = await pumlCache.get(code);
        // The document can have been repainted or closed while the jar ran.
        if (!n.isConnected) return;
        if (out.svg) {
          n.closest('.diagram').innerHTML = sanitizeSvg(out.svg);
        } else {
          showDiagramError(n, out.error);
        }
      } catch (err) {
        pumlCache.delete(code); // a transport failure is worth retrying
        if (n.isConnected) showDiagramError(n, String(err.message || err));
      }
    }),
  );
}

/** Say why a diagram is not there, above the source that was meant to draw it. */
function showDiagramError(pre, message) {
  const box = pre.closest('.diagram');
  box.classList.add('diagram-unavailable');
  const note = document.createElement('p');
  note.className = 'diagram-note';
  note.textContent = message || 'PlantUML rendering is unavailable.';
  box.prepend(note);
}

export const drawDiagrams = (root = doc) => Promise.all([drawMermaid(root), drawPlantuml(root)]);

// `toggle` does not bubble, so listen in the capture phase.
doc.addEventListener('toggle', (e) => drawDiagrams(e.target as HTMLElement), true);
