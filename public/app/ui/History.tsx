// History: every version of the document, newest first, as the list in the right-hand column.
//
// The first panel of the page drawn by a component rather than by hand. It renders from what
// it reads — the payload `paintHistory` last handed it, whether the marks are on, which row is
// asking to be forgotten, which has its menu open — and is re-rendered whenever any of those
// change, so nothing that changes them has to remember to repaint the list. What a row *does*
// is the page's business, not the list's: `pick`, `menu` and `prune` come in from main.ts,
// which is what keeps this module from importing it.
//
// The row menu (`#verMenu`) is still drawn by main.ts. It lights its row and dims what Forget
// would take through `menuFor` and `cutFrom`, never through the row's classes, because Preact
// owns these nodes now and would put a class it did not set straight back.
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { state, shownHistory, menuFor, cutFrom } from '../state.js';

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
const AGO: [Intl.RelativeTimeFormatUnit, number][] = [
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

/**
 * Whether this row is what the document is being compared against — which is a
 * version whether it was picked by name or reached through the "last read"
 * pointer, and the list should say so either way.
 *
 * The newest row is the other end of the same question: comparing the file
 * against itself is the plain document, which is the marks put away.
 */
export function isBaseline(d, v) {
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

/**
 * A committed version is better named by its commit than by our hash of its
 * bytes: the subject is what the person who wrote it chose to call it. One that
 * was only ever saved has no such name, so it is called when it was.
 */
export const versionName = (v) => (v.git ? v.git.subject || 'Commit' : clockName(v.ts));

export interface HistoryActions {
  /** A row clicked: compare against that version, or for the newest, against nothing. */
  pick(v): void;
  /** The row's menu, under its "…" (`from`) or at the pointer. `n` is how many Forget takes. */
  menu(row: HTMLElement, v, n: number, at: { from?: Element | null; keyboard?: boolean;
    x?: number; y?: number }): void;
  closeMenu(): void;
  /** Forget `hash` and every version older than it. */
  prune(hash: string): void;
}

// Set by `askPrune` and spent by the confirmation it puts up. Not every confirmation that
// mounts was just asked for: opening the column on one left waiting mounts it too, and that is
// no reason to take the keyboard from wherever it was.
let focusAsk = false;

/** Turn a row into its own question, and put the keyboard on the answer. */
export function askPrune(hash: string) {
  focusAsk = true;
  state.pruneAsk = hash;
}

function History({ actions }: { actions: HistoryActions }) {
  const d = shownHistory.value;
  // Built only while its column is showing — the right one, which is where History lives
  // now — and setTocSide opening it is what has it drawn. A closed column costs nothing.
  if (!d || !state.tocSide) return null;
  const versions = d.history ?? [];
  if (versions.length < 2) return <p class="side-empty">No earlier versions yet.</p>;
  return (
    <>
      {versions.map((v, i) =>
        state.pruneAsk === v.hash ? (
          <PruneAsk key={v.hash} v={v} n={versions.length - i} actions={actions} />
        ) : (
          <VersionRow key={v.hash} d={d} v={v} i={i} actions={actions} />
        ),
      )}
    </>
  );
}

function VersionRow({ d, v, i, actions }: { d; v; i: number; actions: HistoryActions }) {
  const name = versionName(v);
  // Everything a 236 px column had to shorten: the whole of a subject, the
  // exact time behind both the clock above and the "9 hours ago" below, and
  // the hash that used to sit in the row itself — a row already carrying a
  // name and two flags had no room left to spend on an identifier nobody
  // reads at a glance, so it moved here instead of disappearing.
  const when = new Date(v.ts).toLocaleString();
  let title = v.git
    ? `${name}\n${when} · commit ${v.git.sha.slice(0, 12)}`
    : `${when} · ${v.hash.slice(0, 12)}`;
  // The version on disk: picking it leaves nothing to compare, which is the
  // document read plainly. It is still not a version to throw away, though —
  // everything else in the list is compared against it. Added to rather than
  // replacing: what the click does is worth saying, but not at the price of the
  // one place the exact time is written out.
  if (v.current) title += '\nRead the file as it is now, with nothing compared';
  const on = isBaseline(d, v);
  const cls = [
    'ver',
    on && 'on',
    v.current && 'head',
    menuFor.value === v.hash && 'held',
    cutFrom.value === v.hash && 'cutting',
  ];

  // "now" is the file as it stands on disk; "read" is the version the change
  // marks are measured from. They can be the same version, and often are. Set
  // as quiet text rather than a filled chip — the row already says which
  // version it is by its name, so these are a note, not a badge.
  const flags = [v.current && 'now', v.baseline && 'read'].filter(Boolean);

  // Underneath, the particulars, in one shape for every row: how long ago this
  // was, and how far the file moved arriving here.
  const moved = v.delta
    ? `${v.delta > 0 ? '+' : '−'}${bytes(Math.abs(v.delta))}`
    : v.size == null
      ? ''
      : bytes(v.size);

  // How many would go with it: this row and every row under it, which is the
  // same arithmetic the confirmation does.
  const n = d.history.length - i;

  // A right-click opens the same menu, at the pointer, in place of the
  // browser's own: Back, Reload and Inspect have nothing to say about a
  // version, and a right-click on an item in a list is where any app keeps
  // what is done to it less often than a click does.
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const row = e.currentTarget as HTMLElement;
    // The context-menu key has no pointer to open at, and reports the corner.
    const keyboard = !e.clientX && !e.clientY;
    const from = keyboard ? row.querySelector('.ver-more') : null;
    actions.menu(row, v, n, { from, keyboard, x: e.clientX, y: e.clientY });
  };

  return (
    <button
      type="button"
      class={cls.filter(Boolean).join(' ')}
      title={title}
      aria-current={on ? 'true' : undefined}
      onClick={() => actions.pick(v)}
      onContextMenu={onContextMenu}
    >
      <span class="ver-text">
        <span class="ver-top">
          <span class="ver-name">{name}</span>
          {flags.length > 0 && <span class="ver-flags">{flags.join(' · ')}</span>}
        </span>
        <span class="ver-sub">
          <span class="ver-note">{[longAgo(v.ts), moved].filter(Boolean).join(' · ')}</span>
        </span>
      </span>
      <More v={v} n={n} actions={actions} />
    </button>
  );
}

/**
 * The row's "…": what can be done to a version besides comparing against it.
 *
 * Comparing is what a click on the row does, because it is what is done to a
 * version all the time; marking one read and forgetting one are done now and
 * then, and one of them cannot be undone, so neither is a click away. They
 * used to be one control each, at the end of the row, and a row has room for
 * one. The cut icon that forgot versions was the third attempt at a picture of
 * "this one and everything older" — a bin, then scissors, then a perforation —
 * and a menu item can simply say it.
 *
 * Out of sight until the row is pointed at, like the × on an open file. A
 * right-click on the row opens the same menu, for anyone who reaches for that
 * first; this is for those who do not, and for the keyboard.
 */
function More({ v, n, actions }: { v; n: number; actions: HistoryActions }) {
  const open = (e: Event, keyboard: boolean) => {
    // Inside the row, which is a button: a click here is not a click on it.
    e.stopPropagation();
    e.preventDefault();
    const more = e.currentTarget as HTMLElement;
    if (menuFor.value === v.hash) actions.closeMenu();
    else actions.menu(more.closest<HTMLElement>('.ver'), v, n, { from: more, keyboard });
  };
  return (
    <span
      class="ver-more"
      role="button"
      tabIndex={0}
      title="Mark as read, forget…"
      aria-label="Actions for this version"
      aria-haspopup="menu"
      aria-expanded={menuFor.value === v.hash ? 'true' : 'false'}
      onClick={(e) => open(e, false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') open(e, true);
      }}
    >
      <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="3.5" cy="8" r="1.25" />
        <circle cx="8" cy="8" r="1.25" />
        <circle cx="12.5" cy="8" r="1.25" />
      </svg>
    </span>
  );
}

/** The row, turned into its own confirmation. `n` is how many would go. */
function PruneAsk({ v, n, actions }: { v; n: number; actions: HistoryActions }) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focusAsk) return;
    focusAsk = false;
    go.current?.focus();
  }, []);
  // `cutting` as well as `ask`: the repaint that puts the question here would
  // otherwise drop the dim that pointing at Forget had just shown, exactly
  // when the question "how many is that?" is being asked. The number in the
  // text and the rows gone grey say the same thing twice, on purpose.
  return (
    <div class="ver ask cutting">
      <span class="ask-text">{`Forget ${n} version${n === 1 ? '' : 's'}?`}</span>
      <button
        ref={go}
        type="button"
        class="btn ask-go"
        title="This cannot be undone"
        onClick={() => actions.prune(v.hash)}
      >
        Forget
      </button>
      <button type="button" class="btn ask-no" onClick={() => (state.pruneAsk = null)}>
        Cancel
      </button>
    </div>
  );
}

/** Draw the list into `root`, which it owns from here on: nothing else may touch its children. */
export function mountHistory(root: HTMLElement, actions: HistoryActions) {
  render(<History actions={actions} />, root);
}
