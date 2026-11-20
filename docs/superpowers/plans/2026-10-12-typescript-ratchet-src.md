# TypeScript Ratchet, `src` + `noImplicitAny` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `noImplicitAny` on for the `src` project (`tsconfig.src.json`) and annotate the 196 places it reports, with no change to what `src` emits, and make a test hold the flag on.

**Architecture:** Annotation only. `tsc` erases types, so the compiled `out/src/**/*.js` must be what it was before, and a diff of the two is the proof. Work goes bottom-up through the project (leaf `core/` modules, `render`, then `diff`/`inline-diff`, then `reader/` and the web host) so each file is typed against callees that already are. The flag itself is switched on in the last task, once the project reports zero, with the floor assertion and the docs. The per-task check is the CLI flag (`--noImplicitAny`), not the config, so every commit builds.

**Tech Stack:** TypeScript 5.9 (`tsc -b`, composite projects), Node ESM, the repo's own `test-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` (§2 the ratchet: one project at a time, `noImplicitAny` then `strictNullChecks` then `strict`, and "a test asserts a floor"). It is untracked and lives in the main checkout at `/Users/chau.vinh.tuan/ws/me/redlineapp/docs/superpowers/specs/`; read it from there.

## Global Constraints

- **Annotation only.** No runtime change: no new statement, no renamed binding, no moved `let`, no changed default, no added check, no `?.` or `!` that was not there (`!` and `as` erase, but a new `?.` does not). The proof is the emit diff (below).
- **Emit gate, every task:** `sh /tmp/claude-502/ts6/gate.sh <file-prefix>...` from the worktree root. It must print `0` for the task's files under `--noImplicitAny`, nothing under "not a TS70xx code", `tsc -b` `ok`, and the emit diff `identical`, or differing only in where a comment sits (read `/tmp/claude-502/ts6/gate-emit.diff`; any hunk that is code is a defect). The `.d.ts` files are not part of the diff: they change on purpose, as the types get more precise.
- **`tsc -b` must pass at every commit.** The node and page projects consume `src`'s `.d.ts`, so a more precise parameter can turn a call in `test-smoke.ts`, `hosts/node/`, `public/*.ts` or `bin/` into a real error. That is the ratchet working. Never loosen the annotation to hide it (see Findings).
- **The `any` policy.** In order of preference: (1) an existing named type (`Block`, `Heading`, `RenderEnv`, `Checked`, `FrontRow`, `FrontValue`, `Paths`, `Git`, `Platform`, `DocPayload`, `Caps`, `HistoryRow`, `ReaderEvent`, `WireError`, `OpenFile`, `Backend`, `Session`, the DOM lib types, `markdown-it`'s `MarkdownIt`, `Token`, `StateCore`, ...), found by grepping `src/` before inventing one; (2) a small local `interface` or `type` that says what the code actually uses of the value, declared where it is used, with a one-line why when it is not obvious (the web host's window and file-system-handle types are this: `lib.dom` does not have `showOpenFilePicker`); (3) `unknown`, where the value is only passed along, never read; (4) an explicit `any`, only for a value that is untyped by nature (JSON off the wire, a foreign API with no declaration), and then with a comment that says why. A task reports how many explicit `any`s it added and where. There are 10 matches of `: any|as any|any[]` in `src/` today, one of them in a comment; the count may go down and a new one needs its comment.
- **Casts.** An `as T` only where the code already guarantees what the type says and `tsc` cannot see it, with a one-line why. Never `as unknown as` in `src/`. Report every cast added.
- **No suppression comments.** No `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck`, anywhere. `src/`, `public/`, `site/`, `scripts/` and `bin/` have none today.
- **Findings, not fixes.** A type that comes out different from what the code does is a real defect the conversion found, and the report says so with `file:line`. Fix it only when the fix is a type (a generic, a union, an optional marker) and the emit stays identical. If fixing it would change behaviour, make the narrowest type-only accommodation that compiles, comment why, and report it as a Finding for the controller to rule on. Do not change behaviour in this PR.
- **Style.** 2-space indent, single quotes, trailing commas, 100-column soft limit (`awk 'length > 100 {print FILENAME":"FNR}' <files>` must name no line you touched; `public/app.js:674` and one other line elsewhere are pre-existing offenders in files this plan does not touch). Comments say why, not what, and match the density of the file; an annotation does not need a comment, a cast or a deliberate `unknown` does. Do not reformat lines you are not changing.
- **No new dependency.** No `@types/*` package. The one missing declaration (`markdown-it-task-lists`) is a shim in the repo.
- **Spec §4 read rule.** A source-shape grep or assertion reads the `.ts`; anything that is executed, served or shipped is the compiled `.js` under `out/`.
- **Commits.** One per task, `git add` the named files only, message `Type src/...: noImplicitAny` shaped, ending with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Branch is `typescript-ratchet-src`; never push, never touch another branch or worktree.
- **The suite needs the sandbox off.** `npm test` binds `127.0.0.1`; run it with `dangerouslyDisableSandbox: true`. Nothing else here needs it.
- **Delete nothing outside your own scratch.** Keep scratch in `/tmp/claude-502/ts6/`. Use copy-aside and copy-back, not `git checkout -- file`, to undo your own experiment.

## Typing catalogue

Most of the 196 are one shape. The fix for each is a type, and the first of the three below covers about 150 of them (TS7006, "parameter implicitly has an `any` type").

| Shape | Code | Fix |
| --- | --- | --- |
| Callback or helper parameter | `(a, b) => ...` TS7006 | Name the type from how the body uses it, or from the caller: a string used with `.trim()` is `string`, a markdown-it instance is `MarkdownIt`, a rendered block is `Block`. Read the call sites with `grep -n` when the body does not say. |
| Rest parameter | `(...parts)` TS7019 | `(...parts: string[])` and so on; the element type is what the body joins or spreads. |
| Binding pattern | `({ rootId, rel })` TS7031 | Annotate the whole pattern: `({ rootId, rel }: { rootId: string; rel: string })`, or name the type it is already declared as elsewhere. |
| Empty-array accumulator | `let changes = []` TS7034 + TS7005 at each use | `let changes: Change[] = []`: the element type is what the body pushes. Declare a local `interface` if none exists. |
| Late-assigned variable | `let off = null`, `let reopenName = null` TS7034 | `let off: (() => void) | null = null`. Without `strictNullChecks`, `null` is in every type already, so the annotation is `() => void`; write the union anyway, it is what the next flag will want and it costs nothing. |
| Object method that refers to its siblings | `NO_GIT: Git = Object.freeze({ info: async () => null, ... })` TS7023 | Give the call its type argument: `Object.freeze<Git>({ ... })`, or annotate each method's return. The emit is the same. |
| Untyped generic helper | `const serial = (fn) => { chain.then(fn) ... }` | `const serial = <T>(fn: () => T \| Promise<T>): Promise<T> => ...` with `let chain: Promise<unknown>`. This also stops `addRoot` collapsing to `Promise<void>` (see Task 4). |
| Index with a string | `was[k] === t[k]`, `({ n: '\n', t: '\t' })[c]` TS7053 | Type the index: `k as keyof OpenFile`, or give the lookup object a `Record<string, string>`. A cast needs its one-line why. |
| `globalThis[name]` / `win[name]` TS7017 | | A local `interface` for the window the code reads, or `(win as Record<string, unknown>)[name]`; say why. |
| Function expression with no return type TS7011 | `() => (opening = null)` | Annotate the return: `: null` or `: void`. |
| Missing declaration TS7016 | `import taskLists from 'markdown-it-task-lists'` | A shim file, Task 2. |

## File structure

- **Modify (annotation only):** `src/core/{hash,paths,document,links,front-matter,render,diff,inline-diff}.ts`, `src/reader/{git,plantuml}.ts`, `src/hosts/web/{welcome,handles,worker,platform,open-files,kv-files,idb}.ts`.
- **Create:** `src/core/markdown-it-task-lists.d.ts` (Task 2, a module declaration; no emit, nothing outside `src/core/render.ts` imports it).
- **Modify (Task 4):** `test-smoke.ts`: drop the one cast that Task 4's `serial` fix makes redundant.
- **Modify (Task 5):** `tsconfig.src.json` (the flag), `test-smoke.ts` (floor + suppression assertions), `docs/typescript.md`.

## Gate scripts

`/tmp/claude-502/ts6/gate.sh` is described in Global Constraints. It needs no arguments; the file prefixes it takes are only for counting. The baseline it compares against, `/tmp/claude-502/ts6-emit-before/src`, is a copy of `out/src` built from `origin/typescript` at `df8fb50`, before any task. The starting error list is `/tmp/claude-502/ts6-probe/src-noImplicitAny.log` (196 errors; `grep '^src/core/hash'` gives a task's share). Re-run the gate after each file, not only at the end.

---

### Task 1: `core/` leaf modules

**Files:**
- Modify: `src/core/hash.ts` (7 errors), `src/core/paths.ts` (4), `src/core/document.ts` (2), `src/core/links.ts` (1), `src/core/front-matter.ts` (24)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: typed signatures that `render.ts`, `diff.ts` and the hosts call. Keep names and parameter order exactly as they are. `renderDocument(md, current: string, base: string | null, checked: Checked)` in `document.ts` keeps its `base: string | null`; only `md` is new (`MarkdownIt`).

- [ ] **Step 1: Read the work list.** `grep '^src/core/\(hash\|paths\|document\|links\|front-matter\)' /tmp/claude-502/ts6-probe/src-noImplicitAny.log`. Open each file; read the exported types already there (`Paths`, `FrontValue`, `FrontRow`, `Checked`).
- [ ] **Step 2: Annotate** all 38 sites using the catalogue. Known sites: `paths.ts:26` is a rest parameter (`...parts: string[]`); `front-matter.ts:69` indexes a `{ n, t }` literal with a char from a regex callback (TS7053; type the lookup `Record<string, string>` and say why in a few words).
- [ ] **Step 3: Gate.** `sh /tmp/claude-502/ts6/gate.sh src/core/hash src/core/paths src/core/document src/core/links src/core/front-matter`. All five prefixes `0`; emit identical or comment-only.
- [ ] **Step 4: Commit.** `git add src/core/{hash,paths,document,links,front-matter}.ts` and commit `Type src/core leaf modules: noImplicitAny`.
- [ ] **Step 5: Write the report** to the path in the dispatch: files, the count of annotations by shape, every cast and every explicit `any` added (or "none"), every Finding with `file:line`, the gate output verbatim.

---

### Task 2: `core/render.ts` and the plugin shim

**Files:**
- Modify: `src/core/render.ts` (35 errors, one of them TS7016)
- Create: `src/core/markdown-it-task-lists.d.ts`

**Interfaces:**
- Consumes: Task 1's typed `core/` modules. `render.ts` already exports `RenderEnv`, `Block`, `Heading`.
- Produces: typed `render.ts` exports; `diff.ts` (Task 3) and `document.ts` call them. Keep every exported name and parameter order.

- [ ] **Step 1: The shim.** `markdown-it-task-lists` ships no declaration; `src/core/render.ts:3` imports its default and `render.ts:277` calls `md.use(taskLists, { label: true })`. Read `node_modules/markdown-it-task-lists/index.js` for its options (`enabled`, `label`, `labelAfter`) and write `src/core/markdown-it-task-lists.d.ts` declaring the module so that `md.use(taskLists, { label: true })` type-checks against markdown-it's `PluginWithOptions`. The file has no top-level `import` or `export` (that would make it a module and turn the `declare module` into an augmentation); reference markdown-it's type with `import('markdown-it')` inside the declaration. Start with a comment saying what it is and why it is here (no `@types` package exists, and a new dependency was ruled out). Whether it is `export default` or `export =` is decided by what makes the existing `import taskLists from '...'` compile with the existing emit; try one, then the other, and keep what the compiler accepts.
- [ ] **Step 2: Annotate** the other 34 sites in `render.ts`. This file is the bridge to markdown-it: its parameters are mostly `MarkdownIt`, `Token`, `StateCore`, `RenderEnv`, `string` and the exported `Block`/`Heading`. Several rule callbacks take `(tokens, idx, options, env, self)`; markdown-it's `Renderer.RenderRule` is the type of the whole callback and annotates all five parameters at once. If a markdown-it field the code reads is missing from the `@types`, a local `interface` that extends the real one is better than a cast.
- [ ] **Step 3: Gate.** `sh /tmp/claude-502/ts6/gate.sh src/core/render`. `0`; no non-TS70xx error; `tsc -b` ok; emit identical or comment-only. Confirm the shim emitted nothing: `out/src` has the same 38 `.js` files as the baseline.
- [ ] **Step 4: Commit.** `git add src/core/render.ts src/core/markdown-it-task-lists.d.ts`, message `Type src/core/render.ts and shim markdown-it-task-lists: noImplicitAny`.
- [ ] **Step 5: Write the report** as in Task 1, plus which of `export default` / `export =` the shim uses and why.

---

### Task 3: `core/diff.ts` and `core/inline-diff.ts`

**Files:**
- Modify: `src/core/diff.ts` (27 errors), `src/core/inline-diff.ts` (31)

**Interfaces:**
- Consumes: Tasks 1-2's typed `render.ts` (`Block`, `RenderEnv`, `Heading`) and `Checked` from `diff.ts` itself.
- Produces: typed `renderDiff`, `renderRawDiff` and the inline-word-diff helpers. Keep every exported name and parameter order.

- [ ] **Step 1: Read first.** Both files are the diff engine: `diff.ts` builds the blocks and calls `inline-diff.ts` for the word diff, which tokenises tags whole (CLAUDE.md, thing 4). Read the header comments of both before typing anything; the types follow from what a "change" and an "open tag" are.
- [ ] **Step 2: Annotate.** Known sites: `diff.ts:146` and `:309` (`changes`, an accumulator: declare a local `interface Change` from what is pushed), `:166` and `:170` (rest `parts`), and in `inline-diff.ts` the accumulators `open` (`:39`), `buf` (`:78`), `del` and `add` (`:172-173`), each with several TS7005 uses that clear when the declaration is typed. Type each accumulator once at its declaration, not at its uses.
- [ ] **Step 3: Gate.** `sh /tmp/claude-502/ts6/gate.sh src/core/diff src/core/inline-diff`. Both `0`; emit identical or comment-only.
- [ ] **Step 4: Commit.** `git add src/core/diff.ts src/core/inline-diff.ts`, message `Type src/core/diff.ts and inline-diff.ts: noImplicitAny`.
- [ ] **Step 5: Write the report** as in Task 1.

---

### Task 4: `reader/` and the web host

**Files:**
- Modify: `src/reader/git.ts` (4 errors), `src/reader/plantuml.ts` (1), `src/hosts/web/welcome.ts` (15), `src/hosts/web/handles.ts` (13), `src/hosts/web/worker.ts` (10), `src/hosts/web/platform.ts` (10), `src/hosts/web/open-files.ts` (7), `src/hosts/web/kv-files.ts` (4), `src/hosts/web/idb.ts` (1)
- Modify: `test-smoke.ts` (one cast, below)

**Interfaces:**
- Consumes: Tasks 1-3 typed `core/` (the web host imports `paths`, `render` types; `reader/` imports `Git`, `Platform`).
- Produces: typed web host. Notably `handles.addRoot` resolves to its real record after the `serial` fix, and `welcome.ts` declares the window it reads.

- [ ] **Step 1: The web host is DOM and storage glue.** Annotate with the DOM lib types (`Document`, `HTMLElement`, `Window`, `FileSystemFileHandle`, `FileSystemDirectoryHandle`, `IDBDatabase`, `IDBRequest`, `Storage`, `MessagePort`), plus local interfaces for what `lib.dom` lacks: `showOpenFilePicker` and `showDirectoryPicker` on the window, `getAsFileSystemHandle` on a `DataTransferItem`, `requestPermission` on a handle. A local `interface` says what the code reads and nothing more; a comment gives the reason in a line.
- [ ] **Step 2: The sites that are not a plain parameter.**
  - `git.ts:37-40` and `plantuml.ts:94` (TS7023): `NO_GIT` and `NO_PLANTUML` are `Object.freeze({ ... })` assigned to a typed constant, and the freeze call is what is circular. `Object.freeze<Git>({ ... })` and `Object.freeze<PlantumlRenderer>({ ... })`.
  - `handles.ts:100` `serial`: make it `const serial = <T>(fn: () => T | Promise<T>): Promise<T> => { ... }` with `let chain: Promise<unknown> = Promise.resolve()`. This is a type-only fix for a real defect: the untyped `serial` collapses `addRoot` to `Promise<void>`, and the suite casts `as unknown as { rootId: string }` where it reads the result (`test-smoke.ts:4428-4431`). After the fix, read the declared type of `addRoot` in `src/hosts/web/welcome.ts:66` (`addRoot(handle: any): Promise<{ rootId: string }>`) and `platform.ts` / `backend.ts` where it is used, and confirm it now agrees with what `serial` returns; if the interface and the implementation disagree, that is a Finding.
  - `open-files.ts:87-91` `note({ id, path, name, dir = '', label = path })`: the pattern is self-referential (`label = path`), hence TS7022; annotate it `Pick<OpenFile, 'id' | 'path' | 'name'> & Partial<Pick<OpenFile, 'dir' | 'label'>>` (or the equivalent), and index with `k as keyof OpenFile` at `:91`.
  - `welcome.ts:98` and `:184`: `win.showOpenFilePicker` and `win[name]` on a window; one local `interface` for the window the file reads.
  - `welcome.ts:201`/`:210` `reopenName`, `worker.ts:328`/`:378` `off`: annotate the `let` (catalogue).
  - `welcome.ts:313`, `idb.ts:50`: annotate the return of the function expression.
  - `platform.ts:106` `handleOf({ rootId, rel })`: annotate the pattern.
- [ ] **Step 3: The cast in the suite.** After `serial` is typed, `test-smoke.ts:4428-4431` no longer needs `as unknown as { rootId: string }`. Remove the cast and the comment above it that explains it (the comment says `serial` is untyped; it would now be false), keeping the assertion itself. The emit of `out/test-smoke.js` must be unchanged except for that comment. If another `addRoot` call in the file still carries a cast of this kind, remove it by the same reasoning; `grep -n 'as unknown as' test-smoke.ts | grep -i root`.
- [ ] **Step 4: Gate.** `sh /tmp/claude-502/ts6/gate.sh src/reader src/hosts/web`. Both `0`; whole project `0` (`src --noImplicitAny: 0 errors in total`); emit of `out/src` identical or comment-only. The gate's baseline covers `out/src` only, so check the suite's emit by hand: copy `out/test-smoke.js` to `/tmp/claude-502/ts6/test-before.js` before Step 3, then `diff` it against the rebuilt `out/test-smoke.js`; only the removed comment may differ.
- [ ] **Step 5: Commit.** `git add` the nine `src/` files and `test-smoke.ts`, message `Type src/reader and src/hosts/web: noImplicitAny`.
- [ ] **Step 6: Write the report** as in Task 1, plus what `addRoot` resolves to now, and whether `welcome.ts`'s `addRoot(handle: any)` could now be typed (note it; do not change it unless the type is a one-liner with the same emit).

---

### Task 5: switch the flag on, hold it with a test, write it down

**Files:**
- Modify: `tsconfig.src.json`, `test-smoke.ts`, `docs/typescript.md`

**Interfaces:**
- Consumes: Tasks 1-4. The project must already report zero errors under `--noImplicitAny`.
- Produces: `"noImplicitAny": true` in `tsconfig.src.json`; a floor assertion in `test-smoke.ts` that later ratchet PRs extend by one entry each.

- [ ] **Step 1: The flag.** In `tsconfig.src.json`, add `"noImplicitAny": true` to `compilerOptions`, after `"types": []` and before `tsBuildInfoFile`, with the file's formatting. Run `npm run build:ts`; it must be green with no other change. `tsc -p tsconfig.src.json --noEmit` (no CLI flag) now also reports 0.
- [ ] **Step 2: The floor.** In `test-smoke.ts`, next to the existing node-project block (the one that reads `tsconfig.node.json`, search `nodeProject`), add a block with a comment saying why: a flag that is on must not be switched off, and a floor guards regression without forcing progress. The block holds `const FLOOR: Record<string, string[]> = { 'tsconfig.src.json': ['noImplicitAny'] };` and, for each entry, reads the project file and `tsconfig.base.json`, merges their `compilerOptions` (project over base; every project extends the base and nothing deeper, so one level is enough), and asserts `options[flag] ?? options.strict` is `true`, with the message naming the file and the flag and saying the ratchet only goes up. A later PR adds an entry; it must not need to touch the logic.
- [ ] **Step 3: No suppression in `src/`.** Beside it, assert that no `.ts` file under `src/` (walk with `fs.readdirSync(rootUrl('src/'), { recursive: true })`, filter `/\.ts$/`, and skip `.d.ts` only if the shim has a comment mentioning the pattern; it should not) matches `/@ts-(nocheck|ignore|expect-error)/`, so that a comment cannot keep the flag on and the errors hidden. Per the spec's read rule this reads the `.ts` sources, not `out/`.
- [ ] **Step 4: See it fail.** Copy `tsconfig.src.json` to `/tmp/claude-502/ts6/tsconfig.src.json.keep`, set `"noImplicitAny": false`, and run `npm test` (sandbox off): the new assertion must fail with its message. Then copy the file back and `cmp` it against the copy; the working tree must show only the intended change. Report both runs.
- [ ] **Step 5: Docs.** `docs/typescript.md`, and any other `docs/*.md` or `README.md` line found by `grep -rniE 'lenient|ratchet|implicit|untyped|strict'` that this PR makes stale (`docs/architecture.md` and `docs/building.md` have none today):
  - lines 18-20: `src/` is now checked with `noImplicitAny`; the other projects, and every other flag, are still lenient. Say which, in one or two sentences, not a table.
  - line 81 (`checks it the same lenient way`) stays true for the node project; leave it unless it contradicts the new text.
  - lines 91-100, the "two real mismatches" paragraph: `serial` is now typed and the suite no longer casts `addRoot`'s result (delete that sentence's claim and the `handles.addRoot` entry in the list of casts above it, around line 88: read the whole paragraph, lines 80-100, and keep what is still true). `renderDocument`'s `base` was fixed at the call site in step 5 and needs nothing further from the ratchet: say so, and drop "both left for the step 6 ratchet", which was wrong for it. Add that the suite's floor is asserted.
  - the ladder, item 6 (line 399): the ratchet is in progress; `src` has `noImplicitAny` (this PR); `strictNullChecks` and `strict` for `src`, and all three flags for `node` and `page`, are next, one flag per project per PR.
  - a short paragraph, under the projects section, on the floor test: where the table of flags lives, that a PR adds one entry, and that it does not force progress.
  - "What `tsc -b` costs" (lines 404-438): see Step 6.
- [ ] **Step 6: Measure, and transpose the table.** Measure on the tip with `noImplicitAny` on (3 runs each, `tsc` from `node_modules`): rebuild everything `npx tsc -b --force`; up to date `npx tsc -b`; up to date as `npm run build:ts`. Record `uptime` before and after, as the doc's earlier columns did (a load average above about 2 means the numbers are not a finding). To say what the flag cost, repeat the three with `"noImplicitAny": false` (copy aside and back as in Step 4). The table in the doc has grown to five step-columns, with two rows over 100 columns, and the step 5 ruling was to transpose it when the next entry arrived: do that. Rows are the steps (`Step 1 (50 files, none checked)`, `Step 2`, ... `Step 6, src noImplicitAny`), columns are the three measurements, every row under 100 columns, the numbers already in the table unchanged. Rewrite the prose that refers to "the last row" as "the last column". Replace "`strict` will cost more; step 6 measures it" with what was measured and what is still to measure.
- [ ] **Step 7: Verify and commit.** `awk 'length > 100 {print FILENAME":"FNR}' test-smoke.ts docs/typescript.md` names no line you added (the table's old over-limit rows are gone with the transpose). `rm -rf out` is not needed by you; the controller does the clean build. Run `npm run build:ts`, `npm test` (sandbox off) and `sh /tmp/claude-502/ts6/gate.sh`, all green. `git add tsconfig.src.json test-smoke.ts docs/typescript.md` (and any other doc you changed) and commit `Turn noImplicitAny on for src, hold it with a test, and document it`.
- [ ] **Step 8: Write the report** as in Task 1, plus both `npm test` runs, the measurement table, the docs lines changed (`file:line` before and after), and every doc line you considered and left.
