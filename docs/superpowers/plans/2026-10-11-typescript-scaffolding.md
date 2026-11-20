# TypeScript Scaffolding (Step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a `tsc` compile between the source and everything Node runs, with all code still JavaScript, so the later steps can rename files to `.ts` one directory at a time with the suite green.

**Architecture:** Two composite `tsc` projects (`src`, `node`) built by `tsc -b` from a root `tsconfig.json` that only holds references. They emit into `out/`, which mirrors the repository, and every npm script runs from there. A `repoRoot` helper replaces the hand-counted `..` anchors so the same code finds the repository from `src/` and from `out/`. `pages.yml` is split into a build job and a deploy job, because building the landing page now needs `npm ci`.

**Tech Stack:** TypeScript 5 (`tsc -b`, `module`/`moduleResolution` NodeNext, `allowJs`), `@types/node` 22, Node ESM, esbuild (unchanged), GitHub Actions.

**Spec:** `/Users/chau.vinh.tuan/ws/me/redlineapp/docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` — read it first. This plan is step 1 of its Section 5 ("Migration and docs"). Steps 2–6 each get their own plan, written once this one has landed and the real error counts are known.

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements include these.

- **Goal of the whole conversion:** catch bugs at compile time, chiefly drift between the three hosts (Node, Tauri, web) over the document payload, the `Platform` contract, the rpc messages and the session surface.
- **Approach:** full `tsc` compile to an output directory (not JSDoc `checkJs`, not Node type stripping).
- **Scope:** every JS file: `src/`, `bin/`, `public/`, `scripts/`, `site/`, `test-smoke.js`. HTML, CSS and Rust are untouched.
- **Strictness:** lenient first (`strict: false`), tightened later by a ratchet.
- **Run by node** (`bin/`, `src/`, `scripts/`, the test): `tsc` emits into `out/`, mirroring the repo (`out/src/core/diff.js`, `out/bin/redline.js`). `package.json`'s `bin` points at `out/bin/redline.js`. It is `out/` and not `dist/`: `dist/` holds release artifacts (`Redline.app`, the dmg, `dist/web`) and CI uploads from it. `out/` is already gitignored.
- **Imports do not change:** the source already imports `./render.js`, and `module: NodeNext` resolves that to `render.ts`.
- **The `src` project has DOM lib and no node types**, so "nothing under `core/`, `page/` or `reader/` may touch a node built-in" becomes a compile error once those files are `.ts`.
- **esbuild bundles** (`build-web.mjs`) read `src/**` directly. A type error does not block a bundle; `tsc` is what fails the build.
- **One shared `repoRoot(import.meta.url)` helper** walks up to the first `package.json` (`out/` has none) and gives the same answer from source and from compiled code.
- **Every npm script that runs a script gains `build:ts` up front** (`"build:web": "npm run build:ts && node out/scripts/build-web.mjs"`). `npm test` is `pretest` (`build:ts`, then `build:web`) and then `node out/test-smoke.js`.
- **`pages.yml`** copies `webapp.yml`'s split: a `build` job (`npm ci`, `tsc`, `build:site`, uploads `site/`, no secret) and a `deploy` job (downloads it, holds the token, runs nothing from the repo).
- **Behaviour must not change at any step**, so `npm test` and `npm run bundle` are green at each.
- **If you change behaviour, change the doc in the same commit** (`CLAUDE.md`).
- **Style:** 2-space indent, single quotes, trailing commas, 100-column soft limit; comments say why, not what, and match the density of the file.
- **`npm test` must run with the command sandbox off** (`dangerouslyDisableSandbox: true`): it boots a real server and binds `127.0.0.1`. `npx prettier` does not work here; check line length with `awk 'length > 100 {print FILENAME":"FNR}' <files>`.
- **Say plainly what was and was not verified.** There is no browser here; nothing about a window can be checked by looking.

## Deviations from the spec

Decided while reading the code to write this plan. Each is a smaller step 1 than the spec's Section 5 describes, not a change of design.

1. **Two projects, not three.** The `page` project (`public/*.ts`, `site/*.ts`, emitted in place) arrives in step 4 with the first rename. `public/app.js` cannot be both an input and an in-place output, so there is nothing for that project to hold yet, and `tsc` refuses a project with no inputs.
2. **No `tsc --watch` in `scripts/dev.mjs` yet.** In step 1 the page is not compiled, `src/` edits reach the window through esbuild (which reads the source), and `scripts/` is not edited during a dev session. `npm run dev` compiles once at start. The watch lands in step 4, when `public/app.ts` makes it matter.
3. **Scripts stay `.mjs`.** `allowJs` emits `scripts/x.mjs` as `out/scripts/x.mjs`. (The spec's example said `.js`; they become `.js` when step 3 renames them to `.ts`.)
4. **Two of the spec's new assertions wait for what they assert.** "Every bundle has a shim in `types/vendor/`" lands in step 4 with the shims. "The strictness floor holds" lands in step 6; with `strict: false` everywhere it would assert nothing.
5. **`markdown-it-task-lists`'s local declaration waits for step 2.** `@types/markdown-it` is installed now (one registry visit); nothing uses either until a `.ts` file imports `markdown-it`.

And one consequence of the spec that a reader will notice: `bin` is `out/bin/redline.js`, which is gitignored, so `npm link` on a fresh checkout links a file that is not there. The docs now say `npm run build:ts && npm link` (Task 6 Step 4); a `prepare` script was rejected because it would make every install, CI's `npm ci` included, run `tsc`.

## Unverified assumptions

`tsc` could not be installed in the session that wrote this plan (the sandbox blocks the npm registry), so none of the following has been run. Each has a verification step and, where it matters, a fallback.

- **`composite` with `allowJs`** emits declarations for JS files, which can raise declaration-emit errors on some JSDoc. Task 1 Step 5 is the gate; its fallback is non-composite projects built in sequence.
- **`.mjs` inputs** are emitted as `.mjs` by `module: NodeNext`.
- **Unused imports are elided from the emit.** A module imported only for a side effect, by a named import that is never used, would silently stop running. The suite is the check; none is known.
- **`tsc -b` timings** (cold and up to date) are estimates until Task 1 Step 6 measures them.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `tsconfig.base.json` | create | Options every project shares |
| `tsconfig.src.json` | create | `src/` except `hosts/node/`; DOM lib, no node types |
| `tsconfig.node.json` | create | `src/hosts/node/`, `bin/`, `scripts/`, `test-smoke.js`; node types |
| `tsconfig.json` | create | References only; what `tsc -b` and editors open |
| `src/hosts/node/root.js` | create | `ROOT`, `repoRoot(metaUrl)`, `rootUrl(name)` |
| `src/hosts/node/server.js` | modify | Take `ROOT` from `root.js` |
| `scripts/*.mjs` (9 files) | modify | Take `ROOT` from `root.js`; `dev.mjs` and `bundle.mjs` spawn from `out/` |
| `package.json` | modify | devDependencies, `build:ts`, scripts and `bin` point at `out/` |
| `test-smoke.js` | modify | `rootUrl` anchors, updated script strings, new assertions |
| `.github/workflows/pages.yml` | modify | Split into `build` and `deploy` |
| `docs/typescript.md` | create | The projects, `out/`, `repoRoot`, the migration ladder |
| `docs/building.md`, `docs/architecture.md`, `docs/cli.md`, `docs/README.md`, `README.md`, `CLAUDE.md` | modify | The build chain; the "no transpiler" convention; `npm link` needs a build first |

`skills/` is write-protected in the agent's sandbox. See Task 6, Step 8.

---

### Task 0: Preflight

**Files:** none.

- [ ] **Step 1: Confirm the prerequisite.** The spec requires the owner's uncommitted `web-cache-busting` changes (`public/app.js`, `test-smoke.js`, three docs) to have landed first; renaming and re-anchoring those files under unmerged edits would conflict.

Run: `git fetch origin && git log --oneline origin/main -8 && git branch -a | grep -i cache-busting`
Expected: the cache-busting commit is on `origin/main`. If it is not, **stop** and tell the owner.

- [ ] **Step 2: Work in a worktree off `main`.**

```bash
git worktree add ../redlineapp-ts -b typescript-scaffolding origin/main
cd ../redlineapp-ts
npm ci
```

`docs/superpowers/` is untracked in the main checkout, so the worktree does not have the spec or this plan; read them from the paths above.

- [ ] **Step 3: Record the baseline.**

Run: `npm test` (sandbox off)
Expected: exits 0; the last lines are `✓` lines, ~40 s. Note the final line, so that Task 7 can compare.

---

### Task 1: Toolchain and tsconfigs

**Files:**
- Create: `tsconfig.base.json`, `tsconfig.src.json`, `tsconfig.node.json`, `tsconfig.json`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run build:ts` (= `tsc -b`), and the `out/` layout: `out/bin/redline.js`, `out/src/**`, `out/scripts/*.mjs`, `out/test-smoke.js`.

- [ ] **Step 1: Install the toolchain.** This needs the npm registry, which the agent's command sandbox blocks; run it where the registry is reachable, or ask the owner to.

```bash
npm install -D typescript@5 @types/node@22 @types/markdown-it@14
```

`@types/node@22` matches the Node 22 CI runs on (`engines` says `>=18`, which is a floor, not what is tested). Expected: `package.json` gains three `devDependencies`; `dependencies` is untouched.

- [ ] **Step 2: Add `tsconfig.base.json`.**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "allowJs": true,
    "checkJs": false,
    "strict": false,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "composite": true,
    "rootDir": ".",
    "outDir": "out"
  }
}
```

`checkJs` is off on purpose: step 1 compiles the JavaScript and does not judge it. Types arrive file by file, from step 2.

- [ ] **Step 3: Add `tsconfig.src.json`, `tsconfig.node.json` and `tsconfig.json`.**

`tsconfig.src.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "tsBuildInfoFile": "out/tsconfig.src.tsbuildinfo"
  },
  "include": ["src"],
  "exclude": ["src/hosts/node"]
}
```

`"types": []` is what keeps `@types/node` out of this project even though it is installed. It does nothing to a `.js` file today (nothing is checked), and everything once the files are `.ts`.

`tsconfig.node.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "types": ["node"],
    "tsBuildInfoFile": "out/tsconfig.node.tsbuildinfo"
  },
  "include": ["src/hosts/node", "bin", "scripts", "test-smoke.js"],
  "references": [{ "path": "./tsconfig.src.json" }]
}
```

`tsconfig.json`:

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.src.json" }, { "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 4: Add the `build:ts` script.** In `package.json`, as the first entry of `scripts`:

```json
    "build:ts": "tsc -b",
```

- [ ] **Step 5: Compile, and read the result. This is the gate.**

Run: `npx tsc -b; echo "exit $?"`
Expected: `exit 0` and no output.

Run: `ls out/bin/redline.js out/test-smoke.js out/src/hosts/node/server.js out/src/core/diff.js out/scripts/build-web.mjs out/scripts/stage-page.mjs && head -1 out/bin/redline.js`
Expected: every file listed, and `#!/usr/bin/env node` (tsc keeps a shebang).

Run: `git status --short`
Expected: only `package.json`, `package-lock.json` and the four `tsconfig*.json` files. `out/` is ignored, `.d.ts` files in it included.

**If `tsc -b` fails with declaration-emit errors** (codes in the 9xxx range, `TS2742`, `TS7056`, "has or is using private name"), or does not emit `.mjs` files: do **not** start suppressing them one by one. Apply the fallback, which makes the projects non-composite and builds them in sequence. It costs the type-resolution-across-projects that composite gives, and `src/` is then compiled by both projects (the same output twice, harmless).

In `tsconfig.base.json`, replace `"composite": true,` with `"incremental": true,`. In `tsconfig.node.json`, delete the `references` block and change `include` to `["src", "bin", "scripts", "test-smoke.js"]`. Replace `tsconfig.json` with:

```json
{ "extends": "./tsconfig.node.json" }
```

and set the script to `"build:ts": "tsc -p tsconfig.src.json && tsc -p tsconfig.node.json"`. Re-run this step. Record in the commit message that the fallback was used and why, and carry the same note into `docs/typescript.md` (Task 6).

- [ ] **Step 6: Measure, so the docs stop saying "estimated".**

Run: `rm -rf out && time npx tsc -b && time npx tsc -b`
Expected: the first (cold) is seconds, the second is a no-op. Write both numbers down for `docs/typescript.md` (Task 6, Step 5).

- [ ] **Step 7: Smoke the compiled CLI.**

Run: `node out/bin/redline.js --help`
Expected: the usage text. (`server.js` still computes its root by counting `..`, which is wrong from `out/`; `--help` never reads it. Task 3 fixes that.)

- [ ] **Step 8: The suite is unchanged by new dev dependencies.**

Run: `npm test` (sandbox off)
Expected: green, with the same last line as Task 0. This also shows that `THIRD-PARTY-NOTICES.md`'s digest, which covers non-dev dependencies and `Cargo.lock`, did not move.

- [ ] **Step 9: Commit.**

```bash
git add tsconfig.base.json tsconfig.src.json tsconfig.node.json tsconfig.json package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add a tsc build that compiles the JavaScript into out/

Nothing runs from out/ yet and no file is checked: allowJs, checkJs off. This is
the toolchain the TypeScript conversion rests on, proven on the code as it is.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The `repoRoot` helper

**Files:**
- Create: `src/hosts/node/root.js`
- Modify: `test-smoke.js` (imports; one new block)

**Interfaces:**
- Consumes: nothing.
- Produces, from `src/hosts/node/root.js`:
  - `repoRoot(metaUrl: string): string` — the first directory at or above the file `metaUrl` names that holds a `package.json`; throws if none.
  - `ROOT: string` — `repoRoot(import.meta.url)` for this file, i.e. the repository root.
  - `rootUrl(name?: string): URL` — a `file:` URL under `ROOT`. A trailing slash survives, so `rootUrl('src/')` is a directory URL. It stands in for `new URL('./x', import.meta.url)`, which in the test file was a repository-root lookup and is a lookup in `out/` once the test is compiled.

- [ ] **Step 1: Write the failing test.** In `test-smoke.js`, change the `node:url` import and add the helper import after the `nodePlatform` one:

```js
import { fileURLToPath, pathToFileURL } from 'node:url';
```

```js
import { ROOT, repoRoot, rootUrl } from './src/hosts/node/root.js';
```

Then add this block immediately before `const tmp = fs.mkdtempSync(...)`:

```js
// --- 0. where the repository is ------------------------------------------
// Node-run code compiles into out/, which mirrors the repository, so a `..` count that is
// right in src/ is wrong one directory deeper. The root is found by walking up to the first
// package.json instead, and out/ has none because tsc does not emit one.
{
  assert.ok(fs.existsSync(path.join(ROOT, 'package.json')), 'ROOT holds package.json');
  assert.strictEqual(repoRoot(import.meta.url), ROOT, 'the same answer from this file');
  for (const deep of ['src/hosts/node/x.js', 'out/src/hosts/node/x.js', 'out/scripts/x.mjs']) {
    const from = pathToFileURL(path.join(ROOT, deep)).href;
    assert.strictEqual(repoRoot(from), ROOT, `from ${deep}, in source or compiled`);
  }
  assert.strictEqual(
    fileURLToPath(rootUrl('package.json')),
    path.join(ROOT, 'package.json'),
    'rootUrl names a file under the root',
  );
  assert.ok(rootUrl('src/').href.endsWith('/src/'), 'and a trailing slash survives, for a directory');
  assert.throws(() => repoRoot('file:///no-such-root/x.js'), /no package\.json/, 'or says so');
  console.log('✓ the repository root is found from a file, in source or compiled');
}
```

- [ ] **Step 2: Run it to see it fail.**

Run: `node test-smoke.js 2>&1 | head -5` (sandbox off)
Expected: fails at once with `ERR_MODULE_NOT_FOUND` for `src/hosts/node/root.js`.

- [ ] **Step 3: Write `src/hosts/node/root.js`.**

```js
// Where the repository is, found from the file asking and not counted in `..`s.
//
// Node-run code compiles into out/, which mirrors the repository (out/src/hosts/node/,
// out/scripts/), so a `..` count that is right in src/ lands in out/ when the same file
// runs compiled. Walking up to the first package.json gives one answer from both: out/
// holds only what tsc emitted, and tsc does not emit a package.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The directory at or above the file `metaUrl` names (an `import.meta.url`) that has a package.json. */
export function repoRoot(metaUrl) {
  const from = fileURLToPath(metaUrl);
  let dir = path.dirname(from);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package.json at or above ${from}`);
    dir = up;
  }
  return dir;
}

export const ROOT = repoRoot(import.meta.url);

/**
 * A file: URL under the root, for what used to be `new URL('./x', import.meta.url)` in a file
 * that sat at the root. A trailing slash is kept, so `rootUrl('src/')` is a directory.
 */
export const rootUrl = (name = '') => new URL(name, pathToFileURL(ROOT + path.sep));
```

- [ ] **Step 4: Run the suite.**

Run: `npm test` (sandbox off)
Expected: green, with the new `✓ the repository root is found from a file, in source or compiled` line. (The suite still runs from source here; `import.meta.url` is the repo root's `test-smoke.js` and the `out/` cases are synthetic URLs, which is why the block passes both before and after Task 4.)

- [ ] **Step 5: Commit.**

```bash
git add src/hosts/node/root.js test-smoke.js
git commit -m "$(cat <<'EOF'
Find the repository root by walking up to package.json

The same file now gets one answer from src/ and from a compiled copy under out/.
Nothing uses it yet.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Adopt `ROOT` in the server and the scripts

**Files:**
- Modify: `src/hosts/node/server.js`, `scripts/build-site.mjs`, `scripts/build-web.mjs`, `scripts/bundle.mjs`, `scripts/dev.mjs`, `scripts/make-icons.mjs`, `scripts/notices.mjs`, `scripts/serve-site.mjs`, `scripts/serve-webapp.mjs`, `scripts/stage-page.mjs`

**Interfaces:**
- Consumes: `ROOT` from `src/hosts/node/root.js` (Task 2).
- Produces: the same ROOT as before, from either depth. No behaviour change, which is why this lands, and is checked, before anything moves to `out/`.

- [ ] **Step 1: Confirm what is there.**

Run: `for f in scripts/*.mjs src/hosts/node/server.js; do printf "%-34s fileURLToPath=%s\n" "$f" "$(grep -c fileURLToPath $f)"; done`
Expected: `fileURLToPath=2` for `build-site`, `build-web`, `bundle`, `dev`, `make-icons`, `stage-page` and `server.js` (the import and the root line, nothing else); `=3` for `notices`, `serve-site`, `serve-webapp` (the third is the `process.argv[1] === fileURLToPath(import.meta.url)` guard, which stays); `=2` for `build-webapp`, which has no root line and is not touched.

- [ ] **Step 2: The six scripts with no other use of `fileURLToPath`** (`build-site`, `build-web`, `bundle`, `dev`, `make-icons`, `stage-page`). In each: replace the line

```js
import { fileURLToPath } from 'node:url';
```

with

```js
import { ROOT } from '../src/hosts/node/root.js';
```

and delete the line

```js
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
```

In `build-web.mjs` and `stage-page.mjs` leave `const require = createRequire(import.meta.url);` alone: resolving a package from `out/scripts/` walks up to the repository's `node_modules`.

In `make-icons.mjs` also change the usage line in the header comment, `//   node scripts/make-icons.mjs`, to `//   npm run icons`: the script is no longer run from `scripts/`.

- [ ] **Step 3: The two with a `fileURLToPath` guard** (`notices`, `serve-webapp`). Keep the `node:url` import. Add `import { ROOT } from '../src/hosts/node/root.js';` directly below it, and delete the same `const ROOT = …` line.

- [ ] **Step 4: `serve-site.mjs`.** Keep the `node:url` import (the guard uses it) and add the `root.js` import below it. Replace

```js
const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
```

with

```js
const SITE = path.join(ROOT, 'site');
```

- [ ] **Step 5: `src/hosts/node/server.js`.** Delete `import { fileURLToPath } from 'node:url';`. After `import { nodePlatform } from './platform.js';` add:

```js
import { ROOT } from './root.js';
```

Delete the line `const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');`. Keep `const require = createRequire(import.meta.url);`.

- [ ] **Step 6: Check what is left.**

Run: `grep -n "import.meta.url" scripts/*.mjs src/hosts/node/*.js`
Expected exactly: `createRequire(import.meta.url)` in `build-web.mjs`, `stage-page.mjs` and `server.js`; the `process.argv[1] === fileURLToPath(import.meta.url)` guards in `build-webapp.mjs`, `notices.mjs`, `serve-site.mjs`, `serve-webapp.mjs`; and `root.js`. Anything else is a missed anchor.

Run: `grep -c "fileURLToPath" scripts/build-site.mjs scripts/build-web.mjs scripts/bundle.mjs scripts/dev.mjs scripts/make-icons.mjs scripts/stage-page.mjs src/hosts/node/server.js`
Expected: `0` for every file.

- [ ] **Step 7: Run the suite, still from source.**

Run: `npm test` (sandbox off)
Expected: green. The scripts and the server are running against a ROOT from `root.js` at their old depth, which is the claim this task makes.

- [ ] **Step 8: Commit.**

```bash
git add src/hosts/node/server.js scripts
git commit -m "$(cat <<'EOF'
Take the repository root from root.js in the server and the scripts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Run everything from `out/`

The package scripts, the two scripts that spawn other scripts, and the test's own anchors move together: the test asserts the package scripts, and runs from the place they now point at.

**Files:**
- Modify: `package.json`, `scripts/dev.mjs`, `scripts/bundle.mjs`, `test-smoke.js`

**Interfaces:**
- Consumes: `build:ts` (Task 1); `ROOT`, `rootUrl` (Task 2).
- Produces: every npm script runs compiled code; `bin.redline` is `out/bin/redline.js`; the suite runs as `out/test-smoke.js`.

- [ ] **Step 1: Point the scripts at `out/`.** In `package.json`, replace the `bin` and `scripts` blocks with:

```json
  "bin": {
    "redline": "out/bin/redline.js"
  },
  "scripts": {
    "build:ts": "tsc -b",
    "build:web": "npm run build:ts && node out/scripts/build-web.mjs",
    "build:dist": "npm run build:ts && node out/scripts/build-dist.mjs",
    "build:webapp": "npm run build:ts && node out/scripts/build-webapp.mjs",
    "build:site": "npm run build:ts && node out/scripts/build-site.mjs",
    "prestart": "npm run build:web",
    "start": "node out/bin/redline.js",
    "prewebapp": "npm run build:web && npm run build:webapp",
    "webapp": "node out/scripts/serve-webapp.mjs",
    "presite": "npm run build:site",
    "site": "node out/scripts/serve-site.mjs",
    "preapp": "npm run build:web && npm run build:dist",
    "app": "cargo run --manifest-path shell/Cargo.toml --",
    "dev": "npm run build:ts && node out/scripts/dev.mjs",
    "icons": "npm run build:ts && node out/scripts/make-icons.mjs",
    "notices": "npm run build:ts && node out/scripts/notices.mjs",
    "bundle": "npm run build:ts && node out/scripts/bundle.mjs",
    "pretest": "npm run build:web",
    "test": "node out/test-smoke.js"
  },
```

`start`, `webapp`, `site` and `test` get their compile from the `pre` hook beside them (each ends in `build:web` or `build:site`, which start with `build:ts`); the others run it themselves. A chain of `pre` hooks runs `tsc -b` more than once, and an up-to-date `tsc -b` is a no-op.

- [ ] **Step 2: The two scripts that spawn scripts.**

In `scripts/bundle.mjs`, replace

```js
sh('node', [path.join('scripts', 'build-web.mjs')]);
sh('node', [path.join('scripts', 'build-dist.mjs')]);
```

with

```js
sh('node', [path.join('out', 'scripts', 'build-web.mjs')]);
sh('node', [path.join('out', 'scripts', 'build-dist.mjs')]);
```

In `scripts/dev.mjs`, in `build`, replace `spawnSync('node', [path.join('scripts', script)], {` with `spawnSync('node', [path.join('out', 'scripts', script)], {`.

- [ ] **Step 3: Re-anchor the test.** Run this once, from a directory that is not the repository (it is throwaway and is not committed):

```bash
cat > "$TMPDIR/rooturl.mjs" <<'EOF'
import fs from 'node:fs';
const file = 'test-smoke.js';
const before = fs.readFileSync(file, 'utf8');
const after = before
  .replace(/new URL\('\.\/([^']*)', import\.meta\.url\)/g, "rootUrl('$1')")
  .replace(/new URL\(`\.\/([^`]*)`, import\.meta\.url\)/g, 'rootUrl(`$1`)')
  .replace(/new URL\(f, import\.meta\.url\)/g, 'rootUrl(f)');
fs.writeFileSync(file, after);
console.log('lines changed:', before.split('\n').filter((l, i) => l !== after.split('\n')[i]).length);
EOF
node "$TMPDIR/rooturl.mjs"
```

Expected: about 60 lines changed (50 `'./x'`, 6 template, 4 `f`).

Two things in `test-smoke.js` are not plain lookups. The first is a *module import*, which the sed above does not touch. Found while executing Task 1: `tsc` follows a literal `import('./public/backend.js')`, so it emitted a stray `out/public/` (the page's `backend.js` and the generated `vendor/backend-*.js` bundles), and once the suite runs from `out/` that relative import would load the compiled copy instead of the file under test. Make it non-literal, so `tsc` does not follow it and the real file is loaded. Find it with `grep -n "import('./public" test-smoke.js`:

```js
  const { createBackend } = await import('./public/backend.js');
```

becomes

```js
  const { createBackend } = await import(rootUrl('public/backend.js').href);
```

After Step 8, `find out -path '*/public/*'` must print nothing.

The second is the one that is not a lookup at all. Find it with `grep -n "new URL('\.'" test-smoke.js`; it reads:

```js
  const repo = path.resolve(fileURLToPath(new URL('.', import.meta.url)));
```

and becomes

```js
  const repo = ROOT;
```

- [ ] **Step 4: Check what is left.**

Run: `grep -n "import.meta.url" test-smoke.js`
Expected: exactly `createRequire(import.meta.url)` (resolving packages from `out/` walks up to `node_modules`), the new block in Task 2 (`repoRoot(import.meta.url)`, which must stay: it is the check that the test itself is under the root), the `out/` assertion added in Step 6, and one comment that mentions `import.meta.url` (about "dist/web works from any directory"). Anything else is an anchor that would now look in `out/`.

- [ ] **Step 5: Update the assertions that spell the old scripts.** Find them with `grep -n "'node scripts/" test-smoke.js`: five lines, for `build-webapp`, `serve-webapp`, `dev`, `notices` and `serve-site`. Each is a `strictEqual` against a string in `package.json`; their line numbers move whenever the file does, so go by the text:

```js
// in the web app's block, beside the `npmScripts.prewebapp` one, which does not change
  assert.strictEqual(
    npmScripts['build:webapp'],
    'npm run build:ts && node out/scripts/build-webapp.mjs',
    'npm run build:webapp',
  );
  assert.strictEqual(npmScripts.webapp, 'node out/scripts/serve-webapp.mjs', 'npm run webapp');
```

```js
// the dev loop (was `'node scripts/dev.mjs'`)
assert.strictEqual(
  devScripts.dev,
  'npm run build:ts && node out/scripts/dev.mjs',
  'the dev loop is one command',
);
```

```js
// the notices (was `'node scripts/notices.mjs'`)
assert.strictEqual(
  pkgJson.scripts.notices,
  'npm run build:ts && node out/scripts/notices.mjs',
  'npm run notices',
);
```

```js
// the landing page (was `'node scripts/serve-site.mjs'`)
assert.strictEqual(
  scripts.site,
  'node out/scripts/serve-site.mjs',
  'the page can be served from here',
);
```

(`npmScripts.prewebapp` and `scripts.presite` are unchanged and keep passing.)

- [ ] **Step 6: Add what is new.** Directly after the Task 2 block (`✓ the repository root is found…`), add:

```js
// The suite runs what ships. `npm test` compiles first (pretest) and this file is the compiled
// copy; pointed back at the source, every assertion below would be about code no npm script
// runs, and nothing would say so.
{
  assert.ok(
    fileURLToPath(import.meta.url).startsWith(path.join(ROOT, 'out') + path.sep),
    'the suite runs from out/, the compiled copy',
  );
  const pkg = JSON.parse(fs.readFileSync(rootUrl('package.json'), 'utf8'));
  assert.strictEqual(pkg.bin.redline, 'out/bin/redline.js', 'the CLI is the compiled one');
  assert.strictEqual(pkg.scripts['build:ts'], 'tsc -b', 'one command compiles every project');
  // A script with a pre hook gets its compile from the hook, which ends in build:web or
  // build:site, and both of those start with build:ts.
  const compiledBy = { start: 'prestart', webapp: 'prewebapp', site: 'presite', test: 'pretest' };
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(cmd, /\bnode (scripts|bin)\/|\bnode test-smoke/, `${name} runs compiled code`);
    if (!/\bnode out\//.test(cmd)) continue;
    const gate = compiledBy[name] ? pkg.scripts[compiledBy[name]] : cmd;
    assert.match(gate, /^npm run build:(ts|web|site)\b/, `${name} compiles before it runs`);
  }
  console.log('✓ the suite and every npm script run the compiled copy, compiled first');
}
```

- [ ] **Step 7: Format check.**

Run: `awk 'length > 100 {print FILENAME":"FNR}' test-smoke.js scripts/*.mjs src/hosts/node/*.js`
Expected: nothing new. Lines that were already long are not this task's to fix; compare with `git stash -q && awk … ; git stash pop` if unsure.

- [ ] **Step 8: Run the suite from `out/`.**

Run: `npm test` (sandbox off)
Expected: `pretest` runs `tsc -b` then `build:web`; the suite then runs as `out/test-smoke.js`, green, and includes `✓ the suite and every npm script run the compiled copy, compiled first`.

If something fails with a `ENOENT` for a path under `out/`, it is a missed anchor from Step 4; a failure about the `spawn` count or the layering rule means a source grep is reading `out/`, which it should not.

- [ ] **Step 9: Run what the suite does not.** Each of these runs a compiled script from `out/`, which is the point:

```bash
npm run build:dist && npm run build:webapp && npm run build:site
git status --short
```

Expected: all three succeed and `git status` shows this task's edits plus `site/index.html`. The first two outputs are ignored, but `build:site` is meant to stamp `package.json`'s version into the page's download link (`build-site.mjs`, the `versioned` write), and the tracked page lags a release behind (0.6.0 against 0.7.0), so it shows as modified. It is not this task's change: leave it out of the commit by naming files in Step 10, and never `git add -A`. Then the CLI, in the sandbox-off shell, from a second terminal's point of view:

```bash
npm run build:web
node out/bin/redline.js sample.md --no-open > "$TMPDIR/redline.log" 2>&1 &
pid=$!; sleep 3; cat "$TMPDIR/redline.log"
```

Read the port out of the log (`7391`, or the next free one), then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7391/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7391/vendor/render.js
kill $pid
```

Expected: `200` and `200`. The second is the proof that matters: `render.js` is served out of `public/vendor/` at the repository root, found by `ROOT` from `out/src/hosts/node/`.

- [ ] **Step 10: Commit.**

```bash
git add package.json scripts/dev.mjs scripts/bundle.mjs test-smoke.js
git commit -m "$(cat <<'EOF'
Run the CLI, the scripts and the suite from the compiled copy in out/

Every npm script that runs a script compiles first. The test reads the
repository from its root and not from where it sits, and asserts that it is the
compiled copy that is running.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Split `pages.yml` into build and deploy

`build:site` is a compiled script now, so the job that runs it needs `npm ci`, and `npm ci` runs every dependency's install scripts. That job must not also hold the Cloudflare token. `webapp.yml` solved the same thing the same way.

**Files:**
- Modify: `.github/workflows/pages.yml`, `wrangler.toml` (one comment), `test-smoke.js`

**Interfaces:**
- Consumes: `npm run build:site` (Task 4).
- Produces: workflow `Pages` with jobs `build` (artifact `redline-site`, from `site/`) and `deploy`. Its triggers, `concurrency` and `permissions` are unchanged, which the existing assertions already pin.

- [ ] **Step 1: Write the failing test.** In `test-smoke.js`, in the landing-page block, directly after the line `assert.match(wrangler, /^name = "redline"$/m, 'into the project it names');`, add:

```js
// Two jobs, for the reason the web app's deploy is two: building the page compiles a script, so it
// needs `npm ci`, which runs every dependency's install scripts, and the job that has done that
// must not hold the Cloudflare token.
{
  assert.deepStrictEqual(
    pagesCode.slice(pagesCode.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
    ['  build:', '  deploy:'],
    'a job that builds the page, and a job that deploys what it built',
  );
  const buildJob = pagesCode.slice(pagesCode.indexOf('\n  build:'), pagesCode.indexOf('\n  deploy:'));
  const deployJob = pagesCode.slice(pagesCode.indexOf('\n  deploy:'));
  assert.match(deployJob, /needs: build/, 'the deploy waits for the build');
  assert.match(buildJob, /run: npm ci\b[\s\S]*run: npm run build:site\b/, 'built from a clean install');
  assert.doesNotMatch(buildJob, /secrets\./, 'the job that runs npm ci holds no secret');
  assert.match(deployJob, /apiToken: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'the token');
  assert.match(deployJob, /accountId: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'the account');
  assert.doesNotMatch(deployJob, /actions\/checkout/, 'with no checkout, so no wrangler.toml');
  assert.doesNotMatch(deployJob, /\bnpm\b|\bnpx\b/, 'and no npm to run a dependency with');
  assert.strictEqual(deployJob.match(/^ {6}- /gm).length, 3, 'a node, the artifact, the deploy');
  // wrangler.toml is not there to be read, so the project and the directory are named here, and
  // they are the ones wrangler.toml names.
  assert.strictEqual(
    deployJob.match(/--project-name=(\S+)/)?.[1],
    wrangler.match(/^name = "(.+)"$/m)[1],
    "into the landing page's project",
  );
  assert.strictEqual(
    deployJob.match(/pages deploy (\S+) /)?.[1],
    wrangler.match(/^pages_build_output_dir = "(.+)"$/m)[1],
    'and the directory wrangler.toml names',
  );
  assert.match(deployJob, /command: pages deploy site --project-name=redline --branch=main/);
  // What is uploaded is what was built: the one directory, by the one name, and an empty one is
  // an error.
  assert.match(
    buildJob,
    /name: redline-site\n\s+path: site\n\s+if-no-files-found: error/,
    'site/ or nothing',
  );
  assert.match(deployJob, /name: redline-site\n\s+path: site/, 'which the deploy downloads to site/');
  console.log('✓ pages.yml builds in one job and deploys from another, token in one');
}
```

- [ ] **Step 2: Run it to see it fail.**

Run: `npm test 2>&1 | tail -15` (sandbox off)
Expected: fails at `a job that builds the page, and a job that deploys what it built` (today there is one job, `deploy`).

- [ ] **Step 3: Rewrite `.github/workflows/pages.yml`.** Keep the header's secrets paragraph, `name`, `on`, `concurrency` and `permissions` exactly as they are. Replace the first comment paragraph and the `jobs:` block. The first paragraph (lines 1–5) becomes:

```yaml
# Publish the landing page in site/ to Cloudflare Pages.
#
# Its own workflow rather than a job in ci.yml, because it shares nothing with
# it: a change to the page is no reason to run the reader's suite and compile a
# dmg. It does share the compiler, since build:site is a compiled script, so it
# installs what the repository does and is two jobs for the reason webapp.yml is.
```

and `jobs:` becomes:

```yaml
jobs:
  # Everything that runs this repository's code and its dependencies' code, and no secret.
  build:
    name: build the landing page
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      # Compiles the script, then runs it. It also fails the run if the page
      # points at a file that is not there, which is the only check available for
      # a page with no browser to open it in -- see the comment at the top of the
      # script.
      - name: Stage the icon and the og:image
        run: npm run build:site

      # What is uploaded is what was built here, to the byte, and the deploy job
      # is not given a checkout to build it again from.
      - uses: actions/upload-artifact@v7
        with:
          name: redline-site
          path: site
          if-no-files-found: error

  # The one job that holds the Cloudflare token. It runs nothing from this
  # repository and nothing from node_modules, only a directory of static files
  # and wrangler: `npm ci` runs every dependency's install scripts, and a job
  # that has done that should not also be handed the key to the account.
  #
  # It has no checkout, so there is no wrangler.toml for `wrangler pages deploy`
  # to find, and the project and the directory are what is written on the command
  # line below -- the same two wrangler.toml names, which the test suite compares.
  deploy:
    name: deploy to Cloudflare Pages
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 22

      - uses: actions/download-artifact@v7
        with:
          name: redline-site
          path: site

      - name: Deploy
        uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy site --project-name=redline --branch=main
```

Then, in `wrangler.toml`, the one sentence that is no longer true: the workflow now names the project and the directory itself. Replace

```
# `pages_build_output_dir` is what gets uploaded, so `wrangler pages deploy`
# needs no argument and the workflow and a local run cannot disagree about which
# directory is the site. Run `npm run build:site` first either way: the
# screenshots and the icon are copied in rather than committed, so an unbuilt
# site/ is the page with no images.
```

with

```
# `pages_build_output_dir` is what a local `wrangler pages deploy` uploads, with
# no argument. The workflow has no checkout to read this file from, so it names
# the same project and directory on its command line, and test-smoke.js fails if
# they ever differ. Run `npm run build:site` first either way: the screenshots
# and the icon are copied in rather than committed, so an unbuilt site/ is the
# page with no images.
```

- [ ] **Step 4: Run the suite.**

Run: `npm test` (sandbox off)
Expected: green, including the new `✓ pages.yml builds in one job…` and the older assertions that still have to hold: `pages.yml runs by hand, and on nothing else`, `/npm run build:site/`, `/command: pages deploy/`, and the `wrangler.toml` ones (`pages_build_output_dir = "site"`, `name = "redline"`). None of them reads a job boundary, which is why they survive the split.

- [ ] **Step 5: Say what this cannot check.** A workflow cannot be run from here, and `pages.yml` runs only by hand or from a release, so a mistake in it would first show at release time. Before merging, run `actionlint` if it is installed (`actionlint .github/workflows/pages.yml`). Do **not** run the workflow from the branch: like `webapp.yml`, `--branch=main` deploys the ref it runs on as production. After merge, the owner starts **Pages** by hand from `main`; the page is unchanged, so a redeploy is safe, and it is the real test.

- [ ] **Step 6: Commit.**

```bash
git add .github/workflows/pages.yml wrangler.toml test-smoke.js
git commit -m "$(cat <<'EOF'
Build the landing page in one job and deploy it from another

Building it compiles a script, so the build needs npm ci, and the job that runs
npm ci must not hold the Cloudflare token. Copies webapp.yml's split.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Docs

Behaviour changed (`node bin/redline.js` needs a compile first; the scripts run from `out/`; the deploy is two jobs), so the docs change in the same PR.

**Files:**
- Create: `docs/typescript.md`
- Modify: `docs/architecture.md`, `docs/building.md`, `docs/cli.md`, `docs/README.md`, `README.md`, `CLAUDE.md` (gitignored, the owner's local notes)

- [ ] **Step 1: `docs/architecture.md`, the opening.** Replace

```
Node ESM and hand-written CSS, no framework. Nothing is transpiled, so what you read
in `src/` and `public/` is what runs; the only dependencies that reach the page are
```

with

```
Node ESM and hand-written CSS, no framework. The code Node runs (`bin/`, `scripts/`,
`src/hosts/node/`, the test) goes through `tsc` into `out/` first; what esbuild
bundles is `src/` as written, and what the page runs is `public/` as written. All of it
is still JavaScript while the conversion is under way ([typescript.md](typescript.md));
the only dependencies that reach the page are
```

- [ ] **Step 2: `docs/architecture.md`, the module map.** Under `src/hosts/node/`, after the `platform.js` line, add:

```
  root.js               where the repository is, from any file, in source or compiled
```

and under the `bin/redline.js` line near the top add a line for `out/` (the file's own column alignment decides the spacing):

```
out/                    tsc's output: what every npm script runs. Gitignored
```

- [ ] **Step 3: `docs/architecture.md`, the convention.** Replace the bullet that begins `- No framework and no transpiler — the cost of reading a file is reading that file.` through `(\`markdown-css.mjs\`).` with:

```
- No framework. One compiler, `tsc`, and it is here for one reason: the three hosts
  (node, Tauri, web) share a payload, a `Platform`, an rpc protocol and a session, and
  the compiler is what fails when they disagree. It compiles what node runs into `out/`
  and never into `src/`. The two page build steps exist because the app's page has no
  node to import from and no server to fetch from, and they are not a second compile of
  anything: `build-web.mjs` bundles `src/` as it is, and `stage-page.mjs` only copies.
  The one rewrite is github-markdown-css's palette, keyed to the page's scheme
  (`markdown-css.mjs`). [typescript.md](typescript.md) has the layout.
```

- [ ] **Step 4: `README.md`, `docs/cli.md`, `docs/README.md`.**

In `README.md`, replace (the wrap is as shown)

```
**No framework, no transpiler, six dependencies.** What you read in `src/` and
`public/` is what runs: one client module and one hand-written stylesheet. The diff
```

with

```
**No framework, one compiler, six dependencies.** `tsc` compiles the code Node runs and
nothing else; the page runs what you read in `src/` and `public/`, bundled but not
translated: one client module and one hand-written stylesheet. The diff
```

(The "six" is the README's own count and is not touched here.)

`npm link` is a documented way to install the CLI, and `bin` is now `out/bin/redline.js`, which is gitignored: on a fresh checkout `npm link` would link a file that is not there yet. So in `README.md` replace `npm start -- path/to/doc.md        # or: npm link && redline doc.md` with

```
npm start -- path/to/doc.md        # or: npm run build:ts && npm link && redline doc.md
```

and in `docs/cli.md` replace ``On your `$PATH` after `npm link`; from a checkout, `npm start --`.`` with

```
On your `$PATH` after `npm run build:ts && npm link` — the command is the compiled copy in
`out/`, so build it first; from a checkout, `npm start --`.
```

(A `prepare` script that compiled on every `npm install` would also fix it. It is not chosen: it makes every install, CI's `npm ci` included, run `tsc`, to save a command a person types once.)

In `docs/README.md`, add a row to the "Working on it" table, after the Building and testing row:

```
| [TypeScript](typescript.md) | The compile step, `out/`, finding the repository root, and where the conversion stands |
```

- [ ] **Step 5: `docs/typescript.md`.** Create it:

````markdown
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

The design is `docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` (not
tracked), which also lists what could not be verified when it was written.

## What `tsc -b` costs

Cold: TODO-MEASURED. Up to date: TODO-MEASURED. (Task 1, Step 6 of the step-1 plan.)
````

Replace both `TODO-MEASURED` with the numbers from Task 1, Step 6 **before committing**. (If the fallback in Task 1 was used, add a section here that says the projects are non-composite and why.)

- [ ] **Step 6: `docs/building.md`.** Seven edits, in file order. Each gives the text to find and the text to put there.

1. The opening block, line 5. Replace `npm start -- sample.md       # a browser tab: node, no build step` with:

```
npm start -- sample.md       # a browser tab: compiled, bundled, served
```

2. The paragraph under the block (four lines, `For the browser there is no build step worth the name:` through `After that it is seconds.`). Replace all four lines with:

```
For the browser the build is short: `tsc -b` compiles what node runs into `out/` (a no-op
when nothing changed), `prestart` bundles `src/` for the page, and `public/` runs as it
is. The native window is a Rust binary, so it needs a toolchain — [rustup](https://rustup.rs) —
and the first compile takes a few minutes. After that it is seconds.
```

3. "What is generated". Replace `Three commands, and the reason to know about the first two is that the app **embeds**` and the next three lines (through `working.`) with:

```
Four commands, and the reason to know about `build:web` and `build:dist` is that the app
**embeds** its copy of the page at compile time. A change to `public/` that has not been
through both is a change that is not in the window, which looks exactly like the change
not working.
```

and add this as the **first** row of the table, above `npm run build:web`:

```
| `npm run build:ts` | `tsc -b`: compiles `bin/`, `scripts/`, `src/` and the test into `out/`, which mirrors the repository (`out/src/core/diff.js`, `out/scripts/build-web.mjs`). Gitignored, and what every npm script runs; every other build command runs it first. See [TypeScript](typescript.md) |
```

4. The paragraph after the table. Replace

```
`npm run app`, `npm run dev`, `npm run bundle`, `npm run webapp` and `npm test` each run
the ones they need, so the only time to reach for them by hand is after editing `src/` with a
window already open — and `npm run dev` re-runs them for you on every edit, which is
[the point of it](#the-dev-loop).
```

with

```
`npm run app`, `npm run dev`, `npm run bundle`, `npm run webapp` and `npm test` each run
the ones they need, so the only time to reach for them by hand is after editing `src/` with a
window already open — and `npm run dev` re-runs them for you on every edit, which is
[the point of it](#the-dev-loop). One exception: `npm run dev` compiles `out/` once, when
it starts. A change to `scripts/` or `src/hosts/node/` while it runs is not picked up until
the next `npm run build:ts`; a change to `src/` is, because esbuild reads it directly.
```

5. "Tests", line 258. Replace the first sentence, `One file, \`test-smoke.js\`, run by \`node\` with no test framework.` (the rest of the paragraph stays), with:

```
One file, `test-smoke.js`, which `pretest` compiles into `out/` and `node` runs from there,
with no test framework. Its file lookups go through `rootUrl`, from the repository root, so
the compiled copy greps the same source the original does.
```

6. The CI table, line 305. Replace `| \`.github/workflows/pages.yml\` | the landing page, [deployed](#deploying-it) to Cloudflare Pages |` with:

```
| `.github/workflows/pages.yml` | the landing page, built in one job and [deployed](#deploying-it) to Cloudflare Pages from another |
```

7. "Deploying it". Two replacements.

First, the paragraph that follows the `wrangler.toml` block's introduction (lines 714–715, `\`wrangler.toml\` names the project and the directory, so the workflow and a local run` / `cannot disagree about what is being deployed:`) becomes:

```
`wrangler.toml` names the project and the directory for a local run. The workflow has no
checkout to read it from, so it writes the same two on its command line, and
`test-smoke.js` fails if they ever differ:
```

Second, the paragraph that begins `The deploy runs \`npm run build:site\` first and **no \`npm ci\`**` (four lines, ending `alongside the page itself.`) becomes:

```
It is **two jobs**, the way [the web app's](#publishing-the-web-app) is. `build` runs
`npm ci` and `npm run build:site` — which compiles `scripts/build-site.mjs` first, so
the job needs the repository's dependencies, and `npm ci` runs every dependency's
install scripts — and uploads `site/`. `deploy` holds the Cloudflare token and runs
nothing from the repository: it downloads that artifact and hands it to wrangler, with
the project and the directory named on the command line, because it has no checkout and
so no `wrangler.toml`. An unbuilt `site/` is the page with no icon and no link preview,
and it would upload perfectly happily — which is why the staging step is asserted in
`test-smoke.js` alongside the page itself.
```

(`#publishing-the-web-app` is the anchor of the `### Publishing the web app` heading in the same file, and `#deploying-it` of `## Deploying it`.)

- [ ] **Step 7: `CLAUDE.md`** (gitignored: this edit is the owner's local notes and is not part of the commit, but the next agent reads it). Replace the intro sentence (it wraps in the file, after `no`): `Node ESM and hand-written CSS, no framework, nothing transpiled — what you read is what runs.` with `Node ESM and hand-written CSS, no framework. \`tsc\` compiles the code Node runs into \`out/\`, and every npm script runs from there; what esbuild bundles and what the page runs is read as written. The conversion to TypeScript is under way — see docs/typescript.md.` Replace `- No framework, no transpiler, no new dependency without a reason that survives\n  being written down.` with `- No framework, and no new dependency without a reason that survives\n  being written down.` Add `out/` to the Layout block (`out/                tsc's output; what npm scripts run, gitignored`), a `docs/typescript.md` row to the table at the top, and to "Six things" #1 the sentence: `Node-run code is compiled into out/: a change to bin/, scripts/ or src/hosts/node/ is not what runs until npm run build:ts, and node bin/redline.js from a fresh checkout does nothing useful.` Anchor on the repository root with \`rootUrl\`/\`ROOT\` from src/hosts/node/root.js, never by counting \`..\`.

- [ ] **Step 8: `skills/` — not editable from here.** `skills/` is write-protected in the agent's sandbox. Do not look for a way round it. Tell the owner these four guides will be stale until they update them or lift the protection: `redline-testing` (the suite runs as `out/test-smoke.js`; anchor with `rootUrl`), `redline-shipping` (`pages.yml` is two jobs; every npm script compiles first; `bin` is `out/bin/redline.js`), `redline-client` (its opening says `Nothing is transpiled: what you read is what runs`) and `redline-tauri` (the dev loop compiles once at start; `node` scripts run from `out/`). Say it in the PR description.

- [ ] **Step 9: Check.**

Run: `grep -rn "transpil\|node scripts/\|node bin/redline\|no build step" docs README.md CLAUDE.md --include='*.md' | grep -v docs/superpowers`
Expected: nothing. (`skills/` is not in the grep: it is out of reach, Step 8.)

Run: `awk 'length > 100 {print FILENAME":"FNR}' docs/typescript.md`
Expected: nothing. (Prose in the other docs wraps near 90; match it.)

Run: `npm test` (sandbox off)
Expected: green. A doc cannot fail the suite except through the "nothing cites the plan" scan, which reads `docs/` for a phrase this file does not contain.

- [ ] **Step 10: Commit.**

```bash
git add docs/typescript.md docs/architecture.md docs/building.md docs/cli.md docs/README.md README.md
git commit -m "$(cat <<'EOF'
Document the compile step, out/, and why there is a compiler at all

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

(`CLAUDE.md` is ignored by `.gitignore` and does not appear in `git status`.)

---

### Task 7: Verify the whole, then hand over

**Files:** none.

- [ ] **Step 1: A clean checkout builds.** The bug this catches is a dependency on something only a long-lived `out/` has.

```bash
rm -rf out public/vendor shell/dist dist
npm test
```

Expected: green from nothing. `out/` and `public/vendor/` are rebuilt by `pretest`.

- [ ] **Step 2: The packaging path.** `CLAUDE.md` asks for this before a PR unless the change is landing-page-only, and this one is not.

Run: `npm run bundle` (needs a Rust toolchain; takes minutes)
Expected: `dist/Redline.app` and the dmg, sizes close to the 8 MB / 3 MB `CLAUDE.md` gives. `bundle.mjs` spawned `out/scripts/build-web.mjs` and `out/scripts/build-dist.mjs`, which is what is being checked. If there is no Rust toolchain here, say so in the PR; CI's `bundle` job runs it on every pull request.

- [ ] **Step 3: Compare with the baseline.** The last lines of `npm test` should match Task 0 Step 3, plus the three new `✓` lines (the root helper, the compiled copy, `pages.yml`).

- [ ] **Step 4: Report, in the PR description, what was and was not checked.**

- Run: `npm test` from a clean tree, `npm run bundle` (or that it was not run, and why), `npm run build:dist`, `build:webapp`, `build:site`, and the compiled CLI serving `/` and `/vendor/render.js`.
- Not run: `pages.yml` (it cannot be, from here; see Task 5 Step 5), the native window, and anything about layout. Nothing visual changed, and none of it was looked at.
- The measured `tsc -b` times from Task 1 Step 6; whether the non-composite fallback was needed.
- `skills/` is stale (Task 6 Step 8).
- The follow-up that matters: **step 2 is where the first real type-error count appears**, and it should be reported then.

- [ ] **Step 5: Do not merge from the branch.** Open the PR; push and open it only when the owner asks (`CLAUDE.md`: branch, commit and push when asked).

---

## Self-review

**Spec coverage.** Section 1 (two homes): `out/` and the `bin` entry, Task 4; in-place page emit is step 4 by Deviation 1. Path anchors and `repoRoot`: Tasks 2–3 (server, nine scripts) and Task 4 (the test). The behaviour change for `node bin/redline.js` is in `docs/typescript.md` and `CLAUDE.md`. Section 2: `tsconfig.base/src/node/root` Task 1; the `page` project and `types/vendor/` are step 4 (Deviations 1 and 4); `worker.ts` globals are step 2. devDependencies Task 1 (`markdown-it-task-lists` declaration deferred, Deviation 5). The ratchet is step 6. Section 3: `build:ts`, every script compiling first, `pretest`, Task 4; the `.gitignore` additions for `public/app.js` etc. are step 4 (nothing is emitted there yet); the dev-loop watch is step 4 (Deviation 2); `ci.yml` and `webapp.yml` need no change, and the suite's existing assertions about both still hold; the `pages.yml` split Task 5. Section 4: `rootUrl` for the ~100 lookups Task 4 (62 lines); greps about source keep reading source because step 1 moves nothing; new assertions: the compiled-copy and `bin`/scripts one Task 4, shims and floor deferred. Section 5 docs: `architecture.md`, `building.md`, `docs/typescript.md` Task 6, with `skills/` named as out of reach.

**Placeholder scan.** The only deliberate blanks are the two `TODO-MEASURED` numbers in `docs/typescript.md`, which Task 6 Step 5 says to fill from Task 1 Step 6 before committing; they exist because the numbers cannot be known until `tsc` runs. Everything else is code or an exact edit.

**Type and name consistency.** `ROOT`, `repoRoot(metaUrl)`, `rootUrl(name)` are defined once (Task 2) and used with those names in Tasks 3 and 4. `redline-site` is the artifact name in both the workflow and its prose. `build:ts` is `tsc -b` in Tasks 1 and 4 and in the assertion that pins it; if the Task 1 fallback is used, Task 4's script text and the assertion `pkg.scripts['build:ts'] === 'tsc -b'` change with it, and the executor must change both.

**Known weak points.** The fallback in Task 1 interacts with Task 4's assertion (above). The `rooturl.mjs` rewrite changes about 60 lines of the test mechanically; Step 4's leftover check is what catches a shape it did not anticipate. Task 6's doc edits quote the text they replace, and were checked against the files when the plan was written, but a doc that moves before the executor starts (the owner's `web-cache-busting` change touches three) can shift a quote; where one does not match, find the paragraph by its first words and keep its meaning.
