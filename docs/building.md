# Building and testing

```
npm install
npm start -- sample.md       # a browser tab: node, no build step
npm test

rustup toolchain install stable   # once, for the native window
npm run app -- sample.md     # the native window
npm run dev -- sample.md     # the same window, page reloadable without a recompile
```

For the browser there is no build step worth the name: `src/` and `public/` run as
they are, and `prestart` only writes the two generated files below. The native
window is a Rust binary, so it needs a toolchain — [rustup](https://rustup.rs) — and
the first compile takes a few minutes. After that it is seconds.

## What is generated

Two commands, and the reason to know about them is that the app **embeds** its copy
of the page at compile time. A change to `public/` that has not been through both is
a change that is not in the window, which looks exactly like the change not working.

| | |
| --- | --- |
| `npm run build:web` | Bundles `src/` into `public/vendor/render.js`, `public/vendor/sanitize.js` and `public/vendor/backend-tauri.js` — the renderer, DOMPurify and the reader, for a page that has no node to import them from |
| `npm run build:dist` | Stages `shell/dist`: `public/`, the vendored CSS, the mermaid ESM tree, the icon. This is what `tauri.conf.json` names as the front end |

`npm run app`, `npm run dev`, `npm run bundle` and `npm test` each run the ones they
need, so the only time to reach for them by hand is after editing `src/` with a
window already open — and `npm run dev` re-runs them for you on every edit, which is
[the point of it](#the-dev-loop).

There is a third, `npm run build:site`, but it generates nothing the app or the
reader uses — see [The landing page](#the-landing-page).

And one that is committed rather than built every time: `npm run notices` writes
`THIRD-PARTY-NOTICES.md`, every npm package and crate the app ships with its license
and its license text. Run it after anything that changes `package-lock.json` or
`shell/Cargo.lock`. It needs cargo, which is why it is not a pre-step of anything;
`npm test` recomputes the digest of the two lockfiles that the file records, and
fails if they have moved on without it. See [Licenses](#licenses).

A development run shares its bundle identifier with an installed copy, and the
single-instance lock is keyed on that — so quit the installed one first, or the
second launch will simply hand its files to the first. Giving the run its own `HOME`
gives it its own preferences and its own snapshot store:

```
HOME=/tmp/redline-dev npm run app -- sample.md
```

## The dev loop

Three numbers decide which of the three commands above to reach for. On an
M-series laptop, with everything warm:

| | |
| --- | --- |
| `npm start` | no compile at all. The browser tab is `src/` and `public/` as they are |
| `npm run app` | **~3 s** — `build:web` and `build:dist` are two tenths of it, a cargo dev build is the rest. Every page edit pays it, because the page is *in* the binary |
| `npm run bundle` | **~40 s of compile** before it even starts bundling, and then a dmg. `opt-level = "z"` with LTO and one codegen unit means an edit anywhere re-optimizes everything |

So the bundle is for shipping, and CI is where it belongs. Three seconds is not
slow, but it is three seconds and a lost scroll position on every CSS tweak, and
`npm run dev` is for when that adds up.

```
npm run dev                  # an empty window
npm run dev -- sample.md     # opening a file, like `npm run app`
npm run dev -- --no-watch    # stage once and leave it alone
```

It runs `tauri dev` rather than `cargo run`. With `frontendDist` and no `devUrl`,
Tauri starts a static server of its own over `shell/dist` (port 1430) and points
the window at that instead of embedding it — so the page is a file on disk again,
and **⌘R picks up an edit with no compile**. `scripts/dev.mjs` adds the restaging:
a watch on `public/` and `src/` that re-runs the two build steps. Rust is still a
recompile, but `tauri dev` watches for that itself and restarts the app.

That this works at all rests on `shell/dist` being **gitignored**, because Tauri's
watcher honours gitignore and would otherwise see every restage as a reason to
rebuild the Rust — which is the cost the whole exercise exists to avoid. If a page
edit ever starts recompiling, that is the rule that broke; `test-smoke.js` asserts
it.

Two things differ from the app you ship, and the first one catches everybody:

- **The window's origin is `http://localhost:1430`, not `tauri://localhost`.**
  `localStorage` is keyed by origin, and every layout preference this reader has
  lives there — `redline:settings`, `redline:side`, `redline:toc`, all of them. A
  dev run therefore opens with default sidebars, default font and marks on, and
  remembers nothing an installed copy knows. That is isolation rather than damage,
  but *my widths are gone* is the expected behaviour and not a bug.
- **The page arrives over http**, not through the custom protocol the bundle uses.
  Anything protocol- or origin-sensitive is untested until `npm run app` or
  `npm run bundle`, and those stay what a change is checked with before it is
  called done.

Run one at a time. `build:dist` empties `shell/dist` before it refills it, so two
watchers staging into it race and the loser dies somewhere inside the mermaid
tree — and the app's single-instance lock makes a second window pointless anyway.

For work that is only `public/`, `npm start` is still the better loop: no cargo in
the picture, and devtools that are not WebKit's inspector bolted to a webview.
`npm run dev` earns its keep on the page code that only exists in the window — the
drag-region toolbar, the tab strip, the menu wiring, the drop overlay.

## Tests

```
npm test
```

One file, `test-smoke.js`, run by `node` with no test framework. It boots the real
server on a temp file under a temp `REDLINE_HOME`, edits the file, and asserts on
what comes back over HTTP — so a passing run means the thing actually works end to
end, not that its units agree with their mocks.

What it covers: the first clean render; static assets including the mermaid bundle;
the block diff and the word diff inside a changed block (including that the HTML it
emits is balanced and that it falls back when it should); the raw view with and
without a baseline; the contents list and heading anchors, including that a
baseline-only heading cannot steal an id; checking a change off over `/api/ack`;
SSE reload; snapshot and git baselines; mark-read; the version a
document is compared against being remembered, surviving a restart and being
forgotten when that version is cleaned up; the git import and its catch-up after a
later commit; cleaning up history to a version; several documents open at once on
one server; persistence across restarts; that a store left under the app's old
name is migrated; and that the server refuses a rebound `Host` or another site's
request, and serves the page with its CSP; that `LICENSE` is the Apache text to the
byte, the bundle carries it with `NOTICE` and the third-party notices, and those
notices are current with both lockfiles; and that the bundle identifier is the new
one, with the copy-over from the old one wired in ahead of the prefs.

It also greps `public/` to check that each of those features is actually **wired
up** — the id exists, the handler exists, the CSS rule exists. A diff that is
correct and unreachable would otherwise pass.

It cannot watch a hostile document fail to run, because there is no DOM here. What
it checks instead is that each layer from
[What a document can do](architecture.md#what-a-document-can-do) exists and is
wired to the place it guards: both document sinks go through DOMPurify, and every
other `innerHTML` in the page is named. The app's CSP matches the server's. The
shell's spawn allowlist matches the argument lists `src/` builds, down to the
osascript text. The cases themselves — which command lines run, which paths can
be written — are Rust unit tests, run in `shell/` with `cargo test`.

The PlantUML checks work either way round: with a renderer installed they assert the
inline SVG, without one they assert the fallback block and its note. The run says
which it did.

## CI

Two workflows, and **neither runs unless somebody presses Run workflow** on the
Actions tab: no push, no pull request and no tag starts anything.

| | |
| --- | --- |
| `.github/workflows/bundle.yml` | `npm run bundle` on `macos-latest`, uploaded as an artifact — **`Redline-universal-dmg`** or **`Redline-arm64-dmg`**. A **Universal** checkbox, off by default, picks which; one arch is half the compile and proves the same two things, that the release profile builds and that the bundle assembles. Started on a `vN.N.N` tag, or with **Deploy** ticked, it is a release instead: always universal, and [published](#publishing-a-release) |
| `.github/workflows/pages.yml` | the landing page, [deployed](#deploying-it) to Cloudflare Pages |

That is all of it, on purpose. This repo is private, so Actions minutes are metered,
and a **macOS minute bills at ten times a Linux one**. The bundle is an LTO compile of
a size-tuned profile, twice over for a universal binary; when it ran on every push
and pull request — with a test matrix and a debug compile in front of it — most of
the allowance went on answers nobody had asked for yet. Now every run is one
somebody wanted, and costs what that one answer costs.

**There is no test job.** `npm test` runs on the Mac the change was written on,
before the pull request is opened — which on a Mac includes the darwin-only font
assertions — and the bundle for app code either there or by Run workflow on the
branch. "App code" is anything outside `site/`, `docs/` and the root `*.md` files;
when a branch touches both, it is app code. What nothing checks any more is the suite on Linux, which is what used to catch a macOS
assumption getting into code meant to be portable.

The Rust build is cached on `shell/Cargo.lock`. An Actions cache is scoped to the
ref that wrote it, and every ref can read the default branch's but no other
branch's, so a run on `main` is the only one that leaves a cache a branch or a tag
can start from.

### Publishing a release

The artifact above needs a GitHub login to download, so it can't be what a Homebrew
cask points at. So a release is the bundle workflow **started on a tag**: push
`vN.N.N`, then Run workflow with the tag chosen under *Use workflow from*. That run
is always universal, and a second job, `release`, runs behind the bundle. It
attaches the signed, notarized dmg to a **GitHub release** for the tag, as
`Redline-<version>-universal.dmg`, reachable over plain HTTPS at
`https://github.com/tuanchauict/redlineapp/releases/download/v<version>/Redline-<version>-universal.dmg`
once the repository is public. A `.sha256` file goes up alongside it — a cask
formula needs that hash, and recomputing it by hand from a downloaded dmg is the
kind of step that gets skipped. There is nothing to set up for this and no secret
for it: the job's own `GITHUB_TOKEN`, given `contents: write`, is enough.

It is a job of its own, on Linux, because it is the only part of the run that
writes — a release here, a commit on the tap — and in its own job neither that
permission nor the tap token is in reach of the `npm ci` and the Apple credentials
in the bundle job. None of it needs a Mac. It refuses to run anywhere but
`tuanchauict/redlineapp`, since everything it publishes names that repository, and
the bundle job refuses a tag that disagrees with `package.json`, since the landing
page builds its link from the latter.

Releases used to go to a Cloudflare R2 bucket behind `dl.iamtuna.org`. Nothing
publishes there any more; the one file left that matters is `redline/latest.json`,
which copies up to 0.5.0 still read — see below.

The same job also updates the **Homebrew cask**, which lives in a separate
repository (`homebrew-tap`) with no git history in common with this one — so pushing
to it needs a credential of its own:

```
TAP_REPO_TOKEN    a PAT with push access to the homebrew-tap repository
```

The step clones that repo fresh, rewrites the `version` and `sha256` lines in
`Casks/redline.rb` — and the first `url` line, to the release download, so the cask
cannot go on naming wherever the dmg used to be — and pushes straight back to its
default branch: no PR, since a cask that still names last week's dmg is wrong for as
long as one is open. It reuses the version and hash the job computed when it staged
the files rather than asking the dmg again, so the two cannot disagree. A re-run
that finds the cask already right says so instead of failing on an empty commit.

Every release also carries a `latest.json` — `{"version", "url"}`, nothing else —
which is what **Check for Updates…** in the app reads
([native-window.md](native-window.md#checking-for-updates)), through
`releases/latest/download/latest.json`: GitHub redirects that to the file on
whichever release is marked **Latest**. So the release is published *not* marked
Latest, and marked only as the last step, after the cask: marking it is the claim
that the release exists, and a Homebrew copy told to `brew upgrade` before the cask
was pushed would be told about a version brew has not heard of.

Copies up to 0.5.0 read `https://dl.iamtuna.org/redline/latest.json` instead. That
file is replaced by hand, once, in the Cloudflare dashboard, with one naming the
first release published on GitHub, and then left alone: an old copy is told about
that release, and the copy it upgrades to asks GitHub from then on.

Pushing the tag does nothing by itself, so a tag that is pushed and never run is a
release that has not happened: the landing page names a dmg no release has. Run it
straight after the push.

A run on a branch publishes only if **Deploy** is ticked, off by default. It is the
same release — universal, GitHub release, cask, Latest — for a tagged run that
failed partway or a rebuild of the version already out, and with no tag to read it
takes the version from `package.json`, the one `build:site` writes into the download
link; with no tag to attach to, it creates `v<version>` at the commit it built. Run
it from `main`: whatever the branch holds is what every `brew install` and every
Check for Updates… gets. On a release that already exists the files are replaced
in place, and the cask is rewritten on every such run, not only the first, because a
rebuild under a filename already out has a new hash, and a cask holding the old one
fails every install with a checksum mismatch.

The artifact is the **dmg** and not the `.app`: the app is inside it, and a disk
image survives the artifact store's zip and unzip with its permissions and symlinks
intact — notarization ticket included, since the ticket is stapled into the bundle
rather than left for Gatekeeper to ask Apple about at launch.

Everything that reaches the bundle leg now is a push or a hand-started run, so there
is one bundle step rather than two: all of them have the secrets, and it is **signed
and notarized**. With none of them set — a fork building its own `main` —
`scripts/bundle.mjs` signs ad hoc and still produces a dmg, so that is not a red
tick either.

Rust is cached — the registry, and `shell/target` — on a key that is the hash of
`shell/Cargo.lock` alone, so there is one entry per set of dependencies rather than
one per commit. The debug and release legs use **separate keys**: the two profiles
leave different artifacts in `shell/target`, and sharing one entry would mean each
run restoring the other's and rebuilding anyway, in a cache twice the size. The cache
is not small, and the release profile is `opt-level = "z"`
with LTO and a single codegen unit, twice over for a universal build; it is minutes
of compile to save and seconds to restore.

## The landing page

`site/` is the project's page on the web — one hand-written `index.html`, one
stylesheet, one module, no framework and no bundler, the same way the reader itself
is written. It is not part of the app and the app knows nothing about it.

```
npm run site                       # builds, serves, opens http://127.0.0.1:8080/
npm run site -- -p 4000 --no-open  # a different port, and stay out of my browser
npm run build:site                 # just stage the icon and the og:image
```

`presite` runs `build:site`, so `npm run site` is one command and there is no staging
step to forget. `scripts/serve-site.mjs` is ~60 lines of `node:http` over `site/`,
loopback only, nothing cached — a stylesheet held for a minute during a round of
edits is a change that looks like it did not land. It takes the same `-p` / `--port`
and `--no-open` as the reader's own CLI and walks to the next free port the same way.

Nothing is watched and nothing is rebuilt while it runs, and it does not need to be:
the page is served exactly as it is written, so edit `index.html`, the stylesheet or
the module and reload. Only the icon and the og:image are staged, and those change
about once a year.

**Not `open site/index.html`.** `landing.js` is a module, and every browser refuses a
module script from a `file://` origin. The page still renders — it ships in its
finished state on purpose — so what you get is a page that looks right while the
theme toggle, the copy buttons, the scroll reveal and all five animations are
silently dead. That failure looks exactly like the script being broken. Serve it.

`build:site` copies `assets/icon.svg` to `site/icon.svg`, and out of `docs/images/`
only the files the page actually names — which is one, `hero.png`, for the `og:image`.
Both destinations are **gitignored**, for the same reason `public/vendor/` is: they
are bytes this repository already has, and a second copy is a second thing to
remember to update. The script fails if the page points at a local file that is not
there, which is the only check available for a page with no browser in this
repository to open it in. It reads `content=` as well as `src=` and `href=`, because
the `og:image` is a reference nothing here or in any browser would ever report
broken — the only thing that resolves it is somebody else's link preview.

That `og:image` is written **absolute**, `https://redline.iamtuna.org/images/hero.png`.
The Open Graph spec asks for a full URL and an unfurler does not resolve a relative one
against the page: with `images/hero.png` Slack drew the title and description next to
an empty grey box. `build:site` strips the site's own origin back off to find the file
to copy, and refuses a page whose `og:image` is not absolute on that origin.
`og:image:width` / `height` are given so a preview can lay out the card before it has
fetched the image — regenerate `hero.png` at a different size and change them too.

### Nothing on it is a screenshot

Not the hero and not the four scenes below it. Every feature the page shows is played
out live, in markup the stylesheet animates, and the rule each of them keeps is the
same one: **the markup is already in a finished, correct state, and the script only
moves one attribute or one class.** Block the module and the page is still a complete,
honest, still page — which is also what it is while `landing.js` is being served from
a `file://` origin, so this is not a hypothetical.

The hero is a short document marked and unmarked on a loop, moving `data-phase`
between `clean`, `reload` and `marked`. That is the same thing the reader's own
`no-diff` class does, and the demo arrives `marked`.

The four scenes under it invert that convention — a scene starts clean, and `is-marked`
turns a mark **on** — because each one is about arriving somewhere rather than about
the marks going away:

| Scene | What moves | What draws it |
| --- | --- | --- |
| `#sim-view` | `data-view` | rendered prose or the raw markdown, same file |
| `#sim-tone` | `data-tone` | the scene's own light and dark palette, diagram included |
| `#sim-jump` | `is-at`, `is-off` | `n` / `p` / `c` walking the changes and putting them away |
| `#sim-history` | `is-marked` | the same document against three different baselines |

`#sim-view` and `#sim-tone` share one driver, because a scene that is a pair of
buttons writing one attribute does not need two: the markup says which attribute, in
`data-set`, and the script says nothing about either scene. `#sim-jump` translates the
document under a fixed window rather than scrolling it, so a trackpad cannot fight the
animation, and it derives the `+1 ~2 −1` on its bar from what is still outstanding —
that *is* what the number means in the app. Each scene plays itself only while it is
on screen, never under `prefers-reduced-motion`, and stops for good the first time a
pointer or a key reaches it.

Three more consequences worth knowing before editing any of it:

- **The three change colours are the reader's**, copied from `public/styles.css`, and
  `test-smoke.js` asserts they are still equal. The page is a picture of the product,
  and a green that is nearly the product's green is worse than no picture. The raw
  scene's `--syn` is deliberately *not* one of them: a colour that means "changed"
  somewhere on this page cannot also mean "this is a heading".
- **A scene with its own palette has to say `color` out loud.** `#sim-tone` redefines
  `--fg`, `--muted` and the rest on itself, which is how it shows the theme the page
  is not in. That reaches everything that names a property — the paragraph asks for
  `--muted`, the diagram's `fill` asks for `--fg` — and nothing that does not. `body`
  resolved `var(--fg)` once, and what the heading and the filename inherited is the
  colour it produced, not the reference; redefining the property above them changes
  nothing. So `.sim-tone` sets `color: var(--fg)` itself, and the scene's palette
  reaches what inherits. `test-smoke.js` asserts the declaration is still there,
  because the failure is dark text on a dark mock and the page it is on looks fine.
- **No mock may change height.** Both `.split` rows are `align-items: center`, so a
  scene that grows does not only grow — it moves the copy beside it and everything
  below it, twice a lap, with nobody touching the page. Each of the five handles it
  without a pixel value for anyone to maintain: the hero's marked state is taller than
  its clean one (the removed block and the removed words leave the flow), so
  `landing.js` measures it once and pins it; `#sim-view` gives both panes the same
  grid cell, which makes the box the taller of prose and source at every width;
  `#sim-jump` scrolls inside a fixed window; `#sim-tone` only ever changes colour; and
  `#sim-history` hides its removed paragraph with `visibility` rather than taking it
  out of the flow — which is why that paragraph has to stay the **last** block in that
  document, so the space it keeps reads as bottom padding. For the same reason, a
  block in that scene that comes and goes with the baseline carries no `w-del`: a
  `w-del` is `display: none` when its block is not in the baseline, and one word
  leaving the flow can cost the paragraph a line. `test-smoke.js` asserts all of it,
  because the failure is a pulse and there is no browser here to see one in.

The theme is applied by an inline script in the `<head>`, not by the module — the same
before-first-paint rule the reader's own page lives by, and for the same reason.

### The column, and the band that runs past it

Every band is `max-width: var(--page)` with `clamp(16px, 4vw, 34px)` either side, so
the content of the page sits in one column however wide the window is. `.band-alt` is
the exception that has to break that — its tinted background runs edge to edge — and
how it gets the column back is load-bearing. It is **padding**, computed to reproduce
the ordinary band's content box exactly:

```css
padding-inline: calc(clamp(16px, 4vw, 34px) + max(0px, (100% - var(--page)) / 2));
```

The obvious alternative — `max-width` and `margin-inline: auto` on each child — looks
equivalent and is not, because `margin-inline` is something a child can overwrite
without ever naming it. `.sim-wrap` sets `margin: 52px 0 0` for its top gap, and the
`0`s in that shorthand are the inline margins: the scene dropped out of the column and
sat against the left edge of the *window* while its siblings stayed centred, with the
gap between them growing by half of every pixel of window width. On a laptop it is a
few pixels. It was found on a wide monitor, where it was 400. The padding is out of a
child's reach, which is the whole reason to prefer it.

The same rule also kept the two kinds of band 34px out of line with each other, since
`max-width` on a child is a content box and `max-width` on `.band` is a border box
with the padding inside it. `test-smoke.js` asserts the padding form is still there
and that no per-child margin has come back.

### A row of cards has to look like a row

`.cards` is `auto-fit` over `minmax(270px, 1fr)`, which fills the band with as many
columns as fit: `floor((W + 18) / 288)`, so three at the full `--page` width. That is
the right answer for a group of three and the wrong one for a group of four, which
comes out as three and an orphan sitting under the gap where two more would go — a
card that did not fit, rather than the fourth thing worth saying. The four-card group
carries `cards-wide`, which states `repeat(2, 1fr)` and makes four a square. It has
to be stated: no minimum width gives two here and keeps giving two, because the count
is derived from the width and the width is a `clamp`. The cost of stating it is that
the rule cannot notice it has run out of room, so `@media (max-width: 560px)` takes
it back to one column — which is where `auto-fit` would have gone anyway, two 270px
columns and a gap wanting 558px against the 528 the page has there.

Within a row, the cards are stretched to the tallest of them and the slack has to go
somewhere. Three cards whose prose differs by one line otherwise end with their
illustrations at three different heights, and the row reads as broken rather than as
text of unequal length. `.card > p:last-of-type` takes `margin-bottom: auto`, so the
slack opens above the illustration instead of below it and the mocks land on the
floor together. `.mini` already says `margin-top: auto` and would do the same job,
but `.cards .mini` overrides it to hold the 20px gap in the card that has no slack —
one declaration cannot be both, so the two sit either side of the gap. A card with no
illustration is unaffected: its last paragraph is already the last thing in it.

One thing that is not a layout rule but looks like one: `.nb` is `white-space:
nowrap`, and it wraps a bracketed key cap — `(⌘B)` — as a single unwrappable word. A
`kbd` is an inline-block, a line break is allowed in front of it like any other word
boundary, and a `(` left at the end of a line with its cap on the next reads as a
typo rather than as a wrap.

### What it may not say

The repository is **private**, and the page is the only part of this project a
stranger sees. So it offers no route that needs a login and no install from a
checkout: no link into the repository, no `npm install`, no `git clone`. Both are asserted
in `test-smoke.js`, because the natural thing to write on a page about a reader with
~430 lines of diff in it is *go and read it*, and nobody can.

What it offers instead is what [Publishing a release](#publishing-a-release) puts
within reach of a stranger: the Homebrew cask, and the dmg on the GitHub release
beside it — the one `github.com` link the page is allowed.

**The product the page sells is the app.** `npm start` and the browser tab it opens
stay exactly where they are — they are how this repository is developed and tested —
but the page does not mention a local server, a port or a browser, because a stranger
who can only `brew install --cask` has no way to reach any of them. The same asserted
absence of `npm install|start|run` covers it.

**It does not sell the implementation.** No comparison to Electron, no download size,
no dependency count, no line count, no assertion count. A page that says "only six
dependencies" is talking about the repository, and the repository is the one thing a
stranger cannot have; what is left is a boast they have to take on trust about a
product they have not used. The `Built like this on purpose` section that said all of
that is gone, and nothing load-bearing went with it — snapshots-not-commits and the
50-commit git import are in the ticks under *You choose what since means*, and
`~/.redline` and nothing-leaves-the-machine are in the note at the foot of *Get it*.

The strip of four big numbers under the hero went the same way and for the same
reason, one rule later than it should have: two of them were `0` — files written
beside yours, requests off the machine — which is the promise this product is making
and deserves the sentence it already has at the foot of *Get it*, not a scoreboard
cell. The other two were `50` commits read in and `6` dependencies, which is the
repository talking about itself. Counted as a figure, `0` invites the reader to work
out what large would have meant, and the two numbers beside it answered in a unit
that has nothing to do with them. `test-smoke.js` now asserts the page quotes no
count of its own parts, so the next one has to be argued for.

**And it does not print a keyboard map.** Keys are named in the prose of the feature
they belong to — `r` where the raw view is described, `n` / `p` / `c` on the buttons
of the scene that walks changes — because a key is worth knowing at the moment you
learn what it does, and a grid of sixteen of them on a page for somebody who has not
installed the app yet is a reference for a thing they cannot press.

And the page is a **markdown reader** first. Review mode is the feature it leads with
and the reason the product exists, but it is one section of several, under a heading
that says so. Nothing on the page forecloses an edit mode or an agent that writes —
so no sentence anywhere says there is no edit mode — and nothing on it promises one
either.

### The version it names

The release job builds the dmg's filename out of the version, so the download button
has to name a version, and that is the one thing on the page that goes stale by
itself. `build:site` writes `package.json`'s version into the `href` and the version
printed on the button, so bumping a release is one edit — `package.json` — and a
build, not two strings kept in step by eye across two files. It still fails loudly
if the button or its version span is missing outright, rather than guessing at a
page that no longer has one.

The page names the real tap, `tuanchauict/tap/redline`, in both the hero and the
install band, and [Publishing a release](#publishing-a-release) is what keeps the
cask behind that name current on every release. `build:site` still refuses to
stage a page that says the placeholder it once did — **`TAP/redline`** — so a
revert back to it fails the build loudly rather than publishing a `brew install`
nobody can run.

## Deploying it

Cloudflare Pages, from `.github/workflows/pages.yml`, by hand from the Actions tab
and never on a push. Run it after anything that changes what is uploaded: `site/`,
`docs/images` (copied in by `build:site`), or a version bump in `package.json`, which
`build:site` writes into the download button — so a release wants a Pages run after
the bundle run.

The project is **`redline`**, and the hostname is **`redline-1dq.pages.dev`** — not
the project name plus `.pages.dev`, which is the obvious guess and is somebody else's
site. The subdomain is global rather than per-account, `redline` was already taken,
and Cloudflare suffixed this one. Nothing in the repository records it, because
nothing in the repository chose it: the deploy log is where it is written, on
wrangler's last line (`✨ Deployment complete! Take a peek over at …`), and the Pages
dashboard shows it too.

`wrangler.toml` names the project and the directory, so the workflow and a local run
cannot disagree about what is being deployed:

```toml
name = "redline"
pages_build_output_dir = "site"
```

Three things are needed once, before the first run. The project itself, which wrangler
will not create from CI:

```
npx wrangler login
npx wrangler pages project create redline --production-branch=main
```

and two repository secrets, under Settings ▸ Secrets and variables ▸ Actions:

```
CLOUDFLARE_API_TOKEN     a token with the "Cloudflare Pages: Edit" permission
CLOUDFLARE_ACCOUNT_ID    Workers & Pages, in the sidebar on the right
```

The deploy runs `npm run build:site` first and **no `npm ci`**: the page has no
dependencies, and the ones in this repository belong to the reader. An unbuilt `site/`
is the page with no icon and no link preview, and it would upload perfectly happily —
which is why the staging step is asserted in `test-smoke.js` alongside the page itself.

`site/_headers` is Cloudflare's own format and is committed rather than copied in;
nothing in it is cached as immutable, because none of these filenames carries a
content hash and a regenerated image has to be able to reach somebody who has already
been here.

**`landing.css` and `landing.js` are `no-cache`, and that is deliberate.** The HTML
sends no `Cache-Control`, so it revalidates on every visit; anything held by a
`max-age` does not. Hold the stylesheet for an hour and a returning reader gets this
deploy's markup against the previous deploy's CSS — which, on a page whose markup
ships in its finished state and whose stylesheet is the whole of what makes it look
like anything, is unstyled buttons, scenes with no frame, and the diagrams drawing in
SVG's default black. `no-cache` is not `no-store`: both files stay in the browser
cache, they are just revalidated, and the usual answer is a 304 with no body. Two
files on a one-page site is not a bandwidth question. Images keep their day, because a
slightly old screenshot is still a screenshot. `test-smoke.js` asserts the pair — the
`no-cache` and the unversioned filenames — so adding a version string is a line that
tells you to revisit this.

You will not see this skew yourself: your first visit after a deploy has nothing
cached, and `npm run site` sends `no-store`. It only appears for people who have been
here before.

Deploys are **not** cancelled in progress, unlike CI: a half-finished upload is a
worse thing to leave behind than a wasted minute.

## Icons

`assets/icon.svg` is the source; `assets/icon.png` and `assets/icon.icns` are
rendered from it and committed, so nothing is needed to build or run. If you change
the artwork:

```
brew install librsvg
npm run icons
```

## Shipping it

```
npm run bundle                  # this machine's architecture
npm run bundle -- --universal   # Intel and Apple silicon in one app
```

Stages the page, compiles the shell, and writes `dist/Redline.app` (**8 MB**) and a
`dist/Redline-<version>-<arch>.dmg` (**3 MB**) with everything the reader needs
inside it, including the mermaid renderer. The recipient drags the app to
Applications and needs nothing installed. PlantUML is still not bundled, for the
reasons in [Diagrams](diagrams.md#plantuml).

Those numbers are the whole reason the shell is Rust: the same app on Electron was
375 MB of `.app` and a 165 MB dmg, because an Electron app ships a browser and a
node of its own. This one asks macOS for the WebKit already on the machine, so the
bundle is one 8 MB binary with `shell/dist` compiled into it and nothing else — and
5.5 of those 6 MB of page are the mermaid renderer. The shell is the small part.

`shell/Cargo.toml` is deliberate about the rest: `opt-level = "z"`, `lto`,
`codegen-units = 1`, `panic = "abort"` and `strip`. None of the unwinding tables or
the symbols is worth a megabyte in a document reader.

### Licenses

Redline is Apache-2.0: `LICENSE` is the Apache text exactly as apache.org publishes
it, and `NOTICE` carries the copyright. The bundle puts both in
`Redline.app/Contents/Resources`, with `THIRD-PARTY-NOTICES.md` beside them
(`bundle.resources` in `tauri.conf.json`), because the app is a binary built from
other people's code and most of their licenses ask for their notice to go wherever
the code goes. For the same reason `build:web` keeps each bundle's license comments,
at the end of the file, rather than minifying them away.

`scripts/notices.mjs` decides what counts as shipped: every non-dev package in
`package-lock.json`, and every crate the shell links on macOS, followed through
normal dependencies only. Two of them ask for more than their notice — **elkjs**
(EPL-2.0, in mermaid's layout engine) and the MPL-2.0 crates under Tauri's HTML
handling — and what they ask is that the source be findable, which the notices file
does with a link for every row. Nothing in the tree is GPL. PlantUML is, which is one
of the reasons [it is not bundled](diagrams.md#plantuml).

## Signing

Whoever runs the bundle decides how it is signed, and `scripts/bundle.mjs` says
which of the three it did on the line after the file sizes.

| | |
| --- | --- |
| **Ad hoc** | The default, from `signingIdentity: "-"` in `tauri.conf.json`. The least macOS will launch on Apple silicon, and nothing like enough for a Mac that downloaded it |
| **Signed** | `APPLE_SIGNING_IDENTITY` in the environment is patched over that `-` with `tauri build -c`, which merges last-over-first — a documented promise, rather than a guess about whether the config file or the variable wins |
| **Signed and notarized** | A *whole* set of credentials alongside it — `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_API_KEY` + `APPLE_API_ISSUER`. Tauri notarizes on its own once it finds them; nothing here asks for it. Half a set notarizes nothing, and the script will not claim otherwise: `APPLE_ID` alone is a variable people have exported for other reasons |

Signing without notarizing does **not** get you a clean first launch. Since Catalina
Gatekeeper wants both, and a Developer ID app that was never sent to Apple is refused
exactly like an ad hoc one. So the signed-but-not-notarized case still prints the
quarantine note:

```
xattr -dr com.apple.quarantine /Applications/Redline.app
```

(or right-click the app ▸ **Open** and confirm once).

The certificate is a **Developer ID Application** one — a different type from the
*Apple Development* / *Apple Distribution* certificates an iOS app is signed with,
but the same paid Apple Developer Program membership, which covers every platform.
Xcode ▸ **Settings ▸ Accounts ▸ Manage Certificates ▸ + ▸ Developer ID Application**
is the short way to one; it needs the Account Holder or Admin role, and the Apple
Developer *Enterprise* Program does not offer Developer ID at all. Export it from
Keychain Access as a `.p12`.

`APPLE_PASSWORD` is an **app-specific password** from appleid.apple.com ▸ Sign-In and
Security, not the Apple ID password. An App Store Connect API key works instead —
`APPLE_API_KEY`, `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`.

`macOSPrivateApi: true` is not a problem here: notarization is a malware scan and a
check that the signature and the hardened runtime are in order, not App Store review,
and it has no opinion about private API.

These are the repository secrets the bundle job reads:

```
APPLE_CERTIFICATE            base64 -i cert.p12 | pbcopy
APPLE_CERTIFICATE_PASSWORD   the .p12 password
APPLE_SIGNING_IDENTITY       Developer ID Application: Name (TEAMID)
APPLE_ID                     the Apple ID the membership is on
APPLE_PASSWORD               the app-specific password
APPLE_TEAM_ID                the ten-character team id
```

Tauri imports the certificate into a keychain of its own, so CI needs no keychain
setup. Locally, export the same variables before `npm run bundle` — or export none of
them and get the ad hoc build, which is all a local run needs.
