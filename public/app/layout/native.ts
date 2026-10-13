// ---------- native shell ----------

// Everything here is a no-op in a plain browser tab: `window.mdNative` is put
// up by the desktop build (src/hosts/tauri/native.ts) and by nothing else, so the
// same file is the whole app in a window and the whole app in a tab.
//
// What the shell's events do is main.ts's, handed in to `bindNative`, which main.ts calls at the
// point in its own start-up where this block used to run.

import { prefs, state } from '../state.js';
import { $, pane } from '../dom.js';
// Typed from what `installNative` in the Tauri host leaves, so the page's calls on the shell are
// checked against what it provides. Named outright on `native` because the export has to be: tsc
// cannot spell the inferred type of `window.mdNative` from another module. Erased from the build.
import type { MdNative } from '../../../src/hosts/tauri/native.js';

export const native: MdNative | undefined = window.mdNative;
// Resolved once `onTabs`'s first event has shown a document -- the window is
// revealed once this settles (see the bottom of main.ts) rather than after
// main.ts's own `load()`, which a native window never calls: asking for
// no document in particular would race the shell's answer for which one its
// tabs say to show, and whichever of the two happened to resolve last would
// win, even if it was the guess.
let openedFirstTab = () => {};
export const firstTabShown = new Promise<void>((resolve) => {
  openedFirstTab = resolve;
});

export function bindNative({
  toggleView,
  toggleDiff,
  goToChange,
  tapMarkRead,
  openFind,
  setSide,
  setTocSide,
  setDocId,
  connect,
  keptBaseline,
  load,
  scrollMemory,
}) {
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
      if (prefs.getItem('redline:side') === null && tabs.length > 1) setSide(true, false);
      const switching = active && active !== state.docId;
      if (switching) {
        scrollMemory.set(state.docId, pane.scrollTop);
        setDocId(active);
      }
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
}
