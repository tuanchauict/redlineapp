// The native window, with the page reloadable without a recompile.
//
//   npm run dev                  # an empty window
//   npm run dev -- sample.md     # opening a file, like `npm run app`
//   npm run dev -- --no-watch    # stage once and leave it alone
//
// `npm run app` is `cargo run`, and the app it runs has `shell/dist` compiled
// into it: every edit to public/, however small, is a relink before you can
// look at it. Measured on an M-series laptop that is about three seconds, which
// is not slow -- but it is three seconds and a lost scroll position each time,
// and the thing being edited is usually a stylesheet.
//
// `tauri dev` takes the page out of the binary instead. With `frontendDist` and
// no `devUrl` it starts a static server of its own over shell/dist (port 1430
// by default) and points the window at that, so restaging the page and hitting
// ⌘R is the whole loop. What this script adds is the restaging: a watch on
// public/ and src/ that re-runs the two build steps, which together are about
// two tenths of a second.
//
// Rust is still a recompile, but `tauri dev` watches for that itself and
// restarts the app when it lands. shell/dist is **gitignored**, and Tauri's
// watcher honours gitignore -- which is the only reason restaging the page does
// not trip a rebuild of the thing we just avoided rebuilding. If a page edit
// ever starts recompiling Rust, that is the rule that broke.
//
// Two things are different in here from the app you ship, and the first one
// surprises everybody:
//
//   The window's origin is http://localhost:1430, not tauri://localhost.
//   localStorage is keyed by origin and every layout preference this reader has
//   lives there -- redline:settings, redline:side, redline:toc, all of it. So a
//   dev run opens with default sidebars, default font, marks on, and nothing it
//   remembers is shared with an installed copy. That is isolation, not damage,
//   but "my widths are gone" is expected rather than a bug.
//
//   The page arrives over http rather than through the custom protocol the
//   bundle uses. Anything protocol- or origin-sensitive is therefore untested
//   until `npm run app` or `npm run bundle`, and those remain what a change gets
//   checked with before it is called done.
//
// For work that is only public/ and not the shell, `npm start` is still the
// better loop: a browser tab, no cargo in the picture at all, and devtools that
// are not WebKit's inspector bolted to a webview. This is for the page code that
// only exists in the window -- the drag-region toolbar, the tab strip, the menu
// wiring, the drop overlay.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = path.join(ROOT, 'shell');

/** How long to let edits settle before restaging. A save is often several. */
const DEBOUNCE_MS = 80;

// Everything that is not one of this script's own flags is the app's: a list of
// files to open, the same as `npm run app` takes. They go after a second `--`,
// which is where the Tauri CLI splits runner arguments from application ones.
const argv = process.argv.slice(2);
const watching = !argv.includes('--no-watch');
const appArgs = argv.filter((a) => a !== '--no-watch');

/**
 * Run a build step. Quiet once the window is up: the size report each of them
 * prints is worth reading on the first pass and is noise on the fiftieth.
 *
 * @returns {boolean} Whether it succeeded — a failed stage leaves the last good
 *   one on disk, so the answer is whether ⌘R is worth pressing.
 */
const build = (script, quiet) => {
  const r = spawnSync('node', [path.join('scripts', script)], {
    cwd: ROOT,
    stdio: quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  return r.status === 0;
};

const stage = (quiet, web = true) =>
  (web ? build('build-web.mjs', quiet) : true) && build('build-dist.mjs', quiet);

// Staged before the window opens rather than from a `predev` hook, for the same
// reason the bundle does its own: there is to be no way to ask for this and get
// a stale page.
if (!stage(false)) process.exit(1);

const tauri = spawn('npx', ['tauri', 'dev', ...(appArgs.length ? ['--', '--', ...appArgs] : [])], {
  cwd: SHELL,
  stdio: 'inherit',
});

if (watching) {
  // src/ is bundled into public/vendor/ and then staged; public/ is only
  // staged. Knowing which of the two changed is what keeps a CSS edit from
  // running esbuild, and it is one boolean.
  let pending = null;
  let touchedSrc = false;

  const changed = (src) => (_event, file) => {
    // public/vendor/ is what build:web just wrote, not something anyone edits.
    // Without this a src/ change restages twice: once for the source, once for
    // the bundle the first pass produced.
    if (!src && file && file.startsWith(`vendor${path.sep}`)) return;
    touchedSrc ||= src;
    clearTimeout(pending);
    pending = setTimeout(() => {
      const web = touchedSrc;
      touchedSrc = false;
      const at = new Date().toTimeString().slice(0, 8);
      // Said after the work rather than before it, so the line is a result and
      // not a promise. ⌘R is named because nothing here can press it: the page
      // is served to a window this script does not talk to.
      console.log(
        stage(true, web)
          ? `  ${at}  restaged${web ? ' (rebuilt src/)' : ''} — ⌘R in the window`
          : `  ${at}  build failed, page unchanged`,
      );
    }, DEBOUNCE_MS);
  };

  // Recursive watching is supported on macOS and Windows, which between them
  // are the only platforms the native window is built for.
  const watchers = [
    fs.watch(path.join(ROOT, 'public'), { recursive: true }, changed(false)),
    fs.watch(path.join(ROOT, 'src'), { recursive: true }, changed(true)),
  ];
  tauri.on('exit', () => watchers.forEach((w) => w.close()));

  console.log('\n  watching public/ and src/ — ⌘R in the window picks up a restage\n');
}

// The child stays in this process group, the same way `npm run app` leaves
// cargo in it, so a ctrl-c at a terminal reaches node, npx, cargo and the
// window together and the forward below is belt and braces.
//
// It is not redundant, though, because a signal aimed at this process alone --
// from a script, or an editor's stop button -- reaches no one else, and
// registering a handler at all is what stops node exiting on its own. Without
// the forward that leaves a watcher behind with no window, and *two* of these
// restaging one shell/dist is not a harmless duplicate: build:dist empties the
// directory before it refills it, so the pair race, and the loser dies on
// EEXIST or ENOENT somewhere inside the mermaid tree. That is a real five
// minutes lost to a stray process, found by leaving one.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    tauri.kill(sig);
    // A child that has not taken the hint gets no third chance: there is
    // nothing here worth waiting on past the point the window should be gone.
    setTimeout(() => {
      tauri.kill('SIGKILL');
      process.exit(1);
    }, 2000);
  });
}
tauri.on('exit', (code) => process.exit(code ?? 0));
