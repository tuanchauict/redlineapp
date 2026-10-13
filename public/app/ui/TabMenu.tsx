// The chevron by the name, and the list it opens: the sidebar's rows, for when the sidebar is
// shut.
//
// Two mounts sharing `tabMenuAt`, because the two halves cannot share a parent. The chevron is on
// the bar, next to the name it hangs off. The list cannot be: `.bar` has a `backdrop-filter`,
// which makes it the containing block of anything `position: fixed` inside it, so a menu drawn
// in the bar would be placed against the bar and clipped to it. It is drawn after the header.
import { render } from 'preact';
import { effect } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { state, tabMenuAt } from '../state.js';
import { TabLabel, type Tab } from './TabLabel.js';

/**
 * Whether there is a chevron at all: only with the sidebar shut, where the list is not already
 * on screen, and only once there is more than one file to choose between.
 */
const shown = () => !state.side && state.tabs.length > 1;

export interface TabMenuActions {
  /** Open the menu under the chevron at `left`, or shut it if it is open. */
  toggle(left: number): void;
  select(id: string): void;
}

function Chevron({ actions }: { actions: TabMenuActions }) {
  return (
    <button
      id="tabMenu"
      class="icon chev"
      title="All open files"
      hidden={!shown()}
      aria-expanded={tabMenuAt.value !== null && shown() ? 'true' : 'false'}
      onClick={(e) => {
        // Or the document's own click handler, which shuts the menu, would shut it again.
        e.stopPropagation();
        actions.toggle(e.currentTarget.getBoundingClientRect().left);
      }}
    >
      <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 6.5 4 4 4-4" />
      </svg>
    </button>
  );
}

function List({ actions }: { actions: TabMenuActions }) {
  const list = useRef<HTMLDivElement>(null);
  const at = tabMenuAt.value;
  // Under the chevron, nudged back inside the window if it would hang off. Measured after the
  // rows are drawn, since its width is theirs, and before it is painted, so it never shows
  // anywhere else first.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || at === null) return;
    el.style.left = `${Math.max(6, Math.min(at - 6, innerWidth - el.offsetWidth - 6))}px`;
  }, [at, state.tabs]);

  return (
    <div id="tabList" class="menu" ref={list} hidden={at === null}>
      {at !== null &&
        (state.tabs as Tab[]).map((t) => (
          <button key={t.id} type="button" title={t.path} onClick={() => actions.select(t.id)}>
            <span class="tick">{t.id === state.docId ? '✓' : ''}</span>
            <TabLabel tab={t} />
          </button>
        ))}
    </div>
  );
}

/** The chevron into `chevron`, the list into `list`; each owns its slot from here on. */
export function mountTabMenu(chevron: HTMLElement, list: HTMLElement, actions: TabMenuActions) {
  // A menu whose chevron has gone — the sidebar opened, or the files closed down to one — has
  // nothing left to hang off, so it is shut, not just hidden: hidden, it would be open again
  // the moment the chevron came back, which can be from a key with no click to shut it.
  effect(() => {
    if (!shown()) tabMenuAt.value = null;
  });
  render(<Chevron actions={actions} />, chevron);
  render(<List actions={actions} />, list);
}
