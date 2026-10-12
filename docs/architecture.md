# Architecture

Node ESM and hand-written CSS, no framework. `src/`, `bin/`, `scripts/` and the page
(`public/`, `site/`) are TypeScript, apart from the two classic scripts that have to stay
JavaScript; the test is still JavaScript while the conversion is under way
([typescript.md](typescript.md)). The code Node runs (`bin/`, `scripts/`, `src/hosts/node/`,
the test) goes through `tsc` into `out/` first. The page's three files compile in place
instead, to the `.js` that a URL names, so `public/app.ts` is what is edited and
`public/app.js` is what is served. What esbuild bundles is `src/` as written. The only
dependencies that reach the page are vendored as they ship (`highlight.js` themes,
`mermaid`), and `github-markdown-css` with its two palettes re-keyed from the system's scheme
to the page's by `build:web` (`scripts/markdown-css.mts`) and nothing else changed.

**One reader, three shells.** Everything that decides what a document is — the
renderer, the diff, the snapshot store, the git import — runs in whichever
JavaScript engine it finds itself in. In a browser tab that is node behind
`node:http`; in the desktop app it is the webview, and there is no node and no
server at all. The web app is the third: no server and no node, the reader in a
SharedWorker, and a page that has to be *given* its files ([The web app's
reader](#the-web-apps-reader), and [the web app](web-app.md) as a user meets it).
What differs between them is one adapter apiece, and nothing above them knows which
one it has.

```
bin/redline.ts          CLI: parse flags, start the server, open a browser
bootstrap/              the one hand-written .mjs, run before `tsc -b`: a page whose compiled
                        .js a branch switch deleted is rebuilt, not reported up to date
out/                    tsc's output: what every npm script runs. Gitignored

src/contract/           types only: the payload, the events, the two surfaces; imports only itself
  payload.ts            what the reader produces and every page consumes
  seam.ts               `Session`, the reader as a transport serves it; `Backend`, what a page holds
src/core/               pure: no I/O and no platform, so it runs anywhere
  document.ts           two versions of a text -> HTML, marks, contents
  render.ts             markdown-it and its plugins, block splitting, the outline
  front-matter.ts       the `---` header block's lines, as fields to show
  hljs.ts               the highlighter, with a chosen set of languages
  diff.ts               block-level diff, and the markup the marks are made of
  inline-diff.ts        word-level diff, over rendered HTML
  hash.ts               SHA-1 and SHA-256 in plain JS, because they are names
  paths.ts              join, dirname, basename, resolve for a given separator
  links.ts              where a link points: `walkPath`, `shorten` for `~`, and `MD_LINK`
  csp.ts                the content security policy as data, and the inline-script hashes
src/page/sanitize.ts    DOMPurify, and what a document may put on the page
src/reader/             the reader and what it needs, written against the platform
  reader.ts             the open-document registry, the watcher, the payload
  store.ts              the snapshot store: history, baselines, checked changes
  session.ts            the reader's surface as a page asks for it: what each call means
  platform.ts           the `Platform` interface: the disk, as the reader asks for it
  git.ts                git detection, `git log --follow`, `git show`
  plantuml.ts           local PlantUML renderer, with a per-diagram cache
  fonts.ts              the installed font families, where the OS can list them
src/rpc/                the page and the reader over messages; imports only rpc/ and contract/
  protocol.ts           the message shapes, the method list, errors across the wire
  serve.ts              the reader's end: answer a page's calls from a session
  client.ts             the page's end: the seam's shape, over `post` and `onMessage`
src/hosts/node/         the CLI's shell
  server.ts             HTTP + SSE over the reader
  platform.ts           the platform over node
  root.ts               where the repository is, from any file, in source or compiled
src/hosts/tauri/        the app's shell, in the page
  platform.ts           the platform over the shell's IPC, on core/paths.ts
  native.ts             `window.mdNative` over the shell's IPC
  backend.ts            the entry point the app's page imports
src/hosts/web/          the web app's shell: no server, no node, files in IndexedDB
  kv-files.ts           the store's file operations over a key-value store
  idb.ts                that key-value store, over IndexedDB; the one file no test runs
  platform.ts           the platform over `web:` handles, `drop:` files and the store
  handles.ts            the files the user granted, what a doc id was, what may be read now
  worker.ts             the reader, in a SharedWorker: one per origin, a document per tab
  backend.ts            the page's end of it: finds the worker, names it for the build, pings it,
                        asks for permission
  welcome.ts            the empty state: a file, a drop, the limits, a grant to ask for again
  host.js               the shim that makes a page the web app's; `stage-page.mts` puts it over
                        `public/host.js`, with the build's version after it

public/host.js          a classic script, first in the head, empty here; a host's own shim
                        (the web app's is `src/hosts/web/host.js`, put over this one by its build)
public/index.html       the page: toolbar, two sidebars, document pane, Settings sheet
public/app.ts           the whole client. Compiled in place to `app.js`, which is gitignored
public/backend.ts       the seam: an http server, or the reader in the page. Compiled in place too
public/styles.css       the whole stylesheet

shell/src/main.rs       the desktop shell: launch, files arriving, window events
shell/src/win.rs        windows and tabs
shell/src/menu.rs       the menu bar, and what each item means
shell/src/cmds.rs       what the page may ask of the shell
shell/src/host.rs       what the page may ask of the disk, and what it may not
shell/src/prefs.rs      window.json: bounds, session, recent, settings

scripts/build-web.mts   src/ -> public/vendor/, for a page with no node
scripts/markdown-css.mts  github-markdown-css, its palette keyed to the page's scheme
scripts/stage-page.mts  the page for a host with no server: public/, the vendored CSS, Mermaid,
                        the icon, and that host's own bundles and shim
scripts/build-dist.mts  stage shell/dist: `stagePage` for the desktop app
scripts/build-webapp.mts  stage dist/web, and write `_headers`: `stagePage` for the web
scripts/serve-webapp.mts  serve dist/web as a static host will, headers and all
scripts/make-icons.mts  icon.svg -> icon.png, icon.icns
scripts/bundle.mts      .app and .dmg
scripts/build-site.mts  stage site/: the icon, and the one image it names
scripts/serve-site.mts  serve site/ over node, so a module script loads at all
test-smoke.js           the whole test suite

site/                   the landing page, `landing.ts` compiled in place to `landing.js`.
                        Nothing above it knows it exists
types/vendor/           one-line shims for what `build:web` writes to `public/vendor/`: what the
                        page is type-checked against, whether or not `build:web` has run
```

Which of the `src/` directories a file may import is a test, not a habit. `contract/`
imports only `contract/`; `core/` imports `core/`, `contract/` and packages; `page/` adds
`page/`; `reader/` imports `core/`, `reader/` and `contract/`, and no packages; `rpc/`
imports `rpc/` and `contract/`, and no packages; and a host imports anything above it and
itself, never another host. Every import of `contract/` is an `import type`, which is what
lets a layer that may import almost nothing import it, and keeps it out of every bundle.
`node:` stays in `hosts/node/`, and `@tauri-apps/api` in `hosts/tauri/`. The page bundles
depend on it: nothing under `core/`, `page/` or `reader/` may reach for a node built-in.

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
   then puts the scroll position back. If what comes out is the markup already on
   screen for that document — which is the usual outcome of a `history` event, the
   version list arriving — `paint` leaves `#doc` standing (`reuse`, and the
   `painted` it is compared with). Rebuilding it would throw away what the reader has
   done to the DOM: a disclosure opened, a selection, the marks of a find. When the
   article *is* rebuilt, what the reader did to it is carried over by `kept`, below.

Re-rendering everything on every keystroke-save is fine at the size a document
actually is, and it means there is no incremental-update path to get wrong: the page
is a pure function of the payload. The exceptions are the unchanged article above and
`kept`, and a paint of a different document inherits neither: `painted` holds the
document it was built for, and `closeDocument` clears it.

### State the reader put in the DOM

Some things the reader does live on an element and not in the payload — a `<details>`
being open is the one there is today, and a task-list checkbox would be the next. A
rebuild would undo them, so `paint` reads them off the old nodes before `innerHTML` is
replaced and writes them onto the new ones straight after (`readKept` / `writeKept` in
`public/app.ts`), before anything is measured or drawn. What it carries is the `kept`
table, and a new kind of state is one more entry in it: a selector, a name, how to read
the state and how to put it back.

The **name** is what makes this safe, and it is made from what the element says and
never from where it is. A **before** is named by its change's `data-key`, which is
content-addressed and is the same key a check-off uses. Any other `<details>` is named by
its summary, or by how its text begins if it has none. Elements with the same name are
told apart by their order — the one place position is used, because to the reader they
are the same. Position as the name would be wrong: a paragraph added at the top moves
everything under it, and the state would go to the neighbour.

What this costs: edit the text an element is named by and it is a new element, with the
state it was built with. That is the intent, because it is something else to read. State
is carried only between builds of the *same* document (`painted.id`), and not across a
switch between the rendered and raw views, which have no elements in common.

It is *not* the answer to state that has to outlive the window or the document being
reopened. A check-off is that, and lives in `DocStore`; a task-list tick that is to
survive a quit would too. `kept` is for state that is only worth keeping for as long as
the page is looking at that text.

## Open documents

`createReader` (`src/reader/reader.ts`) keeps a `Map` of open documents keyed by
`hashContent(abs).slice(0, 12)`, and hands back `retain` / `release` / `setFile` /
`pathOf` plus a method per action for whoever is embedding it.

`createReader` takes the platform and, optionally, a provider for each thing that needs a
program: `git`, `plantuml` (`false` turns it off), `fonts`, and `label` for how a path is
shown, plus `pollMs`. With none given, a platform that has `spawn` gets git, PlantUML
discovery and the font list as it always did; a platform without it gets `NO_GIT`, no
PlantUML and no fonts, and its reader still opens, diffs and prunes. `spawn` is optional in
the contract (`src/reader/platform.ts`) for that reason — a host that has none leaves it
out rather than providing a function that throws. The options are `ReaderOptions` in
`src/reader/reader.ts`, and the contract is the `Platform` interface there.

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

The routes are thin on purpose. What a call *means* — a blank baseline is `last:read`, a
check-off must name a change or say `clear`, a link must name a file, a diagram is capped
at 256 KB, a document that closed is `Closed` — is decided once in `src/reader/session.ts`,
which throws `Closed` and `BadRequest`; the server turns those into a 410 and a 400 and
nothing else. `createSession` returns `Session` (`src/contract/seam.ts`), so a method renamed
here, or one that answers a different shape, stops compiling rather than surfacing when a page
asks. `src/rpc/` is the same session behind messages (`hello`, `call`, `bye` one
way, and the web host's `ping`, which its worker answers itself; `ret`, `err`, `ev`, `live`,
`command` the other, all structured-cloneable), and `createRpcBackend` is the third
implementation of the seam below. A test serves one reader over http and over a
`MessageChannel` and holds the answers equal, so a transport cannot quietly decide something
on its own.

Both directions are typed — `PageMessage` and `ReaderMessage` in `src/rpc/protocol.ts` — and
so is the list of methods a page may call: `SESSION_METHODS` is checked against `Session` in
both directions, so a method added to one and not the other stops `tsc` instead of failing
the first page that asks for it.

`bye` stops the connection's watch and then calls the host's `onBye`, for a host that holds a
document on a page's behalf and has to let go of it (the web worker retains on `hello`). A
host's own calls go in `extra`, tried before the session, and reach the page through the
client's `call`, which the page never uses itself: a host's wrapper does. A `live` message
may carry `needs`, the host's hint at what would fix it — `'permission'`, today. An error
travels as `{ name, message }` and, when a host's error is about one root, its `rootId`: the
only thing beyond those two that `encodeError` and `decodeError` keep.

The reader says when it cannot read a file it could. Node and Tauri answer an unreadable file
with `null`, but a browser handle whose permission was taken back *throws*, so the poll
catches it and emits `{ type: 'unreadable', name, why }` once, and `{ type: 'readable' }` when a
later poll succeeds. Nothing else listens for them yet but the web worker.

| | |
| --- | --- |
| `GET /api/doc?id&baseline` | The whole document payload (below) |
| `GET /events?id` | SSE: `{type:'change'}`, `{type:'file'}`, `{type:'history'}` |
| `POST /api/mark-read?id&at` | Move the read mark to the current version, clearing the check-offs, or with `at` to that version in the history, keeping them. Answers with a fresh payload |
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
| `caps` | `{ git, plantuml }`: whether this host can do each at all, which `tracked` is not — it is per file. A host with no `spawn` has neither |

**The document itself is not in here** — no `html`, no `rawHtml`, no stats, changes
or contents list. Those come from `renderDocument(root, text, base)` in
`src/core/document.ts`, called by the page, and that is the whole reason the payload is
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
`src/hosts/node/server.ts` answers a request with no `baseline` param as `last:read`, and
`public/app.ts` sends `keptBaseline()` wherever it shows a document and
`defaultBaseline()` only when the setting changes.

## The store

Content-addressed, and shared by every document: `objects/<hash>.md` is one distinct
version of some file, `docs/<sha1-of-path>.json` is one file's history, baseline
pointer, remembered comparison, checked-off keys and imported commits. See
[History ▸ Where it lives](history.md#where-it-lives) for the layout and the caps.

`DocStore.gc()` sweeps objects nothing references; it runs at startup and after a
prune, because only a pass over every document's history can say whether an object
is still wanted. It never sweeps an object younger than ten minutes: `record` writes
the object and then the index that names it, and a sweep in another process can run
between the two. An object that is already there counts only while it is young, so
`record` and `importGit` write one again once it is five minutes old. Otherwise a
version that came back to an old, unreferenced object could lose it to that sweep.

**The store may be open in more than one process** — the app and a browser tab, two
editor windows, the CLI beside the app. So an index is never written from the copy
read when the document was opened. Every method passes what it means to do to
`#update(change)`, which reads the index as it is on disk now, applies the change and
writes it back; changes within one process run one at a time. What is left is a few
milliseconds between that read and that write, and a lock is not planned (the platform
has no exclusive create, and a stale lock needs its own timeout). An index that will
not parse is read once more after 50 ms before it is taken for a first run.

Writes are atomic: the platform contract says `writeText` replaces a file whole, and
the node platform does it by writing `<file>.<pid>-<n>.writing` and renaming it over.

Each process notices the others: the reader's poll calls `DocStore.refresh()`, which
reads the index only when its modification time moved and believes it only when the text
differs from what this process last read or wrote, and the reader then emits `history` —
the page already reloads on that. An update that merged another process's write sets the
same flag, because by then there is nothing left for the poll to compare.

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

`src/core/diff.ts` splits both versions into top-level blocks with markdown-it's own
parser (`splitBlocks`), diffs the block *sources* with `diffArrays`, and pairs a run
of removals against the run of additions after it: an aligned pair that is at least
35% similar is one edit rather than a delete and an insert.

A paired block goes to `src/core/inline-diff.ts`, which diffs the two blocks' **rendered
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
- **Preferences live in `localStorage`**, reached as `prefs` — `globalThis.__REDLINE_PREFS
  ?? localStorage`, in `app.ts` and in the head script alike, so a host that has no usable
  `localStorage` can put a synchronous store of its own there from `host.js` — under
  `redline:settings`, `redline:side`,
  `redline:sidew`, `redline:toc`, `redline:tocw`, `redline:diff`, `redline:view` and
  `redline:shut`, and the ones that affect layout are mirrored onto `<html>` by an
  inline script in `index.html` **before first paint** — otherwise the window
  flashes at the wrong size, or with the marks on, on every open. `redline:shut` is the
  list of folded sections, one key per disclosure (`files`, `toc`, `hist`):
  `shutNow` reads every twist on the page, hidden ones too, so two sections under one
  key would undo each other. Whether there is a left column at all is decided there as
  well: `html.native` from `?native`, `html.web` from the web app's `host.js`, and with
  neither — a CLI tab — `redline:side` is not honoured, the `#side` button is not
  drawn, and ⌘B does nothing (`leftColumn` in `app.ts`). The two sidebar
  widths are clamped against each other so the document keeps 320px whatever they
  were dragged to, and that clamp is therefore in two places: `fitWidths` in
  `app.ts` and the same arithmetic in the inline script. Either alone is a visible
  correction on the first frame.
- **Light or dark is the page's to draw**, as `data-scheme` on `<html>`, and sepia is
  `data-tint` over light. A browser tab cannot be told it is dark the way the shell
  tells a window, so nothing reads `prefers-color-scheme` but the code that resolves
  **System**: the head script before first paint and `applyScheme` in `app.ts` after,
  which also switch highlight.js's two stylesheets by their `media`. Every dark palette
  is `screen` only, so print stays light. In the app the shell still pins the window's
  theme from the same setting, for the chrome and for what System reads.
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
— the Settings gear, which the app menu provides instead — and the app icon a browser
tab starts its bar with (`.app-icon`, the favicon's `icon.svg`): the traffic lights have
that edge, and the dock has the icon. Everything else in
`app.ts` is written once and does not ask.

- **A native window's first document comes from `onTabs`, not from a blind
  `load()`.** A browser tab's starting document is whatever `?id=` names, or with
  none whatever the other side answers — the server's file, the web app's last
  document — which `load()` is written to handle on its own. A native window has no
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
already on the window. Both are typed on the page's side: `Handoff` in
`src/hosts/tauri/platform.ts` is `Handoff` in `shell/src/host.rs` field for field, and
`MdNative` in `src/hosts/tauri/native.ts` is whatever `installNative` builds. The compiler
cannot see across the language boundary, so a field added to the Rust struct is added to the
interface by hand.

The label is there so the page can say which window's events it wants; see the third
of the [three Rust things](#the-desktop-shell) below for why that is not the default.

`public/backend.ts` reads the first of those and becomes one of three things (the
`createRpcBackend` in `src/rpc/client.ts` is the same surface over messages, for a host that
has neither a server nor the reader in the page, and the third is built on it):

| | |
| --- | --- |
| No `__REDLINE_HOST` | `fetch` and an `EventSource` against the server the page came from. Reconnecting a dropped stream lives here, because that is a fact about http and means nothing further up |
| `__REDLINE_HOST` | A dynamic import of `vendor/backend-tauri.js`, which builds the reader **in the page** over `hosts/tauri/platform.ts` and calls it directly. A browser tab never downloads it |
| `__REDLINE_WEB` | A dynamic import of `vendor/backend-web.js`, which reaches the reader **in a SharedWorker** (`vendor/reader-worker.js`, over `hosts/web/platform.ts`) through `createRpcBackend`, and adds what a tab has that the others do not. See below |

All three expose the same methods with the same arguments, which is the whole point: the
one implementation of the diff runs wherever the page is, so a tab and the app
cannot disagree about what changed.

### The web app's reader

One reader for every tab of the origin, so two tabs on one file share a poll and a snapshot
store. It is `createWebHost` in `src/hosts/web/worker.ts`, run as a SharedWorker named
`redline@<version>+<hash>`; a browser with none gets the same code in the page behind a
`MessageChannel`, one reader a tab over the one IndexedDB store. A SharedWorker is found by its
URL and its name, so one that did not change would, after a deploy, hand a new tab the old
reader that a tab left open on the old build keeps alive. The build is in both: the URL has the
page's `?v=` (`sibling` in `web/backend.ts` copies the query of its own bundle's URL, since a
relative URL does not inherit one), and the name has the version and a hash of the two bundles
the reader is made of, because the version alone is the same across every rebuild at one
version. Each alone would do; neither is leaned on alone. Two builds get a worker each, over the
one store, which is the case the fallback already depends on and which `idb.ts` allows by closing
its connection on `versionchange`. The page learns the build from the shim the build stages
(below).

- **A tab holds a document from `hello` to `bye` or to silence.** `hello` retains the document
  the page names, `bye` releases it, and a page that has said neither for 30 s is let go of,
  because a closed tab cannot say so. The page pings every 10 s. A sweep that finds a tab
  silent releases it; its next message of any kind takes the document again and answers with a
  `change`, so a hidden tab whose timers were throttled catches up instead of going stale. The
  back/forward cache is `pagehide` → `bye` and `pageshow` (persisted) → `hello`, a new watch
  and a `change`; that wiring is in `web/backend.ts`, where a test can reach it.
- **A reload is `?id=`.** The worker remembers `docId → { rootId, rel }` in the `opened` store,
  so a fresh worker can find the file again. The root's permission decides what happens:
  `granted` opens it, `prompt` is `NeedsPermission`, and `denied` or a root the registry does
  not have is `NoDocument` — the page's cue for the welcome and a clean address. `doc` asks
  again on every call, so a root denied under a page that is showing it is `NoDocument` too,
  and lets go of the document, which the reader would otherwise go on polling; a `prompt` keeps
  what it holds, because a grant brings it back.
- **A visit with no `?id=` is the last document a tab showed.** `opened` has one key that is not
  a doc id, `last → docId`, and a `hello` that names nothing is given it, after which it goes as
  a reload does: `granted` opens it, `prompt` is the **Reopen** button, `denied` or gone is the
  welcome. It is written when a page opens a file in a root and when a `hello` or a `grant` takes
  one, and not by a tab taken back after a silence — a background tab waking is not the user
  going anywhere, and would take `last` back from the tab in front — nor by the page it was
  given to, since another tab may have moved it on meanwhile, nor by a drop, which is gone with
  its worker. One per browser profile, not per tab: a new tab is not the one that was closed.
- **Permission is asked only by a page, from a click.** The worker can *query* a handle and
  never ask. On `NeedsPermission` — from a load, or from a watch whose poll was refused
  (`live` with `needs: 'permission'`) — the page finds the root's name in the stores and tells
  whoever called `onNeedsPermission(fn)`; its button calls `reopen()`, which
  `requestPermission`s on the handle it already holds and then tells the worker (`grant`), which
  checks for itself before it believes it. The button is on the welcome (below).
  `NeedsPermission` carries the `rootId` it is about, because a file being opened — one of the
  open files gone back to, `open` on a lapsed root, whose first read is refused — is not the
  document on screen, and the button must ask for the file being opened. The page then stays on
  what it was showing, shows the welcome with a way back, and opens that file again after the
  grant (`pendingLink` in `app.ts`), rather than the document it was reading.
- **Handles go to the worker as they are** (`addRoot`, over `postMessage`), and only the worker
  writes the `roots` store, so two tabs picking one file at once are one root
  (`isSameEntry`). The page reads the stores, to hold the handle it will ask about.
- A document from a drop has no handle to keep: `drop:<name>` lives in the worker's memory, and
  does not outlive it.
- **The welcome is the only door.** A desktop reader is handed a file and a server is told one; a
  page is handed nothing, so `welcome.ts` (mounted by `backend.welcome(el, hooks)` into
  `<section id="welcome">`) is how anything gets opened. The page owns *whether* it shows
  (`showWelcome` and `hideWelcome` in `app.ts`: they hide `#doc` and set `html.welcoming`) and
  the module owns what is inside; it builds it with `createElement` and `textContent`, because a
  file name is the user's. It shows when `doc` is `NoDocument` (and then drops `?id=` from the
  address, and empties Contents and History, which are outside `#doc` and would go on listing a
  file the reader has let go of) or `NeedsPermission` (and offers **Reopen** *name*: `reopen()`,
  then the page loads again, or opens the link that was refused). No other backend has a
  `welcome`, which is the whole of why a shell, VS Code and the CLI's tab never show one.
  - **Open, with a document on screen**: ⌘O and **Open file…** at the foot of the open files
    (`#newTab`, retitled `if (welcome)`) are the file picker itself, `welcome.pickFile()` — the
    welcome's own **Open file…**, called inside the click or the key, as a picker has to be —
    and not the welcome over the document: what is picked joins the open files, and the file
    being read stays a click away in them. The bar has no button for it. The welcome still
    comes up over a document for a grant that lapsed on a file that is not the one on screen,
    with **Back to the document**, and Escape takes it down (`backToDocument`). `load()` takes
    it down only for a document opened (`keepScroll: false`) or a grant it was asking for.
  - **Files, not folders.** The web app reads the file in front of it; a set of notes and the
    links between them is the Mac app's. Nothing calls `showDirectoryPicker`, and a folder
    dropped is refused, *The web app opens files, not folders*, and pointed at the Mac app.
    The worker still reads a folder root it was given before, and follows that folder's links.
  - **Open file…** (the primary button) is `showOpenFilePicker` for markdown: `MD_LINK`, in
    `core/links.ts`, the same pattern the page follows links by. Picking one is
    `addRoot(file)` and `open('web:<root>/<name>')`. The file is a root of its own and can read
    nothing beside it, so a click on one of its links says that the web app opens one file at a
    time and that the Mac app follows them (`backend.linkNote`, `LINK_NOTE`, shown by the page
    as a notice) instead of doing nothing; so does a copy.
  - **The limits**, said in the welcome before a user finds them out one refusal at a time: one
    file at a time, its links not followed, no git, no PlantUML, and a link to the Mac app
    (`MAC_APP_URL`, the landing page's `#get`, so that it follows each release) in a new tab.
  - **A drop** anywhere on the window — it is on the window, not the welcome, because a file
    dropped on a page that is not listening is opened *by the browser*, in place of the page.
    `getAsFileSystemHandle()` is read first and is the same as a pick; a `File` with no handle is
    a copy. A browser with no handles gives a folder as a `File` named for it, so
    `webkitGetAsEntry()` is read too, in the handler, to refuse it as a folder rather than as
    not markdown. A drop with a document on screen finds the welcome hidden, and what the
    welcome would say goes to the page's `notify` hook: a refusal goes to the notice and does
    not take the user off the document.
  - **No File System Access** (no `showOpenFilePicker`): `<input type="file">`, and every file is
    a copy, `drop:<name>` — no watching, no links, and a name is the whole of its identity, so
    two files of one name are one history. The welcome says so.
  - A file that is not markdown is refused with a message before anything is granted.
  - After the first document opens from a click the welcome asks for
    `navigator.storage.persist()`, once. It is a request the browser answers from how it has been
    used, and Firefox asks the user, which it may do only for a click.
- **The left column is the open files, kept by the page.** A desktop window's are its tabs,
  which the shell keeps and pushes over `md:tabs`; a browser tab has no shell, so
  `backend.openFiles` (`open-files.ts`) keeps the list, `{ id, path, name, dir, label }` in the
  order opened, and `app.ts` puts it in `state.tabs` for `paintTabs` to draw with the same
  rows. Every way a document arrives — a pick, a drop, a link, a reload, the one a bare visit
  resumes — ends in `load()`, which calls `noteOpen()`: the document joins the end of the list,
  or is relabelled in place, and the column opens by itself at the second file while
  `redline:side` is unset, as `onTabs` does. A row's click and × go through `selectTab` and
  `closeTab`, which hand them to the shell in a window and to `switchTo` / `closeOpen` here.
  `switchTo` is `openFile(path)` with the scroll kept in `scrollMemory` per id, and a file that
  will not open stays listed and says *Could not open …*. `closeOpen` on the file on screen
  goes to its neighbour (`close` answers which), and to `closeDocument()` — the welcome, with
  nothing behind it and nothing of it left on the bar: no count, arrows, version tag, ruler or
  dropped-watch dot — when there is none or it will not open; a neighbour refused for a lapsed
  grant keeps the welcome asking for that file, so granting it opens it. `paintTabs`
  remembers which document it drew around (`tabsFor`), so the change and history events that
  load the same one again do not redraw the rows under the pointer.
  - **Kept twice, under `redline:open`.** sessionStorage holds the tab's own, so a reload keeps
    it and two tabs on the app each have one; localStorage holds the last list any tab wrote,
    to seed a tab that has none of its own. Both are written on every change, and either
    refusing is not an error — the list then lasts as long as the page. It is not a
    preference and not in the head script: nothing about the layout depends on it, and the
    rows are drawn by `app.ts` before the first load, so a file that has to be asked for
    again does not hold the rest of them up.
  - **A tab that closed everything is not handed a file back.** A bare address is given the
    document a tab last showed (`last`), which after closing every file is the one just
    closed. `closedAll()` — a list was kept and is empty — makes the startup show the welcome
    instead of loading.
  - `⌃⇥` and `⌘W` are the browser's and are not offered; switching and closing are the rows'.
- **What the host cannot do is not offered** (`caps`, on every payload). `state.caps` is read in
  `adopt`, and `applyCaps` hides the `git HEAD` option of *Compare against* unless `caps.git`; a
  saved choice of git is shown as *Last read* where there is none. The option is `hidden` in the
  markup, so that Settings opened on the welcome, where no payload has said, does not offer it.
  PlantUML is not handled: a diagram that cannot draw says why where it would have been
  (`showDiagramError`), and there is no Settings row for it to hide yet.
- **What is not verified from here:** the pickers, a drop, `persist()` and how a `SharedWorker`
  calls `getFile()` and `queryPermission()` are behaviours of a browser. The tests stand in
  fakes for them (test-smoke.js, 12d), and the layout and contrast of the welcome, and of the
  open files in a browser, have not been looked at.

### Staging the page, and the web app's build

`scripts/stage-page.mts` is `stagePage(dest, { host })`: `public/`, the vendored CSS, Mermaid's
minified ESM tree and the icon, laid out the way the CLI's server routes them, so that the page's
relative `vendor/...` links hold unchanged. Two things are the host's: the bundles it loads (the
desktop app's `backend-tauri.js`, the web app's `backend-web.js` and `reader-worker.js`) and the
shim over `public/host.js`. `build:web` writes every host's bundles into `public/vendor/` and
`public/` is copied whole, so each host leaves out the others'. `build-dist.mts` and
`build-webapp.mts` are one call each.

- **The shim** is `src/hosts/web/host.js` with one line added, `__REDLINE_VERSION`: the version
  from `package.json` and a hash of the staged web bundles, `0.7.0+3fa9c2d1e0b4`. Only the staged
  copy has it: the repository's `public/host.js` stays empty, so a change to the web app's shim
  cannot reach the desktop app or the CLI.
- **`stagePage` empties its destination**, so it will not be given the repository or anything
  that holds it (`assertSafeDest`): `''` and `'.'` are the repository, `.git` and all. It does not
  stop a destination inside the repository, `src/` say, which is for whoever picks it.
- **`_headers`**, for Cloudflare Pages, is the CLI's policy from `core/csp.ts` with the *staged*
  `index.html`'s head-script hash and one directive more, `worker-src 'self'`, plus
  `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, as one rule for `/*`.
  The rule covers every path, which is how the worker's own script gets a policy: a worker is held
  to the one on its response, not its page's. The hash is read from the staged page, after the
  shim is in, because the head script's hash changes with the script.
- **The web app asks for every file by its build, and a browser keeps each for a year.** The
  staged `index.html` names its scripts, styles and icon as `name?v=<id>`; the staged `app.js` and
  `backend.js` have it in their imports, which would otherwise be the one place a query is lost
  (a relative import takes none from its importer); and the worker's URL copies it from its own
  bundle's (`hosts/web/backend.ts`, `sibling`). `<id>` is `pageHash`: 12 hex of a sha256 over every
  staged file, the version and the shim, taken before anything is rewritten, so that one id covers
  the page and a cycle of imports has no order to be resolved in. `_headers` then says
  `Cache-Control: public, max-age=31536000, immutable` for every top-level path but `index.html`
  (`heldPaths` in `build-webapp.mts`), and `no-cache` for `/` and `/index.html`, which is what a
  release is found through. Mermaid's chunks are asked for with no query and held by name, which
  is safe because each name is a hash of its content (a test reads the staged tree and fails on
  one that is not). The desktop app, whose page is in the binary, and the CLI, whose server
  sends no-cache, are not given a `?v=` (`versioned` in `stage-page.mts`'s host table). The
  cost of the scheme is a rule: a file in `public/` asked for under a name with no `?v=` would
  be held for a year under a name that never changes.
- **`npm run webapp`** serves `dist/web/` on `127.0.0.1` and answers with `_headers`' `/*` rule
  (it ignores the query, and every response is `no-store`, so the held headers are not run
  there), so the policy has been run before the first deploy. It does not walk to the next port
  when one is taken (the landing page's server does): another port is another origin, with its
  own IndexedDB and its own granted files, and the app would open with no history and look as if
  it had lost it.
- **Not verified from here:** that Cloudflare Pages serves Mermaid's `.mjs` chunks as
  `text/javascript`, which a module script needs and `nosniff` will not forgive. The local
  server sets it, so the first deploy is the first time it is a fact about Pages. Nor how Pages
  combines the `/*` rule with the path rules below it for `Cache-Control`, nor that a zone's
  *Browser Cache TTL* leaves it alone; `curl -sI` against the deployed site says.

## The desktop shell

Rust, and small on purpose: `shell/` owns a window, a menu, a modal panel and the
disk, and nothing about what a document is. The reader is JavaScript in the webview
either way, so porting the shell was porting the window management and none of the
product.

- **`host.rs`** is the disk, as `src/hosts/tauri/platform.ts` asks for it: read, write,
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
- **A second process loses Finder's file unless it leaves it behind.** When Finder
  starts a second process instead of reusing the running one — any other copy of
  the app with the same bundle identifier (`dist/`, a mounted dmg, a build) — that
  process hands its *arguments* to the first and exits from the plugin's setup, and
  the document was never an argument. The first instance heard a bare launch,
  brought its window forward, and opened nothing. So the pre-`setup` branch of
  `arrive` also writes the paths to `inbox.json` in the config dir (before the
  plugin exits, since `Opened` comes first), and `arrive` with an empty list reads
  it, if it is under 10 s old. `setup` deletes whatever an earlier launch left.
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
  behaves perfectly, which is why it took a while to find. `src/hosts/tauri/native.ts`
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

**Sanitized at insertion.** `src/page/sanitize.ts` runs DOMPurify over the document —
rendered or raw — as `app.ts` assigns it to the pane, and over each PlantUML SVG
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

- `src/hosts/node/server.ts` computes it, hash included, and sends it as a header on
  `index.html`. The directive list and the hashing are `src/core/csp.ts`, which a
  host that builds its own page (a `<meta>`, a `_headers` file) takes the same list from.
  It may tighten a directive and may not loosen one.
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

- the four git invocations in `src/reader/git.ts`, with anything the page chose kept
  where git reads it as a name and never as an option;
- the one JXA script in `src/reader/fonts.ts`, compared byte for byte;
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
- No framework. One compiler, `tsc`, and it is here for one reason: the three hosts
  (node, Tauri, web) share a payload, a `Platform`, an rpc protocol and a session, and
  the compiler is what fails when they disagree. It compiles what node runs into `out/`
  and never into `src/`; the page's three files are the exception, compiled in place beside
  their sources because their `.js` names are URLs. The two page build steps exist because
  the app's page has no node to import from and no server to fetch from, and they are not a
  second compile of anything: `build-web.mts` bundles `src/` as it is, and `stage-page.mts`
  only copies. The one rewrite is github-markdown-css's palette, keyed to the page's
  scheme (`markdown-css.mts`). [typescript.md](typescript.md) has the layout.
- One stylesheet, custom properties at the top, sections in the same order as
  `index.html`.
- An author `display` beats the browser's own `[hidden] { display: none }` whatever
  its specificity, so any rule that sets `display` on an element that gets toggled
  with `hidden` must carry its own `[hidden]` rule. The idiom here is
  `.row[hidden] { display: none }`.
- Every behaviour that can be asserted from outside gets an assertion in
  `test-smoke.js` — see [Building and testing](building.md).
