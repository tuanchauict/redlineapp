// Contents: the document's headings, as the list in the right-hand column above History.
//
// Drawn from `state.toc` and `state.tocAt`, and re-rendered when either changes. What is not
// here is finding the headings: `paintToc` in main.ts pairs each with its node in the document
// it has just written, because that has to happen after the write and before the scroll spy
// measures anything, and an effect does not promise to run in that order. So main.ts hands
// this a list of `{ h, node }` and says which one you are reading under, and this draws it.
//
// `state.toc` is null when there is no list to draw — the column is shut, or no document is
// open — and an empty array when there is a document with nothing to list. The two look the
// same to the scroll spy and different to a reader: only the second says "No headings".
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { state } from '../state.js';

export interface ContentsActions {
  /** Put this heading's node at the top of the pane; null for a heading not in this view. */
  go(node: Element | null): void;
}

function Contents({ actions }: { actions: ContentsActions }) {
  const toc = state.toc;
  const at = state.tocAt;
  const current = useRef<HTMLButtonElement>(null);
  // Scrolled into view only when the heading changes, not on every render, so a long
  // document does not fight the list's own scrollbar while you read.
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest' });
  }, [toc, at]);

  if (!toc || !state.tocSide) return null;
  if (!toc.length) return <p class="side-empty">No headings in this document.</p>;

  // Indented against the shallowest heading in this document rather than
  // against h1, because plenty of files start at `##` and would otherwise sit
  // in from the edge for no reason.
  const top = Math.min(...toc.map(({ h }) => h.level));
  return (
    <>
      {toc.map(({ h, node }, i) => (
        <button
          key={i}
          ref={i === at ? current : undefined}
          type="button"
          class={['toc', h.level === top && 'toc-top', i === at && 'on'].filter(Boolean).join(' ')}
          style={{ paddingLeft: `${8 + Math.min(h.level - top, 4) * 10}px` }}
          title={h.text}
          aria-current={i === at ? 'true' : 'false'}
          onClick={() => actions.go(node)}
        >
          {/* An empty heading is a real heading — it is somewhere the document goes —
              and still needs a row you can hit. */}
          {h.text || '—'}
        </button>
      ))}
    </>
  );
}

/** Draw the list into `root`, which it owns from here on: nothing else may touch its children. */
export function mountContents(root: HTMLElement, actions: ContentsActions) {
  render(<Contents actions={actions} />, root);
}
