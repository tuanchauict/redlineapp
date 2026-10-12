// The change ruler: where the changes are in the file, down the track the scrollbar runs in.
//
// Drawn from `rulerBands` and `rulerCurrent`, and re-rendered when either changes. Measuring
// is not here: `paintRuler` in main.ts reads every marked block's rectangle in the document it
// has just written, merges touching ones and scales them to the track, and that has to follow
// the write in order, which an effect does not promise. So main.ts hands over finished bands,
// and this places them.
//
// Keyed by position, so a repaint keeps the elements already on screen and only moves them.
// That is what lets a mark that stops being current fade (`.ruler-mark`'s opacity transition)
// rather than snap: a freshly made element has no "before" for a transition to start from.
import { render } from 'preact';
import { rulerBands, rulerCurrent } from '../state.js';

export interface RulerActions {
  /** Land on this node, the way `n`/`p` would. */
  go(node: HTMLElement): void;
  /** The pointer is on this band's blocks, or on none of them. */
  hover(nodes: HTMLElement[] | null): void;
}

function Ruler({ actions }: { actions: RulerActions }) {
  const current = rulerCurrent.value;
  return (
    <>
      {rulerBands.value.map(({ kind, ok, top, height, nodes }, i) => (
        <div
          key={i}
          class={[
            'ruler-mark',
            `ruler-${kind}`,
            ok && 'ruler-ok',
            current && nodes.includes(current) && 'ruler-current',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ top: `${top}px`, height: `${height}px` }}
          // A mark answers "take me there" as well as "where am I": the first node of its band
          // lands the same way `n`/`p` would, and a band with no index of its own -- a
          // raw-removed line, an already-checked change -- still scrolls, just with nothing
          // for `c` to act on once it arrives (see `goToNode`).
          onClick={() => actions.go(nodes[0])}
          // Enter and leave rather than over and out: each mark has its own handler, so there
          // is no bubbling from a child to tell apart from really leaving.
          onPointerEnter={() => actions.hover(nodes)}
          onPointerLeave={() => actions.hover(null)}
        />
      ))}
    </>
  );
}

/** Draw the marks into `root`, which it owns from here on: nothing else may touch its children. */
export function mountRuler(root: HTMLElement, actions: RulerActions) {
  render(<Ruler actions={actions} />, root);
}
