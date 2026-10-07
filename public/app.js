import { createMarkdown, renderDocument } from './vendor/render.js';
import { sanitizeDocument, sanitizeSvg } from './vendor/sanitize.js';
import { createBackend } from './backend.js';

const $ = (id) => document.getElementById(id);
const doc = $('doc');
// The scroll area is the document pane, not the page — see `main` in the CSS.
const pane = document.querySelector('main');
const darkMode = matchMedia('(prefers-color-scheme: dark)');

// Sepia is drawn by the page, not reported by the window, so no media query
// knows about it — the dataset that the head script and `applySettings` set
// is the one place to ask.
const sepia = () => document.documentElement.dataset.tint === 'sepia';

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
    : { theme: darkMode.matches ? 'dark' : 'default' }),
});

// Loaded on first use only: it is a multi-megabyte bundle, and a document
// without diagrams should not pay for it — nor should a failure to load it
// take the reader down.
let mermaid = null;
let mermaidBroken = false;
async function getMermaid() {
  if (mermaid || mermaidBroken) return mermaid;
  try {
    mermaid = (await import('/vendor/mermaid/mermaid.esm.min.mjs')).default;
    mermaid.initialize(mermaidConfig());
  } catch (err) {
    console.error('mermaid failed to load', err);
    mermaidBroken = true;
  }
  return mermaid;
}

const state = {
  // Which of the server's open documents this page is showing. One server
  // backs every window, so every request has to say which document it means;
  // a lone browser tab can leave it empty and get the only one.
  docId: new URLSearchParams(location.search).get('id') || '',
  view: localStorage.getItem('redline:view') || 'rendered',
  // Show the change marks, or just read the document. Hiding them is a page
  // concern only: the baseline keeps tracking, so turning them back on costs
  // no round trip and nothing is forgotten in between.
  diff: localStorage.getItem('redline:diff') !== '0',
  baseline: 'read',
  data: null,
  changeIndex: -1,
  // The changes ticked off in this document, by the server's name for each.
  // Kept per document rather than per page, so closing the tab does not undo an
  // afternoon of reading through a long set of edits.
  acked: new Set(),
  // The contents rows and the headings they stand for, paired up at paint time:
  // the scroll spy runs on every frame the document moves and cannot be asking
  // the sidebar what is in it each time.
  toc: [],
  tocAt: -1,
  // The window's other documents, in a native window. A browser tab has none.
  tabs: [],
  // Whether each sidebar is showing — the files and versions down the left,
  // the contents down the right. Read back from the classes the inline script
  // set before first paint, so neither flashes.
  side: document.documentElement.classList.contains('side-open'),
  tocSide: document.documentElement.classList.contains('toc-open'),
  // The version whose "forget everything older" is waiting to be confirmed.
  // Deleting is the one thing in the sidebar that cannot be undone, so it asks
  // in the row itself rather than throwing a dialog over the window.
  pruneAsk: null,
};

/** Where each document was left, so switching back does not lose the place. */
const scrollMemory = new Map();

// ---------- fetching & rendering ----------

// Everything the page asks of what is behind it goes through here -- see
// ./backend.js, which is also where the choice between a server and a reader
// held in the page is made. The id is read per call rather than passed in,
// because it is assigned by the other side and can change under the page.
const backend = await createBackend({ docId: () => state.docId });

/** Keep the id in the address too, so a reload comes back to this document. */
function setDocId(id) {
  if (!id || id === state.docId) return false;
  state.docId = id;
  const url = new URL(location.href);
  url.searchParams.set('id', id);
  history.replaceState(null, '', url);
  return true;
}

// One markdown renderer for the life of the page. Building it is not free and
// it holds no per-document state -- what varies between documents is passed in
// (see `renderDocument`), because the diff renders a single document twice and
// two renderers would be two sets of plugin rules to keep in step.
const md = createMarkdown();

/**
 * Take a document payload as the one this page is showing, however it arrived —
 * a load, a read mark, a pruned history. Everything the page holds about the
 * document that the payload is authoritative on is re-read from it here, so
 * there is one place for it rather than one per endpoint.
 *
 * The payload is the two versions of the text; the HTML, the marks and the
 * contents list are worked out here. That is where it has to happen for the
 * desktop app — a webview with no server behind it — and doing it here for the
 * browser too is what keeps there being one diff rather than two.
 */
function adopt(data) {
  const checked = { keys: data.acked, from: data.ackedFrom };
  state.data = Object.assign(data, renderDocument(md, data.text, data.base, checked));
  // The id is assigned by the reader when this page did not name one.
  setDocId(data.id);
  // The baseline asked for is not always the one that could be honoured — a
  // default of git HEAD means nothing outside a repo, and a version can have
  // been forgotten. The payload says which was used, and the document in it is
  // built from that one, so its answer is the one to keep.
  state.baseline = data.baseline;
  state.acked = new Set(data.acked ?? []);
}

async function load({ keepScroll = true } = {}) {
  const y = pane.scrollTop;
  const want = state.docId;
  const data = await backend.doc(state.baseline);
  // Switch tabs faster than the answer arrives and two loads are in flight;
  // the one you have already left must not paint over the one you are on.
  if (want && want !== state.docId) return;
  adopt(data);
  paint();
  if (keepScroll) pane.scrollTo(0, y);
}

function paint() {
  const d = state.data;
  if (!d) return;

  // A document that names itself in its header gets called that. `SKILL.md`,
  // `README.md`, `CLAUDE.md` -- the filename is the convention the tool reading
  // the file insists on, not what the document is, and three windows of them
  // are three windows with the same title. The file's name is not lost: it
  // moves into the path underneath, which is set rtl, so the name is the part
  // that stays visible when there is not room for all of it.
  //
  // Only when there is a title to show, or the bar would say the filename twice.
  document.title = d.title || d.name;
  $('name').textContent = d.title || d.name;
  $('nameDir').textContent = ltrPath(d.title ? d.pathLabel : d.dirLabel);
  $('nameBox').title = d.path;

  const raw = state.view === 'raw';
  // The link that was under the pointer is about to stop existing, and a node
  // that is gone never reports the pointer leaving it.
  hidePeek();
  hoverNode = null;
  // The document's own HTML is let through by the renderer, so this is where
  // what would run in it is taken out -- see src/sanitize.js.
  doc.innerHTML = sanitizeDocument(raw ? d.rawHtml : d.html);
  doc.classList.toggle('raw-view', raw);

  const view = $('view');
  view.dataset.view = state.view;
  view.setAttribute('aria-pressed', String(raw));
  view.title = raw ? 'Show rendered (r)' : 'Show raw source (r)';
  view.setAttribute('aria-label', view.title);

  applyMarks();
  applyAcks();
  paintHistory(d);
  paintToc(d);
  paintCount();
  paintRuler();
  state.changeIndex = -1;
  drawDiagrams();
  // The marks just drawn over are gone with the rest of `#doc`'s old markup;
  // a find still open has to be redone against the document now on screen,
  // not scrolled to again -- the repaint is not something the reader asked for.
  if (!$('findBar').hidden) {
    find.matches = markMatches(find.query);
    const last = find.matches.length - 1;
    find.index = last < 0 ? -1 : Math.max(0, Math.min(find.index, last));
    paintFindCount();
    highlightCurrent();
  }
}

/**
 * The open files, one row each. The list lives in the sidebar; with it closed
 * the chevron next to the filename opens the same list as a menu, and appears
 * only once there is more than one file to choose between.
 */
function paintTabs() {
  $('tabMenu').hidden = state.side || state.tabs.length < 2;
  if ($('tabMenu').hidden) closeTabMenu();
  if (!state.side) return;

  $('fileList').replaceChildren(
    ...state.tabs.map((t) => {
      const el = document.createElement('button');
      el.className = t.id === state.docId ? 'tab on' : 'tab';
      el.title = t.path;
      el.ariaCurrent = t.id === state.docId ? 'true' : 'false';
      el.addEventListener('click', () => native.selectTab(t.id));
      el.addEventListener('auxclick', (e) => e.button === 1 && native.closeTab(t.id));

      // Name over directory: two files called README.md are told apart by the
      // only thing that differs, and it is the line that can be clipped.
      const label = document.createElement('span');
      label.className = 'label';
      const name = document.createElement('span');
      name.className = 'label-name';
      name.textContent = t.name;
      const dir = document.createElement('span');
      dir.className = 'label-dir';
      dir.textContent = ltrPath(t.dir);
      label.append(name, dir);

      const x = document.createElement('span');
      x.className = 'x';
      x.role = 'button';
      x.innerHTML =
        '<svg class="i" viewBox="0 0 16 16" aria-hidden="true">' +
        '<path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" /></svg>';
      x.title = `Close ${t.name}`;
      x.setAttribute('aria-label', x.title);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        native.closeTab(t.id);
      });

      el.append(label, x);
      return el;
    }),
  );
}

/** Remembered, because it is the kind of thing you set once and keep. */
function setSide(on, remember = true) {
  state.side = on;
  if (remember) localStorage.setItem('redline:side', on ? '1' : '0');
  document.documentElement.classList.toggle('side-open', on);
  const btn = $('side');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)';
  btn.setAttribute('aria-label', btn.title);
  // Opening a column changes what the window has left for the other one and
  // for the document, so both widths are worked out again from scratch.
  applyWidths();
  // The list is not built while the column is shut — there is nothing to
  // build it into — so opening it is what fills it.
  paintTabs();
}

/**
 * The contents, down the right, with a switch and a remembered state of its
 * own. Which is the whole point of its being a second column rather than a
 * second tab: where am I in this and what has changed since when are different
 * questions, and a reader following a long document through a review is asking
 * both of them at once.
 */
function setTocSide(on, remember = true) {
  state.tocSide = on;
  if (remember) localStorage.setItem('redline:toc', on ? '1' : '0');
  document.documentElement.classList.toggle('toc-open', on);
  const btn = $('tocBtn');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Hide contents (⌥⌘B)' : 'Show contents (⌥⌘B)';
  btn.setAttribute('aria-label', btn.title);
  applyWidths();
  // Neither list is built while the column is shut — there is nothing to
  // build it into — so opening it is what fills both.
  if (state.data) {
    paintToc(state.data);
    paintHistory(state.data);
  }
}

// ---------- sidebar widths ----------

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
const storedW = (key) => clampSideW(Number(localStorage.getItem(key)));

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
function applyWidths() {
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
    localStorage.setItem(key, String(clampSideW(w)));
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

// ---------- contents height ----------

// Where History starts, under Contents, is something to drag too — the
// same deal as the two widths above, turned on its side. 180px is a default
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
 * agree, the same deal as the widths below.
 */
const barH = () => (document.documentElement.classList.contains('native') ? 38 : 34);

// The column's own padding (6px top and bottom) and the grip between the two
// sections (its own 9px, plus the 2px gap either side of it) are spoken for
// before either section sees a pixel of what is left.
const TOC_H_CHROME = 12 + 13;

const storedTocH = () => Number(localStorage.getItem(TOC_H_KEY)) || TOC_H_DEFAULT;

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
    localStorage.setItem(TOC_H_KEY, String(clampTocH(h)));
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

// ---------- sidebar disclosures ----------

// Open files and Contents each keep a disclosure: both sit at the top of
// their column, where you start, but both are also the thing you stop
// needing once a file is chosen or a document's shape is learned — and
// putting either away hands the whole column to the panel below it.
// Remembered, and applied before first paint (see the inline script in
// index.html), so nothing unfolds and folds again on open.

const SHUT_KEY = 'redline:shut';

const shutNow = () =>
  [...document.querySelectorAll('.side-twist')]
    .filter((b) => b.getAttribute('aria-expanded') === 'false')
    .map((b) => b.dataset.shut);

for (const twist of document.querySelectorAll('.side-twist')) {
  const open = !document.documentElement.classList.contains(`shut-${twist.dataset.shut}`);
  twist.setAttribute('aria-expanded', String(open));
  twist.addEventListener('click', () => {
    const on = twist.getAttribute('aria-expanded') === 'true';
    twist.setAttribute('aria-expanded', String(!on));
    document.documentElement.classList.toggle(`shut-${twist.dataset.shut}`, on);
    localStorage.setItem(SHUT_KEY, JSON.stringify(shutNow()));
    // A list coming back should open already pointing at where you are in the
    // document, not at the top of it.
    if (!on) spyToc();
  });
}

/** The chevron's list — the sidebar's rows, for when the sidebar is closed. */
function openTabMenu() {
  const list = $('tabList');
  list.replaceChildren(
    ...state.tabs.map((t) => {
      const b = document.createElement('button');
      b.title = t.path;

      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = t.id === state.docId ? '✓' : '';

      const label = document.createElement('span');
      label.className = 'label';
      const name = document.createElement('span');
      name.className = 'label-name';
      name.textContent = t.name;
      const dir = document.createElement('span');
      dir.className = 'label-dir';
      dir.textContent = ltrPath(t.dir);
      label.append(name, dir);

      b.append(tick, label);
      b.addEventListener('click', () => {
        closeTabMenu();
        native.selectTab(t.id);
      });
      return b;
    }),
  );

  list.hidden = false;
  $('tabMenu').setAttribute('aria-expanded', 'true');
  // Under the chevron, nudged back inside the window if it would hang off.
  const left = $('tabMenu').getBoundingClientRect().left - 6;
  list.style.left = `${Math.max(6, Math.min(left, innerWidth - list.offsetWidth - 6))}px`;
}

function closeTabMenu() {
  $('tabList').hidden = true;
  $('tabMenu').setAttribute('aria-expanded', 'false');
}

$('tabMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('tabList').hidden) openTabMenu();
  else closeTabMenu();
});
document.addEventListener('click', () => closeTabMenu());
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeTabMenu());

/**
 * The marks on or off. There is no button for this: the choice is the far end
 * of "what am I comparing against", so it is made where that is made — the
 * newest row in the history, which is the file against itself. The class does
 * the hiding, so the baseline underneath is not given up and turning the marks
 * back on costs no round trip.
 */
function applyMarks() {
  document.documentElement.classList.toggle('no-diff', !state.diff);
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

const drawDiagrams = (root = doc) => Promise.all([drawMermaid(root), drawPlantuml(root)]);

// `toggle` does not bubble, so listen in the capture phase.
doc.addEventListener('toggle', (e) => drawDiagrams(e.target), true);

darkMode.addEventListener('change', () => {
  mermaid?.initialize(mermaidConfig());
  paint(); // re-paints from source, so diagrams redraw in the new theme
});

/**
 * A path, wrapped so it reads left to right inside a box that clips from the
 * left. `.name-dir` / `.label-dir` are `direction: rtl` to put the ellipsis at
 * the front; without an isolate around the text, the leading slash is a
 * neutral character and lands at the far end instead — `/tmp/x` as `tmp/x/`.
 */
const ltrPath = (p) => (p ? `\u2066${p}\u2069` : '');

// ---------- link peek ----------

// Where a link goes, while the pointer is on it. Link text is written to read
// well \u2014 "the design doc", "see below" \u2014 and says nothing about where it
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
const HAS_SCHEME = /^[a-z][a-z0-9+.\-]*:|^\/\//i;
/** A link this app can answer: the extensions it opens on a command line. */
const MD_LINK = /\.(md|markdown|mdown|mkd|mdx|txt)$/i;

/**
 * Walk a relative link from the directory the document is in. Done here rather
 * than with `new URL`, which would resolve it against this page's address: a
 * `../` from the root that a loopback server serves from clamps away silently,
 * turning a real sibling directory into the wrong file with no sign of it.
 */
function walkPath(dir, rel) {
  const parts = dir.split('/');
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg !== '..') parts.push(seg);
    // Only the filesystem root is above everything; a link cannot climb past it.
    else if (parts.length > 1) parts.pop();
  }
  return parts.join('/') || '/';
}

/**
 * `~` for home, matching the directory under the filename and the sidebar.
 *
 * Home is worked out from the pair the document already carries \u2014 its real
 * directory and the shortened one \u2014 rather than resolving against the short
 * form directly, so a link that climbs above home comes out as the path it
 * actually points at instead of being quietly clamped to `~`.
 */
function shorten(abs, d) {
  const cut = d.dirLabel.startsWith('~') ? d.dir.length - d.dirLabel.length + 1 : -1;
  const home = cut >= 0 ? d.dir.slice(0, cut) : '';
  if (!home) return abs;
  if (abs === home) return '~';
  return abs.startsWith(home + '/') ? '~' + abs.slice(home.length) : abs;
}

/**
 * A destination written the way the document's author would recognise it: a URL
 * in full, an in-page jump as the anchor it lands on, and a link to a file
 * beside this one as that file's path.
 *
 * The last two are where a browser's own answer would be no help. Both are
 * served over loopback, so Chrome would show `http://127.0.0.1:53219/?id=8f2\u2026`
 * \u2014 the port this reader happens to have started on, and never what was
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
function linkTarget(href) {
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

function hidePeek() {
  if (peek.hidden) return;
  peek.hidden = true;
  peek.textContent = '';
}

doc.addEventListener('pointerover', (e) => showPeek(linkAt(e.target)));
doc.addEventListener('pointerout', (e) => {
  // Crossing between the pieces of one link \u2014 a bold word inside it, a line
  // break \u2014 fires out and then over again. Only leaving the link clears it.
  if (!linkAt(e.relatedTarget)) hidePeek();
});

// Tab to a link and the same question wants the same answer.
doc.addEventListener('focusin', (e) => showPeek(linkAt(e.target)));
doc.addEventListener('focusout', () => hidePeek());

// Scrolling moves both of these. The peek goes because the pointer has not
// moved and nothing else will say the link left it — under the pointer after a
// scroll is whatever scrolled into that spot; the contents list follows because
// where you are in the document is what it is for.
pane.addEventListener('scroll', () => {
  hidePeek();
  queueSpy();
});
// An external link that has just taken the focus to a browser is behind us.
addEventListener('blur', hidePeek);

// ---------- contents ----------

// The document's own headings, down the side. A long file is not navigable by
// scrolling, and the shape of one — what it covers, how deep it goes — is not
// visible from any one screen of it. The list answers both, and it is the
// document's own structure rather than anything this app invented: the server
// walks the source once and sends the headings with the render (see `outline`).
//
// Rows indent by heading level, capped: a document nested six deep would
// otherwise spend the whole column on whitespace.

/** Where the pane's text starts, which is what "at the top" is measured against. */
const paneTop = () => pane.getBoundingClientRect().top;

/**
 * The element a heading row points at.
 *
 * Two views, two ways to find it. The rendered view has ids on its headings, so
 * the link a document writes itself (`[see below](#notes)`) and a row here both
 * land the same way. The raw view is the file's lines and has no ids at all, so
 * the row finds the line the heading is on instead.
 *
 * Looked up inside the document rather than with `document.getElementById`,
 * which would also answer with the app's own furniture: a heading called
 * "Name" slugs to `name`, and so does the filename in the toolbar.
 */
function headingNode(h) {
  if (state.view === 'raw') return doc.querySelector(`.raw-line[data-line="${h.line}"]`);
  return byId(h.id);
}

/** A node in the document by its id, for an id that came from the document. */
const byId = (id) => (id ? doc.querySelector(`#${CSS.escape(id)}`) : null);

/** Put a node at the top of the pane, where a heading you just jumped to belongs. */
function scrollToNode(node, smooth = true) {
  if (!node) return;
  const top = pane.scrollTop + node.getBoundingClientRect().top - paneTop() - 8;
  pane.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'instant' });
}

function paintToc(d) {
  const heads = d.toc ?? [];
  // Dropped before anything else: the rows point at nodes in a document that
  // has just been replaced, and whatever follows must not be able to read them.
  state.toc = [];
  state.tocAt = -1;

  // A document whose only heading is its title has no contents — a list of one
  // row saying what the toolbar already says. The column stays and says so,
  // rather than taking itself away: whether it is open is the reader's
  // standing choice, and a column that shut itself on one document and came
  // back on the next would be the window rearranging itself as you read.
  const has = heads.length > 1;
  $('tocCount').textContent = has ? String(heads.length) : '';
  if (!state.tocSide) return;
  if (!has) {
    $('tocList').replaceChildren(el('p', 'side-empty', 'No headings in this document.'));
    return;
  }

  // Indented against the shallowest heading in this document rather than
  // against h1, because plenty of files start at `##` and would otherwise sit
  // in from the edge for no reason.
  const top = Math.min(...heads.map((h) => h.level));
  state.toc = heads.map((h) => {
    const row = el('button', h.level === top ? 'toc toc-top' : 'toc');
    row.type = 'button';
    row.style.paddingLeft = `${8 + Math.min(h.level - top, 4) * 10}px`;
    // An empty heading is a real heading — it is somewhere the document goes —
    // and still needs a row you can hit.
    row.textContent = h.text || '—';
    row.title = h.text;
    // Resolved here and kept, not looked up per click or per scroll: the whole
    // document is replaced on every paint and this runs with it, so the node is
    // never staler than the list itself.
    const node = headingNode(h);
    row.addEventListener('click', () => scrollToNode(node));
    return { h, row, node };
  });
  $('tocList').replaceChildren(...state.toc.map((t) => t.row));
  spyToc();
}

/**
 * Mark the heading you are reading under: the last one whose top has gone past
 * the top of the pane. Scrolled into view only when it changes, so a long
 * document does not fight the list's own scrollbar on every frame.
 */
function spyToc() {
  if (!state.toc.length) return;
  const limit = paneTop() + 8;
  let at = 0;
  for (let i = 0; i < state.toc.length; i++) {
    // A heading only in the baseline has no node in this view; it keeps its row
    // — the list is the document's shape — but there is nowhere to go to.
    const { node } = state.toc[i];
    if (node && node.getBoundingClientRect().top <= limit) at = i;
  }
  if (at === state.tocAt) return;
  state.tocAt = at;
  state.toc.forEach(({ row }, i) => {
    row.classList.toggle('on', i === at);
    row.ariaCurrent = i === at ? 'true' : 'false';
  });
  state.toc[at].row.scrollIntoView({ block: 'nearest' });
}

// Coalesced to one a frame: scroll fires far more often than the list can
// usefully change, and every call measures every heading.
let spying = false;
function queueSpy() {
  if (spying) return;
  spying = true;
  requestAnimationFrame(() => {
    spying = false;
    spyToc();
  });
}

/**
 * A link into the document itself. The browser would handle it, but only in the
 * rendered view and only by putting the heading wherever it happens to land;
 * this puts it at the top of the pane in either view, and leaves the address
 * alone — a fragment in the URL would be one more thing a reload has to undo.
 */
doc.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  const id = a && decodeURIComponent(a.getAttribute('href').slice(1));
  if (!id) return;
  const head = (state.data?.toc ?? []).find((h) => h.id === id);
  // A link to something that is not a heading — an anchor the author wrote
  // themselves — is still a link into the document.
  const node = head ? headingNode(head) : byId(id);
  if (!node) return;
  e.preventDefault();
  scrollToNode(node);
});

/**
 * A link that leaves the document.
 *
 * Neither shell can let the browser have this one. A relative link is written
 * against the directory the file is filed in — `./api.md`, `../adr/0004.md` —
 * and that is not where either shell is serving from: a browser tab is a
 * loopback port that answers `./api.md` with 404, and the desktop app is a
 * webview with no address to resolve against and no Back to return from. Both
 * do know which directory the document came out of, which is the only fact
 * the link was ever missing.
 *
 * Where it goes once resolved is the one real difference between the two. The
 * app has windows, so a referenced file gets one of its own and the document
 * you came from stays open behind it. A tab has no windows to give, so it goes
 * where a link goes in a browser: in place, with the address updated, so
 * Reload comes back to what is on screen.
 */
doc.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href]');
  const href = a?.getAttribute('href')?.trim();
  if (!href || href.startsWith('#')) return; // in-page jumps are handled above

  // Something with a scheme is the browser's business, and in a window that
  // has no browser it is the real browser's business.
  if (HAS_SCHEME.test(href)) {
    if (!native) return;
    e.preventDefault();
    // Anything else — a scheme this app has no business following.
    if (/^(https?:|mailto:)/i.test(href)) native.openExternal(href);
    return;
  }

  // Held either way, even when nothing comes of it: a relative link to an
  // image, a directory, or a file this reader does not open would otherwise
  // navigate the page off the document, and going nowhere beats going wrong.
  e.preventDefault();
  const abs = linkTarget(href);
  if (!abs) return;
  if (native) native.openPaths([abs]);
  else openFile(abs);
});

// ---------- history ----------

// Every version of the document, newest first. The list is in the sidebar and
// not on the toolbar because a history gets long, and because a row has the
// room to say what a version actually is — when it is from, how far it moved,
// which commit it was — where a dropdown on a one-line bar has room for none
// of that. Picking a row is how you choose what the file is compared against.
//
// It is also the only place that is asked. The bar used to carry a shortlist of
// the same versions and a button for the read mark; both said, less well, what
// a row here says in place — so the bar now holds what the document is and what
// the app is showing, and everything about versions is here.

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const AGO = [
  ['year', 31557600],
  ['month', 2629800],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** Said in full: a row down the side has the room a toolbar never had. */
function longAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  for (const [unit, secs] of AGO) {
    if (s >= secs) return rtf.format(-Math.round(s / secs), unit);
  }
  return rtf.format(-1, 'minute');
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const DATE_YEAR = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A name for a version nobody named.
 *
 * "9 hours ago" cannot be one. It is a different string every time you look at
 * it, so the row you meant to come back to is not called what it was called;
 * and an evening of saves says it four times over, so it does not pick out a
 * row either. A clock time does both: it holds still, and two versions of one
 * file rarely land in the same minute.
 */
function clockName(ts) {
  const then = new Date(ts);
  const now = new Date();
  const days = Math.round((midnight(now) - midnight(then)) / 86400000);
  const at = CLOCK.format(then);
  if (days <= 1) return `${capital(rtf.format(-days || 0, 'day'))} ${at}`;
  if (then.getFullYear() === now.getFullYear()) return `${DATE.format(then)}, ${at}`;
  return `${DATE_YEAR.format(then)}, ${at}`;
}

/** Bytes as a person says them, and never to more precision than is real. */
function bytes(n) {
  const abs = Math.abs(n);
  if (abs < 1024) return `${n} B`;
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(abs < 10240 ? 1 : 0)} kB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Whether this row is what the document is being compared against — which is a
 * version whether it was picked by name or reached through the "last read"
 * pointer, and the list should say so either way.
 *
 * The newest row is the other end of the same question: comparing the file
 * against itself is the plain document, which is the marks put away.
 */
function isBaseline(d, v) {
  if (v.current) return !state.diff;
  if (!state.diff) return false;
  if (d.baseline === `snap:${v.hash}`) return true;
  if (d.baseline === 'read') return v.baseline;
  // git HEAD has no row of its own, and needs none: the newest version carrying
  // a commit is the newest commit that touched this file, which is exactly what
  // HEAD holds of it. Reached only through the Settings default.
  if (d.baseline === 'git:HEAD') return v.hash === d.history.find((h) => h.git)?.hash;
  return false;
}

function paintHistory(d) {
  const list = $('histList');
  const versions = d.history ?? [];

  $('histCount').textContent = versions.length > 1 ? String(versions.length) : '';
  $('histClear').hidden = versions.length < 2;
  if (!state.tocSide) return;

  if (versions.length < 2) {
    list.replaceChildren(el('p', 'side-empty', 'No earlier versions yet.'));
    return;
  }
  list.replaceChildren(
    ...versions.map((v, i) =>
      state.pruneAsk === v.hash ? pruneAskRow(v, versions.length - i) : versionRow(d, v, i),
    ),
  );
}

function versionRow(d, v, i) {
  const row = el('button', 'ver');
  row.type = 'button';
  // A committed version is better named by its commit than by our hash of its
  // bytes: the subject is what the person who wrote it chose to call it. One
  // that was only ever saved has no such name, so it is called when it was.
  const name = v.git ? v.git.subject || 'Commit' : clockName(v.ts);
  // Everything a 236 px column had to shorten: the whole of a subject, the
  // exact time behind both the clock above and the "9 hours ago" below, and
  // the hash that used to sit in the row itself — a row already carrying a
  // name and two flags had no room left to spend on an identifier nobody
  // reads at a glance, so it moved here instead of disappearing.
  const when = new Date(v.ts).toLocaleString();
  row.title = v.git
    ? `${name}\n${when} · commit ${v.git.sha.slice(0, 12)}`
    : `${when} · ${v.hash.slice(0, 12)}`;
  if (isBaseline(d, v)) {
    row.classList.add('on');
    row.setAttribute('aria-current', 'true');
  }

  const text = el('span', 'ver-text');

  const top = el('span', 'ver-top');
  top.append(el('span', 'ver-name', name));
  // "now" is the file as it stands on disk; "read" is the version the change
  // marks are measured from. They can be the same version, and often are. Set
  // as quiet text rather than a filled chip — the row already says which
  // version it is by its name, so these are a note, not a badge.
  const flags = [v.current && 'now', v.baseline && 'read'].filter(Boolean);
  if (flags.length) top.append(el('span', 'ver-flags', flags.join(' · ')));

  // Underneath, the particulars, in one shape for every row: how long ago this
  // was, and how far the file moved arriving here.
  const sub = el('span', 'ver-sub');
  const moved = v.delta
    ? `${v.delta > 0 ? '+' : '−'}${bytes(Math.abs(v.delta))}`
    : v.size == null
      ? ''
      : bytes(v.size);
  sub.append(el('span', 'ver-note', [longAgo(v.ts), moved].filter(Boolean).join(' · ')));
  text.append(top, sub);
  row.append(text);

  // The version on disk: picking it leaves nothing to compare, which is the
  // document read plainly. It is still not a version to throw away, though —
  // everything else in the list is compared against it.
  if (v.current) {
    row.classList.add('head');
    // Added to rather than replacing: what the click does is worth saying, but
    // not at the price of the one place the exact time is written out.
    row.title += '\nRead the file as it is now, with nothing compared';
    row.addEventListener('click', () => {
      state.pruneAsk = null;
      setMarks(false);
    });
    return row;
  }

  row.addEventListener('click', () => {
    state.pruneAsk = null;
    // Marks on first: picking a version to compare against and seeing nothing
    // marked would look like the click missed. It also keeps the scroll anchored
    // across the blocks that hiding the marks had collapsed.
    setMarks(true);
    // Named outright, which is also how the choice sticks: the reader keeps
    // the baseline it was asked for by name, and hands it back the next time
    // this document is opened. Nothing to store here.
    //
    // The row carrying the read mark is named as `read` rather than by its
    // hash, because that is what the row means: the version counted as read,
    // which moves as you read rather than staying where it is now. It is also
    // the way back — a choice is kept from now on, so naming that row by hash
    // would pin the document to it with nothing in the list to unpin it.
    state.baseline = v.baseline ? 'read' : `snap:${v.hash}`;
    load({ keepScroll: true });
  });
  // How many would go with it: this row and every row under it, which is the
  // same arithmetic the confirmation does.
  row.append(cutButton(v, d.history.length - i));
  return row;
}

/**
 * Whether the read mark is already on the version on disk, and so whether
 * there is anything left for `m` to do.
 */
function readDone(d) {
  const at = d?.history?.find((v) => v.baseline);
  return !at || at.current;
}

/**
 * Move the read mark to the version on disk. It is about the stored pointer
 * rather than what is on screen, so it works just as well while looking at an
 * older version or with the marks off.
 *
 * There is no control for this on the row any more. The row it would have sat
 * on is the one you click to compare against that version, and the two did
 * very nearly the same thing from an inch apart — a clean document either way.
 * What is left is the part the list cannot do: saying "I have seen this"
 * without opening the sidebar at all. Hence `m`, ⇧⌘M and the View menu, and
 * the `read` chip to say where the mark ended up.
 */
async function markRead() {
  const y = pane.scrollTop;
  adopt(await backend.markRead());
  paint();
  pane.scrollTo(0, y);
}

/**
 * Forget this version and everything behind it — the only destructive act here.
 *
 * It was a bin, which was the wrong sign: a bin on a row promises to remove
 * that row, and this removes the row and every row under it. It was open
 * scissor blades after that, cutting being the right verb — but at the size
 * of a row they read as a stray mark more than a tool. What it draws now is
 * the line you'd cut along rather than the tool that cuts it: a perforation,
 * angled so it still reads as an edge and not a row of dots. Pointing at it
 * dims exactly what would go, so the scope is readable before the click
 * instead of only in the confirmation after it.
 */
function cutButton(v, n) {
  const cut = el('span', 'ver-cut');
  cut.role = 'button';
  cut.tabIndex = 0;
  cut.title =
    n === 1
      ? 'Forget this version'
      : `Forget these ${n} versions — this one and everything older`;
  cut.setAttribute('aria-label', cut.title);
  cut.innerHTML =
    '<svg class="i" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M2 12h5M4.5 8h5M7 4h5" /></svg>';

  // On the row rather than on the list, so the stylesheet can take it from
  // here with `~`: what goes is this row and every row below it, which is
  // exactly what a sibling combinator says.
  const mark = (on) => cut.closest('.ver')?.classList.toggle('cutting', on);
  cut.addEventListener('pointerenter', () => mark(true));
  cut.addEventListener('pointerleave', () => mark(false));
  cut.addEventListener('focus', () => mark(true));
  cut.addEventListener('blur', () => mark(false));

  const ask = (e) => {
    e.stopPropagation();
    state.pruneAsk = v.hash;
    paintHistory(state.data);
    $('histList').querySelector('.ask-go')?.focus();
  };
  cut.addEventListener('click', ask);
  cut.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && ask(e));
  return cut;
}

/** The row, turned into its own confirmation. `n` is how many would go. */
function pruneAskRow(v, n) {
  // `cutting` as well as `ask`: the repaint that puts the question here would
  // otherwise drop the dim that hovering the cut icon had just shown, exactly
  // when the question "how many is that?" is being asked. The number in the
  // text and the rows gone grey say the same thing twice, on purpose.
  const row = el('div', 'ver ask cutting');
  row.append(el('span', 'ask-text', `Forget ${n} version${n === 1 ? '' : 's'}?`));

  const go = el('button', 'btn ask-go', 'Forget');
  go.type = 'button';
  go.title = 'This cannot be undone';
  go.addEventListener('click', () => prune(v.hash));

  const no = el('button', 'btn ask-no', 'Cancel');
  no.type = 'button';
  no.addEventListener('click', () => {
    state.pruneAsk = null;
    paintHistory(state.data);
  });

  row.append(go, no);
  return row;
}

async function prune(upto) {
  const y = pane.scrollTop;
  state.pruneAsk = null;
  // The version being compared against may be one of the ones just forgotten;
  // the payload says what it fell back to.
  adopt(await backend.prune(upto, state.baseline));
  paint();
  pane.scrollTo(0, y);
}

$('histClear').addEventListener('click', () => {
  // "Clear" is the same act as forgetting everything below the current
  // version, so it asks in the same place, on that row.
  const second = state.data?.history?.[1];
  if (!second) return;
  state.pruneAsk = second.hash;
  paintHistory(state.data);
  $('histList').querySelector('.ask-go')?.focus();
});

// And it previews the same way the cut icon does, from the row it would cut at —
// everything but the version on disk. A button under the list says what it
// acts on far less plainly than the list going dim does.
for (const [on, when] of [
  [true, 'pointerenter'],
  [false, 'pointerleave'],
  [true, 'focus'],
  [false, 'blur'],
]) {
  $('histClear').addEventListener(when, () => {
    $('histList').children[1]?.classList.toggle('cutting', on);
  });
}

/** The changes still asking to be looked at — a checked one is not one of them. */
function changeNodes() {
  return [...doc.querySelectorAll('[data-chg]')].filter((n) => !n.classList.contains('chg-ok'));
}

function paintCount() {
  // Counted from the list the payload carries rather than from the page, so the
  // number is the same in either view: the raw view is the file's own lines and
  // has no blocks to check off, and it should not therefore disagree about how
  // much of the document is still unread.
  const changes = state.data?.changes ?? [];
  const live = changes.filter((c) => !state.acked.has(c.key));
  const of = (kind) => live.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
  const added = of('add');
  const modified = of('mod');
  const removed = of('del');
  const done = changes.length - live.length;

  const count = $('count');
  count.hidden = live.length === 0 || !state.diff;
  count.innerHTML = live.length
    ? [
        added && `<span class="c-add" title="${added} added">+${added}</span>`,
        modified && `<span class="c-mod" title="${modified} changed">~${modified}</span>`,
        removed && `<span class="c-del" title="${removed} removed">−${removed}</span>`,
      ]
        .filter(Boolean)
        .join('')
    : '';

  const ack = $('ackCount');
  ack.hidden = done === 0 || !state.diff;
  ack.innerHTML = `${TICK_SVG}${done}`;
  ack.title = `${done} change${done === 1 ? '' : 's'} checked off — bring them back (⇧C)`;
  ack.setAttribute('aria-label', ack.title);

  const hasNav = state.diff && changeNodes().length > 0;
  $('prev').hidden = $('next').hidden = !hasNav;
  // It separates a pair; with nothing on its left it would be a line on its own.
  $('divide').hidden = count.hidden && ack.hidden && !hasNav;
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

const ruler = $('ruler');

/** Everything the ruler stands for: marked blocks rendered, marked lines raw. */
const rulerNodes = () => doc.querySelectorAll('[data-chg], .raw-del');

// `.chg:hover` tints the paragraph itself in pure CSS, since tag and text are
// right there together — but the ruler mark for it lives in a different part
// of the DOM, out of any CSS selector's reach, so naming it needs JS. Delegated
// on `doc` rather than bound per node, because the blocks are replaced whole on
// every paint (see `paint`); `pointerover`/`pointerout` bubble, unlike `enter`/
// `leave`, which is what makes delegating them possible at all.
let hoverNode = null;
doc.addEventListener('pointerover', (e) => {
  const node = e.target.closest('[data-chg], .raw-del');
  if (node === hoverNode) return;
  hoverNode = node;
  highlightRulerCurrent();
});
doc.addEventListener('pointerout', (e) => {
  const node = e.target.closest('[data-chg], .raw-del');
  // Moving between two elements inside the same block re-fires over/out on
  // its descendants; only actually leaving the block should drop the mark.
  if (node !== hoverNode || node?.contains(e.relatedTarget)) return;
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
let hoverMark = null;
ruler.addEventListener('pointerover', (e) => {
  const mark = e.target.closest('.ruler-mark');
  if (!mark || mark === hoverMark) return;
  hoverMark = mark;
  for (const node of mark._nodes) node.classList.add('chg-hot');
  hoverNode = mark._nodes[0];
  highlightRulerCurrent();
});
ruler.addEventListener('pointerout', (e) => {
  const mark = e.target.closest('.ruler-mark');
  if (mark !== hoverMark || mark?.contains(e.relatedTarget)) return;
  hoverMark = null;
  for (const node of mark._nodes) node.classList.remove('chg-hot');
  hoverNode = null;
  highlightRulerCurrent();
});

// A mark answers "where am I" as well as "take me there": the first node of
// its band lands the same way `n`/`p` would, and a band with no index of its
// own -- a raw-removed line, an already-checked change -- still scrolls,
// just with nothing for `c` to act on once it arrives (see `goToNode`).
ruler.addEventListener('click', (e) => {
  const mark = e.target.closest('.ruler-mark');
  if (!mark) return;
  const node = mark._nodes[0];
  state.changeIndex = changeNodes().indexOf(node);
  goToNode(node);
});

function paintRuler() {
  const on = state.diff && !!state.data;
  ruler.hidden = !on;
  if (!on) return void ruler.replaceChildren();

  const span = pane.scrollHeight;
  const track = ruler.clientHeight;
  // Nothing to scale against yet — a document mid-layout, or a window with no
  // height. The observer below brings us back once there is.
  if (span <= 0 || track <= 0) return void ruler.replaceChildren();

  // Rects are viewport coordinates; this is where the top of the scrolled
  // content sits in them, so subtracting it gives an offset into the document.
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  // Scaled against scrollHeight, tail padding included, because the ruler is
  // only worth anything if a mark is level with the thumb that reaches it.
  const at = (y) => (y / span) * track;

  // The one change `n`/`p` last took you to, or the one the pointer is over
  // right now — so the ruler can answer "where am I" as well as "where are
  // the changes", the way the scrollbar thumb answers it for scroll position.
  const current = hoverNode ?? (state.diff ? changeNodes()[state.changeIndex] : undefined);

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
    const isCurrent = node === current;
    const top = at(rect.top - origin);
    const bottom = at(rect.bottom - origin);
    const last = bands.at(-1);
    // Forty consecutive changed lines are one change to the eye and forty
    // nodes to the DOM. Touching bands of the same kind merge, or the ruler
    // becomes a dotted line whose gaps mean nothing.
    if (last && last.kind === kind && last.ok === ok && top <= last.bottom + 1) {
      last.bottom = Math.max(last.bottom, bottom);
      last.current = last.current || isCurrent;
      last.nodes.push(node);
    } else {
      bands.push({ kind, ok, top, bottom, current: isCurrent, nodes: [node] });
    }
  }

  ruler.replaceChildren(
    ...bands.map(({ kind, ok, top, bottom, current, nodes }) => {
      const cls =
        `ruler-mark ruler-${kind}${ok ? ' ruler-ok' : ''}` + (current ? ' ruler-current' : '');
      const mark = el('div', cls);
      // Floored to something you can see: one edited line in a long file is a
      // fraction of a pixel, and being seeable is the whole job.
      const height = Math.max(3, bottom - top);
      mark.style.top = `${Math.max(0, Math.min(top, track - height))}px`;
      mark.style.height = `${height}px`;
      // Kept for `highlightRulerCurrent` below, so hover and `n`/`p` can flip
      // the one class that changes on the very element already on screen,
      // rather than rebuilding the ruler and losing the "before" a fade needs.
      mark._nodes = nodes;
      return mark;
    }),
  );
}

// Hover and `n`/`p` don't move a single mark or change how many there are —
// only which one is current — so answering them by calling `paintRuler` again
// would replace every mark with a fresh element for a CSS transition to find
// no "before" state on. This instead flips `.ruler-current` on the marks
// already drawn, which is what makes losing it fade rather than snap.
function highlightRulerCurrent() {
  const current = hoverNode ?? (state.diff ? changeNodes()[state.changeIndex] : undefined);
  for (const mark of ruler.children) {
    mark.classList.toggle('ruler-current', !!current && mark._nodes.includes(current));
  }
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

// ---------- checked-off changes ----------

// A change you have looked at and are done with. Its mark goes, it stops being
// counted, and n/p walk past it — so reading a heavily edited file is a matter
// of working down the marks until there are none left, rather than reading
// around a page of highlighting that stays exactly as loud as when you started.
//
// Not the same as marking the version read, which says "all of this is seen"
// and moves what everything is measured from. This says "that bit is seen", one
// block at a time, and the file has still moved.

const TICK_SVG =
  '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.4 3 3 6-6.9" /></svg>';

/** Every marked block the checked state applies to. The raw view has none. */
const ackNodes = () => [...doc.querySelectorAll('.chg[data-key]')];

function applyAcks() {
  for (const node of ackNodes()) {
    const on = state.acked.has(node.dataset.key);
    node.classList.toggle('chg-ok', on);
    const tag = node.querySelector(':scope > .chg-tag');
    if (!tag) continue;
    tag.title = on ? 'Bring this change back (c)' : 'Checked — put this mark away (c)';
    tag.setAttribute('aria-label', tag.title);
    tag.setAttribute('aria-pressed', String(on));
  }
}

/** Take the server's word for the list, which is the copy that outlives the tab. */
function adoptAcks(acked) {
  state.acked = new Set(acked);
  if (state.data) state.data.acked = acked;
  applyAcks();
  paintCount();
  paintRuler();
}

async function setAck(key, on) {
  // Taken here first so the click answers at once, and anchored because putting
  // a deleted block away takes it out of the page and moves the text below it.
  keepAnchored(() => {
    if (on) state.acked.add(key);
    else state.acked.delete(key);
    applyAcks();
    paintCount();
  });
  paintRuler();
  // What the change was, as well as its name: the version this page is showing
  // and the change's own block in it, so that if the block is edited later it
  // comes back marked against what was read here (see `reader.ack`).
  const block = state.data?.changes?.find((c) => c.key === key)?.block;
  adoptAcks(await backend.ack({ key, on, at: state.data?.hash, block }));
}

async function clearAcks() {
  if (!state.acked.size) return;
  keepAnchored(() => {
    state.acked.clear();
    applyAcks();
    paintCount();
  });
  paintRuler();
  adoptAcks(await backend.ack({ clear: true }));
}

/**
 * The change `c` acts on: the one you were last taken to, and otherwise the
 * first one still on screen — so a run of them is n, c, n, c without having to
 * find and point at each mark.
 */
function changeUnderCursor() {
  const nav = changeNodes();
  const at = nav[state.changeIndex];
  if (at?.dataset.key) return at;
  const top = pane.getBoundingClientRect().top;
  return ackNodes().find((n) => n.getBoundingClientRect().bottom > top + 8) ?? null;
}

function tapCheck() {
  if (!state.diff) return;
  const node = changeUnderCursor();
  if (!node) return;
  const on = !state.acked.has(node.dataset.key);
  // The list it is in is about to be one shorter. Without this, `n` would step
  // over whichever change moves up into the place this one had.
  if (on && state.changeIndex >= 0) state.changeIndex--;
  setAck(node.dataset.key, on);
}

// The word in the margin naming the change is the button that puts it away —
// delegated, because the marks are re-rendered whole on every change to the file.
doc.addEventListener('click', (e) => {
  const tag = e.target.closest('.chg-tag');
  const key = tag && tag.closest('[data-key]')?.dataset.key;
  if (!key) return;
  setAck(key, !state.acked.has(key));
});

$('ackCount').addEventListener('click', () => clearAcks());

// ---------- change navigation ----------

/**
 * The landing behaviour `n`/`p` and a ruler click share: scroll, flash, and
 * bring the ruler's own idea of "current" along with it. Takes any node, not
 * only one `changeNodes()` knows about -- a raw-removed line or an
 * already-checked change lands here too, just without a `changeIndex` to show
 * for it.
 */
function goToNode(node) {
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

function goToChange(step) {
  if (!state.diff) return;
  const nodes = changeNodes();
  if (!nodes.length) return;
  state.changeIndex = (state.changeIndex + step + nodes.length * 2) % nodes.length;
  goToNode(nodes[state.changeIndex]);
}

// ---------- find ----------

// Find in the current document only -- there is no filename filter and no
// cross-document index here. `#doc` is replaced whole on every paint (see
// `paint`), so matches are never kept across one: they are found fresh each
// time the bar opens, the query changes, or the document repaints under it.
const find = { query: '', matches: [], index: -1 };

/** Every text node under `doc`, in document order -- what a match can touch. */
function textNodesIn(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n; (n = walker.nextNode()); ) nodes.push(n);
  return nodes;
}

// What a match is allowed to run across: the whole of one paragraph, heading,
// list item, table cell or code block -- however many inline tags are nested
// inside it -- and no further. Without a boundary here, concatenating every
// text node in the document with nothing between them would let a query match
// across two blocks that just happen to be adjacent in the markup, with no
// word break between them to say they were never one piece of text.
const FIND_BLOCK = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th,dt,dd,caption,.raw-line';
const blockOf = (node) => node.parentElement?.closest(FIND_BLOCK) ?? doc;

/**
 * Wrap every case-insensitive occurrence of `query` in `<mark class="search-hit">`
 * and return one array of marks per match, in document order.
 *
 * The search runs over the text nodes' content concatenated together, because
 * a match can cross the boundary between two of them -- a search for "release
 * notes" crosses the node boundary where `**release**` ends. A match found
 * that way is then rebuilt one touched node at a time rather than spliced
 * into a single element: nodes on either side of a tag boundary are not
 * siblings, so the match becomes more than one `<mark>` when it crosses one --
 * the same highlighted run to the eye, each piece kept in its own parent.
 */
function markMatches(query) {
  clearMatches();
  if (!query) return [];
  const nodes = textNodesIn(doc);
  const starts = [];
  let total = 0;
  for (const node of nodes) {
    starts.push(total);
    total += node.nodeValue.length;
  }
  const hay = nodes.map((n) => n.nodeValue).join('').toLowerCase();
  const needle = query.toLowerCase();

  // Where a block ends and the next begins, as an offset into `hay` -- a
  // match that straddles one of these is rejected rather than highlighted.
  const cuts = [];
  for (let i = 1; i < nodes.length; i++) {
    if (blockOf(nodes[i]) !== blockOf(nodes[i - 1])) cuts.push(starts[i]);
  }
  const crossesBlock = (start, end) => cuts.some((c) => c > start && c < end);

  const ranges = [];
  let from = 0;
  let at;
  while ((at = hay.indexOf(needle, from)) !== -1) {
    const end = at + needle.length;
    if (crossesBlock(at, end)) {
      from = at + 1;
      continue;
    }
    ranges.push({ start: at, end, marks: [] });
    from = end;
  }
  if (!ranges.length) return [];

  // One pass, one replacement per node: splitting a node for every match that
  // touches it (as `Node.splitText` would, called match by match) invalidates
  // the offsets of whichever match comes next in the same node. Slicing the
  // node's own text against every range that overlaps it, once, has no such
  // ordering problem.
  let r = 0;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodeStart = starts[i];
    const nodeEnd = nodeStart + node.nodeValue.length;
    while (r < ranges.length && ranges[r].end <= nodeStart) r++;
    const text = node.nodeValue;
    const parts = [];
    let cursor = 0;
    let touched = false;
    for (let j = r; j < ranges.length && ranges[j].start < nodeEnd; j++) {
      const range = ranges[j];
      const from = Math.max(range.start - nodeStart, 0);
      const to = Math.min(range.end - nodeStart, text.length);
      if (from > cursor) parts.push(document.createTextNode(text.slice(cursor, from)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.appendChild(document.createTextNode(text.slice(from, to)));
      parts.push(mark);
      range.marks.push(mark);
      cursor = to;
      touched = true;
    }
    if (!touched) continue;
    if (cursor < text.length) parts.push(document.createTextNode(text.slice(cursor)));
    node.replaceWith(...parts);
  }
  return ranges.map((range) => range.marks);
}

/** Undo `markMatches`, leaving the text exactly as `paint` last set it. */
function clearMatches() {
  for (const mark of doc.querySelectorAll('mark.search-hit')) mark.replaceWith(mark.firstChild);
  doc.normalize();
}

function paintFindCount() {
  $('findCount').textContent = find.matches.length
    ? `${find.index + 1} of ${find.matches.length}`
    : find.query
      ? 'No results'
      : '';
}

/** Mark which match is current without moving the page -- what a repaint needs. */
function highlightCurrent() {
  for (const marks of find.matches) for (const m of marks) m.classList.remove('current');
  const current = find.matches[find.index];
  if (!current) return;
  for (const m of current) m.classList.add('current');
}

/** And actually go there -- what opening the bar and stepping through it need. */
function revealCurrent() {
  highlightCurrent();
  find.matches[find.index]?.[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function runFind(query) {
  find.query = query;
  find.matches = markMatches(query);
  find.index = find.matches.length ? 0 : -1;
  paintFindCount();
  revealCurrent();
}

function stepFind(step) {
  if (!find.matches.length) return;
  find.index = (find.index + step + find.matches.length) % find.matches.length;
  paintFindCount();
  revealCurrent();
}

function openFind() {
  $('findBar').hidden = false;
  $('find').setAttribute('aria-pressed', 'true');
  const input = $('findInput');
  input.focus();
  input.select();
  if (input.value) runFind(input.value);
}

function closeFind() {
  if ($('findBar').hidden) return;
  $('findBar').hidden = true;
  $('find').setAttribute('aria-pressed', 'false');
  clearMatches();
  find.matches = [];
  find.index = -1;
  pane.focus({ preventScroll: true });
}

const toggleFind = () => ($('findBar').hidden ? openFind() : closeFind());

$('find').addEventListener('click', toggleFind);
$('findClose').addEventListener('click', closeFind);
$('findNext').addEventListener('click', () => stepFind(1));
$('findPrev').addEventListener('click', () => stepFind(-1));
$('findInput').addEventListener('input', (e) => runFind(e.target.value));
$('findInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    stepFind(e.shiftKey ? -1 : 1);
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeFind());

// ---------- events ----------

// "+4 ~1" raises the question "since what?", and the versions are the answer,
// so the count is also the way to them rather than a number you can only read.
// Clicking it again puts the column away: it is one button, one question.
$('count').addEventListener('click', () => setTocSide(!state.tocSide));

$('next').addEventListener('click', () => goToChange(1));
$('prev').addEventListener('click', () => goToChange(-1));

$('view').addEventListener('click', () => toggleView());

// Both columns and their keys work in a browser tab as much as in the
// desktop app; only the list of open files inside the left one is the
// shell's.
$('side').addEventListener('click', () => setSide(!state.side));
$('tocBtn').addEventListener('click', () => setTocSide(!state.tocSide));

// Run once with `remember` off, to set the buttons and the widths from the
// classes the inline script put on the root before first paint. Nothing is
// being chosen here, so nothing is written back.
setSide(state.side, false);
setTocSide(state.tocSide, false);

function setView(view) {
  // Keep the place, not the pixel: the two views agree on the file, and on
  // nothing else (see `sourceAt`).
  const at = sourceAt();
  state.view = view;
  localStorage.setItem('redline:view', view);
  paint();
  scrollToSource(at);
}

const toggleView = () => setView(state.view === 'raw' ? 'rendered' : 'raw');

// Switching views should leave you looking at the sentence you were looking at.
// The scroll offset cannot say that — the same paragraph is one height as prose
// and another as the lines of markdown it was written as, so the same number of
// pixels down is a different part of the document. What the two views do share
// is the file: every block of the render and every line of the source carries
// the line it came from (`data-line`, from `sourceLines` and `renderRawDiff`).
// So the place is read off as a line of the file — with the fraction, because a
// block can be a screen tall — and put back by the same measure on the far side.

/**
 * The last index where `holds` is true, given it is true for a prefix and false
 * after. A binary search rather than a scan because the blocks are siblings in
 * document order, so both the lines and the offsets only ever go up, and a long
 * file is thousands of them to measure on a keypress.
 */
function lastWhere(n, holds) {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (holds(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Everything on screen that knows where it is in the file, in file order.
 *
 * Whichever view is up answers: lines in the raw one, top-level blocks in the
 * rendered one. What is not the file is not in here — a deleted block, the
 * "before" inside a rewrite — which is the point, since neither is a place the
 * other view could show you.
 */
const anchors = () => doc.querySelectorAll('[data-line]');

/** Where the top edge of the pane is, as a line of the file, fractionally. */
function sourceAt() {
  const nodes = anchors();
  if (!nodes.length) return null;
  const edge = paneTop();
  const i = lastWhere(nodes.length, (k) => nodes[k].getBoundingClientRect().top <= edge);
  const box = nodes[i].getBoundingClientRect();
  const line = +nodes[i].dataset.line;
  // How far into the block the edge has cut, as a share of the lines it spans:
  // half way down a ten-line paragraph is line five, and that is a place the
  // other view has too — where "half way down the paragraph" is some other
  // number of pixels entirely.
  const span = spanOf(nodes, i, line);
  const into = box.height ? clamp((edge - box.top) / box.height, 0, 1) : 0;
  return line + into * span;
}

/** Put line `at` back at the top edge, as near as the other view can manage. */
function scrollToSource(at) {
  if (at == null) return;
  const nodes = anchors();
  if (!nodes.length) return;
  // The line may be one this view does not have a block for — the raw view has
  // every line of the file and the rendered one has a block per several — so
  // the block that holds it is the last one that starts at or before it.
  const i = lastWhere(nodes.length, (k) => +nodes[k].dataset.line <= at);
  const line = +nodes[i].dataset.line;
  const box = nodes[i].getBoundingClientRect();
  const span = spanOf(nodes, i, line);
  const into = clamp(at - line, 0, span) / span;
  pane.scrollBy(0, box.top - paneTop() + into * box.height);
}

/**
 * How many lines of the file a block covers: up to where the next one starts.
 * The last block has nothing after it to measure against and is taken as one
 * line, which costs nothing — the end of the document is already on screen.
 */
function spanOf(nodes, i, line) {
  const next = nodes[i + 1];
  return next ? Math.max(+next.dataset.line - line, 1) : 1;
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

const ANCHORABLE = 'h1,h2,h3,h4,h5,h6,p,ul,ol,pre,table,blockquote,.raw-line:not(.raw-del)';

/**
 * Run `fn`, then scroll so the block you were looking at is where you left it.
 * Hiding the marks removes whole deleted blocks, so the text below them moves.
 */
function keepAnchored(fn) {
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

function setDiff(on) {
  if (on === state.diff) return;
  keepAnchored(() => {
    state.diff = on;
    // The pre-paint mirror, so the marks never flash on for someone who
    // turned them off — see the inline script in index.html.
    localStorage.setItem('redline:diff', on ? '1' : '0');
    applyMarks();
    if (state.data) {
      // The history says what is being compared against, and with the marks off
      // the answer is "nothing" — the newest row.
      paintHistory(state.data);
      paintCount();
    }
  });
  // Turning the marks off takes the removed text out of the page, so the
  // document is a different height and every mark is somewhere else.
  paintRuler();
  drawDiagrams(); // diagrams in blocks that were hidden could not be measured
}

/**
 * The one switch for the marks, wherever it is thrown: the newest row in the
 * history, `d`, ⇧⌘D, or the Settings checkbox. It is remembered, so a document
 * opens the way you left the last one.
 */
function setMarks(on) {
  if (on === state.diff) return;
  setDiff(on);
  writeSettings({ marks: on });
}

const toggleDiff = () => setMarks(!state.diff);

/**
 * `m` and the menu item, and nothing when the mark is already on the version on
 * disk: pressing it twice should not cost a round trip and a repaint to leave
 * the document exactly as it was.
 */
function tapMarkRead() {
  if (!readDone(state.data)) markRead();
}

/**
 * The document pane is the scroll area rather than the page, so the keys that
 * scroll have to be aimed at it: whatever holds focus — a toolbar button, the
 * body — is not inside it, and the browser scrolls the page instead of it.
 * Returns whether the key was one of them.
 */
function scrollByKey(e) {
  const page = pane.clientHeight * 0.9;
  const step =
    { ArrowDown: 64, ArrowUp: -64, PageDown: page, PageUp: -page }[e.key] ??
    // Space pages down, shift-space up — unless a button has focus, where the
    // space bar belongs to the button.
    (e.key === ' ' && e.target === document.body ? (e.shiftKey ? -page : page) : null);

  if (step != null) {
    pane.scrollBy({ top: step, behavior: Math.abs(step) > 100 ? 'smooth' : 'instant' });
    return true;
  }
  if (e.key === 'Home' || e.key === 'End') {
    pane.scrollTo({ top: e.key === 'Home' ? 0 : pane.scrollHeight, behavior: 'smooth' });
    return true;
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  // Settings is modal: the letters belong to it while it is up.
  if ($('prefs').open) return;
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (scrollByKey(e)) return e.preventDefault();
  const key = e.key.toLowerCase();
  if (key === 'r') toggleView();
  else if (key === 'd') toggleDiff();
  else if (key === 'n' || key === 'j') goToChange(1);
  else if (key === 'p' || key === 'k') goToChange(-1);
  else if (key === 'm') tapMarkRead();
  // Next to n and p on purpose: working through a set of edits is n, c, n, c.
  else if (key === 'c') e.shiftKey ? clearAcks() : tapCheck();
  else return;
  e.preventDefault();
});

// ---------- native shell ----------
// Everything here is a no-op in a plain browser tab: `window.mdNative` is put
// up by the desktop build (src/native-tauri.js) and by nothing else, so the
// same file is the whole app in a window and the whole app in a tab.

const native = window.mdNative;
// Resolved once `onTabs`'s first event has shown a document -- the window is
// revealed once this settles (see the bottom of this file) rather than after
// this module's own `load()`, which a native window never calls: asking for
// no document in particular would race the shell's answer for which one its
// tabs say to show, and whichever of the two happened to resolve last would
// win, even if it was the guess.
let openedFirstTab = () => {};
const firstTabShown = new Promise((resolve) => {
  openedFirstTab = resolve;
});
if (native) {
  const root = document.documentElement;
  root.classList.add('native', `platform-${native.platform}`);
  native.onFullscreen((on) => root.classList.toggle('fullscreen', on));

  native.onToggleView(() => toggleView());
  native.onToggleDiff(() => toggleDiff());
  native.onNextChange(() => goToChange(1));
  native.onPrevChange(() => goToChange(-1));
  native.onMarkRead(() => tapMarkRead());
  native.onFind(() => openFind());
  $('newTab').addEventListener('click', () => native.pickFile());
  native.onToggleSide(() => setSide(!state.side));
  native.onToggleToc(() => setTocSide(!state.tocSide));

  native.onTabs(({ tabs, active }) => {
    state.tabs = tabs;
    // Never asked for either way: the sidebar shows itself the moment there
    // is more than one file to choose between, which is when it earns its
    // width. After that the toggle is the answer and this stops second
    // guessing it.
    if (localStorage.getItem('redline:side') === null && tabs.length > 1) setSide(true, false);
    const switching = active && active !== state.docId;
    if (switching) {
      scrollMemory.set(state.docId, pane.scrollTop);
      setDocId(active);
    }
    paintTabs();
    if (!switching) {
      openedFirstTab();
      return;
    }
    // A different document on the server: the old event stream was the old
    // one's, and the baseline choice does not carry across files — each one is
    // compared against what it was last compared against, not against what the
    // tab you came from was on.
    connect();
    state.baseline = keptBaseline();
    load({ keepScroll: false })
      .then(() => {
        pane.scrollTo(0, scrollMemory.get(active) ?? 0);
        // Picking a tab redraws the list under the click, so focus would be left
        // nowhere and the arrow keys would stop scrolling.
        const held = document.activeElement;
        if (held === document.body || held?.closest('.side, .menu')) {
          pane.focus({ preventScroll: true });
        }
      })
      .finally(openedFirstTab);
  });

  // Now that the handler is up, ask: the window's first push can land before
  // this module has finished evaluating, and there is no catching up after.
  native.requestTabs();

  // A file being dragged over the window. The shell says so rather than the
  // page watching for it, and the shell does the opening too: a dropped file
  // belongs to the window, and what a webview is handed has no path in it.
  native.onDrag((over) => root.classList.toggle('dropping', over));

  // Links out of the document are followed in one place for both shells —
  // see the click handler under "contents".
}

// ---------- settings ----------

// What is worth a setting: the things you decide once and want kept — how the
// app looks, what it does when it starts, how the document reads, and what
// "changed" is measured against. Everything else stays on the toolbar, where
// it is one click away and belongs to the moment rather than to you.
//
// The desktop app keeps them beside the window state, so every window agrees
// and the shell can act on the ones that are its own (theme, launch, Finder);
// a browser tab keeps its own copy and simply never shows those rows.

const DEFAULT_SETTINGS = {
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

let settings = { ...DEFAULT_SETTINGS };

/** A font name goes into a stylesheet, so keep it to what a name can be. */
const cleanFontName = (s) =>
  String(s ?? '')
    .replace(/[\p{C}"'\\;{}]/gu, '')
    .trim();

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
 * asking the OS is not a thing you can do (src/fonts.js is macOS only).
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
}).map(([label, names]) => [label, names.split(',').map((n) => n.trim())]);

/**
 * What the typeface popup is on. A picked face is stored as `font: 'custom'`
 * with its name beside it — and `custom` with nothing named renders as the
 * system font, so that is what the popup should say it is.
 */
const fontValue = () => {
  if (settings.font !== 'custom') return settings.font;
  const named = cleanFontName(settings.fontName);
  return named ? `name:${named}` : 'sans';
};

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
 * Each entry is drawn in its own face where the platform lets a popup do that,
 * and the specimen under the section answers for it where it does not.
 */
async function listFonts() {
  if (fontsListed) return;
  fontsListed = true;
  const installed = await backend.fonts().catch(() => []);
  const groups = installed.length
    ? [['On this machine', installed]]
    : FONT_CHOICES.map(([label, names]) => [label, names.filter(fontInstalled)]);

  const select = $('setFont');
  const here = new Set();
  for (const [label, names] of groups) {
    if (!names.length) continue;
    const group = el('optgroup');
    group.label = label;
    for (const name of names) {
      here.add(name);
      const option = el('option', null, name);
      option.value = `name:${name}`;
      option.style.fontFamily = JSON.stringify(name);
      group.append(option);
    }
    select.append(group);
  }

  // Set on a machine that had the font, opened on one that does not: say so
  // rather than showing the popup as blank and losing what it is set to.
  const named = settings.font === 'custom' && cleanFontName(settings.fontName);
  if (named && !here.has(named)) {
    const group = el('optgroup');
    group.label = 'Not on this machine';
    const option = el('option', null, named);
    option.value = `name:${named}`;
    group.append(option);
    select.append(group);
  }
  // The popup could not be set to the right entry before the entry existed.
  paintPrefs();
}

/** What **Compare against** in the settings sheet names, as a baseline id. */
const defaultBaseline = () => (settings.baseline === 'git' ? 'git:HEAD' : 'read');

/**
 * What to ask for when a document is *shown* rather than when a baseline is
 * *chosen*: the one it was last compared against, and the setting above only
 * for a document that has never been compared against anything.
 *
 * The reader resolves the pair, because only it knows the file's history — see
 * `validBaseline` in src/reader.js. Asking it that way instead of looking the
 * answer up here is what keeps the first paint right: this page does not learn
 * which file it is showing until the document arrives.
 */
const keptBaseline = () => `last:${defaultBaseline()}`;

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
  // The window is pinned light by the shell for sepia; the cream over it is
  // the stylesheet's, keyed off this. Diagrams are drawn with their colours
  // baked in, so a change of tint has to redraw them, as a change of scheme
  // does — but only a change: this runs on every setting, and at boot.
  const wasSepia = sepia();
  if (settings.appearance === 'sepia') root.dataset.tint = 'sepia';
  else delete root.dataset.tint;
  if (sepia() !== wasSepia && mermaid) {
    mermaid.initialize(mermaidConfig());
    paint();
  }
  // Mirrored for the inline script in index.html, which runs before first
  // paint — and, in a browser tab, this is the store rather than a mirror.
  localStorage.setItem('redline:settings', JSON.stringify(settings));
  setDiff(settings.marks);
  paintPrefs();
}

/** Take a change here first, so the window answers at once, then store it. */
function writeSettings(patch) {
  settings = { ...settings, ...patch };
  applySettings();
  native?.setSettings(patch);
}

/** How far the document's own text is allowed to go, in px. */
const SIZE_MIN = 11;
const SIZE_MAX = 24;

/** A segmented control is a radio group, read and written by option value. */
function setSeg(id, value) {
  for (const input of $(id).querySelectorAll('input')) input.checked = input.value === value;
}

const onSeg = (id, fn) => $(id).addEventListener('change', (e) => fn(e.target.value));

function paintPrefs() {
  setSeg('setAppearance', settings.appearance);
  setSeg('setReopen', settings.reopenLast ? '1' : '0');
  setSeg('setFinder', settings.finderOpensIn);
  $('setFont').value = fontValue();
  $('setSizeOut').textContent = `${settings.textSize} px`;
  $('setSizeDown').disabled = settings.textSize <= SIZE_MIN;
  $('setSizeUp').disabled = settings.textSize >= SIZE_MAX;
  setSeg('setWidth', settings.width);
  // Named widths say which is wider, not how wide. The measure comes off the
  // variable the document reads, so the two can never drift apart.
  const measure = getComputedStyle(document.documentElement).getPropertyValue('--doc-width');
  $('setWidthHint').textContent = `${measure.trim()} of text, centred in the window`;
  $('setMarks').checked = settings.marks;
  setSeg('setBaseline', settings.baseline);
}

onSeg('setAppearance', (v) => writeSettings({ appearance: v }));
onSeg('setReopen', (v) => writeSettings({ reopenLast: v === '1' }));
onSeg('setFinder', (v) => writeSettings({ finderOpensIn: v }));
$('setFont').addEventListener('change', (e) => {
  const picked = e.target.value;
  // A built-in is a stylesheet rule and a picked face is a name; the name is
  // kept either way, so going to Serif and back does not lose your choice.
  if (picked.startsWith('name:')) writeSettings({ font: 'custom', fontName: picked.slice(5) });
  else writeSettings({ font: picked });
});

const stepSize = (by) => () =>
  writeSettings({ textSize: Math.min(Math.max(settings.textSize + by, SIZE_MIN), SIZE_MAX) });

$('setSizeDown').addEventListener('click', stepSize(-1));
$('setSizeUp').addEventListener('click', stepSize(+1));

onSeg('setWidth', (v) => writeSettings({ width: v }));
$('setMarks').addEventListener('change', (e) => writeSettings({ marks: e.target.checked }));
onSeg('setBaseline', (v) => {
  writeSettings({ baseline: v });
  // It says what to compare against from now on, and "now" includes the
  // document in front of you — otherwise the setting looks like it did nothing.
  state.baseline = defaultBaseline();
  load({ keepScroll: true });
});

const prefs = $('prefs');

function openPrefs() {
  if (prefs.open) return;
  paintPrefs();
  prefs.showModal();
}

$('prefsBtn').addEventListener('click', openPrefs);
$('prefsDone').addEventListener('click', () => prefs.close());
$('setReveal').addEventListener('click', () => native?.revealStore());

// The menu sends this in the desktop app; in a browser tab the page has to
// catch the key itself.
native?.onOpenSettings(() => openPrefs());

// ---------- about, and updates ----------

// What this copy is, and whether there is a newer one. Only ever on request —
// the button here or Check for Updates… in the app menu — because it is the
// one time the app reaches off the machine, and that should be something
// somebody chose. A browser tab has neither: run from a checkout, upgrading
// is `git pull`, and the section is `data-shell`.

/** Homebrew's own word for it: replacing a cask's app any other way leaves
 *  the cask believing the old version is still installed. */
const BREW_UPGRADE = 'brew upgrade --cask redline';

/** Where Download goes, when the button is a download; empty when it copies. */
let updateUrl = '';

async function checkUpdate() {
  const note = $('updateNote');
  const button = $('checkUpdate');
  $('updateRow').hidden = true;
  updateUrl = '';
  note.textContent = 'Checking…';
  button.disabled = true;
  try {
    const u = await native.checkUpdate();
    if (!u.newer) {
      note.textContent = `${u.current} is the newest version`;
    } else if (u.brew) {
      note.textContent = `${u.latest} is out — installed with Homebrew, so upgrade there`;
      $('updateCmd').textContent = BREW_UPGRADE;
      $('updateGo').textContent = 'Copy';
      $('updateRow').hidden = false;
    } else {
      note.textContent = `${u.latest} is out`;
      // The file, so the button says what it fetches before it is pressed.
      $('updateCmd').textContent = u.url.split('/').pop();
      $('updateGo').textContent = 'Download';
      updateUrl = u.url;
      $('updateRow').hidden = !u.url;
    }
  } catch {
    note.textContent = 'Could not reach the update server — try again later';
  } finally {
    button.disabled = false;
  }
}

if (native) {
  $('setVersion').textContent = native.version;
  $('checkUpdate').addEventListener('click', checkUpdate);
  $('updateGo').addEventListener('click', () => {
    if (updateUrl) {
      native.openExternal(updateUrl);
      return;
    }
    // A clipboard refused is not worth a message: the command is on screen
    // and selectable, so select it and let ⌘C do the rest.
    navigator.clipboard.writeText(BREW_UPGRADE).catch(() => {
      getSelection().selectAllChildren($('updateCmd'));
    });
  });
  native.onCheckUpdate(() => {
    openPrefs();
    $('aboutSec').scrollIntoView({ block: 'nearest' });
    checkUpdate();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openPrefs();
  }
  // ⌘B and ⌥⌘B come from the View menu in the desktop app; here they have to
  // be caught. By `code` rather than by `key`: ⌥B on a Mac keyboard arrives as
  // `∫`, so the letter is no use for the one with Option in it.
  if (!native && e.code === 'KeyB' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    if (e.altKey) setTocSide(!state.tocSide);
    else setSide(!state.side);
  }
  // ⌘F comes from the Edit menu in the desktop app; in a browser tab it would
  // otherwise open the browser's own find, which cannot see into `#doc` the
  // way this one needs to for the diff marks and the rendered/raw split.
  if (!native && e.code === 'KeyF' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    openFind();
  }
});

async function initSettings() {
  let stored = {};
  try {
    stored = native
      ? await native.settings()
      : JSON.parse(localStorage.getItem('redline:settings') || '{}');
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

  if (native) $('setStore').textContent = await native.storeRoot();

  // Started now rather than when the sheet opens: asking the OS costs a third
  // of a second, and a popup that fills in after you have looked at it is a
  // popup you saw the wrong answer in. Nothing waits on it.
  listFonts();
}

// ---------- live reload ----------

// Only the broken state has anything to say, so only the broken state gets a
// name: while the watch is up there is nothing on the bar to read or announce.
function setLive(on, why) {
  const live = $('live');
  live.classList.toggle('off', !on);
  live.title = on ? '' : why;
  live.setAttribute('aria-hidden', String(on));
  if (on) live.removeAttribute('aria-label');
  else live.setAttribute('aria-label', why);
}

// One watch at a time: switching tabs re-points this at the new document, and
// the old one's events would load the wrong file over the top of it.
let unwatch = null;

// Staying connected is the backend's problem — what a dropped watch means, and
// whether one can drop at all, is a thing only it knows. Here there is just
// what each event does to the screen.
function connect() {
  unwatch?.();
  unwatch = backend.watch({
    onLive: setLive,
    onEvent(msg) {
      if (msg.type === 'file') {
        // A different document was opened (File > Open, drag and drop).
        state.baseline = keptBaseline();
        return load({ keepScroll: false });
      }
      // Earlier versions arrived — the file's commits, read in the background
      // after it opened. Nothing on screen changes, only the list of them.
      if (msg.type === 'history') return load({ keepScroll: true });
      if (msg.type === 'change') return load({ keepScroll: true });
    },
  });
}

/**
 * Show a different file in this tab, following a link out of the document.
 *
 * The watch is closed first and reopened after, rather than left running. The
 * reader announces the switch from inside the request that caused it, before
 * that request has answered — so a stream still listening would hear "file",
 * ask for the document by the id this page is still holding, and be told that
 * one has closed. Standing the watch down for the length of the swap costs a
 * moment of not following a file that is about to be replaced anyway.
 *
 * A path that will not open throws before anything is released, so the old
 * document is still there: reconnecting in `finally` leaves the page exactly
 * as it was, reading what it was reading.
 */
async function openFile(path) {
  unwatch?.();
  unwatch = null;
  try {
    const { id } = await backend.open(path);
    setDocId(id);
    // Whatever the file we came from was compared against says nothing about
    // this one, which has a comparison of its own to be put back on.
    state.baseline = keptBaseline();
    await load({ keepScroll: false });
  } catch (err) {
    // A link to a file that is not there is the document being out of date,
    // not the reader breaking. Staying put is the answer, and the console is
    // where the reason goes.
    console.error('could not open', path, err);
  } finally {
    connect();
  }
}

// Before the first load: the text size, the width and the marks all have to be
// right on the first paint, and the baseline decides what that paint shows.
await initSettings();
if (native) {
  // Which document that is comes from `onTabs`'s first event instead -- see
  // `firstTabShown` above.
  await firstTabShown;
} else {
  await load({ keepScroll: false });
  connect();
}
// There is a document on screen, so the window can be shown. It was built
// hidden: a window that appears empty and fills in a moment later reads as a
// slow app even when it is not.
native?.ready();
// So the arrow keys and the space bar scroll the document straight away,
// without a click in it first — but never stealing a control's focus.
if (document.activeElement === document.body) pane.focus({ preventScroll: true });
