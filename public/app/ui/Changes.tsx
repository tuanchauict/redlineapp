// The bar's half of the document: which old version is on the page, how far the file has moved
// since the one it is compared against, how much of that is checked off, and the arrows through
// it. All of it is about the document rather than the window, and all of it is gone with no
// document open, so it is one component, ending in the line that divides it from the buttons
// that are about the window.
//
// Drawn from `tally`, which `paintCount` (vm/changes.ts) leaves, `soloName` (vm/history.ts), and
// `state.diff`: the number of changes is worked out from the payload, and how many of them the
// arrows can reach is counted off the page, which is not a thing a render should be asking.
import { render } from 'preact';
import { state } from '../state.js';
import { soloName } from '../vm/history.js';
import { tally } from '../vm/changes.js';

export interface ChangesActions {
  /** Back to comparing, from reading one version by itself. */
  unsolo(): void;
  /** To the next change, or the previous at -1 -- of `kind` only, if one is given. */
  go(step: number, kind?: string): void;
  /** Bring back every change checked off. */
  unack(): void;
}

function Changes({ actions }: { actions: ChangesActions }) {
  const { add, mod, del, live, done, nav } = tally.value;
  const solo = soloName.value;
  const count = state.diff && live > 0;
  const ack = state.diff && done > 0;
  const hasNav = state.diff && nav > 0;
  const soloTitle = solo
    ? `Reading ${solo} by itself, not the file as it is now — click for what changed since (v)`
    : undefined;
  const ackTitle = `${done} change${done === 1 ? '' : 's'} checked off — bring them back (⇧C)`;

  return (
    <>
      {/* Which older version is on the page, while versions are being read by themselves:
          with no marks, nothing else in the window tells it from the file as it is. */}
      <button
        id="soloTag"
        class="icon count solo"
        hidden={!solo}
        title={soloTitle}
        aria-label={soloTitle}
        onClick={actions.unsolo}
      >
        <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
        <span id="soloName" class="solo-name">
          {solo}
        </span>
      </button>

      {/* A number of changes is something to go and look at, so the count is a way to them
          rather than a number you can only read: click the figure for one kind to go to the
          next of that kind, the gap between them for the next of any, with ⇧ to go back. The
          versions it was counted against are in the right column, which has a button and a
          key of its own. */}
      <button
        id="count"
        class="icon count"
        title="Next change (⇧ for the previous)"
        hidden={!count}
        onClick={(e) =>
          actions.go(
            e.shiftKey ? -1 : 1,
            (e.target as Element).closest<HTMLElement>('[data-kind]')?.dataset.kind,
          )
        }
      >
        {add > 0 && (
          <span class="c-add" data-kind="add" title={`${add} added`}>
            +{add}
          </span>
        )}
        {mod > 0 && (
          <span class="c-mod" data-kind="mod" title={`${mod} changed`}>
            ~{mod}
          </span>
        )}
        {del > 0 && (
          <span class="c-del" data-kind="del" title={`${del} removed`}>
            −{del}
          </span>
        )}
      </button>

      {/* And how much of that you have already checked off, which no longer counts towards
          the number on its left. Their marks are hidden, not forgotten, and nothing else in
          the window would say so — so this is also the way back to them. */}
      <button
        id="ackCount"
        class="icon count ack"
        hidden={!ack}
        title={ackTitle}
        aria-label={ackTitle}
        onClick={actions.unack}
      >
        <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m3.5 8.4 3 3 6-6.9" />
        </svg>
        {done}
      </button>
      <button
        id="prev"
        class="icon"
        title="Previous change (p)"
        hidden={!hasNav}
        onClick={() => actions.go(-1)}
      >
        ↑
      </button>
      <button
        id="next"
        class="icon"
        title="Next change (n)"
        hidden={!hasNav}
        onClick={() => actions.go(1)}
      >
        ↓
      </button>

      {/* It separates a pair; with nothing on its left it would be a line on its own. */}
      <span id="divide" class="divide" hidden={!count && !ack && !hasNav && !solo} />
    </>
  );
}

/** Draw the cluster into `root`, which it owns from here on. */
export function mountChanges(root: HTMLElement, actions: ChangesActions) {
  render(<Changes actions={actions} />, root);
}
