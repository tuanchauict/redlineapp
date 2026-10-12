// Check-offs: the changes read and put away, one block at a time.
//
// A viewmodel over `state.acked`, which `adopt` fills from the payload and this keeps. What it
// shows is the `chg-ok` class and the tag's wording on the blocks in `#doc`, which no component
// draws, so it is written straight onto them; the count and the ruler it moves are
// vm/changes.ts's, repainted from here.
import { state } from '../state.js';
import { doc, pane } from '../dom.js';
import { backend } from '../backend.js';
import { hoverNode, changeNodes, keepAnchored, paintCount, paintRuler } from './changes.js';

// A change you have looked at and are done with. Its mark goes, it stops being
// counted, and n/p walk past it — so reading a heavily edited file is a matter
// of working down the marks until there are none left, rather than reading
// around a page of highlighting that stays exactly as loud as when you started.
//
// Not the same as marking the version read, which says "all of this is seen"
// and moves what everything is measured from. This says "that bit is seen", one
// block at a time, and the file has still moved.

/** Every marked block the checked state applies to. The raw view has none. */
const ackNodes = () => [...doc.querySelectorAll<HTMLElement>('.chg[data-key]')];

export function applyAcks() {
  for (const node of ackNodes()) {
    const on = state.acked.has(node.dataset.key);
    node.classList.toggle('chg-ok', on);
    const tag = node.querySelector<HTMLElement>(':scope > .chg-tag');
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

export async function clearAcks() {
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
 * The change `c` acts on: the one under the pointer, which is also the one the
 * ruler is showing as current; otherwise the one you were last taken to, and
 * otherwise the first one still on screen — so a run of them is n, c, n, c
 * without having to find and point at each mark.
 */
function changeUnderCursor() {
  // `hoverNode` can outlive its block: putting a deleted change away takes the
  // block out of the page, and a node that is gone never reports the pointer
  // leaving it. It is also any marked block, raw-view lines included.
  if (hoverNode?.isConnected && hoverNode.matches('.chg[data-key]')) return hoverNode;
  const nav = changeNodes();
  const at = nav[state.changeIndex];
  if (at?.dataset.key) return at;
  const top = pane.getBoundingClientRect().top;
  return ackNodes().find((n) => n.getBoundingClientRect().bottom > top + 8) ?? null;
}

export function tapCheck() {
  if (!state.diff) return;
  const node = changeUnderCursor();
  if (!node) return;
  const on = !state.acked.has(node.dataset.key);
  // The list it is in is about to be one shorter. Without this, `n` would step
  // over whichever change moves up into the place this one had. The node may
  // be any change, not only the one `n` is on, so it is counted by where it is.
  const at = changeNodes().indexOf(node);
  if (on && at >= 0 && at <= state.changeIndex) state.changeIndex--;
  setAck(node.dataset.key, on);
}

// The word in the margin naming the change is the button that puts it away —
// delegated, because the marks are re-rendered whole on every change to the file.
doc.addEventListener('click', (e) => {
  const tag = (e.target as Element).closest('.chg-tag');
  const key = tag && tag.closest<HTMLElement>('[data-key]')?.dataset.key;
  if (!key) return;
  setAck(key, !state.acked.has(key));
});
