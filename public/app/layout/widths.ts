// ---------- sidebar widths ----------

import { prefs, state } from '../state.js';
import { $ } from '../dom.js';

// A column that holds a path over a filename, a commit subject, and a heading
// indented three levels cannot be one width for every document — 236px is
// where it starts, not what it is. So each inner edge is something to pull,
// and where it is pulled to is remembered: it is the kind of thing you set
// once. The two are remembered separately, because a file list and a contents
// list are not the same shape.
//
// Kept in localStorage rather than in Settings, alongside whether either
// column is open at all: all four are facts about this window's furniture
// rather than about how a document should read, and none is worth a row in a
// panel.

const SIDE_W_KEY = 'redline:sidew';
const TOC_W_KEY = 'redline:tocw';
const SIDE_W_DEFAULT = 236;
const SIDE_W_MIN = 150;
const SIDE_W_MAX = 560;
/** What the document keeps of the window, whatever the columns were left at. */
const DOC_W_MIN = 320;

const clampSideW = (w) =>
  Math.round(Math.min(Math.max(w || SIDE_W_DEFAULT, SIDE_W_MIN), SIDE_W_MAX));

/** What an edge was left at, before the window has had its say. */
const storedW = (key) => clampSideW(Number(prefs.getItem(key)));

/**
 * The two widths a window this size can actually give them.
 *
 * Each column is clamped on its own first, by `storedW`; this is the clamp
 * they need as a pair, because two columns that are each perfectly reasonable
 * can still leave no document between them. Contents gives way first — the
 * prose and the files you are moving between are worth more of a narrow window
 * than the map of one of them — and neither goes below `SIDE_W_MIN`, since a
 * column narrower than that is not a column; past that point the document is
 * what gives, and the reader can close one.
 *
 * This is mirrored by the inline script in index.html, which has to arrive at
 * the same two numbers before this file has been fetched. Change one and you
 * must change the other, or opening the window is a visible correction.
 */
function fitWidths(side, toc, width = innerWidth) {
  const room = Math.max(0, width - DOC_W_MIN);
  if (side + toc > room && toc) toc = Math.max(SIDE_W_MIN, room - side);
  if (side + toc > room && side) side = Math.max(SIDE_W_MIN, room - toc);
  return [side, toc];
}

/**
 * Put both widths on the root, from what they were left at and what the window
 * can spare. Nothing is written back to storage: a narrow window squeezing a
 * column is the window's doing, and must not overwrite the width that was
 * actually chosen.
 */
export function applyWidths() {
  const want = [storedW(SIDE_W_KEY), storedW(TOC_W_KEY)];
  const fit = fitWidths(state.side ? want[0] : 0, state.tocSide ? want[1] : 0);
  const root = document.documentElement.style;
  // A closed column keeps its chosen width in the variable rather than going
  // to zero. Nothing lays it out while it is closed, and the squeeze is only
  // meaningful between columns that are both on screen.
  root.setProperty('--side-w', `${state.side ? fit[0] : want[0]}px`);
  root.setProperty('--toc-w', `${state.tocSide ? fit[1] : want[1]}px`);
}

/**
 * Make one column's inner edge draggable.
 *
 * `sign` is which way the pointer moves it: the left column grows as the
 * pointer goes right, the right column grows as it goes left. Everything else
 * about the two is identical, and a second copy of it would be a second place
 * to forget the pointer capture.
 */
function wireGrip(grip, key, sign) {
  const setW = (w) => {
    prefs.setItem(key, String(clampSideW(w)));
    applyWidths();
  };

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // a drag from here is not a text selection
    // Captured, so the pointer leaving the 7px strip — which it does
    // immediately — does not end the drag, and so the release is heard
    // wherever it happens.
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.documentElement.classList.add('resizing');

    // Measured from where the edge actually is rather than from the stored
    // width, so a column the window is currently squeezing does not jump to
    // its full size on the first pixel of the drag.
    const edge = grip.getBoundingClientRect().left + 3;
    const was = sign > 0 ? edge : innerWidth - edge;
    const move = (ev) => setW(was + sign * (ev.clientX - e.clientX));
    const done = () => {
      grip.removeEventListener('pointermove', move);
      grip.classList.remove('dragging');
      document.documentElement.classList.remove('resizing');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done, { once: true });
    grip.addEventListener('pointercancel', done, { once: true });
  });

  // The way back, and the convention for a divider: a double-click on the edge
  // puts it where it started.
  grip.addEventListener('dblclick', () => setW(SIDE_W_DEFAULT));

  // Reachable without a pointer. The keys are taken here rather than left to
  // the page's own handler, which reads them as scrolling the document.
  grip.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[e.key];
    const end = { Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined && end === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    // The arrows follow the edge, so which key widens depends on which edge
    // this is. Home and End are the ends of the range, which are the same two
    // ends either way round.
    setW(end ?? storedW(key) + step * sign);
  });
}

wireGrip($('sideGrip'), SIDE_W_KEY, 1);
wireGrip($('tocGrip'), TOC_W_KEY, -1);

// A window narrowed past what the columns were left at gives the document its
// room back, and takes none of it permanently: the chosen widths are what
// return when there is room for them again.
addEventListener('resize', applyWidths);
applyWidths();
