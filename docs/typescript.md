# TypeScript

Redline is being converted from JavaScript to TypeScript, **to catch drift between the
three hosts at compile time**: the payload, the `Platform` contract, the rpc messages and
the session surface that Node, Tauri and the web app each implement or consume. The `.ts`
extension is not the goal; a compile that fails when two hosts disagree is.

This is step 1 of the conversion. **Every file is still JavaScript and nothing is
type-checked** (`allowJs` on, `checkJs` off): what has landed is the build that the
renames will run through.

## Two homes for compiled code

| | Where it lives | Compiled to |
| --- | --- | --- |
| Run by Node: `bin/`, `src/`, `scripts/`, `test-smoke.js` | the repository | `out/`, mirroring the repository (`out/src/core/diff.js`, `out/scripts/build-web.mjs`) |
| Named by a URL: `public/app.js`, `public/backend.js`, `site/landing.js` | the repository | **not yet compiled.** Step 4 emits them in place, gitignored, because the server, `stage-page.mjs` and the tests already name those paths |

`out/` is gitignored and is **not** `dist/`, which holds release artifacts. Every npm
script that runs a script runs it from `out/` and compiles first (`npm run build:ts`,
which is `tsc -b`); an up-to-date compile is a no-op. `node bin/redline.js` from a fresh
checkout therefore does not work before `npm run build:ts`; `npm start` does it for you.

esbuild is a separate thing. `build-web.mjs` bundles `src/` **as written**, from the source,
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
compile error once those files are `.ts`. A third project, `page`, holds `public/` and
`site/` and arrives with step 4.

## Finding the repository root

Do not count `..` from `import.meta.url`. Compiled code sits one directory deeper than its
source, so a count that is right in `src/` is wrong in `out/`. Import `ROOT`, `repoRoot`
and `rootUrl` from `src/hosts/node/root.js`, which walks up to the first `package.json` —
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
2. `src/core` and `src/rpc` with the shared payload and rpc types; then `src/reader`
   (`Platform`, `Session`); then the three hosts.
3. `scripts/` and `bin/`.
4. The `page` project: `app.ts`, `backend.ts`, `landing.ts`, each a single rename, plus
   `tsc -b --watch` in `scripts/dev.mjs` and the vendor shims in `types/vendor/`.
5. `test-smoke.ts`.
6. The ratchet, one flag per project: `noImplicitAny`, then `strictNullChecks`, then `strict`.

What the design decided is in this file and in [architecture.md](architecture.md); the
design document itself is not in the repository.

## What `tsc -b` costs

Measured with `tsc` 5.9.3 on an arm64 Mac, over the 50 files compiled today, none of them
type-checked yet:

| | Time |
| --- | --- |
| Cold, from no `out/` | about 0.9 s |
| Up to date, `tsc -b` itself | about 0.06 s |
| Up to date, as `npm run build:ts` | about 0.16 s |

The last row is what `npm test`, `npm start` and the other scripts pay on every run, most
of it npm's own start-up. Both numbers grow once the files are `.ts` and are checked; the
ones to compare against are the ones step 2 reports.
