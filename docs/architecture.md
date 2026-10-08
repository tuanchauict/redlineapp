# Architecture

Node ESM and hand-written CSS, no framework. Nothing is transpiled, so what you read
in `src/` and `public/` is what runs; the only dependencies that reach the page are
vendored as they ship (`github-markdown-css`, `highlight.js` themes, `mermaid`).

**One reader, two shells.** Everything that decides what a document is — the
renderer, the diff, the snapshot store, the git import — runs in whichever
JavaScript engine it finds itself in. In a browser tab that is node behind
`node:http`; in the desktop app it is the webview, and there is no node and no
server at all. What differs between the two is one adapter apiece, and nothing
above them knows which one it has.

```
bin/redline.js          CLI: parse flags, start the server, open a browser

src/reader.js           the open-document registry, the watcher, the payload
src/server.js           HTTP + SSE over the reader
src/store.js            the snapshot store: history, baselines, checked changes
src/document.js         two versions of a text -> HTML, marks, contents
src/render.js           markdown-it and its plugins, block splitting, the outline
src/front-matter.js     the `---` header block's lines, as fields to show
src/hljs.js             the highlighter, with a chosen set of languages
src/diff.js             block-level diff, and the markup the marks are made of
src/inline-diff.js      word-level diff, over rendered HTML
src/hash.js             SHA-1 and SHA-256 in plain JS, because they are names
src/git.js              git detection, `git log --follow`, `git show`
src/plantuml.js         local PlantUML renderer, with a per-diagram cache
src/paths.js            paths as a person reads them (`~`)
src/platform.js         the disk, as the reader asks for it
src/platform-node.js      ... over node
src/platform-tauri.js     ... over the shell's IPC
src/native-tauri.js     `window.mdNative` over the shell's IPC
src/backend-tauri.js    the entry point the app's page imports
src/sanitize.js         DOMPurify, and what a document may put on the page

public/index.html       the page: toolbar, two sidebars, document pane, Settings sheet
public/app.js           the whole client
public/backend.js       the seam: an http server, or the reader in the page
public/styles.css       the whole stylesheet

shell/src/main.rs       the desktop shell: launch, files arriving, window events
shell/src/win.rs        windows and tabs
shell/src/menu.rs       the menu bar, and what each item means
shell/src/cmds.rs       what the page may ask of the shell
shell/src/host.rs       what the page may ask of the disk, and what it may not
shell/src/prefs.rs      window.json: bounds, session, recent, settings

scripts/build-web.mjs   src/ -> public/vendor/, for a page with no node
scripts/build-dist.mjs  stage shell/dist: the page, as the app embeds it
scripts/make-icons.mjs  icon.svg -> icon.png, icon.icns
scripts/bundle.mjs      .app and .dmg
scripts/build-site.mjs  stage site/: the icon, and the one image it names
scripts/serve-site.mjs  serve site/ over node, so a module script loads at all
test-smoke.js           the whole test suite

site/                   the landing page. Nothing above it knows it exists
```

## What happens when a file changes

1. The file is watched: `fs.watch` on its **directory** — not the file, so an atomic
   save (write temp, rename) does not lose the watch — with a 1.5 s poll behind it
   for network and odd filesystems, and a read retried a few times because
   mid-rename the path briefly does not exist. The app has no `fs.watch`, so there
   it is the poll alone, a little faster.
2. The new text is hashed and handed to `DocStore.record`, which writes
   `objects/<hash>.md` if that content is new and puts the version at the newest end
   of the file's history.
3. Every subscriber on that document is told `{ type: 'change' }` — over SSE in a
   browser tab, as a direct call in the app.
4. The page asks for the payload again and re-renders the whole document from it,
   then puts the scroll position back.

Re-rendering everything on every keystroke-save is fine at the size a document
actually is, and it means there is no incremental-update path to get wrong: the page
is a pure function of the payload.

## Open documents

`createReader` (`src/reader.js`) keeps a `Map` of open documents keyed by
`hashContent(abs).slice(0, 12)`, and hands back `retain` / `release` / `setFile` /
`pathOf` plus a method per action for whoever is embedding it.

Entries are **reference counted**. Two windows on the same file share one watcher
and one store; the last one to let go is the one that stops watching. This is what
keeps a document's history consistent when the same file is open in two places.

A caller names its document by id. In a browser tab a request with no id gets
whichever document is open, which is how a plain tab works; naming a document that
has since been closed raises `Closed` — `410` over HTTP — rather than handing back
somebody else's file.

## HTTP

Only the browser build. The app calls the same reader directly, with the same
arguments and the same answers, which is why there is no second table here.

| | |
| --- | --- |
| `GET /api/doc?id&baseline` | The whole document payload (below) |
| `GET /events?id` | SSE: `{type:'change'}`, `{type:'file'}`, `{type:'history'}` |
| `POST /api/mark-read?id` | Move the read mark to the current version; answers with a fresh payload |
| `POST /api/ack?id&key&on&at&block` | Check one change off, or bring it back. `at` is the version the page was showing and `block` the change's own block in it, so an edit to it later is marked against what was read. `?clear=1` for all of them. Answers with the key list and nothing else — the page has already hidden the mark |
| `POST /api/prune?id&upto&baseline` | Forget a version and everything older; sweeps unreferenced objects |
| `POST /api/open?id&path` | Show a different file in this page — a link to the document beside this one. Answers `{id, path}`, and the id is not the one sent: opening releases the document the page was on. Browser only; the app answers the same link with a window of its own |
| `GET /` and `public/*` | The client. Plus `/icon.svg`, the vendored CSS, and `/vendor/mermaid/*` out of `node_modules` |

Only `127.0.0.1` is bound, and no request ever leaves the machine. Binding the
loopback keeps other machines out but not other web pages, so every request has to
come from this server's own page — see
[What a document can do](#what-a-document-can-do).

### The document payload

`buildDoc` answers with everything the page needs in one go, so a paint is never a
sequence of round trips:

| | |
| --- | --- |
| `id`, `path`, `name`, `dir`, `dirLabel` | What this document is, and how to title it |
| `hash`, `mtime` | The version on disk |
| `text` | The file as it stands |
| `base` | The version it is being compared against, or `null` for none |
| `acked` | Which change keys are checked off |
| `ackedFrom` | The versions those were checked off in, `[{ hash, text, blocks }]`, for the diff to find the text you read (see [below](#the-diff)). Empty when there is no diff |
| `baseline`, `baselineAvailable` | What it is being compared against, and whether that can still be honoured |
| `history` | Every version, newest first, with `current` / `baseline` marked |
| `tracked` | Whether git knows about the file |

**The document itself is not in here** — no `html`, no `rawHtml`, no stats, changes
or contents list. Those come from `renderDocument(root, text, base)` in
`src/document.js`, called by the page, and that is the whole reason the payload is
shaped like this: the diff is the product, and a browser tab and the app disagreeing
about what changed is the one bug this rules out rather than tests for. There is one
implementation and it runs wherever the page is.

`base` is `null` rather than `''` when there is nothing to compare against, because
the page has to tell those apart: one renders plainly, the other marks the whole
file as added.

[Reading a version by itself](history.md#reading-a-version-by-itself) is the
same payload rendered another way: `adopt` renders `base` plainly instead of `text`
against it, and takes the bar's title from `text` with `titleOf`. The reader is not
asked anything new, which is why the switch is a page state (`state.solo`) and not
a baseline name.

A baseline is named by a string: `read` (the store's own pointer, the default),
`git:HEAD`, `snap:<hash>` for a particular version, or `none` for no comparison at
all. `validBaseline` downgrades a name the store can no longer honour — a pruned
snapshot, `git:HEAD` on an untracked file — to `read`, so a stale request from a
reopened tab degrades instead of failing.

There is a fifth form, `last:<one of the above>`, and the split it draws is the
point: the four above are a baseline being **chosen**, and `last:` is a document
being **shown**. Choosing one is kept in the store (`compare`, separate from the
`baseline` hash); `last:X` means "whatever this document was last compared against,
and `X` only if it never has been". `buildDoc` writes the memory and
`validBaseline` reads it, which is why both live on this side rather than in the
page: the page does not know which file it is showing until the payload arrives, so
resolving it there would mean a first paint against the wrong baseline and a visible
correction — and the browser tab and the app's webview are separate origins, which
would have given one file two memories.

The fallback travels inside the token because it comes from **Compare against** in
the settings sheet, which the page holds and the reader does not. A `last:` request
is not itself a choice, so it is not stored; nor is `none`, which names no version.
`src/server.js` answers a request with no `baseline` param as `last:read`, and
`public/app.js` sends `keptBaseline()` wherever it shows a document and
`defaultBaseline()` only when the setting changes.

## The store

Content-addressed, and shared by every document: `objects/<hash>.md` is one distinct
version of some file, `docs/<sha1-of-path>.json` is one file's history, baseline
pointer, remembered comparison, checked-off keys and imported commits. See
[History ▸ Where it lives](history.md#where-it-lives) for the layout and the caps.

`DocStore.gc()` sweeps objects nothing references; it runs at startup and after a
prune, because only a pass over every document's history can say whether an object
is still wanted.

A **change key** names one marked block by its own content —
`kind + hash(before + after).slice(0, 10)`, with a `.2`, `.3` suffix when two
changes are word for word the same. That is what makes a checked-off change survive
the document moving around it, and it is why editing that same wording again makes a
new one.

A check-off is stored as `{ key, at, block }`: the key, the version it was made in,
and the `blockId` of the file's side of the change in that version. `gc` treats
`at` as a reference, so clearing history does not orphan it. A bare string in the
list is a check-off from before records, and is read as `{ key }`.

## The diff

`src/diff.js` splits both versions into top-level blocks with markdown-it's own
parser (`splitBlocks`), diffs the block *sources* with `diffArrays`, and pairs a run
of removals against the run of additions after it: an aligned pair that is at least
35% similar is one edit rather than a delete and an insert.

A paired block goes to `src/inline-diff.js`, which diffs the two blocks' **rendered
HTML** word by word. Marking up markdown source would cut through emphasis runs,
link destinations and fences; working on HTML means the marks have to respect tag
boundaries instead, which is the bulk of that module — plus the bail-outs that send
a block back to the two-versions form when marking it up would read worse than not.

Three consequences worth knowing if you are editing this:

- **Each block is rendered separately**, through its own `md.render` call. Anything
  markdown-it accumulates across a document therefore has to be threaded through an
  `env` by hand. References are collected per side; heading ids come from a queue
  computed once by `outline()` and handed only to the *new* side, so a block that
  exists only in the baseline cannot take an id belonging to one in the file.
- **The old and new sides get different `env`s**, which is why `renderOld` and
  `renderNew` are separate functions rather than one with a flag.
- **A block re-parsed alone believes it starts at line 0**, which a block rule that
  cares where it is has to account for. The `---` header block is the one that does,
  and it happens to want exactly that: it fires only at line 0, so it is recognised
  both at the top of a whole document and when the diff hands it over by itself,
  while a `---` from the middle of a file arrives with no closing fence and falls
  through to `hr`. See [reading](reading.md#the-header-block).

**A checked-off block that has since been edited is diffed against what was
checked**, not the baseline. The reader cannot find that text, because splitting is
markdown-it's parse and markdown-it is on the page's side. So `buildDoc` sends the
versions named by live check-offs as `ackedFrom`, and `renderDiff` splits them
again (`seenBlocks`). An addition, or an edit that is closer to a lapsed check-off
than to its baseline, then goes through `modBlock` against that text, using the
block's own version's `env` so the word diff still lines up tag for tag. Matching
uses the same `similarity` as the block pass, so there is one rule for "the same
block, edited". See [changes](changes.md#a-checked-block-that-is-edited-again).

`renderRawDiff` is the same idea a level down: highlight both sources, split them
into lines, and diff the lines.

## The client

One module, ~1.4k lines, organised in commented sections: state, painting,
tabs, change navigation, checked changes, contents, history, settings, keys. There
is no component model — the document pane is `innerHTML` from the payload, through
`sanitizeDocument` on the way in, and everything else is a handful of
`replaceChildren` calls over small builders.

- **`state`** holds the payload, the view, the baseline, the checked keys and the
  contents rows. Anything derived is derived at paint time.
- **Preferences live in `localStorage`** under `redline:settings`, `redline:side`,
  `redline:sidew`, `redline:toc`, `redline:tocw`, `redline:diff`, `redline:view` and
  `redline:shut`, and the ones that affect layout are mirrored onto `<html>` by an
  inline script in `index.html` **before first paint** — otherwise the window
  flashes at the wrong size, or with the marks on, on every open. The two sidebar
  widths are clamped against each other so the document keeps 320px whatever they
  were dragged to, and that clamp is therefore in two places: `fitWidths` in
  `app.js` and the same arithmetic in the inline script. Either alone is a visible
  correction on the first frame.
- **Scroll position is preserved** across re-renders, view switches and tab
  switches; `keepAnchored` is the helper, and anything that adds or removes text
  above the reader's place goes through it.
- The contents list caches the heading node it points at when it is built, because
  the scroll spy runs on every frame the document moves and cannot be measuring by
  lookup.
- **The change ruler is measured, not derived.** Where a mark belongs on the
  scrollbar is a fact about layout, so `paintRuler` reads every marked node's rect
  and maps it against `scrollHeight`. The things that move them — a diagram
  finishing, a font swapping, a window resizing, the sidebar being dragged — do so
  in bursts and long after paint, so a `ResizeObserver` over the article redraws it,
  coalesced to one a frame.
- **A link out of the document is followed in one place for both shells.**
  `linkTarget` decodes the destination (markdown-it percent-escapes it) and walks it
  from `data.dir`; what happens to the result is the only part that branches — a
  window of its own in the app, `POST /api/open` in a tab.

**`window.mdNative` is what tells the page it is inside the app**, and its absence
is what tells it it is a browser tab. Where it is there, the page sizes its toolbar
for the traffic lights and hides the rows and buttons that are the shell's to answer
— the Settings gear, which the app menu provides instead. Everything else in
`app.js` is written once and does not ask.

- **A native window's first document comes from `onTabs`, not from a blind
  `load()`.** A browser tab's starting document is whatever `?id=` names, or
  nothing, which `load()` is written to handle on its own. A native window has no
  such id to ask with — `state.docId` starts `''` — so it has to wait for the
  shell's own answer, over `md:tabs`, naming which of its restored tabs is active.
  The module's own bottom-of-file startup `await`s a `firstTabShown` promise that
  the `onTabs` handler resolves (`.finally`, so a failed load still counts) instead
  of calling `load()` itself; calling both was a race `load()`'s own guard against
  overlapping loads could not catch, because the guard compares against the id a
  call started with and the blind call started with none. Losing that race left a
  tab looking selected in **Open files** — `paintTabs()` runs synchronously, ahead
  of either `load()` — while the pane silently showed whichever document the blind
  call happened to resolve to.

## The seam

Two facts reach the page before any of its own code runs, put there by the shell as
an initialisation script: `globalThis.__REDLINE_HOST` (the platform, `$HOME`, the
few environment variables that matter, the files this window opened on, the
window's own label, and the app's version for the About row) and `window.mdNative`.
Nothing is probed or fallen back from — by the time anything asks, the answer is
already on the window.

The label is there so the page can say which window's events it wants; see the third
of the [three Rust things](#the-desktop-shell) below for why that is not the default.

`public/backend.js` reads the first of those and becomes one of two things:

| | |
| --- | --- |
| No `__REDLINE_HOST` | `fetch` and an `EventSource` against the server the page came from. Reconnecting a dropped stream lives here, because that is a fact about http and means nothing further up |
| `__REDLINE_HOST` | A dynamic import of `vendor/backend-tauri.js`, which builds the reader **in the page** over `platform-tauri.js` and calls it directly. A browser tab never downloads it |

Both expose the same methods with the same arguments, which is the whole point: the
one implementation of the diff runs wherever the page is, so a tab and the app
cannot disagree about what changed.

## The desktop shell

Rust, and small on purpose: `shell/` owns a window, a menu, a modal panel and the
disk, and nothing about what a document is. The reader is JavaScript in the webview
either way, so porting the shell was porting the window management and none of the
product.

- **`host.rs`** is the disk, as `src/platform-tauri.js` asks for it: read, write,
  mkdirp, read_dir, remove, rename, exists, modified, spawn. Writing and spawning
  are held to what the reader does; see
  [What a document can do](#what-a-document-can-do). Plus `__REDLINE_HOST` —
  the environment is named key by key (`PATH`, `PATHEXT`, `REDLINE_HOME`,
  `PLANTUML_JAR`) rather than handed over wholesale.
- **`cmds.rs`** is what the page may ask of the shell, and the names match what
  `window.mdNative` offers one for one. `cmds::menu` is a test door: it lets a probe
  choose a menu item through the real `menu::dispatch`, and does nothing at all in a
  release build. `cmds::check_update` is the app's only outbound request — a curl for
  the release manifest, asked for and never scheduled; see
  [native-window.md](native-window.md#checking-for-updates).
- **`win.rs`** holds the windows and their tabs. A window's tabs are paths; the page
  is loaded once per window and told which document to show by an event, so
  switching tabs is not a navigation.
- **`prefs.rs`** is one `window.json` under `app_config_dir()`: bounds,
  always-on-top, the open folder, Open Recent, the session, and the app's settings.
  It is held in memory as well as on disk, so a window being dragged is not a file
  being parsed sixty times a second.
- `TitleBarStyle::Overlay` with the traffic lights floated over the page's own bar,
  and `hidden_title(true)` with it: Overlay only makes the title bar transparent, so
  macOS goes on drawing the window's title — which is the document's name — over a
  bar that already says exactly that.
- **`capabilities/default.json`** is what the page may ask of the *toolkit*, as
  against the shell's own commands, which are permitted by being declared. Three
  things: the event stream, and `start_dragging` and `internal_toggle_maximize` so
  that the page's bar can move and zoom the window the way the title bar it replaced
  did. An invoke that is not listed there is refused with nothing to see for it
  outside the webview console.
- A second launch is caught by `tauri-plugin-single-instance` and turned into "open
  these files as tabs of the running app". It is keyed on the bundle identifier, so
  a development build and an installed one cannot run side by side.
- **A document from Finder does not arrive after the launch — it arrives during
  it.** macOS sends `application:openURLs:` from inside
  `-[NSApplication finishLaunching]`, which is *earlier* than the
  did-finish-launching notification Tauri runs its `setup` hook on, so
  `RunEvent::Opened` on a cold launch reaches `arrive` before anything is managed.
  `main.rs` guards on `try_state::<win::Shell>()` and parks those paths in a
  `static PENDING`; `setup` drains it alongside the command line, without the
  duplicates, since `redline doc.md` in a terminal can name the same file both
  ways. With no file either way it waits 250 ms before putting the open panel up,
  because an *Open With* onto an app that is mid-launch can still land after
  `setup`, and the wrong answer arriving first is worse than the right one arriving
  late.
- Links go to the real browser through `tauri-plugin-opener`, from the page rather
  than from a navigation guard. In-page fragment links never leave the page, so the
  document's own anchors are unaffected.

Four things about writing Rust here that cost time to learn:

- **A panic here is not a stack trace, it is a crash report.** The release profile
  sets `panic = "abort"`, so `app.state::<T>()` on state that has not been
  `manage`d — the easy mistake, since every other path has state by then — is
  SIGABRT before the window is drawn, with nothing on stderr and nothing in a log.
  That is what a double-clicked document did for as long as the bug above lived:
  `open doc.md` returned 0 and no app appeared. `try_state` where it might be
  early; `~/Library/Logs/DiagnosticReports` when something vanishes without a word.
- **A synchronous `#[tauri::command]` runs on the main thread**, and
  `std::sync::Mutex` is not reentrant. One lock taken twice in the same call freezes
  the window and every IPC message after it — with no panic and no log to say so.
- **`merge_all_windows` closes the windows that are not in front**, which after a
  `move_tab_to_new_window` is the window that asked for it.
- **`emit_to(label, …)` is only addressed to that window if the page asked to be
  addressed.** A `listen` with no `target` registers for `EventTarget::Any`, and
  Tauri exempts an `Any` listener from the filter an `emit_to` carries — so a page
  that signs up the easy way receives *every* window's events. Everything the shell
  sends is addressed: a window's tab list, the menu commands, the drop overlay, which
  window went fullscreen. Left unscoped it showed up as one window's **Open files**
  listing another window's documents, or listing nothing under a document that was
  still on screen, and as the menu driving all the windows at once. One window
  behaves perfectly, which is why it took a while to find. `src/native-tauri.js`
  names its own label on every registration; an app-wide `emit` (`md:settings`)
  still arrives, because that one carries no filter to fail.

## What a document can do

Nothing that runs. A markdown file is someone else's text, and markdown-it is
configured with `html: true` because real documents use it — `<details>`,
`<img width>`, `<kbd>`, a `<p align="center">` around a README's badges. That
same switch lets a `<script>`, an `onerror=` or a `javascript:` link through. In the
app, the page that draws the document is also the page that can ask the shell to
run git and write the store. So there are three layers, and each one assumes the
one before it has failed.

**Sanitized at insertion.** `src/sanitize.js` runs DOMPurify over the document —
rendered or raw — as `app.js` assigns it to the pane, and over each PlantUML SVG
as it replaces its fence. That happens in the page, after the diff, not in
`render.js`: the renderer also runs in Node, where DOMPurify has no DOM and gives
its input back unchanged. And one call on the way in covers the inline word marks
and the raw view as well. The diff's own markup is plain HTML that the defaults
allow. On top of DOMPurify's defaults:

- `<style>` is forbidden. It applies to the whole window, so it could restyle
  the chrome or hide the change marks, which are this reader's reason to exist.
- `<form>` is forbidden. It is the one element left that can navigate the page
  on a click, and the link handler never sees it.
- The clobbering guard (`SANITIZE_DOM`) is off, and `name` is forbidden instead.
  The guard strips any `id` that is also a property of `document`. Heading ids
  are slugs, so `## Images` or `## Title` would lose its anchor and its entry in
  Contents. Of the elements that survive, only a `name` can stand in for
  `document.something`.

Mermaid draws its own diagrams with `securityLevel: 'strict'`, which sanitizes
labels and turns off click handlers.

**A content security policy under that.** Script comes only from the page's own
origin, plus the head script by its SHA-256. `connect-src` is the page's own
server, or in the app the shell's IPC. `object-src`, `base-uri`, `form-action`
and `frame-ancestors` are all `'none'`. The policy lives in two places:

- `src/server.js` computes it, hash included, and sends it as a header on
  `index.html`.
- `shell/tauri.conf.json` carries it for the app. The bundler hashes the inline
  script into it at compile time, and `dangerousDisableAssetCspModification`
  keeps it off `style-src`, where a nonce would switch off the `'unsafe-inline'`
  that every inline style depends on.

The test suite holds the two copies to the same directives. Images may come
from anywhere, because a README's badges and screenshots are on the web. A
remote image is still a request to its host, which is the price of rendering
those READMEs as written. `npm run dev` carries no CSP: its page is served by
the dev server, not out of the embedded assets the policy is attached to.

**The shell does only what the reader does.** `host.rs` leaves reading open,
because a reader follows links to any file and the CSP keeps what it read from
going anywhere. Writing is held to the store's own layout: `objects/<hash>.md`
and `docs/<key>.json` under the store root, the two directories, deleting a
snapshot, and the one rename from `~/.md-reader` to `~/.redline`. The roots
are `REDLINE_HOME` from the shell's own environment, not from the page,
`~/.redline` and `~/.md-reader`. `spawn` runs only the command lines `src/`
builds:

- the four git invocations in `src/git.js`, with anything the page chose kept
  where git reads it as a name and never as an option;
- the one JXA script in `src/fonts.js`, compared byte for byte;
- `java -jar` with a jar named `plantuml.jar` or the one `PLANTUML_JAR` names;
- a `plantuml` launcher by absolute path.

The test suite checks those argument shapes against the JS that builds them, and
counts the spawn calls in `src/`. A new one fails in the app and works in the
browser until `may_spawn` has an arm for it. `cargo test` in `shell/` runs the
cases.

**The browser server answers its own page and nothing else.** A `Host` other than
`127.0.0.1:<port>` or `localhost:<port>` is DNS rebinding, and every route
refuses it. An `Origin` from elsewhere, or a `Sec-Fetch-Site` other than
`same-origin` or `none`, is another site's page. It cannot read the answer, but
`/api/open` with any path would still have the reader snapshot that file into
the store. A cross-site *link* to the reader is refused for the same reason,
because the page opens whatever path its URL names. curl and Node's `fetch`
send neither header, which keeps the test suite and a script on this machine
working, and a program already running here does not need the server to read a
file.

## Conventions

- Comments say **why**, not what. The code says what.
- No framework and no transpiler — the cost of reading a file is reading that file.
  The two build steps exist because the app's page has no node to import from and
  no server to fetch from, not because anything here is compiled to something else:
  `build-web.mjs` bundles `src/` as it is, and `build-dist.mjs` only copies.
- One stylesheet, custom properties at the top, sections in the same order as
  `index.html`.
- An author `display` beats the browser's own `[hidden] { display: none }` whatever
  its specificity, so any rule that sets `display` on an element that gets toggled
  with `hidden` must carry its own `[hidden]` rule. The idiom here is
  `.row[hidden] { display: none }`.
- Every behaviour that can be asserted from outside gets an assertion in
  `test-smoke.js` — see [Building and testing](building.md).
