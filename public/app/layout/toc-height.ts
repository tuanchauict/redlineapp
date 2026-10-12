// ---------- contents height ----------

import { prefs } from '../state.js';
import { $ } from '../dom.js';

// Where History starts, under Contents, is something to drag too — the
// same deal as the two widths in widths.ts, turned on its side. 180px is a default
// that was chosen rather than derived: enough headings to place a document's
// shape without a fold, because a reader who wants Contents open all the
// time should not have it start out cramped. Kept as a height rather than a
// share of the column, because a percentage fought the grip on every resize
// and settled back to the same crowded fraction the moment the window moved.

const TOC_H_KEY = 'redline:toch';
const TOC_H_DEFAULT = 180;
const TOC_H_MIN = 90;
/** What History needs to still read as a list rather than a sliver under it. */
const HIST_H_MIN = 110;

/**
 * 34px on the web, 38 in the native window, where the titlebar is taller to
 * hold the traffic lights. Mirrors `--bar-h` in styles.css — the two have to
 * agree, the same deal as the widths.
 */
const barH = () => (document.documentElement.classList.contains('native') ? 38 : 34);

// The column's own padding (6px top and bottom) and the grip between the two
// sections (its own 9px, plus the 2px gap either side of it) are spoken for
// before either section sees a pixel of what is left.
const TOC_H_CHROME = 12 + 13;

const storedTocH = () => Number(prefs.getItem(TOC_H_KEY)) || TOC_H_DEFAULT;

/**
 * The most Contents can be given and still leave History its minimum — the
 * column's actual height in this window, less the chrome above, less
 * `HIST_H_MIN`. Mirrored by the inline script in index.html for the same
 * reason as `fitWidths`.
 */
const tocHMax = (height = innerHeight) =>
  Math.max(TOC_H_MIN, height - barH() - TOC_H_CHROME - HIST_H_MIN);

const clampTocH = (h, max = tocHMax()) =>
  Math.round(Math.min(Math.max(h || TOC_H_DEFAULT, TOC_H_MIN), max));

/** Put the height on the root, from what it was left at and what the window can spare. */
function applyTocH() {
  document.documentElement.style.setProperty('--toc-h', `${clampTocH(storedTocH())}px`);
}

/** Make the seam between Contents and History draggable, the way `wireGrip` does. */
function wireTocGrip(grip) {
  const setH = (h) => {
    prefs.setItem(TOC_H_KEY, String(clampTocH(h)));
    applyTocH();
  };

  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('dragging');
    document.documentElement.classList.add('resizing-v');

    // Measured from the section's actual height rather than the stored one, so
    // a column the window is currently squeezing does not jump to its full
    // size on the first pixel of the drag.
    const was = $('tocSec').getBoundingClientRect().height;
    const move = (ev) => setH(was + (ev.clientY - e.clientY));
    const done = () => {
      grip.removeEventListener('pointermove', move);
      grip.classList.remove('dragging');
      document.documentElement.classList.remove('resizing-v');
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', done, { once: true });
    grip.addEventListener('pointercancel', done, { once: true });
  });

  grip.addEventListener('dblclick', () => setH(TOC_H_DEFAULT));

  grip.addEventListener('keydown', (e) => {
    const step = { ArrowUp: -16, ArrowDown: 16 }[e.key];
    const end = { Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined && end === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setH(end ?? storedTocH() + step);
  });
}

wireTocGrip($('histGrip'));

addEventListener('resize', applyTocH);
applyTocH();
