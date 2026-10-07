/* Redline — the landing page's behaviour.
 *
 * The theme toggle, the copy buttons, the scroll reveal, the hero demo loop,
 * and four scenes further down the page. No dependencies and no build step —
 * this file is served as it is written, the same way the reader itself is.
 *
 * Nothing here draws anything. Every scene is already in the markup, in the
 * state it starts in; what these functions do is move one attribute or one
 * class and let the stylesheet animate between them. With this file blocked the
 * page is a complete, correct, still page.
 */

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- theme ---------- */

/* The <head> script has already applied the stored choice; this only has to
   handle changing it. Which way round the toggle goes is decided by what is on
   screen rather than by what is stored, so the first click from `auto` always
   does the visible thing rather than appearing to do nothing. */
const themeBtn = document.getElementById('theme');

function showing() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function label() {
  themeBtn.setAttribute('aria-label', showing() === 'dark' ? 'Switch to light' : 'Switch to dark');
}

themeBtn.addEventListener('click', () => {
  const next = showing() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('redline:site-theme', next);
  } catch (e) {
    /* Private mode. The choice holds for this page view and is not remembered. */
  }
  label();
});

label();

/* ---------- copy buttons ---------- */

for (const btn of document.querySelectorAll('.copy')) {
  let undo;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
    } catch (e) {
      /* Denied permission, or an insecure origin. Nothing to say about it that
         is more use than the command already on screen. */
      return;
    }
    const live = btn.querySelector('#copy-live');
    if (live) live.textContent = 'Copied';
    btn.classList.add('is-done');
    clearTimeout(undo);
    undo = setTimeout(() => {
      btn.classList.remove('is-done');
      if (live) live.textContent = '';
    }, 1600);
  });
}

/* ---------- scroll reveal, and the nav's hairline ---------- */

const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('is-in');
      /* One way only: a section that has been seen stays shown, so scrolling
         back up a long page is not a second round of things fading in. */
      io.unobserve(e.target);
    }
  },
  { rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
);

for (const el of document.querySelectorAll('.reveal, .demo')) io.observe(el);

const nav = document.querySelector('.nav');
const onScroll = () => nav.classList.toggle('is-stuck', window.scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

/* ---------- the demo loop ---------- */

/* The document in the hero is written out in its finished, marked state; the
   loop only moves one attribute between three values, and the stylesheet does
   the rest. `clean` is the document with nothing compared against it, `reload`
   is the beat where a new version lands — it is what covers the reflow when the
   removed words come back into the flow — and `marked` is the diff.
 */
const demo = document.getElementById('demo');
const counters = [...demo.querySelectorAll('[data-count]')];
const targets = counters.map((el) => Number(el.dataset.count));

/* The removed paragraph and the removed words are out of the flow while the
   document is clean, so the marked state is taller than the clean one — and
   without this the hero would change height on every lap and shove the whole
   page below it up and down. The marked state is the tallest, so measuring it
   once per width and holding the body to that is enough.

   offsetHeight rather than a bounding rect: the demo is drawn under a rotateX
   and a rect would hand back the foreshortened height. With no JavaScript at
   all the markup is already in the marked state, so there is nothing to lock. */
const docEl = demo.querySelector('.demo-doc');
const bodyEl = demo.querySelector('.demo-body');
let locked = 0;

function lock() {
  const h = docEl.offsetHeight;
  if (h > locked) {
    locked = h;
    bodyEl.style.minHeight = `${h}px`;
  }
}

const STEPS = [
  ['clean', 1600],
  ['reload', 440],
  ['marked', 4400],
];

let timer = null;
let step = 0;
let frame = null;

function setCounts(n) {
  counters.forEach((el, i) => {
    el.textContent = String(typeof n === 'number' ? n : targets[i]);
  });
}

/* The count ticks up alongside the marks rather than arriving with them: the
   number on the bar is a running total in the reader too. */
function countUp() {
  cancelAnimationFrame(frame);
  const start = performance.now();
  const span = 900;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / span);
    counters.forEach((el, i) => {
      el.textContent = String(Math.round(targets[i] * t));
    });
    if (t < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

function setPhase(phase) {
  demo.dataset.phase = phase;
  if (phase === 'marked') {
    countUp();
    lock();
  } else {
    cancelAnimationFrame(frame);
    setCounts(0);
  }
}

function advance() {
  const [phase, hold] = STEPS[step];
  setPhase(phase);
  step = (step + 1) % STEPS.length;
  timer = setTimeout(advance, hold);
}

function stop() {
  clearTimeout(timer);
  timer = null;
}

function play() {
  if (timer || reduced.matches) return;
  advance();
}

/* Off screen or in a background tab it is not worth a timer, and a loop that
   has been running unseen comes back mid-cycle. */
let inView = false;

new IntersectionObserver(
  (entries) => {
    inView = entries[0].isIntersecting;
    if (inView && !document.hidden) play();
    else stop();
  },
  { threshold: 0.25 },
).observe(demo);

addEventListener('visibilitychange', () => {
  if (document.hidden) stop();
  else if (inView) play();
});

document.getElementById('replay').addEventListener('click', () => {
  stop();
  step = 0;
  advance();
});

/* A new width is a new set of line breaks and so a new tallest state. Measured
   again rather than adjusted, because the height that was right at the old
   width is not a floor for the new one — a wider window makes the document
   shorter.

   The measurement needs the marked phase, which is not necessarily the phase
   the loop is in, so it borrows it and hands it straight back. `data-measuring`
   cuts the transitions for that one synchronous read: without it, reading
   offsetHeight flushes style and the marks start animating towards a state that
   is reverted on the next line. */
let resized;
addEventListener('resize', () => {
  clearTimeout(resized);
  resized = setTimeout(() => {
    const phase = demo.dataset.phase;
    locked = 0;
    bodyEl.style.minHeight = '';
    demo.dataset.measuring = '';
    demo.dataset.phase = 'marked';
    lock();
    demo.dataset.phase = phase;
    delete demo.dataset.measuring;
  }, 180);
});

/* The markup arrives in the marked state, so the first measurement is the one
   that matters and it can be taken before anything has moved. */
lock();

/* Honoured at both ends: the stylesheet drops the transitions, and the loop
   never starts, so the demo simply sits in the state it is trying to show. */
function settle() {
  if (!reduced.matches) return;
  stop();
  setPhase('marked');
  /* setPhase has just started the count tweening. Cancelled before the finals
     are written, or the first frame puts the numbers back to nearly zero and
     counts them up again — the one piece of motion the stylesheet cannot
     reach, since it is a script writing textContent and not a transition. */
  cancelAnimationFrame(frame);
  setCounts();
}

reduced.addEventListener('change', () => {
  settle();
  if (!reduced.matches && inView && !document.hidden) play();
});

settle();

/* ---------- the scenes ---------- */

/* Each scene plays itself while it is on screen and stops for good the first
   time a reader touches it. A scene that keeps moving under the hand driving it
   is worse than one that never moved — and every scene here has controls
   precisely so that it can be driven. */
function drive(el, advance, hold) {
  let timer = null;
  let taken = false;
  let seen = false;

  const halt = () => {
    clearTimeout(timer);
    timer = null;
  };

  const tick = () => {
    advance();
    timer = setTimeout(tick, hold);
  };

  const play = () => {
    if (timer || taken || reduced.matches || document.hidden) return;
    timer = setTimeout(tick, hold);
  };

  new IntersectionObserver(
    (entries) => {
      seen = entries[0].isIntersecting;
      if (seen) play();
      else halt();
    },
    { threshold: 0.3 },
  ).observe(el);

  addEventListener('visibilitychange', () => {
    if (document.hidden) halt();
    else if (seen) play();
  });

  const take = () => {
    taken = true;
    halt();
  };

  el.addEventListener('pointerdown', take);
  el.addEventListener('keydown', take);
}

/* Two of the four scenes are the same scene: a pair of buttons, one attribute
   on the root, and the stylesheet doing all of the rest. `data-set` names the
   attribute and `data-to` the value, so the markup says which scene is which
   and this says nothing about either. */
for (const sim of document.querySelectorAll('.sim-view, .sim-tone')) {
  const btns = [...sim.querySelectorAll('.seg button')];
  const attr = btns[0].dataset.set;

  const show = (to) => {
    sim.dataset[attr] = to;
    for (const b of btns) b.classList.toggle('is-on', b.dataset.to === to);
  };

  for (const b of btns) b.addEventListener('click', () => show(b.dataset.to));

  let at = 0;
  drive(
    sim,
    () => {
      at = (at + 1) % btns.length;
      show(btns[at].dataset.to);
    },
    3400,
  );
}

/* Choosing a baseline. Each block carries the list of baselines that consider
   it changed, so picking one is a matter of asking every block whether it is on
   that list — which is the shape of the real thing too: the document does not
   change, the version it is being held against does. */
const hist = document.getElementById('sim-history');

if (hist) {
  const rows = [...hist.querySelectorAll('.sim-side button')];
  const blocks = [...hist.querySelectorAll('.chg')];
  const counts = [...hist.querySelectorAll('[data-c]')];

  const pick = (row) => {
    for (const r of rows) r.classList.toggle('is-on', r === row);
    for (const b of blocks) {
      b.classList.toggle('is-marked', b.dataset.in.split(' ').includes(row.dataset.pick));
    }
    /* In the markup's order: added, changed, removed. */
    const n = row.dataset.counts.split(' ');
    counts.forEach((el, i) => (el.textContent = n[i]));
  };

  for (const r of rows) r.addEventListener('click', () => pick(r));

  let at = 0;
  drive(
    hist,
    () => {
      at = (at + 1) % rows.length;
      pick(rows[at]);
    },
    2800,
  );
}

/* Walking the changes, and putting them away. The counter on the bar is derived
   from what is still outstanding rather than stored, because that is what the
   number means: `+1 ~2 −1` is the work left, not a description of the edit. */
const jump = document.getElementById('sim-jump');

if (jump) {
  const blocks = [...jump.querySelectorAll('.chg')];
  const ticks = [...jump.querySelectorAll('.sim-ruler i')];
  const doc = jump.querySelector('.sim-doc');
  const port = jump.querySelector('.sim-scroll');
  const left = jump.querySelector('[data-left]');
  const counts = {
    add: jump.querySelector('[data-c="add"]'),
    mod: jump.querySelector('[data-c="mod"]'),
    del: jump.querySelector('[data-c="del"]'),
  };
  let at = 0;

  /* The document is taller than the window it sits in, so arriving at a change
     means bringing it into view. Clamped at both ends: a change near the top or
     the bottom of the file does not get to drag the document past itself. */
  function show() {
    const max = Math.max(0, doc.offsetHeight - port.clientHeight);
    const y = Math.min(max, Math.max(0, blocks[at].offsetTop - 44));
    doc.style.transform = `translateY(${-y}px)`;
    blocks.forEach((b, i) => b.classList.toggle('is-at', i === at));
    ticks.forEach((t, i) => t.classList.toggle('is-at', i === at));
    left.textContent = `change ${at + 1} of ${blocks.length}`;
  }

  function tally() {
    for (const kind of ['add', 'mod', 'del']) {
      const live = blocks.filter(
        (b) => b.dataset.kind === kind && !b.classList.contains('is-off'),
      );
      counts[kind].textContent = String(live.length);
    }
  }

  /* `n` and `p` walk past a change that has been checked off, which is the
     whole reason for checking one off. Returns false when there is nowhere left
     to walk to, which is the end of the file rather than an error. */
  function step(by) {
    const n = blocks.length;
    for (let i = 1; i <= n; i++) {
      const next = (((at + by * i) % n) + n) % n;
      if (!blocks[next].classList.contains('is-off')) {
        at = next;
        show();
        return true;
      }
    }
    return false;
  }

  function reset() {
    for (const el of [...blocks, ...ticks]) el.classList.remove('is-off');
    at = 0;
    tally();
    show();
    return true;
  }

  function check() {
    blocks[at].classList.add('is-off');
    ticks[at].classList.add('is-off');
    tally();
    /* Worked all the way down. In the reader that is where you stop; here the
       file comes back, because the next reader to scroll past wants it whole. */
    if (!step(1)) reset();
    return true;
  }

  const act = { n: () => step(1), p: () => step(-1), c: check };

  for (const btn of jump.querySelectorAll('[data-key]')) {
    btn.addEventListener('click', () => {
      if (!act[btn.dataset.key]()) reset();
    });
  }

  /* Two steps, one put away, and so on down to nothing left — the shape of
     reading a file someone has rewritten, rather than a tour of the buttons. */
  const SCRIPT = ['n', 'n', 'c', 'n', 'c', 'n', 'c', 'reset'];
  let k = 0;

  drive(
    jump,
    () => {
      const move = SCRIPT[k];
      k = (k + 1) % SCRIPT.length;
      if (move === 'reset' || !act[move]()) reset();
    },
    1900,
  );

  /* A new width is new line breaks, so the offset that put a change in view is
     not the offset that does it now. */
  let sized;
  addEventListener('resize', () => {
    clearTimeout(sized);
    sized = setTimeout(show, 180);
  });

  tally();
  show();
}
