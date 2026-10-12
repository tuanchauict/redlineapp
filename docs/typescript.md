# TypeScript

Redline is being converted from JavaScript to TypeScript, **to catch drift between the
three hosts at compile time**: the payload, the `Platform` contract, the rpc messages and
the session surface that Node, Tauri and the web app each implement or consume. The `.ts`
extension is not the goal; a compile that fails when two hosts disagree is.

Step 1 landed the build. Step 2 converted `src/`: every file in it is TypeScript but
`src/hosts/web/host.js`, and the hosts are checked against the contract below. `bin/`,
`scripts/`, the test and the page are still JavaScript. A `.js` file is not type-checked
(`allowJs` on, `checkJs` off), and a `.ts` file is checked leniently (`strict: false`): for
what it declares and what the compiler can infer, with an untyped parameter left as `any`
until the `noImplicitAny` ratchet.

## Two homes for compiled code

| | Where it lives | Compiled to |
| --- | --- | --- |
| Run by Node: `bin/`, `src/`, `scripts/`, `test-smoke.js` | the repository | `out/`, mirroring the repository (`out/src/core/diff.js`, `out/scripts/build-web.mjs`) |
| Named by a URL: `public/app.js`, `public/backend.js`, `site/landing.js` | the repository | **not yet compiled.** Step 4 emits them in place, gitignored, because the server, `stage-page.mts` and the tests already name those paths |

`out/` is gitignored and is **not** `dist/`, which holds release artifacts. Every npm
script that runs a script runs it from `out/` and compiles first (`npm run build:ts`,
which is `tsc -b`); an up-to-date compile is a no-op. `node bin/redline.js` from a fresh
checkout therefore does not work before `npm run build:ts`; `npm start` does it for you.

esbuild is a separate thing. `build-web.mts` bundles `src/` **as written**, from the source,
so a type error does not stop a bundle. `tsc` is what fails the build.

## The projects

`tsc -b` reads `tsconfig.json`, which only lists references; the options are in
`tsconfig.base.json`.

| Project | Holds | Environment |
| --- | --- | --- |
| `tsconfig.src.json` | `src/` except `src/hosts/node/` | DOM lib, **no node types** |
| `tsconfig.node.json` | `src/hosts/node/`, `bin/`, `scripts/`, `test-smoke.js` | `@types/node` |

The `src` project has `"types": []` so that "nothing under `core/`, `page/` or `reader/`
may reach for a node built-in" — a rule `test-smoke.js` checks with a grep — is also a
compile error in a `.ts` file. `core/hash.ts` is where it showed: it uses Node's `Buffer`
only where there is no `TextEncoder`, and says so with a `declare const Buffer` of its own
rather than with the node types. A third project, `page`, holds `public/` and `site/` and
arrives with step 4.

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
| `ReaderEvent`, `DocPayload` and the rest of `payload.ts` | what the reader produces, what `serveRpc` posts, and the `change` that the web worker posts when a connection it had let go of is used again |
| `PageMessage`, `ReaderMessage` | both ends of the rpc, and `SESSION_METHODS`, asserted equal to `Session`'s methods in both directions |

A method added to one side and not the other stops `tsc`, and does not wait for the first
page that asks. A test proves it can: a fixture `Backend` with `markRead` left out, and
another whose `fonts` answers the session's shape, must be refused by the same compiler,
and a correct one beside them must not be. Without that the contract would be a comment.

Not under it yet: `public/backend.js`, the third `Backend`, which is a page file and
arrives with step 4.

## What stays JavaScript

`src/hosts/web/host.js` is a classic script: the first thing in the web app's page, loaded
without `type="module"`, and copied by `scripts/stage-page.mts`, which appends the one line
that sets `__REDLINE_VERSION`. Under
`"type": "module"` and `NodeNext`, `tsc` appends `export {};` to the output of a file that
has no import or export, and a classic script that says `export` does not parse. So it stays
JavaScript, and it is the one `.js` file left in `src/`. `workerName` in `web/backend.ts` is
what reads the `__REDLINE_VERSION` that the staged copy sets, and declares it as a global.

## What the conversion needed

Renaming every file at once and running `tsc` gave 116 errors in 19 files, measured before
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

## Finding the repository root

Do not count `..` from `import.meta.url`. Compiled code sits one directory deeper than its
source, so a count that is right in `src/` is wrong in `out/`. Import `ROOT`, `repoRoot`
and `rootUrl` from `src/hosts/node/root.ts`, which walks up to the first `package.json` —
`out/` has none, because `tsc` does not emit one — and so answers the same from both.
`rootUrl('public/app.js')` is the replacement for `new URL('./public/app.js',
import.meta.url)` in a file that sat at the root.

## Two things that look like bugs

**`tsc -b` does not prune `out/`.** It writes the output of every file in the program and
never deletes the output of one that has left it. Delete or rename a file under `src/` and
its old copy stays in `out/`, where a script can still import it and the suite still
passes. After a delete or a rename, remove `out/` and compile again.

**`tsc` follows a literal dynamic import.** `await import('./public/backend.js')` in a
file `tsc` compiles pulls `public/` into the program and emits a stray `out/public/`. The
test loads that page module through `rootUrl('public/backend.js').href`, which is not a
literal, so `tsc` leaves it alone and the file loaded is the real one and not a compiled
copy of it. A static `import` of a `.js` file is followed as well, which is what you want
for the code `tsc` is meant to check and not for a file it is not.

## The ladder

Each step is its own PR, with `npm test` and `npm run bundle` green.

1. **Scaffolding** (done): the projects, `out/`, `root.js`, the scripts and the suite running
   from `out/`, the `pages.yml` split.
2. `src/` (done), with the shared payload and rpc types, bottom up: `contract/`, `core/`,
   `page/`, `rpc/` and `reader/`, then the three hosts. Three stacked PRs: the contract
   with `core/`, `page/` and `rpc/`; `reader/`; the hosts.
3. `scripts/` and `bin/`.
4. The `page` project: `app.ts`, `backend.ts`, `landing.ts`, each a single rename, plus
   `tsc -b --watch` in `scripts/dev.mts` and the vendor shims in `types/vendor/`.
5. `test-smoke.ts`.
6. The ratchet, one flag per project: `noImplicitAny`, then `strictNullChecks`, then `strict`.

What the design decided is in this file and in [architecture.md](architecture.md); the
design document itself is not in the repository.

## What `tsc -b` costs

Measured with `tsc` 5.9.3 on an arm64 Mac at the end of step 2, over the 37 `.ts` files in
`src/` and the JavaScript that is compiled beside them, checked leniently:

| | Step 1 (50 files, none checked) | Step 2 |
| --- | --- | --- |
| Rebuild everything (`tsc -b --force`; step 1 was from no `out/`) | about 0.9 s | about 1.0 s |
| Up to date, `tsc -b` itself | about 0.06 s | about 0.06 s |
| Up to date, as `npm run build:ts` | about 0.16 s | about 0.18 s |

The last row is what `npm test`, `npm start` and the other scripts pay on every run, most
of it npm's own start-up. Checking the `.ts` files did not move a full rebuild by more than
the noise of the measurement, and does not touch a no-op. `strict` will cost more; step 6
measures it.
