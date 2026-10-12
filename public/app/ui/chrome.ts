// The window's fixed chrome -- the bar's buttons, the dot, the sidebar disclosures, the find bar
// and the notice -- kept to the signals that say what each shows.
//
// Not components, on purpose. These are on screen from the first frame, before app.js has run,
// so they are markup in index.html, where the browser draws them with the rest of the page; a
// component would leave a gap in the bar until the bundle came, and the bar is the native
// window's title bar. What changes about them is an attribute or two, so each is an `effect`:
// it runs once now, against whatever the head script and the stored prefs already say, and again
// whenever a signal it read changes. Code elsewhere sets the signal and never the attribute.
import { effect } from '@preact/signals';
import { state, liveWhy, shut } from '../state.js';
import { findOpen, findCount } from '../vm/find.js';
import { notice } from '../vm/notice.js';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** A switch's state, and its tooltip, which says what pressing it does and so changes with it. */
function press(btn: HTMLElement, on: boolean, title: string) {
  btn.setAttribute('aria-pressed', String(on));
  btn.title = title;
  btn.setAttribute('aria-label', title);
}

export function bindChrome() {
  // One button, two states: the icon shows the view it switches to.
  effect(() => {
    const raw = state.view === 'raw';
    const view = $('view');
    view.dataset.view = state.view;
    press(view, raw, raw ? 'Show rendered (r)' : 'Show raw source (r)');
  });

  effect(() => {
    $('findBar').hidden = !findOpen.value;
    $('find').setAttribute('aria-pressed', String(findOpen.value));
  });
  effect(() => {
    $('findCount').textContent = findCount.value;
  });

  // Not on screen in the first frame, but markup all the same: a live region has to be in the
  // page before what it says changes, or a screen reader has nothing to announce. Put away, it
  // keeps its last words, which nothing can see.
  effect(() => {
    const text = notice.value;
    const box = $('notice');
    if (text !== null) box.textContent = text;
    box.hidden = text === null;
  });

  // Each toggle's band, filled while its column is open, is drawn off `aria-pressed`.
  effect(() => press($('side'), state.side, `${state.side ? 'Hide' : 'Show'} sidebar (⌘B)`));
  effect(() =>
    press($('tocBtn'), state.tocSide, `${state.tocSide ? 'Hide' : 'Show'} contents (⌥⌘B)`),
  );

  // Only the broken state has anything to say, so only the broken state gets a
  // name: while the watch is up there is nothing on the bar to read or announce.
  effect(() => {
    const why = liveWhy.value;
    const live = $('live');
    live.classList.toggle('off', why !== null);
    live.title = why ?? '';
    live.setAttribute('aria-hidden', String(why === null));
    if (why === null) live.removeAttribute('aria-label');
    else live.setAttribute('aria-label', why);
  });

  // The class is what folds the section, and the head script set it before first paint; this
  // keeps it, and the button's state, to `shut` from here on.
  effect(() => {
    for (const twist of document.querySelectorAll<HTMLElement>('.side-twist')) {
      const folded = shut.value.includes(twist.dataset.shut);
      twist.setAttribute('aria-expanded', String(!folded));
      document.documentElement.classList.toggle(`shut-${twist.dataset.shut}`, folded);
    }
  });
}
