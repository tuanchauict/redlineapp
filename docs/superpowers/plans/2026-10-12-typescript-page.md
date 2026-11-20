# TypeScript Conversion, Step 4: The Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the page — `public/app.js`, `public/backend.js`, `site/landing.js` — to TypeScript, so that `tsc -b` checks the page against the same contract the three hosts implement.

**Architecture:** A third `tsc` project, `tsconfig.page.json`, compiles the page **in place** (`public/app.ts` → `public/app.js`, gitignored), because the server, `stage-page.mts`, the `?v=` rewrite and the tests already name those paths. The page imports its bundles from `./vendor/*.js`, which only exists after `build:web`, so committed `.d.ts` shims in `types/vendor/` stand in for them and re-export the `src/` module each bundle is built from. `public/backend.ts` types `httpBackend` as the contract's `Backend` and `createBackend` as a page-side `PageBackend` (the contract plus the web app's optional extras).

**Tech Stack:** TypeScript 5.9 (`tsc -b`, `strict: false`), Node ESM, esbuild (reads `src/**/*.ts` directly), the repo's own test suite `test-smoke.js`.

**Spec:** `docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` (untracked in the main checkout; the repo does not hold it). Steps 1–3 are merged; this is step 4 of the ladder in `docs/typescript.md`.

## Global Constraints

- **Branch:** work on `typescript-page`, which forks `typescript` at `49ee189`. The PR goes into `typescript`, **never `main`**. Implementers do not push and do not open PRs.
- **Every commit is green.** `npm run build:ts` (`tsc -b`) exits 0, **and** `npm test` passes. `npm test` binds `127.0.0.1`, so it must run with the command sandbox off (`dangerouslyDisableSandbox: true`). Nothing else needs it except `npm run bundle`.
- **`npm run bundle` is run once, in Task 6**, with `CARGO_NET_OFFLINE=true` and the sandbox off.
- **Leniency stays:** `strict: false`. No `// @ts-nocheck`, `// @ts-ignore` or `// @ts-expect-error`; no `any` where an annotation or a narrow cast says the same thing more precisely. A cast (`as HTMLInputElement`) is the accepted answer to "the DOM cannot know which element this id is".
- **Types only.** The emitted JavaScript of a converted file behaves as the original did. Allowed edits: annotations, `?` on a parameter its callers omit, `as` casts, `interface`/`type`, `declare global`, a `<T>` on a helper. Not allowed: a changed condition, a new default, a reordered statement.
- **Real drift is reported, not cast away.** If the compiler shows the page calling something a host does not have, or with the wrong arguments, that is what this conversion is for: fix it when the fix is in the page and plainly right, and list it under `## Drift found` in the report either way.
- **Rename with `git mv`** so history follows the file. The compiled `.js` that replaces it is gitignored in the same commit.
- **Source-shape greps read the `.ts`; anything that executes or is served reads the compiled `.js`.** `tsc` reprints what it emits (re-indents, splits one-line `if`s, drops annotations), so a grep for how the *source* is written must read the source. A `vm.runInContext` of text lifted out of the page must read the compiled file, because annotated TypeScript is not JavaScript. Staged-output and URL checks read what shipped.
- **Style:** 2-space indent, single quotes, trailing commas, 100-column soft limit (`awk 'length > 100 {print FILENAME":"FNR}' <files>`; `npx prettier` does not work here). Comments say *why*, not what; match the density of the file you are in. No new dependency.
- **Shell:** the working directory resets between commands, so start each with `cd /tmp/claude-502/redlineapp-ts4-page`. Quote globs (zsh). `Grep` is unavailable; use `grep`/`git grep -F` through Bash. Never `git add -A`; add named files. Commit with `git commit -F - <<'EOF' … EOF` and end the message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **What cannot be verified here:** there is no browser. `npm test`, `tsc -b`, and the builds are what is available; say so, and do not claim the page was seen working.
- **Do not pipe `tsc` through `head`/`tail` and then read `$?`.** Redirect to a file and read the exit code of `tsc` itself.

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `tsconfig.page.json` | create | The `page` project: `public/*.ts`, `site/*.ts`, the shims; in-place emit |
| `tsconfig.json` | modify | Add the reference |
| `types/vendor/*.d.ts`, `types/vendor/mermaid/mermaid.esm.min.d.mts` | create | One shim per bundle the page imports |
| `public/backend.js` → `public/backend.ts` | rename + annotate | `createBackend(): Promise<PageBackend>`, `httpBackend(): Backend` |
| `site/landing.js` → `site/landing.ts` | rename + annotate | The landing page's script |
| `public/app.js` → `public/app.ts` | rename + annotate | The page |
| `scripts/stage-page.mts` | modify | Do not stage `*.ts` |
| `scripts/dev.mts` | modify | `tsc -b --watch`; restage on the emit, not the edit |
| `.github/workflows/pages.yml` | modify | Do not upload `site/*.ts` |
| `.gitignore` | modify | The three emitted files |
| `test-smoke.js` | modify | Shim, config, wiring and read-site assertions |
| `docs/typescript.md`, `docs/architecture.md`, `docs/building.md` | modify | Say what is now true |

---

### Task 1: The page project and the vendor shims

**Files:**
- Create: `tsconfig.page.json`
- Create: `types/vendor/render.d.ts`, `types/vendor/sanitize.d.ts`, `types/vendor/backend-tauri.d.ts`, `types/vendor/backend-web.d.ts`, `types/vendor/mermaid/mermaid.esm.min.d.mts`
- Modify: `tsconfig.json`
- Test: `test-smoke.js`

**Interfaces:**
- Produces: a `page` project that later tasks add `.ts` files to by dropping them in `public/` or `site/`; the shim modules `./vendor/render.js`, `./vendor/sanitize.js`, `./vendor/backend-tauri.js`, `./vendor/backend-web.js`, `./vendor/mermaid/mermaid.esm.min.mjs` as the page's compiler sees them.

Why each line of the config is there (the first one cost an hour to find in the spike): with `outDir: "."` and no explicit `exclude`, `tsc`'s default exclude covers `outDir`, which is the whole repository — **nothing compiles and `tsc` exits 0**. The explicit `exclude` is what makes the project do anything. `declarationDir` keeps the `.d.ts` that `composite` forces out of `public/` and `site/`. `rootDirs` is what makes `./vendor/render.js` resolve to `types/vendor/render.d.ts` under `NodeNext`.

- [ ] **Step 1: Write the project file**

Create `tsconfig.page.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "outDir": ".",
    "declarationDir": "out/page-types",
    "rootDirs": ["public", "types"],
    "tsBuildInfoFile": "out/tsconfig.page.tsbuildinfo"
  },
  "include": ["public/*.ts", "site/*.ts", "types"],
  "exclude": ["node_modules", "out"],
  "references": [{ "path": "./tsconfig.src.json" }]
}
```

Replace `tsconfig.json` with:

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.src.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.page.json" }
  ]
}
```

(Keep whatever layout the file has now if it already lists the other two on separate lines; only the third reference is new.)

- [ ] **Step 2: Write the shims**

Each is one line. `types/vendor/render.d.ts`:

```ts
export * from '../../src/core/document.js';
```

`types/vendor/sanitize.d.ts`:

```ts
export * from '../../src/page/sanitize.js';
```

`types/vendor/backend-tauri.d.ts`:

```ts
export * from '../../src/hosts/tauri/backend.js';
```

`types/vendor/backend-web.d.ts`:

```ts
export * from '../../src/hosts/web/backend.js';
```

`types/vendor/mermaid/mermaid.esm.min.d.mts`:

```ts
export { default } from 'mermaid';
```

Each of the four `export *` lines must name the same `src/` file as the `entry` that `scripts/build-web.mts` gives the bundle of that name (`BUNDLES`, around line 53). The `reader-worker.js` bundle has no shim: the page never imports it, the web backend starts it as a worker.

- [ ] **Step 3: Compile and confirm it compiles nothing, silently, correctly**

Run: `cd /tmp/claude-502/redlineapp-ts4-page && npx tsc -b; echo "exit $?"`
Expected: `exit 0`. Then `git status --short`: only `tsconfig.json`, `tsconfig.page.json` and `types/` are new or changed (no `public/*.js` or `site/*.js` changes, no `.d.ts` outside `out/`).

Run: `npx tsc -p tsconfig.page.json --listFilesOnly | grep -v node_modules | grep -c vendor`
Expected: 5 or more (the shims are in the program; if it prints 0 the `exclude` is missing and the project is empty).

- [ ] **Step 4: Write the assertions**

In `test-smoke.js`, directly after the line `console.log('✓ the contract is wired into every host, and can fail');`, add:

```js
// The page imports its bundles from ./vendor/, which exists only once build:web has run, so tsc
// cannot look there. types/vendor/ holds a shim for each, re-exporting the source the bundle is
// built from, and rootDirs in tsconfig.page.json is what makes `./vendor/render.js` find it. An
// entry in build-web's BUNDLES that changed while its shim did not would check the page against
// a module it no longer loads, and nothing else would say so.
{
  const text = (f) => fs.readFileSync(rootUrl(f), 'utf8');
  const bundles = [...text('scripts/build-web.mts').matchAll(/entry: '([^']+)', out: '([^']+)'/g)]
    .map(([, entry, out]) => ({ entry, out }));
  assert.ok(bundles.length >= 5, "the walk found build-web's bundles");
  // The one bundle the page does not import: the web backend starts it as a worker.
  const notImported = new Set(['reader-worker.js']);
  for (const { entry, out } of bundles.filter((b) => !notImported.has(b.out))) {
    const shim = text(`types/vendor/${out.replace(/\.js$/, '.d.ts')}`);
    assert.ok(
      shim.includes(`export * from '../../${entry.replace(/\.ts$/, '.js')}';`),
      `types/vendor/${out.replace(/\.js$/, '.d.ts')} re-exports ${entry}`,
    );
  }
  assert.ok(
    /export \{ default \} from 'mermaid';/.test(text('types/vendor/mermaid/mermaid.esm.min.d.mts')),
    'and mermaid, which is not built here, has its own',
  );

  // The config is JSON, so its reasons are in docs/typescript.md and these are the lines that
  // would silently stop working: no exclude and `tsc` compiles nothing and exits 0.
  const page = JSON.parse(text('tsconfig.page.json'));
  assert.deepStrictEqual(page.exclude, ['node_modules', 'out'],
    'the page project names its own exclude: outDir "." makes the default exclude the repository');
  assert.strictEqual(page.compilerOptions.outDir, '.', 'it emits beside its sources');
  assert.strictEqual(page.compilerOptions.declarationDir, 'out/page-types',
    'and keeps the .d.ts that composite forces out of public/ and site/');
  assert.deepStrictEqual(page.compilerOptions.rootDirs, ['public', 'types'],
    'rootDirs is what resolves ./vendor/*.js to the shims');
  assert.ok(
    JSON.parse(text('tsconfig.json')).references.some((r) => r.path === './tsconfig.page.json'),
    'tsc -b builds it',
  );
}
console.log('✓ the page project has its shims, and each names the bundle it stands for');
```

- [ ] **Step 5: Run the suite**

Run (sandbox off): `cd /tmp/claude-502/redlineapp-ts4-page && npm test`
Expected: exit 0, "all smoke tests passed", and the new `✓` line is printed.

- [ ] **Step 6: Make the assertion able to fail**

Temporarily change `types/vendor/render.d.ts` to name `core/diff.js`, run `npm run build:ts && node out/test-smoke.js 2>&1 | grep -m1 "re-exports"`; the assertion must name `render.d.ts`. Restore the file (`git checkout types/vendor/render.d.ts` is not possible, it is untracked: write the original line back) and confirm `git diff --stat` shows nothing unexpected.

- [ ] **Step 7: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git add tsconfig.page.json tsconfig.json types test-smoke.js
git commit -F - <<'EOF'
Add the page project and the vendor shims it compiles against

The page imports its bundles from ./vendor/, which does not exist until build:web has
run. A shim per bundle in types/vendor/ re-exports the module the bundle is built from,
and rootDirs resolves the page's imports to them. No page file is converted yet.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: `public/backend.ts`, the staging filter, and what the page may call

**Files:**
- Rename: `public/backend.js` → `public/backend.ts`
- Modify: `scripts/stage-page.mts` (the `cpSync` filter, around line 240)
- Modify: `.gitignore`
- Modify: `test-smoke.js` (read sites at about lines 3258, 5247, 5402; the contract list at about line 555; a new in-place-emit assertion)

**Interfaces:**
- Consumes: Task 1's page project and shims. `Backend` from `src/contract/seam.ts`; `WebBackend` (exported from `src/hosts/web/backend.ts`, reached through the `./vendor/backend-web.js` shim).
- Produces: `export type PageBackend`, and `export async function createBackend({ docId }): Promise<PageBackend>` — Task 4's `app.ts` consumes `PageBackend`'s members: the contract's, plus the web app's optional `openFiles`, `welcome`, `onNeedsPermission`, `linkNote`, `reopen`, `addRoot`, `addDrop`, `close`.

The decision this task carries. `createBackend` returns whichever backend the page is running in, and the page uses four of the web app's extras behind a presence check (`backend.welcome?.(…)`). Today its inferred return type is an untyped union, so `backend.welcome` is an error on it. The contract's `Backend` cannot grow those members (the contract imports nothing from a host), so the page declares:

```ts
export type PageBackend = Backend & Partial<Omit<WebBackend, keyof Backend>>;
```

This names no web-only member, which matters: `test-smoke.js` (the "only the web backend has a welcome" assertion, about line 5400) refuses the words `welcome` and `linkNote` anywhere in `public/backend.ts`.

- [ ] **Step 1: Rename and make the staging filter ship only the compiled file**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git mv public/backend.js public/backend.ts
```

In `scripts/stage-page.mts`, the copy of `public/` currently filters by name only. Replace the filter so it also skips every `.ts`:

```ts
  fs.cpSync(path.join(ROOT, 'public'), out, {
    recursive: true,
    // The page's sources sit beside what they compile to; only the compiled file ships.
    filter: (src) => !others.has(path.basename(src)) && !src.endsWith('.ts'),
  });
```

Without it `backend.ts` and, later, `app.ts` land in `shell/dist` and `dist/web`. The existing test "the page and nothing else sits at the top" (search `pageFiles` in `test-smoke.js`) is what catches it.

Add to `.gitignore`, under the existing `public/vendor/` block:

```
# Compiled beside their sources by tsconfig.page.json, because the URLs the page is loaded by
# (backend.js, app.js, landing.js) are those names. public/host.js is hand-written and tracked.
public/backend.js
```

- [ ] **Step 2: Type the file**

In `public/backend.ts`:

- `import type { Backend } from '../src/contract/seam.js';` and `import type { WebBackend } from './vendor/backend-web.js';` at the top (type-only, so nothing is emitted and `./vendor/backend-web.js` is still reached only by the existing dynamic `import()`).
- Add and export `PageBackend` exactly as above, with a comment saying why it is built with `Omit<WebBackend, keyof Backend>`: *the contract names what every host has; what only a browser tab has is a presence check in the page, so it is optional here and the grep that keeps the page ignorant of those names has nothing to find.*
- `createBackend({ docId }: { docId: () => string | null }): Promise<PageBackend>` and `httpBackend({ docId }: { docId: () => string | null }): Backend`. Match the `docId` parameter type to what `createTauriBackend` and `createWebBackend` take (see `src/hosts/tauri/backend.ts`); if they differ, the difference is drift: report it.
- Annotate the helpers until `tsc` is quiet. The known errors from the spike: `url(path, params = {})` and `json(res)` need parameter types; `get`/`post` need `params?` and `body?` (their callers omit them, and an un-annotated JS parameter was implicitly optional while a `.ts` one is required); and `ack`'s destructured parameter gets its type from `httpBackend` returning `Backend`, so leave it un-annotated and let the contextual type reach it.
- Leave `watch`'s `timer`, `stream` typing to the compiler unless it complains.

- [ ] **Step 3: Compile**

Run: `cd /tmp/claude-502/redlineapp-ts4-page && npx tsc -b > /tmp/claude-502/t2-tsc.log 2>&1; echo "exit $?"; cat /tmp/claude-502/t2-tsc.log`
Expected: `exit 0` and an empty log. `public/backend.js` now exists (emitted, ignored by git: `git status --short` shows the rename and `.gitignore`, not a new `public/backend.js`).

- [ ] **Step 4: Switch the read sites in `test-smoke.js`**

Three greps read `./public/backend.js` for how the *source* is written; they now read the `.ts`:

- about line 3258, the list `['./public/backend.js', /markRead: \(at\) => post\('\/api\/mark-read', \{ at \}\),/]` → `./public/backend.ts`;
- about line 5247, `const pageBackend = read('./public/backend.js');` → `./public/backend.ts`;
- about line 5402, the `.every` list `['./src/hosts/tauri/backend.ts', './public/backend.js', './src/rpc/client.ts']` → `./public/backend.ts`.

**Leave about line 3283 alone:** `await import(rootUrl('public/backend.js').href)` loads the module to *run* it, so it must be the compiled file.

Then add the page's backend to the contract list at about line 555, with the others:

```js
  ['public/backend.ts', /\): Promise<PageBackend>/],
  ['public/backend.ts', /\): Backend\b/],
```

and add, directly after the Task 1 block (the one ending `✓ the page project has its shims…`), a check that compiled output exists beside every page source. It is what notices the silent-exclude failure, which compiles nothing and exits 0:

```js
// A page source with no compiled sibling means the page project compiled nothing, which is a
// thing tsc will do without a word (see docs/typescript.md). `pretest` runs the compile, so
// the sibling is there whenever the project works.
for (const dir of ['public', 'site']) {
  for (const f of fs.readdirSync(fileURLToPath(rootUrl(`${dir}/`))).filter((n) => n.endsWith('.ts'))) {
    assert.ok(
      fs.existsSync(fileURLToPath(rootUrl(`${dir}/${f.replace(/\.ts$/, '.js')}`))),
      `${dir}/${f} has been compiled in place`,
    );
  }
}
```

The assertion that holds the three generated files out of git is written in Task 4, where all three exist; do **not** add it now.

- [ ] **Step 5: Run the suite**

Run (sandbox off): `npm test`
Expected: exit 0. In particular "the page and nothing else sits at the top" passes (it fails if the filter is missing: confirm once by reverting the `.endsWith('.ts')` clause, running only `npm run build:ts && node out/test-smoke.js 2>&1 | grep -m1 "page and nothing"`, then restoring it).

- [ ] **Step 6: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git add public/backend.ts scripts/stage-page.mts .gitignore test-smoke.js
git commit -F - <<'EOF'
Convert public/backend.js to TypeScript

httpBackend is held to the contract's Backend. createBackend answers a PageBackend: the
contract plus the web app's optional extras, built with Omit so the page seam still names
none of them. stage-page no longer ships .ts, since the page's sources now sit beside what
they compile to.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

(`git status` must show `public/backend.js` as a rename into `.ts`, and no untracked `public/backend.js`.)

---

### Task 3: `site/landing.ts`, and keeping it out of the deploy

**Files:**
- Rename: `site/landing.js` → `site/landing.ts`
- Modify: `.gitignore`, `.github/workflows/pages.yml`, `test-smoke.js` (about line 6743, and the existing upload assertion at about line 6972)

**Interfaces:**
- Consumes: Task 1's project (it already includes `site/*.ts`) and Task 2's `.gitignore` block.
- Produces: nothing a later task uses.

`site/index.html` loads it as `<script type="module" src="landing.js">`, so the `export {};` that `tsc` appends to a file with no import or export is harmless here. (It would not be for the classic script `public/host.js`, which is why that stays JavaScript.)

- [ ] **Step 1: Rename, ignore, compile**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git mv site/landing.js site/landing.ts
```

Add `site/landing.js` to the `.gitignore` block from Task 2.

The spike's 18 errors in this file are all DOM narrowing: `dataset`, `style`, `offsetHeight`, `offsetTop` read off an `Element` (13 of the 18 — `querySelector`/`closest` answer `Element`; give the call the element type it is: `querySelector<HTMLElement>(…)`, `closest<HTMLElement>(…)`, or an `as HTMLElement`), one `string | number` handed to a parameter that wants `number` (about line 171: say which it is), and one call with one argument too few (about line 248: mark the parameter optional). Fix them with annotations and casts only.

Run: `npx tsc -b > /tmp/claude-502/t3-tsc.log 2>&1; echo "exit $?"; cat /tmp/claude-502/t3-tsc.log`
Expected: `exit 0`, empty log.

- [ ] **Step 2: Do not deploy the source**

`pages.yml` uploads the directory `site` and the deploy job publishes whatever is in it, so `landing.ts` would go to Cloudflare beside `landing.js`. The file has two `path: site` lines (about 66 and 89). **Change only the first**, the `actions/upload-artifact` step of the `build` job; the `deploy` job's `actions/download-artifact` into `site` stays exactly as it is. The upload step reads `path: site`; change it to:

```yaml
          path: |
            site
            !site/*.ts
```

keeping the surrounding indentation and the comment above the step. Add one sentence to that comment: *the page's TypeScript sits beside what it compiled to, and only the compiled file is the page.* This cannot be exercised here (no CI); say so in the report.

- [ ] **Step 3: The assertions**

- about line 6743: `const siteJs = fs.readFileSync(rootUrl('site/landing.js'), 'utf8');` → `site/landing.ts` (the next assertions grep how the source reads the theme).
- **Update the existing assertion** at about line 6972 (inside the block that reads `buildJob`), which today matches the upload step literally and would fail on the new form. Change its pattern and message, and add no second assertion beside it:

```js
  assert.match(
    buildJob,
    /name: redline-site\n\s+path: \|\n\s+site\n\s+!site\/\*\.ts\n\s+if-no-files-found: error/,
    'site/ without the TypeScript beside its compiled script, or nothing',
  );
```

  The assertion on `deployJob` just below it (`name: redline-site\n\s+path: site`, the download) must still pass untouched: that is the check that you changed the right `path: site`.

- [ ] **Step 4: Run the suite**

Run (sandbox off): `npm test`. Expected: exit 0. Then `git status --short`: a rename, `.gitignore`, `pages.yml`, `test-smoke.js`; no untracked `site/landing.js`.

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git add site/landing.ts .gitignore .github/workflows/pages.yml test-smoke.js
git commit -F - <<'EOF'
Convert site/landing.js to TypeScript

The compiled script is emitted beside the source and ignored, and pages.yml uploads the
site without its .ts, so the deploy carries the page and not its sources.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `public/app.ts`

**Files:**
- Rename: `public/app.js` → `public/app.ts`
- Modify: `.gitignore`, `test-smoke.js` (read sites at about lines 324, 758; the executed extractions at about lines 1076–1082 and 1646; any grep that an annotation breaks)

**Interfaces:**
- Consumes: Task 2's `PageBackend` (the type of `backend`, through `createBackend`'s return). The five shims from Task 1. `window.mdNative` is declared in `src/hosts/tauri/native.ts` (see `docs/typescript.md`, "`declare global`"), which the page does not import.
- Produces: `public/app.js`, compiled in place, which the server serves and `stage-page` stages.

This is the large one: 3,475 lines, **74 errors from the spike's rename-only run**, and they come in a few kinds:

| Kind | Count | The answer |
| --- | --- | --- |
| TS2339 DOM narrowing: `.dataset`, `.title`, `.focus`, `.value`, `.checked`, `.disabled`, `.open`, `.showModal`, `.close`, `.select`, `.media` read off `Element`/`HTMLElement`; `.closest`/`.tagName`/`.value` read off `EventTarget` | ~45 | Type `$` and cast at the use. See below. |
| TS2554 "Expected N arguments": an un-annotated JS parameter was implicitly optional, a `.ts` one is required | 20 | `?` on the parameter its callers omit. No default values. |
| TS2339 web-only capability (`openFiles`, `welcome`, `onNeedsPermission`, `linkNote`) | 4 | Gone once `backend` is a `PageBackend`. |
| One-offs: `window.mdNative` (2869), `(value: unknown) => void` not assignable to `() => void` (2878), `string \| number` to a `number`/unit (1488, 2017), `.filter` on `string \| string[]` (3051), the `_nodes` expando on an `Element` (2240), an overload mismatch (2016), `.read`/`.write` off a union (427, 432) | ~10 | Judgement; each gets the smallest annotation that says what is true. |

Line numbers are the spike's and shift once you edit.

**The `$` helper.** `const $ = (id) => document.getElementById(id);` answers `HTMLElement | null`. Make it generic and cast at the one place it is wrong, so call sites say what element they expect:

```ts
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
```

and write `$<HTMLInputElement>('font')`, `$<HTMLDialogElement>('prefs')`, and so on. Leave `$('doc')` alone where it is used as a plain `HTMLElement`.

**`e.target`.** `e.target.closest(…)` becomes `(e.target as Element).closest(…)` (or `as HTMLElement`, `as HTMLInputElement` for `.value`/`.checked`). That is a textual change, and a test greps the *source* for the old shape (about line 1090: `goToChange\(e\.shiftKey \? -1 : 1, e\.target\.closest\('\[data-kind\]'\)\?\.dataset\.kind\)`). Update such a regex **minimally**, to accept the cast and nothing more: it is the assertion that the wiring exists, and the cast is not what it is about.

**Keep the point of the `innerHTML` allow-list.** The test at about line 332 lists the left-hand side of every `.innerHTML =` in the page (`/([\w$]+)(?:\([^)]*\))?\.innerHTML =/`) and asserts each goes through `sanitizeDocument`/`sanitizeSvg`: it is the check that nothing reaches the DOM unsanitised. A cast in front of one (`($('x') as HTMLElement).innerHTML = …`) changes what that regex captures. Fix it so the assertion still sees **every** assignment, and does not quietly see fewer: if the capture list gets shorter, you widened a hole, not tidied a test. Better to write the cast on a line of its own (`const el = $<HTMLElement>('x'); el.innerHTML = …`) when the regex would otherwise need to loosen.

**`window.mdNative`.** Prefer typing it from its real definition, because that makes the page's calls on it checked against what `native.ts` provides, which is the point. If `native.ts` exports the type (or can export one with an `export type`), `import type` it and `declare global { interface Window { mdNative?: … } }` in `app.ts`. If `src/hosts/tauri/native.ts` already declares `Window.mdNative` globally but the page program cannot see it, say so in the report and choose between the import and a page-local declaration; do not cast to `any`. Anything the typed surface then rejects is probably drift: see Global Constraints.

- [ ] **Step 1: Rename, ignore, see the errors**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git mv public/app.js public/app.ts
```

Add `public/app.js` to the `.gitignore` block. Then:

Run: `npx tsc -b > /tmp/claude-502/t4-tsc.log 2>&1; echo "exit $?"; grep -c "error TS" /tmp/claude-502/t4-tsc.log`
Expected: non-zero exit and **about 74** errors, all in `public/app.ts`. A very different number means the page project is not seeing the shims (the first suspect is `rootDirs`) or `backend.ts` regressed; stop and say so.

- [ ] **Step 2: Fix to zero**

Work through the log until `tsc -b` exits 0, by the table above. Rules while you do:

- Keep the file's shape: do not reorder, do not split a statement, do not rename. Annotations go on the existing lines.
- `import type { PageBackend } from './backend.js'` only if an annotation needs to name it; the type already flows from `createBackend`.
- A function that the tests lift out of this file and run in a `vm` (`stepIndex`, `goToChange`, `changeNodes`, `changeKind`, `continuesRun`, `LANDING_MS`, `applyScheme`) may be annotated freely: Step 3 makes the tests read the compiled file for them.
- Add a short *why* comment at any cast that is not obvious (`// the id is in index.html and is an <input>`), not at every `$<…>`.

Run: `npx tsc -b > /tmp/claude-502/t4-tsc.log 2>&1; echo "exit $?"; cat /tmp/claude-502/t4-tsc.log`
Expected: `exit 0`, empty log.

- [ ] **Step 3: Read sites in `test-smoke.js`**

1. About line 324: `const appJs = fs.readFileSync(rootUrl('public/app.js'), 'utf8');` → `public/app.ts`.
2. About line 758: the `Promise.all` that fetches `/`, `/styles.css` **and `/app.js`**. The greps that follow assert how the *source* is written, so `pageJs` must be the source. Take `/app.js` out of the fetch and read the source:

```js
const [pageHtml, pageCss] = await Promise.all(
  ['/', '/styles.css'].map(async (p) => (await fetch(base + p)).text()),
);
const pageJs = fs.readFileSync(rootUrl('public/app.ts'), 'utf8');
```

   Check the two assertions at about lines 762–780 that loop over `['index.html', pageHtml], ['app.js', pageJs]` (no absolute URLs; the page loads from any base URL): they are about what is served, so give them the **compiled** text — `const pageServed = fs.readFileSync(rootUrl('public/app.js'), 'utf8')` — and keep their wording.
3. **Executed extractions read the compiled file.** The helpers `fn` and `konst` (about lines 1111–1115, in the block that starts "Stepping through the changes") and `applySchemeSrc` (about line 1646) lift function text out of `pageJs` and run it with `vm.runInContext` (at about 1116, 1204 and 1659). The helper text is what to repoint; the `vm.runInContext` calls need no edit. Annotated TypeScript is not JavaScript, so they must read `public/app.js`. Introduce `const pageRun = fs.readFileSync(rootUrl('public/app.js'), 'utf8');` just above the first of them, with a comment saying why, and point `fn`, `konst` and `applySchemeSrc` at it. `tsc` keeps a top-level `function f() {…}` closing at column 0, so their regexes should still match; if one does not, fix the regex, not the page.
4. Run the suite and fix what an annotation changed: a grep for source shape whose text moved (`(e: MouseEvent) =>` for `(e) =>`, a cast in the middle of a chain). Update the regex minimally; if the failing assertion is about something the annotation did not change, you broke the page: look at your diff.
5. Add the last of the three-file assertion that Task 2 deferred, next to the "compiled in place" one:

```js
// The three are compiled beside their sources and must never be committed: a tracked copy would
// go stale against its .ts and look exactly like the change not working.
const ignored = fs.readFileSync(rootUrl('.gitignore'), 'utf8').split('\n');
for (const f of ['public/app.js', 'public/backend.js', 'site/landing.js']) {
  assert.ok(ignored.includes(f), `${f} is generated, and gitignored`);
}
```

- [ ] **Step 4: Run the suite**

Run (sandbox off): `npm test`. Expected: exit 0. Then `git status --short`: a rename `public/app.js -> public/app.ts`, `.gitignore`, `test-smoke.js`; no untracked `public/app.js`.

Check formatting: `awk 'length > 100 {print FILENAME":"FNR}' public/app.ts test-smoke.js`. `public/app.ts` was at 674 before (the known offender, now shifted); anything new is yours to wrap.

- [ ] **Step 5: Report**

Write the report. Under `## Drift found`, list every error that turned out to be the page disagreeing with a host (the usual suspects: `mdNative` members, a `backend` method called with a different shape, an optional capability used with no check), even those you fixed. Under `## Judgement calls`, the one-offs from the table and what you chose.

- [ ] **Step 6: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git add public/app.ts .gitignore test-smoke.js
git commit -F - <<'EOF'
Convert public/app.js to TypeScript

74 errors from the rename, nearly all of them the DOM not knowing which element an id is:
$ is generic and names the element where it is used, a parameter its callers omit is
marked optional, and window.mdNative is typed from the Tauri host. The tests that run
functions lifted out of the page read the compiled file, since annotated source is not
JavaScript; the greps for how the source is written read the .ts.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: `npm run dev` compiles the page as you edit it

**Files:**
- Modify: `scripts/dev.mts`
- Test: `test-smoke.js` (beside the existing `dev.mts` assertions, about line 6490)

**Interfaces:**
- Consumes: the page project (Tasks 1–4), which `npm run dev` already compiles once through `npm run build:ts`.
- Produces: nothing a later task uses.

The window loads `shell/dist`, which `stage-page` fills from `public/app.js`, which `tsc` now writes. An edit to `public/app.ts` therefore needs a compile before the restage is worth anything. `tsc -b --watch` is that compile, and the existing `fs.watch` on `public/` sees what it emits. Two consequences are the reason for the rest of the change: a restage on the *edit* would stage the previous compile and then again on the emit, so `.ts` events under `public/` are ignored; and `tsc` emits through type errors (`noEmitOnError` is off, and since TS 5.6 `tsc -b` does too), so a mistake is a message in this terminal and not a window that stopped updating.

- [ ] **Step 1: Start the watch beside the app**

In `scripts/dev.mts`, after `const tauri = spawn(…)` and before `if (watching) {`, add:

```ts
// The page is TypeScript and what the window loads is what tsc emits beside it, so something
// has to be compiling it. The watch below sees the emit land in public/, which is why it skips
// a `.ts` there: restaging on the edit would stage the previous compile, and then again on the
// emit. tsc emits through type errors, so a mistake is a message in this terminal and the
// window still updates.
const tsc: ChildProcess | null = watching
  ? spawn('npx', ['tsc', '-b', '--watch', '--preserveWatchOutput'], { cwd: ROOT, stdio: 'inherit' })
  : null;
```

Import the type: change `import { spawn, spawnSync } from 'node:child_process';` to `import { spawn, spawnSync } from 'node:child_process';` plus `import type { ChildProcess } from 'node:child_process';` on the next line.

- [ ] **Step 2: Restage on the emit, not on the edit**

In `changed`, extend the ignore for `public/`:

```ts
    // public/vendor/ is what build:web just wrote, not something anyone edits, and a `.ts` is
    // the source of what tsc is about to emit next to it.
    if (!src && file && (file.startsWith(`vendor${path.sep}`) || file.endsWith('.ts'))) return;
```

(keep the existing comment's second sentence about restaging twice, and put the new reason after it).

- [ ] **Step 3: Stop it with everything else**

`tauri.on('exit', () => watchers.forEach((w) => w.close()));` gets `tsc?.kill();` added to its body, and the signal forward gets `tsc?.kill(sig);` beside `tauri.kill(sig);`, and `tsc?.kill('SIGKILL');` beside the `tauri.kill('SIGKILL')` in the timeout. Update the banner line `watching public/ and src/ — ⌘R in the window picks up a restage` to say it also compiles the page: `watching public/ and src/, compiling the page — ⌘R in the window picks up a restage`. Update the comment at the top of the file where it describes the watch ("a watch on public/ and src/ that re-runs the two build steps") with one sentence for `tsc -b --watch`.

- [ ] **Step 4: Compile and check it can compile**

Run: `npx tsc -b > /tmp/claude-502/t5-tsc.log 2>&1; echo "exit $?"; cat /tmp/claude-502/t5-tsc.log`. Expected `exit 0`.

Check the claim the comment makes, once, and leave nothing behind: write a file `public/probe.ts` containing `export const x: number = 'a';`, run `npx tsc -b; echo "exit $?"` (expect non-zero, one error naming `probe.ts`), then `ls public/probe.js` (expect it to exist: tsc emitted through the error), then `rm public/probe.ts public/probe.js` and `rm -r out/page-types/probe.d.ts`. Report what you saw. If `probe.js` does **not** exist, the comment is wrong: say so instead of editing the comment to match what you hoped.

- [ ] **Step 5: The assertions**

Beside the existing `devJs` assertions:

```js
assert.ok(
  /spawn\('npx', \['tsc', '-b', '--watch'/.test(devJs),
  'npm run dev compiles the page as you edit it',
);
assert.ok(
  /file\.endsWith\('\.ts'\)/.test(devJs),
  'and restages on what tsc emitted, not on the edit that caused it',
);
assert.ok(/tsc\?\.kill\(sig\)/.test(devJs), 'and takes the compiler down with the window');
```

- [ ] **Step 6: Run the suite, commit**

Run (sandbox off): `npm test`. Expected exit 0.

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git add scripts/dev.mts test-smoke.js
git commit -F - <<'EOF'
Compile the page while npm run dev is watching it

tsc -b --watch runs beside the window, and the restage follows its emit rather than the
edit to the .ts, which would stage the compile before.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: The docs, and the whole-branch check

**Files:**
- Modify: `docs/typescript.md`, `docs/architecture.md`, `docs/building.md`; and any other `docs/*.md` that names `app.js`, `backend.js` or `landing.js` as a *source* file (`grep -n "app\.js\|backend\.js\|landing\.js" docs/*.md`).

**Interfaces:**
- Consumes: everything above.
- Produces: docs that say what is now true. A stale `docs/` is worse than none.

- [ ] **Step 1: `docs/typescript.md`**

Say, in the file's own voice and at the places it now contradicts:

- The opening: step 4 landed, so the page is TypeScript and **`test-smoke.js` is the only JavaScript left that is compiled** (plus `src/hosts/web/host.js` and `public/host.js`, classic scripts that stay JS).
- The "Two homes" table: the page row is no longer "not yet compiled". It is compiled **in place**, gitignored, to `public/app.js`, `public/backend.js`, `site/landing.js`, and why (the server, `stage-page.mts`, the `?v=` rewrite and the tests name those paths).
- "The projects": add the `page` row (`public/*.ts`, `site/*.ts`, the shims; DOM lib, no node types) and drop "arrives with step 4".
- "Not under it yet" (the contract section): `public/backend.ts` is under it now — `httpBackend` is held to `Backend`, `createBackend` answers a `PageBackend` (the contract plus `Partial<Omit<WebBackend, keyof Backend>>`), and add the two new rows to the held-to table.
- A new section, **The page project**, covering: in-place emit and why; **the `exclude` gotcha** (`outDir: "."` with no explicit `exclude` makes `tsc` default-exclude the whole repository, compile nothing and exit 0); `declarationDir`; `rootDirs` and the shims in `types/vendor/` (what each stands for, that a test holds each to `BUNDLES`, and that the worker bundle has none because the page does not import it); the `.ts` filter in `stage-page`; `pages.yml` excluding `site/*.ts` from the artifact (and that it is untested here); and the **read rule**: greps on source shape read the `.ts`; anything executed in a `vm` or served reads the compiled `.js`, because `tsc` reprints.
- "What the conversion needed": a step 4 paragraph with the spike's numbers — 101 errors in three files (74 `app`, 18 `landing`, 9 `backend`), by code (70 TS2339, 20 TS2554, 5 TS2345, and a few one-offs) — and what they were: the DOM not knowing which element an id is, parameters the callers omit, and four capabilities only the web app has. Include what Task 4 found as drift, from its report.
- "Two things that look like bugs": add the in-place-emit one — a stale `public/app.js` after pulling a rename is not the change failing; run `npm run build:ts`.
- The ladder: step 4 done.
- "What `tsc -b` costs": add a Step 4 column. Measure it, don't estimate: `cd /tmp/claude-502/redlineapp-ts4-page && time npx tsc -b --force`, then `time npx tsc -b` and `time npm run build:ts` on an up-to-date tree, each three times, report the middle one, rounded as the existing cells are.

- [ ] **Step 2: `docs/architecture.md` and `docs/building.md`**

For each mention of `app.js`, `backend.js` or `landing.js` decide whether it means the **source** (now `app.ts`, `backend.ts`, `landing.ts`) or the **shipped file** (still `app.js`): the served and staged names stay. Change the source ones. `docs/building.md` also needs:

- the stale row in the dev-loop table (about line 206): `npm start` is **not** "no compile at all" — `prestart` runs `build:web`, which runs `build:ts` first, and has since step 1;
- the dev loop: `npm run dev` also runs `tsc -b --watch` and restages on its emit;
- the "app embeds its copy of the page" section: add that the copy is the **compiled** page, so `build:ts` is a step before `build:web` and `build:dist` (which the npm scripts already do).

- [ ] **Step 3: Verify the docs against the tree**

For every concrete claim you wrote (a path, a flag, a count), grep the tree for it. Check line length: `awk 'length > 100 {print FILENAME":"FNR}' docs/typescript.md docs/architecture.md docs/building.md` (the existing files may have older offenders; do not add new ones).

- [ ] **Step 4: Whole-branch check**

Run from a clean `out/` so the existence checks mean something (`out/` is gitignored; removing it loses nothing but compile time):

```bash
cd /tmp/claude-502/redlineapp-ts4-page
rm -r out
npm run build:ts > /tmp/claude-502/t6-build.log 2>&1; echo "build exit $?"
```
Expected: `build exit 0`. Then (sandbox off) `npm test` — exit 0 — and `CARGO_NET_OFFLINE=true npm run bundle` (sandbox off) — exit 0, producing `dist/Redline.app` and the dmg. Report the numbers `bundle` prints.

Then `git status --short` must show no untracked `public/*.js` or `site/*.js`, and `git ls-files public site | grep '\.js$'` must list only `public/host.js` (a tracked hand-written classic script).

- [ ] **Step 5: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts4-page
git add docs
git commit -F - <<'EOF'
Document the page project

In-place emit and the exclude it needs, the vendor shims, what stage-page and pages.yml
leave out, and which tests read the source and which read what was compiled.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

## Self-Review

**Spec coverage.** Page project with in-place emit: Task 1. `types/vendor` shims resolved via `rootDirs`, each held to `BUNDLES`: Task 1. `backend.ts` under the contract: Task 2. `landing.ts` and the site deploy: Task 3. `app.ts`: Task 4. `tsc -b --watch` in `dev.mts`: Task 5. Docs in the same PR: Task 6. Not in this step by the spec: `test-smoke.ts` (step 5) and the ratchet (step 6).

**Placeholder scan.** The config, shims, filter, `dev.mts` change and the test blocks are given in full. Task 4's fixes are specified by kind with the spike's counts and sites because the exact edit is a per-line decision on a 3,475-line file; its acceptance test is `tsc -b` exiting 0 on an empty log and the suite passing, and its report must list the drift found.

**Consistency.** `PageBackend` is defined in Task 2 and consumed in Task 4. The test read-site list: `backend.ts` sites in Task 2 (3258, 5247, 5402), `landing.ts` in Task 3 (6743), `app.ts` in Task 4 (324, 758, and the executed extractions at 1076–1082 and 1646). The `.gitignore` block grows in Tasks 2, 3 and 4, and the assertion that lists all three is written in Task 4, once they exist.

**Known unknowns.** `pages.yml`'s artifact negation and the `tsc --watch` behaviour under `tauri dev` cannot be exercised from here (no CI, no window); Task 3 and Task 5 say so, and Task 5 checks the one fact that can be: that `tsc -b` emits through an error.
