// The changes on the page: how many are left, the ruler down the track, and `n`/`p` between them.
//
// A viewmodel: what the chrome shows of them is a signal here -- `tally` for the count on the bar,
// `rulerBands` and `rulerCurrent` for the ruler -- and ui/Changes.tsx and ui/Ruler.tsx draw them.
// Finding the changes is work over the rendered `#doc`, which no component draws, so it reads the
// markup `paint` left: a change is a node, and where it is is a rectangle.
//
// Check-offs are vm/acks.ts, which imports this and not the other way round: what is checked is
// a class on the node by the time anything here looks, so counting and stepping need not know
// how it got there.
import { signal } from '@preact/signals';
import { state } from '../state.js';
import { $, doc, pane } from '../dom.js';

/** One mark: a run of touching changes of one kind, already scaled to the track. */
export interface RulerBand {
  kind: string;
  /** Checked off, which draws it quieter. */
  ok: boolean;
  top: number;
  height: number;
  /** The blocks it stands for, first one first: where a click lands, what a hover tints. */
  nodes: HTMLElement[];
}

/** The marks, top to bottom. Empty when the ruler has nothing to draw, or nothing to scale to. */
export const rulerBands = signal<RulerBand[]>([]);

/**
 * The change the ruler shows as current: the one under the pointer, or the one `n`/`p` last
 * landed on. A node rather than an index, because a band is several nodes and any of them makes
 * it current.
 */
export const rulerCurrent = signal<HTMLElement | null>(null);

/**
 * The count on the bar, as `paintCount` last worked it out: changes still to read, by kind and
 * in all, and how many are checked off. `nav` is how many `n`/`p` can reach, which is counted
 * off the page rather than the payload, so it is the one number here a component could not work
 * out itself.
 */
export const tally = signal({ add: 0, mod: 0, del: 0, live: 0, done: 0, nav: 0 });

/**
 * What a marked node is, which the raw view's removed lines — marked by a class — do not say.
 */
export const changeKind = (n) => n.dataset.chg || 'del';

/**
 * A raw line that carries on from the marked line above it. The raw view marks lines, not
 * blocks, so a rewritten paragraph is a run of them — one change to the eye and to the count,
 * which `n` and the arrows would otherwise take a press per line to get through.
 */
const continuesRun = (n) => {
  const above = n.previousElementSibling;
  return (
    n.classList.contains('raw-line') &&
    !!above?.matches('[data-chg], .raw-del') &&
    changeKind(above) === changeKind(n)
  );
};

/**
 * The changes still asking to be looked at — a checked one is not one of them — one node each.
 * Removed lines in the raw view are among them: they are counted, and the ruler marks them,
 * so stepping past them would be stepping past something the bar says is there.
 */
export function changeNodes() {
  return [...doc.querySelectorAll<HTMLElement>('[data-chg], .raw-del')].filter(
    (n) => !n.classList.contains('chg-ok') && !continuesRun(n),
  );
}

export function paintCount() {
  // Counted from the list the payload carries rather than from the page, so the
  // number is the same in either view: the raw view is the file's own lines and
  // has no blocks to check off, and it should not therefore disagree about how
  // much of the document is still unread.
  const changes = state.data?.changes ?? [];
  const live = changes.filter((c) => !state.acked.has(c.key));
  const of = (kind) => live.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
  // How many `n` and `p` can reach is the page's to say, not the payload's: a change inside a
  // run is reached with the run. ui/Changes.tsx draws the rest from this.
  tally.value = {
    add: of('add'),
    mod: of('mod'),
    del: of('del'),
    live: live.length,
    done: changes.length - live.length,
    nav: changeNodes().length,
  };
}

// ---------- change ruler ----------

// Where the changes are in the file, down the track the scrollbar runs in —
// the overview an editor draws on its own scrollbar.
//
// The marks in the margin only speak for the screen you are on, and the count
// on the bar only says how many there are altogether. Neither answers the
// question you actually have about a file someone has handed you to review:
// is it edited throughout, or is it three paragraphs near the end. A column of
// marks at document scale answers it at a glance, and keeps answering it while
// you scroll.

// The marks themselves are drawn by ui/Ruler.tsx, which main.ts mounts; what is here is the
// measuring, and what a mark does when it is pointed at.
const ruler = $('ruler');

/** Everything the ruler stands for: marked blocks rendered, marked lines raw. */
const rulerNodes = () => doc.querySelectorAll<HTMLElement>('[data-chg], .raw-del');

// `.chg:hover` tints the paragraph itself in pure CSS, since tag and text are
// right there together — but the ruler mark for it lives in a different part
// of the DOM, out of any CSS selector's reach, so naming it needs JS. Delegated
// on `doc` rather than bound per node, because the blocks are replaced whole on
// every paint (see `paint`); `pointerover`/`pointerout` bubble, unlike `enter`/
// `leave`, which is what makes delegating them possible at all.
// Exported for `changeUnderCursor` in vm/acks.ts, which reads it; only this module assigns it.
export let hoverNode = null;
doc.addEventListener('pointerover', (e) => {
  const node = (e.target as Element).closest('[data-chg], .raw-del');
  if (node === hoverNode) return;
  hoverNode = node;
  highlightRulerCurrent();
});
doc.addEventListener('pointerout', (e) => {
  const node = (e.target as Element).closest('[data-chg], .raw-del');
  // Moving between two elements inside the same block re-fires over/out on
  // its descendants; only actually leaving the block should drop the mark.
  if (node !== hoverNode || node?.contains(e.relatedTarget as Node)) return;
  hoverNode = null;
  highlightRulerCurrent();
});

// The same hover, the other way: a mark stands for a whole band of blocks —
// forty merged lines are one mark — so hovering it tints every one of them,
// not only the one `hoverNode` below points at. `.chg-hot` is what lets a
// class toggled from here reach `.chg:hover`'s own styling, a rule this
// subtree has no selector that reaches. `hoverNode` is still set, to one
// node of the band, purely so `highlightRulerCurrent` keeps this same mark
// current without having to learn that a band is more than one node.
let hoverBand: HTMLElement[] | null = null;
export function hoverMarks(nodes: HTMLElement[] | null) {
  for (const node of hoverBand ?? []) node.classList.remove('chg-hot');
  hoverBand = nodes;
  for (const node of nodes ?? []) node.classList.add('chg-hot');
  hoverNode = nodes?.[0] ?? null;
  highlightRulerCurrent();
}


export function paintRuler() {
  const on = state.diff && !!state.data;
  ruler.hidden = !on;
  if (!on) return void (rulerBands.value = []);

  const span = pane.scrollHeight;
  const track = ruler.clientHeight;
  // Nothing to scale against yet — a document mid-layout, or a window with no
  // height. The observer below brings us back once there is.
  if (span <= 0 || track <= 0) return void (rulerBands.value = []);

  // Rects are viewport coordinates; this is where the top of the scrolled
  // content sits in them, so subtracting it gives an offset into the document.
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  // Scaled against scrollHeight, tail padding included, because the ruler is
  // only worth anything if a mark is level with the thumb that reaches it.
  const at = (y) => (y / span) * track;

  const bands = [];
  for (const node of rulerNodes()) {
    const rect = node.getBoundingClientRect();
    // A checked-off deletion is taken out of the layout altogether; it has no
    // place on the ruler either.
    if (rect.height <= 0) continue;
    // Raw removed lines are the one marked thing the markup does not name,
    // having no block to belong to — they are removals all the same.
    const kind = node.dataset.chg || 'del';
    const ok = node.classList.contains('chg-ok');
    const top = at(rect.top - origin);
    const bottom = at(rect.bottom - origin);
    const last = bands.at(-1);
    // Forty consecutive changed lines are one change to the eye and forty
    // nodes to the DOM. Touching bands of the same kind merge, or the ruler
    // becomes a dotted line whose gaps mean nothing.
    if (last && last.kind === kind && last.ok === ok && top <= last.bottom + 1) {
      last.bottom = Math.max(last.bottom, bottom);
      last.nodes.push(node);
    } else {
      bands.push({ kind, ok, top, bottom, nodes: [node] });
    }
  }

  rulerBands.value = bands.map(({ kind, ok, top, bottom, nodes }) => {
    // Floored to something you can see: one edited line in a long file is a
    // fraction of a pixel, and being seeable is the whole job.
    const height = Math.max(3, bottom - top);
    return { kind, ok, top: Math.max(0, Math.min(top, track - height)), height, nodes };
  });
  highlightRulerCurrent();
}

// The one change `n`/`p` last took you to, or the one the pointer is over
// right now — so the ruler can answer "where am I" as well as "where are
// the changes", the way the scrollbar thumb answers it for scroll position.
// Hover and `n`/`p` don't move a single mark or change how many there are,
// so they come here and not to `paintRuler`: nothing is measured again.
function highlightRulerCurrent() {
  rulerCurrent.value =
    hoverNode ?? (state.diff ? changeNodes()[state.changeIndex] : undefined) ?? null;
}

/**
 * The document `paint` is about to replace is where the pointer was, and a node that is gone
 * never reports the pointer leaving it.
 */
export function forgetHover() {
  hoverNode = null;
}

// Every call measures every change, and the things that move them — a diagram
// finishing, a window resizing, a disclosure opening — move them in bursts.
let ruling = false;
function queueRuler() {
  if (ruling) return;
  ruling = true;
  requestAnimationFrame(() => {
    ruling = false;
    paintRuler();
  });
}

// The document's height is what the ruler divides up, and it settles well
// after paint: diagrams render, fonts swap, images arrive, a "before" is
// opened. Watching the article covers all of them without any of them having
// to know the ruler exists.
new ResizeObserver(queueRuler).observe(doc);
// The track's own height is the window's, which the article's box never
// reports.
addEventListener('resize', queueRuler);

// ---------- change navigation ----------

/**
 * The landing behaviour `n`/`p` and a ruler click share: scroll, flash, and
 * bring the ruler's own idea of "current" along with it. Takes any node, not
 * only one `changeNodes()` knows about -- a raw-removed line or an
 * already-checked change lands here too, just without a `changeIndex` to show
 * for it.
 */
export function goToNode(node) {
  landedAt = performance.now();
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const n of doc.querySelectorAll('.flash')) n.classList.remove('flash');
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1200);
  // The smooth scroll above repaints the ruler as it goes, but only once it has
  // moved far enough to fire a scroll event -- which a change already on screen
  // never does, leaving the mark unhighlighted until the next unrelated repaint.
  // Flip the class directly rather than repainting, so the mark fades up
  // instead of snapping in on a freshly rebuilt element.
  highlightRulerCurrent();
}

// A landing starts a smooth scroll, and for the length of it the change is not yet on screen. A
// second press in that time has to go on from the change just chosen, not from wherever the
// scroll has got to — which is how rapid presses used to land back on the one before.
const LANDING_MS = 1500;
let landedAt = -Infinity;

/**
 * Which of `stops` a step lands on. It goes on from the change you were last taken to for as
 * long as the reader is still there — it is on screen, or the scroll to it is still under way.
 * Otherwise the reader has moved: a scroll, the ruler, a reload that put the page back to
 * nothing chosen. Then it is the first change from the top of the window, or the last one
 * before it, so that a step is a step from where you are and not from where you were.
 */
function stepIndex(stops, current, step) {
  const view = pane.getBoundingClientRect();
  const from = stops.indexOf(current);
  if (from >= 0) {
    const rect = current.getBoundingClientRect();
    const here = rect.bottom > view.top && rect.top < view.bottom;
    if (here || performance.now() - landedAt < LANDING_MS) {
      return (from + step + stops.length) % stops.length;
    }
  }
  const top = (n) => n.getBoundingClientRect().top;
  if (step > 0) {
    const next = stops.findIndex((n) => top(n) >= view.top);
    return next < 0 ? 0 : next;
  }
  const before = stops.findLastIndex((n) => top(n) < view.top);
  return before < 0 ? stops.length - 1 : before;
}

/**
 * `kind` is for the count on the bar, which is a count of one kind at a time. A view with none
 * of that kind — the raw view has no *changed*, only lines added and removed — goes through
 * all of them rather than nowhere, since a figure that does nothing when pressed reads as broken.
 */
export function goToChange(step, kind = null) {
  if (!state.diff) return;
  const nodes = changeNodes();
  if (!nodes.length) return;
  const ofKind = kind ? nodes.filter((n) => changeKind(n) === kind) : nodes;
  const stops = ofKind.length ? ofKind : nodes;
  const node = stops[stepIndex(stops, nodes[state.changeIndex], step)];
  state.changeIndex = nodes.indexOf(node);
  goToNode(node);
}

const ANCHORABLE = 'h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,blockquote,.raw-line:not(.raw-del)';

/**
 * Run `fn`, then scroll so the block you were looking at is where you left it.
 * Hiding the marks removes whole deleted blocks, so the text below them moves.
 */
export function keepAnchored(fn) {
  // Anchor on a leaf that exists in both states: the wrappers themselves stop
  // generating a box, and anything inside a deletion is about to disappear.
  const anchor = [...doc.querySelectorAll(ANCHORABLE)].find(
    (el) => !el.closest('.chg-del, .chg-before') && el.getBoundingClientRect().bottom > 0,
  );
  const was = anchor?.getBoundingClientRect().top;
  fn();
  if (anchor?.isConnected) {
    const now = anchor.getBoundingClientRect().top;
    if (now !== was) pane.scrollBy(0, now - was);
  }
}
