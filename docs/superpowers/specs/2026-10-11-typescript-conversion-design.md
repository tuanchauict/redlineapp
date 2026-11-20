# Converting Redline to TypeScript — design

Status: draft for review. Nothing here is implemented.

## Goal and decisions

**Goal:** catch bugs at compile time, chiefly drift between the three hosts (Node, Tauri, web)
over the document payload, the `Platform` contract, the rpc messages and the session surface.
The `.ts` extension is not itself a requirement.

Decisions made while designing this, by the owner:

| Question | Decision |
| --- | --- |
| Approach | Full `tsc` compile to an output directory (not JSDoc `checkJs`, not Node type stripping) |
| Scope | Every JS file: `src/`, `bin/`, `public/`, `scripts/`, `site/`, `test-smoke.js`. HTML, CSS and Rust are untouched |
| Strictness | Lenient first (`strict: false`), tightened later by a ratchet |

This reverses the written convention "no framework, no transpiler — what you read is what
runs" (`docs/architecture.md`, Conventions). That convention's wording must be replaced in the
same change, with the reason this change outweighs it.

## 1. Where compiled code lives

Two kinds of JS, two homes.

- **Run by node** (`bin/`, `src/`, `scripts/`, the test): `tsc` emits into `out/`, mirroring the
  repo (`out/src/core/diff.js`, `out/bin/redline.js`). `package.json`'s `bin` points at
  `out/bin/redline.js`. It is `out/` and not `dist/`: `dist/` holds release artifacts
  (`Redline.app`, the dmg, `dist/web`) and CI uploads from it. `out/` is already gitignored.
- **Named by a URL** (`public/app.js`, `public/backend.js`, `site/landing.js`): compiled in
  place. `public/app.ts` emits `public/app.js`, gitignored like `public/vendor/`. The server,
  `stage-page.mjs`, its `?v=` import rewriting and the test greps all already name
  `public/app.js`, and emitting elsewhere would make the server serve one URL space from two
  roots.
- **esbuild bundles** (`build-web.mjs`) read `src/**/*.ts` directly. A type error does not
  block a bundle; `tsc` is what fails the build.
- **Path anchors.** About ten scripts, `src/hosts/node/server.js` and `test-smoke.js` compute
  the repo root from `import.meta.url` by counting `..`. From `out/` that lands in `out/`. One
  shared `repoRoot(import.meta.url)` helper walks up to the first `package.json` (`out/` has
  none) and gives the same answer from source and from compiled code.
- **Behaviour change:** `node bin/redline.js` from a fresh checkout no longer works before a
  compile. `npm start` has a `prestart` hook and gains `tsc -b`.
- **Rejected:** emitting `.js` beside every `.ts`, gitignored. It needs no path changes, but
  leaves generated twins in every directory, and a stale `.js` survives deleting its `.ts`.

## 2. Type-check setup and the ratchet

Imports do not change: the source already imports `./render.js`, and `module: NodeNext`
resolves that to `render.ts`. The conversion is renames plus annotations.

Three projects, built by `tsc -b` from a root `tsconfig.json` that only holds references,
sharing a `tsconfig.base.json` (target ES2022, `module`/`moduleResolution` NodeNext,
`skipLibCheck`, `strict: false`):

| Project | Holds | Environment | Emits to |
| --- | --- | --- | --- |
| `src` | `src/` except `hosts/node/` | DOM lib, **no node types** | `out/src/` |
| `page` | `public/*.ts`, `site/*.ts` | DOM lib | in place |
| `node` | `src/hosts/node/`, `bin/`, `scripts/`, the test | `@types/node` | `out/` |

- Giving `src` no node types turns "nothing under `core/`, `page/` or `reader/` may touch a
  node built-in" into a compile error. It is a grep today. Expect it to surface places that
  lean on node's types by accident; that is the kind of finding this is for.
- **Vendor shims.** The page imports `./vendor/render.js` and the other bundles, which
  TypeScript cannot see because esbuild builds them. Five one-line declaration files are
  **committed** under `types/vendor/` (`export * from '../../src/core/document.js'` and so
  on), resolved through `rootDirs`. They are committed and not generated because the scripts
  are themselves compiled, so `tsc` must be able to run before any script exists.
- `src/hosts/web/worker.ts` declares the few worker globals it uses. The `webworker` lib
  cannot be loaded beside DOM.
- devDependencies added: `typescript`, `@types/node`, `@types/markdown-it`;
  `markdown-it-task-lists` has no types and gets a local declaration. All are dev-only, so the
  `THIRD-PARTY-NOTICES.md` digest (non-dev dependencies and `Cargo.lock`) is unaffected.

**The ratchet.** With `strict: false`, un-annotated parameters are `any` and internal drift is
not caught. The value in the lenient phase comes from explicitly typing what the hosts share —
the payload, `Platform`, the rpc messages, the session — which are enforced at the boundaries
while internals stay loose. Then, one project at a time: `noImplicitAny`, then
`strictNullChecks`, then `strict`. A test asserts a floor (a flag that is on cannot be switched
off). That guards regression and does not force progress; the progress is a decision for the
owner each time.

## 3. Build order, dev loop and workflows

- `build:ts` is `tsc -b` (incremental). Every npm script that runs a script gains it up front:
  `"build:web": "npm run build:ts && node out/scripts/build-web.js"`. Chained `pre` hooks run
  it more than once; an up-to-date `tsc -b` is expected to be a sub-second no-op (not measured).
- `npm test` is `pretest` (`build:ts`, then `build:web`) and then `node out/test-smoke.js`, so
  a type error fails the suite locally and in CI.
- **Packaging:** the `.app` is unchanged. The shell embeds `shell/dist`, staged from the
  compiled `public/*.js` and the bundles. `bundle` still writes to `dist/`.
  `.gitignore` gains `public/app.js`, `public/backend.js`, `site/landing.js`.
- **Dev loop:** `npm run dev` spawns `tsc -b --watch` beside `tauri dev`, and the existing
  watcher restages on its emit. Cost: edit-then-⌘R is instant today and would wait on an
  incremental `tsc` (estimated 1–2 s, not measured).
- **Workflows:** `ci.yml` and `webapp.yml` need no change (they already `npm ci` and run npm
  scripts). `pages.yml` changes: it holds `CLOUDFLARE_API_TOKEN` in the same job as
  `build:site` and installs nothing, because the page had no dependencies. Compiling
  `build-site` and `landing.ts` needs `typescript`. Copy `webapp.yml`'s split: a `build` job
  (`npm ci`, `tsc`, `build:site`, uploads `site/`, no secret) and a `deploy` job (downloads it,
  holds the token, runs nothing from the repo). The deployed `site/` will include `landing.ts`
  beside `landing.js`; harmless.

## 4. Tests

- About 100 lookups in `test-smoke.js` are `new URL('./x', import.meta.url)`. They become
  `rootUrl('x')` from the shared helper.
- Greps about **what ships** (`public/app.js`, `backend.js`, the bundles, the staged trees)
  keep reading compiled output, so a wiring assertion still means "what the browser gets".
- Greps about **source rules** (import layering between `src/` directories, the `spawn` call
  count, the shell allowlist against the argument builders, and the ~93 `.js`/`.mjs` file-name
  literals) read the `.ts`. An `import type` is a source fact and is erased on emit.
- New assertions: every bundle in `build-web.mjs` has a shim in `types/vendor/`; the strictness
  floor holds; `package.json`'s `bin` and scripts point at `out/`.
- Behaviour must not change at any step, so `npm test` and `npm run bundle` are green at each.

## 5. Migration and docs

**Prerequisite:** the uncommitted changes on `web-cache-busting` (`public/app.js`,
`test-smoke.js`, three docs) land first. Renaming those files under unmerged edits would
conflict. Do the work in a worktree off `main`.

Each step is its own PR with the suite green. `allowJs` lets `.js` and `.ts` coexist in the
`src` and `node` projects.

1. **Scaffolding:** tsconfigs, devDependencies, `repoRoot`, scripts moved to `out/`, test
   anchors, the `pages.yml` split. All code still JS. The riskiest PR, because paths and
   workflows move, though it has no type work.
2. **`src/core` and `src/rpc`** with the shared payload and rpc types; then `src/reader`
   (`Platform`, `Session`); then the three hosts.
3. **`scripts/` and `bin/`.**
4. **The `page` project:** `app.ts`, `backend.ts`, `landing.ts`. In-place emit cannot coexist
   with a same-named input, so each is one rename and not a gradual conversion. Three files,
   and cheap while lenient.
5. **`test-smoke.ts`**, last, since it consumes everything.
6. **Ratchet PRs**, one flag per project.

**Docs**, changed in the same PRs as the behaviour: `architecture.md` (the opening, every `.js`
in the module map, the "no transpiler" convention), `building.md` (what is generated, the
dev-loop cost, the `pages.yml` split) and a new `docs/typescript.md` (the three projects, the
shims, the ratchet).

**Out of reach for the agent:** `skills/` (`redline-testing`, `redline-client`,
`redline-tauri`, `redline-shipping`) is write-protected in the agent's sandbox. Those four
guides describe the build and will go stale unless the owner updates them or lifts the
protection.

## Not verified from here

- Every `tsc` timing above is an estimate.
- How the compiled page behaves in a browser or in the Tauri window. There is no browser in
  this environment; each step would be checked with `npm test` and the builds, and the visual
  result reported as unverified.
- How many type errors the renamed files produce. Nothing has been compiled yet, so the effort
  of steps 2–5 is unmeasured. The lenient setting keeps that number small, and the first step
  that renames a directory should report it.
