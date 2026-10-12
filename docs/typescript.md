# TypeScript

Redline is being converted from JavaScript to TypeScript, **to catch drift between the
three hosts at compile time**: the payload, the `Platform` contract, the rpc messages and
the session surface that Node, Tauri and the web app each implement or consume. The `.ts`
extension is not the goal; a compile that fails when two hosts disagree is.

Step 1 landed the build. Step 2 converted `src/`: every file in it is TypeScript but
`src/hosts/web/host.js`, and the hosts are checked against the contract below. Step 3
converted `bin/` and `scripts/`. Step 4 converted the page: `public/app.ts`,
`public/backend.ts` and `site/landing.ts`, compiled in place by a project of their own
([The page project](#the-page-project)). `test-smoke.js` is the only JavaScript left that is
compiled. The two classic scripts, `src/hosts/web/host.js` and `public/host.js`, stay
JavaScript and are copied as they are ([What stays JavaScript](#what-stays-javascript)).
A `.js` file is not type-checked (`allowJs` on, `checkJs` off; the page project turns
`allowJs` off, and says why below), and a `.ts` file is checked leniently
(`strict: false`): for what it declares and what the compiler can infer, with an untyped
parameter left as `any` until the `noImplicitAny` ratchet.

## Two homes for compiled code

| | Where it lives | Compiled to |
| --- | --- | --- |
| Run by Node: `bin/`, `src/`, `scripts/`, `test-smoke.js` | the repository | `out/`, mirroring the repository (`out/src/core/diff.js`, `out/scripts/build-web.mjs`) |
| Named by a URL: `public/app.ts`, `public/backend.ts`, `site/landing.ts` | the repository | **in place**, gitignored: `public/app.js`, `public/backend.js` and `site/landing.js`, each beside its source. The server, `stage-page.mts`, the `?v=` rewrite and the tests all name those paths, and compiling to `out/` would have renamed every one |

`out/` is gitignored and is **not** `dist/`, which holds release artifacts. Every npm
script that runs a script runs it from `out/` and compiles first (`npm run build:ts`,
which is `tsc -b` behind a check that the page's `.js` is still there, described under
[Three things that look like bugs](#three-things-that-look-like-bugs)); an up-to-date compile
is a no-op. `node out/bin/redline.js` from a fresh checkout therefore does not work before
`npm run build:ts`; `npm start` does it for you. The same compile makes the page's `.js`, so a
fresh checkout has no `public/app.js` either until one has run, and every script that serves
or stages the page runs it first.

esbuild is a separate thing. `build-web.mts` bundles `src/` **as written**, from the source,
so a type error does not stop a bundle. `tsc` is what fails the build.

## Extensions

`bin/redline.ts` and `scripts/*.mts`; the page's three files are plain `.ts`, because they
emit the `.js` that a URL names. A `.mts` compiles to `.mjs`, the names that every npm
script, `dev.mts` and `bundle.mts` ran when these were JavaScript (`node
out/scripts/build-web.mjs`), so nothing that runs a script had to change; a plain `.ts` would
have emitted `.js` and renamed all of them. The CLI is a `.ts` because `package.json`'s `bin`
already named `out/bin/redline.js`. `tsc` keeps its `#!/usr/bin/env node` line, and `npm`
marks the compiled file executable when it installs it.

An import keeps the name of what it will find *after* compiling: `./stage-page.mjs` for the
sibling `stage-page.mts`, and `../src/hosts/node/root.js` for `root.ts`. That is how `NodeNext`
resolves it, and it is the same name in `out/`. A string that names a script
(`build('build-web.mjs')` in `dev.mts`) is compiled output as well, and `tsc` does not check
a string, so `test-smoke.js` checks that each one exists under `out/`, along with every path
that `package.json` hands to Node, and that `bin/` and `scripts/` hold no `.js` or `.mjs` at
all: one would be compiled and never checked, and nothing else would say it was forgotten.
Those existence checks only mean something from a clean `out/`, which is what CI has; see
[Three things that look like bugs](#three-things-that-look-like-bugs).

## The projects

`tsc -b` reads `tsconfig.json`, which only lists references; the options are in
`tsconfig.base.json`.

| Project | Holds | Environment |
| --- | --- | --- |
| `tsconfig.src.json` | `src/` except `src/hosts/node/` | DOM lib, **no node types** |
| `tsconfig.node.json` | `src/hosts/node/`, `bin/`, `scripts/`, `test-smoke.js` | `@types/node` |
| `tsconfig.page.json` | `public/*.ts`, `site/*.ts`, `types/` | DOM lib, **no node types** |

The `src` project has `"types": []` so that "nothing under `core/`, `page/` or `reader/`
may reach for a node built-in" — a rule `test-smoke.js` checks with a grep — is also a
compile error in a `.ts` file. `core/hash.ts` is where it showed: it uses Node's `Buffer`
only where there is no `TextEncoder`, and says so with a `declare const Buffer` of its own
rather than with the node types. The `page` project has `"types": []` for the same reason: it
is code that a browser runs. It references `src`, because the types the page is checked
against are written there (`Backend`, `WebBackend`, `MdNative`); [The page
project](#the-page-project) is the rest of it.

## `src/contract/`

The shapes that the hosts have to agree on are written down once: `payload.ts` has
`DocPayload`, `HistoryRow`, `ReaderEvent` and the rest of what the reader produces, and
`seam.ts` has `Session`, the reader as a transport serves it, and `Backend`, what a page
holds. It is types only, and a test holds it to that: it imports only itself, and every
import of it is an `import type`. That is what lets a layer that may import almost nothing
(`rpc/`, `reader/`) use it, and keeps it out of every bundle.

What it buys is a compile that fails when two sides disagree. Each side names the type it
implements in its signature, which is the whole check, and the test greps that it still does:

| Type | Held to it |
| --- | --- |
| `Platform` (`reader/platform.ts`) | `nodePlatform`, `tauriPlatform` and `createWebPlatform` |
| `Session` | `createSession` over the reader; the web worker's `sessionFor` for each connection; the `session` that `serveRpc` is handed |
| `Backend` | `createTauriBackend`; `createRpcBackend`, as `RpcBackend`; `createWebBackend`, as `WebBackend`, which is `RpcBackend` and the browser's own methods |
| `Backend`, in the page | `httpBackend` (`public/backend.ts`), over `fetch` and an `EventSource` |
| `PageBackend` | `createBackend` (`public/backend.ts`): whichever of the three the page has |
| `ReaderEvent`, `DocPayload` and the rest of `payload.ts` | what the reader produces, what `serveRpc` posts, and the `change` that the web worker posts when a connection it had let go of is used again |
| `PageMessage`, `ReaderMessage` | both ends of the rpc, and `SESSION_METHODS`, asserted equal to `Session`'s methods in both directions |

A method added to one side and not the other stops `tsc`, and does not wait for the first
page that asks. A test proves it can: a fixture `Backend` with `markRead` left out, and
another whose `fonts` answers the session's shape, must be refused by the same compiler,
and a correct one beside them must not be. Without that the contract would be a comment.

`public/backend.ts` is under it as well, which is where the page meets the contract.
`createBackend` answers a `PageBackend`: `Backend`, plus `Partial<Omit<WebBackend, keyof
Backend>>`, which is what only the web app's backend has, as optional members. The page
uses four of them (`openFiles`, `welcome`, `onNeedsPermission`, `linkNote`) and learns
whether they are there by asking, so they cannot be required. They are derived with `Omit`
and not written out because a test greps that `public/backend.ts` and the other two
backends never name a `welcome` or a `linkNote`: only the web backend has one, so the page
must never show it in a shell or a server. The page's calls on the shell are checked the same
way, against `MdNative`, which `app.ts` reaches with an `import type` of `native.ts` (the file
that declares `window.mdNative`); no test greps that one, the compiler is all there is.

## What stays JavaScript

`src/hosts/web/host.js` is a classic script: the first thing in the web app's page, loaded
without `type="module"`, and copied by `scripts/stage-page.mts`, which appends the one line
that sets `__REDLINE_VERSION`. Under
`"type": "module"` and `NodeNext`, `tsc` appends `export {};` to the output of a file that
has no import or export, and a classic script that says `export` does not parse. So it stays
JavaScript, and it is the one `.js` file left in `src/`. `workerName` in `web/backend.ts` is
what reads the `__REDLINE_VERSION` that the staged copy sets, and declares it as a global.

`public/host.js` is the same kind of file, and stays for the same reason: the empty host shim,
first in the page's `<head>`, which the web app's build replaces with the one above. It is
hand-written and tracked, and the page project does not compile it (its `include` is
`public/*.ts`), which is why `.gitignore` names the three compiled page files one by one and
not `public/*.js`.

## The page project

`public/*.ts` and `site/*.ts` are what a browser loads, so `tsconfig.page.json` compiles them
**in place**: `outDir` is `.`, `public/app.ts` comes out as `public/app.js` and
`site/landing.ts` as `site/landing.js`, each beside its source. That is the opposite of the
other two projects, and the URLs decided it. `index.html` loads `app.js` and `site/index.html`
loads `landing.js`; the server serves `public/` as it finds it; `stage-page.mts` names `app.js`
and `backend.js` (`MODULES`, where the `?v=` is written into their imports) and refuses to stage
a page that has no `app.js`; and the tests read those paths. An `out/` for the page would have
renamed every one of them. The compiled files are gitignored, and a test asserts it,
because a tracked copy goes stale against its `.ts` and looks exactly like the change not
working. The config is JSON and cannot say why it is the way it is, so the reasons are here,
and `test-smoke.js` holds each line they explain.

**It names its own `exclude`.** With `outDir` set to `.`, `tsc`'s default `exclude` (`node_modules`
and the `outDir`) is the whole repository, so the project includes nothing: `tsc -b` compiles
nothing, prints nothing and exits 0. A project with `references` is not told that it found no
inputs; one without them is, with TS18003. The first anyone hears of it is a page that has not
been built. So the config says `"exclude": ["node_modules", "out"]` itself, and a test fails
if it stops.

**`declarationDir` is `out/page-types`.** `composite` makes `tsc` write declarations, and with
`outDir` at `.` they would land as a `public/app.d.ts` that nothing wants, in the directory the
server serves. `rootDir` is `.`, so what goes to `out/page-types` mirrors the repository
(`out/page-types/public/app.d.ts`, `out/page-types/site/landing.d.ts`).

**`allowJs` is off, though the base config has it on.** `rootDirs`, below, makes `tsc` try a
specifier as written before it tries the other root, so with `allowJs` on, `./vendor/render.js`
is answered by the *built* bundle in `public/vendor/` and never reaches its shim. `tsc` then
takes the bundle as an input and fails: TS6307 (the file is not in the project's list), TS2305
(`WebBackend` is not an export of a bundle whose types are only what `tsc` infers from the
JavaScript) and TS5055 (it would overwrite its own input). Only a tree that has never run
`build:web` is spared, which is a fresh clone for exactly one compile. Nothing in the page
project needs a `.js` as an input, so it is off, and a test holds it there.

**`rootDirs` and the shims in `types/vendor/`.** The page imports its code from `./vendor/`:
`render.js`, `sanitize.js`, `backend-tauri.js` and `backend-web.js`, which `build:web` writes
and which are gitignored, and Mermaid's `./vendor/mermaid/mermaid.esm.min.mjs`, which the
staging copies from `node_modules`. None of them exists in a fresh checkout, and a type check
of esbuild's output would not check what the page is held to anyway. So `types/vendor/` holds
a one-line shim for each, and `rootDirs: ["public", "types"]` lays that directory over `public/`
so that `./vendor/render.js`, written in `public/app.ts`, finds `types/vendor/render.d.ts`.
Each shim is an `export *` from the source its bundle is built from: `render` is
`src/core/document.ts`, `sanitize` is `src/page/sanitize.ts`, `backend-tauri` is
`src/hosts/tauri/backend.ts` and `backend-web` is `src/hosts/web/backend.ts`. A test holds each
to the `entry` of its bundle in `BUNDLES` in `build-web.mts`: an entry that moved while its
shim stayed would check the page against a module it no longer loads, and nothing else would
say so. Mermaid's shim is `export { default } from 'mermaid'`, since the package ships its
own types. The worker bundle, `reader-worker.js`, has no shim because the page never imports
it: `web/backend.ts` starts it by URL.

**`stage-page` leaves the `.ts` out.** It copies `public/` whole, and the sources now sit in
it, so its copy filter drops a name that ends in `.ts`. Without it `app.ts` would be staged
into `shell/dist` and `dist/web` and shipped; a test asserts that the staged top is the page and
nothing else.

**`pages.yml` leaves `site/*.ts` out of the artifact.** The landing page deploys `site/` as
the build job left it, `landing.ts` included, so the upload step's `path` is `site` with
`!site/*.ts`, and the deploy has `landing.js` and no `landing.ts`. A test asserts the pattern in
the workflow, and that is all that has been checked: **it has not run on GitHub.** The first
Pages run is the check: the upload step's log should list `site` as its search path, and the
deployed site should serve `landing.js` and not `landing.ts`.

**While `npm run dev` runs**, `scripts/dev.mts` spawns `npx tsc -b --watch --preserveWatchOutput`
beside `tauri dev`, and the restage follows what `tsc` emits into `public/`: its own watch
skips a `.ts`, because restaging on the edit would stage the previous compile and then stage
again on the emit. `tsc -b` emits through a type error, so a mistake is a message in that
terminal and the window still updates. It is stopped the way `npx tauri dev` is, by signalling
`npx`, which passes SIGINT and SIGTERM to what it started and cannot pass SIGKILL (checked on
npm 11.6.4; an older npm was not); a hard kill of `dev.mts` can leave a `tsc` watching. The
one thing about it that is **unverified** from here is the live watch under `tauri dev`, which
needs a native window. What has been seen is that the config compiles and that `tsc -b` writes
`public/*.js` through an error. Nobody has watched `tsc -b --watch` start under `dev.mts`, or
an edit compile, restage and reload in the window, and nothing about the page's layout has
been seen in a browser either: there is none here.

**The read rule.** `tsc` reprints what it emits: it re-indents, splits a one-line `if` over
lines and drops every annotation, so the compiled `public/app.js` is not the file whose shape
anyone wrote. A grep for how the *source* is written therefore reads the `.ts`: `appJs` in
`test-smoke.js` is `public/app.ts`, the `Backend` signatures are read from `public/backend.ts`,
and the landing page's checks from `site/landing.ts`. Anything that is *executed* or *served*
reads the compiled `.js`, because annotated TypeScript is not JavaScript and what shipped is
what is worth checking: the helpers lifted out of the page and run in a `vm` (`pageRun`), the
`import()` of `public/backend.js`, the URL checks and the staged output.

The `innerHTML` allow-list is a read of the source, and it is a security check, since every
assignment has to be sanitised or on a short list. Its regex finds `x.innerHTML =` and
`x(…).innerHTML =` and does not find the forms that TypeScript brings, `$<HTMLDivElement>('x')
.innerHTML =` and `(el as T).innerHTML =`, which would pass unseen. So a second assertion
compares the number of left-hand sides that the regex captured with the number of
`.innerHTML =` in the file, and fails if they differ. It still cannot see `.innerHTML=` with
no space, `+=`, `['innerHTML'] =` or `insertAdjacentHTML`; those would need a rule of their
own.

## What the conversion needed

Renaming every file in `src/` at once and running `tsc` gave 116 errors in 19 files, measured before
anything was annotated. 95 were TS2339, a property read from something inferred as `{}`
(`references` off an `{}` in `core/diff.ts` is the first): the code was right and nothing
said what the object was. The rest were nine arity errors on parameters the callers leave
off, four object literals with a key that an inferred options type did not have, and a handful
of one-offs.

So the annotations that the final conversion needed were mostly of one kind: an `interface`
for the object that a closure holds (`Conn` in the worker, `WebBackendOptions`,
`WebPlatformDeps`, `Handoff` in the Tauri host), and `?` on a parameter that its callers
omit. The rest:

- `declare global { var X }` where two modules agree on a global through nothing but its name
  (`__REDLINE_HOST`, `__REDLINE_VERSION`, `window.mdNative`).
- `declare const` for what `lib.dom` has no name for (`SharedWorkerGlobalScope`).
- Four casts in all of `src/`. Two are a timer's `unref`, which Node's `Timeout` has and a
  browser's number does not, and one is the worker's own scope (`onconnect`), which `lib.dom`
  does not describe. The fourth is `serveRpc` calling a `Session` method by name with the
  arguments that arrived in a message: `SESSION_METHODS` is what checks the name, and nothing
  checks the arguments, because a message is not typed.
- `invoke<T>` where the page reads what a Tauri command answers (`tauri/platform.ts`, and the
  settings and update calls in `native.ts`), because `invoke` cannot know the Rust command's
  return type and answers `unknown` without it.

`SpawnResult.code` is `number | string | null`: Node reports a program that could not be run
as the system's error code (`'ENOENT'`), and the type used to say it was a number.

Step 3 had less to find. Renaming `bin/` and `scripts/` and running `tsc` gave 23 errors in
five files, 16 of them in `notices.mts`. 21 were TS2339 and two TS2345. Fifteen of the TS2339
were `src/`'s again, a property read off a value that nothing had typed: `JSON.parse` answers
`any`, and `Object.entries` and `new Map` over an `any` answer `unknown`, which has no
properties. The fix was the same, an interface for what is read (six in `notices.mts`, for the
lockfile and for `cargo metadata`). The CLI's options object had no `help` key, read once and
set once, and `Options` has one. In the servers, `code` was read off the plain `Error` that an
`'error'` listener is handed and `port` off `server.address()`, which is a `string` or an
`AddressInfo`: the listener is annotated `NodeJS.ErrnoException`, and the address is cast to
the `AddressInfo` that a server listening on a TCP port has. The CLI's `listen` needs both as
well, once its `server` parameter is typed. The two TS2345 were `process.on` handed a `string`
where it wants a signal name (`as const` on the list), and `JSON.parse` handed the `Buffer`
that `execFileSync` answers unless it is told an encoding (`encoding: 'utf8'`).

Step 4 was the largest count. Renaming the page's three files and running `tsc` gave 97 errors:
70 in `app.ts`, 18 in `landing.ts` and nine in `backend.ts`. The spike that sized the step
had counted 101 (74, 18 and nine); the four it had over were the web-only capabilities
(`openFiles`, `welcome`, `onNeedsPermission`, `linkNote`), which `PageBackend` had already
answered by the time the files were renamed. By code, 66 were TS2339, 20 TS2554, five TS2345
and six one-offs (TS2551 twice, and one each of TS2322, TS2363, TS2365 and TS2769). It is
`src/`'s count over again, a property read off a type that was too wide for what the caller
knows, and parameters that its callers leave off. The page's answer for the first is the `$`
helper, whose caller names the kind of element it is asking for
(`$<HTMLInputElement>('findInput')`), since `getElementById` can only say `HTMLElement`.
The step found no drift: no error was a call that a host could not answer.

## Finding the repository root

Do not count `..` from `import.meta.url`. Compiled code sits one directory deeper than its
source, so a count that is right in `src/` is wrong in `out/`. Import `ROOT`, `repoRoot`
and `rootUrl` from `src/hosts/node/root.ts`, which walks up to the first `package.json` —
`out/` has none, because `tsc` does not emit one — and so answers the same from both.
`rootUrl('public/app.js')` is the replacement for `new URL('./public/app.js',
import.meta.url)` in a file that sat at the root.

## Three things that look like bugs

**`tsc -b` does not prune `out/`.** It writes the output of every file in the program and
never deletes the output of one that has left it. Delete or rename a file under `src/`,
`bin/` or `scripts/` and its old copy stays in `out/`, where a script can still import it and
the suite still passes. After a delete or a rename, remove `out/` and compile again.
The page's output is the same and sits somewhere worse: a `public/old.js` whose `old.ts` has
gone is still served, and `stage-page` still copies it, because the copy drops a `.ts` and
keeps every `.js`. Remove it by hand. `git status` will list it unless it is one of the
three names that `.gitignore` has.

**`tsc` follows a literal dynamic import.** `await import('./public/backend.js')` in a
file `tsc` compiles pulls `public/` into the program and emits a stray `out/public/`. Now that
the page is TypeScript it also fails the build: the import resolves to `public/backend.ts`,
which the node project checks without the vendor shims, and its imports of `./vendor/…` cannot
be found. The test loads that page module through `rootUrl('public/backend.js').href`, which is
not a literal, so `tsc` leaves it alone and the file loaded is the compiled one in `public/`,
the one the server serves, and not a second copy of it in `out/`. A static `import` of a
`.js` file is followed as well, which is what you want for the code `tsc` is meant to check
and not for a file it is not.

**The `.js` beside a page's `.ts` is output, and `git status` will not say so.** The three
are ignored by name, so a compile leaves the tree looking clean, and a hand edit to
`public/app.js` is overwritten the next time `app.ts` changes. A new page file, `public/x.ts`,
emits an `x.js` that git lists as untracked: that is the prompt to add its name to
`.gitignore` and to the list that the test reads, and not a file to commit.

The same silence is why a stale compile looks exactly like the change not working. Edit
`public/app.ts`, or pull a branch, and the `public/app.js` that the server serves is still the
last compile until something runs `tsc -b`: `npm run build:ts` is the fix, and `npm start`,
`npm run app` and `npm test` run it for you. The window is one step further on. It does not
read `public/app.js` but the copy that `npm run build:dist` stages into `shell/dist` (which
`npm run app` embeds and `npm run dev` serves), so `build:ts` alone does not refresh a window
that is open.

`tsc -b` decides that a project is up to date from `out/tsconfig.page.tsbuildinfo`, which holds
the hash of every input, and it never checks that the outputs are there. That makes two cases
where it says nothing when it should say something:

- **A branch switch deletes the compiled page.** The branches from before the page was
  TypeScript track `public/app.js`, `public/backend.js` and `site/landing.js`. Check one out and
  come back, and git removes the three, which are ignored here, and leaves `out/` alone. Then
  `tsc -b` prints "Updating unchanged output timestamps" and writes nothing, because the hashes
  still match, and touching the `.ts` does not help for the same reason. Everything that serves
  or stages the page fails, or serves a blank one.
- **`git mv` keeps a file's mtime.** A `.js` renamed to `.ts` is a new input with an old
  timestamp, older than the record, so `tsc -b` reports "up to date" and emits nothing until
  the file is touched. (A `.ts` renamed to another `.ts` is noticed, because the old name was
  a root of the last build and is not now.)

`npm run build:ts` is the fix for both, because it is not only `tsc -b`: it runs
`bootstrap/heal-page-build.mjs` first, which looks for a compiled `.js` beside every
`public/*.ts` and `site/*.ts` (the sources are read from `include` in `tsconfig.page.json`, so
there is no list to keep in step) and, if one is missing, deletes
`out/tsconfig.page.tsbuildinfo` and says which files it found gone. A project with no record is
built from scratch, so `tsc -b` then writes every page output, and the other projects' records
are untouched. A fresh checkout has no record to delete, and `tsc -b` builds everything anyway.
The script is plain JavaScript in a directory of its own, and not a `.mts` in `scripts/`,
because it runs before the compile that `scripts/` needs and so cannot be one of the things
that compile produces. A bare `tsc -b` does not run it: after a branch switch use
`npm run build:ts`, or by hand `tsc -b --force` or deleting that one record.

## The ladder

Each step is its own PR, with `npm test` and `npm run bundle` green.

1. **Scaffolding** (done): the projects, `out/`, `root.js`, the scripts and the suite running
   from `out/`, the `pages.yml` split.
2. `src/` (done), with the shared payload and rpc types, bottom up: `contract/`, `core/`,
   `page/`, `rpc/` and `reader/`, then the three hosts. Three stacked PRs: the contract
   with `core/`, `page/` and `rpc/`; `reader/`; the hosts.
3. `scripts/` and `bin/` (done), as `.mts` and `.ts`; see [Extensions](#extensions).
4. The `page` project (done): `app.ts`, `backend.ts`, `landing.ts`, each a single rename, plus
   `tsc -b --watch` in `scripts/dev.mts` and the vendor shims in `types/vendor/`; see
   [The page project](#the-page-project).
5. `test-smoke.ts`.
6. The ratchet, one flag per project: `noImplicitAny`, then `strictNullChecks`, then `strict`.

What the design decided is in this file and in [architecture.md](architecture.md); the
design document itself is not in the repository.

## What `tsc -b` costs

Measured with `tsc` 5.9.3 on an arm64 Mac at the end of each step: step 2 over the 37 `.ts`
files in `src/`, step 3 over those and the 13 in `bin/` and `scripts/`, step 4 over those
and the page's three files and the five shims in `types/`, with the JavaScript that is
compiled beside them, checked leniently:

| | Step 1 (50 files, none checked) | Step 2 | Step 3 | Step 4 |
| --- | --- | --- | --- | --- |
| Rebuild everything (`tsc -b --force`; step 1 was from no `out/`) | about 0.9 s | about 1.0 s | about 1.0 s | about 1.1 s |
| Up to date, `tsc -b` itself | about 0.06 s | about 0.06 s | about 0.06 s | about 0.07 s |
| Up to date, as `npm run build:ts` | about 0.16 s | about 0.18 s | about 0.17 s | about 0.19 s |

The last row is what `npm test`, `npm start` and the other scripts pay on every run, most
of it npm's own start-up. Checking the `.ts` files did not move a full rebuild by more than
the noise of the measurement, at step 2 or at step 3, and does not touch a no-op. Step 2
did read 0.1 s slower on a rebuild and 0.02 s as `npm run build:ts`, and was put down to that
noise; step 4 adds the same (0.1 s and 0.02 s, and 0.01 s to `tsc -b` itself), and unlike the
others it was measured on a busy machine (a load average of about 3.5; the other columns did
not record theirs). So it is a number to watch and not yet a finding. `strict` will cost
more; step 6 measures it.

The last row has one more cost since the table was made: `npm run build:ts` starts
`bootstrap/heal-page-build.mjs` before `tsc -b`, an extra `node` process (about 0.02 s on its
own) that lists two directories. Timed in a scratch copy at the end of that change, with the
load not recorded, an up-to-date `npm run build:ts` went from about 0.17 s to about 0.20 s, and
one from no `out/` and no compiled page took about 1.3 s.
