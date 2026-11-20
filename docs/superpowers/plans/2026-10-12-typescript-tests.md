# `test-smoke.ts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the last compiled JavaScript file, `test-smoke.js`, to `test-smoke.ts`, checked leniently by the `node` project like everything else, with no change to what the suite asserts or how it runs.

**Architecture:** One rename inside the existing `node` project (`tsconfig.node.json` already compiles `test-smoke.js` through `allowJs`; the include entry changes to the `.ts`). The emitted file stays `out/test-smoke.js`, so `package.json`'s `test` script and the CI workflows do not move. The 321 type errors a spike found are not drift between the hosts: they are the test's hand-built fakes (a window with a message port, a DOM `El`, a file handle, a `Storage`), helpers whose JS callers omit trailing arguments, and `server.address()` narrowing. Each class has one fix, set out in Task 1. A byte-level check on the *emitted* JavaScript, before against after, is what shows behaviour did not change.

**Tech Stack:** TypeScript 5.9.3 (`tsc -b`, `strict: false`), Node ESM, `node:assert`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` (§4 Tests, §5 ladder item 5). It is untracked in the main checkout (`/Users/chau.vinh.tuan/ws/me/redlineapp`), not in this worktree. `docs/typescript.md` in this worktree is the maintained account of steps 1–4 and is the doc this plan updates.

## Global Constraints

- **Behaviour must not change at any step, so `npm test` and `npm run bundle` are green** (spec §4). The suite must assert exactly what it asserted before: no assertion removed, reordered, reworded or weakened. The only additions are the two assertions in Task 1 Step 2, and the only edited literal is `'test-smoke.js'` in the `cited` list.
- **Lenient:** `strict: false` stays. No `// @ts-nocheck`, `// @ts-ignore` or `// @ts-expect-error` anywhere in `test-smoke.ts`. Implicit `any` is allowed (it is the lenient floor); `as any` is allowed only where a value comes out of a `vm` context or an evaluated page, where no static type crosses the seam.
- **Read rule (spec §4):** a grep about *source shape* reads the `.ts`; anything executed in a `vm`, served, or shipped reads the compiled `.js`. Reading the test file itself is a source-shape read, so it reads `test-smoke.ts`.
- **`package.json`'s `test` stays `node out/test-smoke.js`** — the emitted name does not change, and a test already asserts the script.
- **No new dependency.** No change to `src/`, `public/`, `scripts/` or `bin/` behaviour. A comment may change in a file that names `test-smoke.js` (Task 2); nothing else in them.
- **Do not touch** `CLAUDE.md` or `skills/` (gitignored, local, and `skills/` is write-protected here), the Rust shell, or `bootstrap/` beyond one comment (Task 2).
- **Conventions:** 2-space indent, single quotes, trailing commas, 100-column soft limit. Comments say *why*, not what. If behaviour changes, change the doc in the same commit.
- **Commands:** `npm test` and `npm run bundle` must run with the command sandbox off (`dangerouslyDisableSandbox: true`); they bind `127.0.0.1`. `npx prettier` does not work here; check length with `awk 'length > 100 {print FILENAME":"FNR}' <files>`. `git mv` keeps the old mtime, so `touch` a renamed file or `tsc -b` may say "up to date". `tsc -b` never prunes `out/`. Never `git add -A`; add files by name. Commit with `git commit -F - <<'EOF'`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Worktree:** `/tmp/claude-502/redlineapp-ts5-tests`, branch `typescript-tests`, off `origin/typescript` at `6c1048e`. `node_modules` and `shell/target` are untracked symlinks there; leave them.

---

### Task 1: Rename `test-smoke.js` to `test-smoke.ts` and make it compile

**Files:**
- Rename: `test-smoke.js` → `test-smoke.ts` (use `git mv`)
- Modify: `tsconfig.node.json:7` (the `include` entry)
- Modify: `test-smoke.ts` — the type fixes below, the `cited` list near line 6333, and one new assertion near the top

**Interfaces:**
- Consumes: the converted `src/` signatures (`renderDocument(md, current: string, base: string | null, checked?)` in `src/core/document.ts:40`, `createServer`, `createSession`, `serveRpc`, `createRpcBackend`, …). Read them; do not change them.
- Produces: `out/test-smoke.js` (same path as before) from `test-smoke.ts`, and a `node` project that includes it. Task 2 describes this in prose and relies on nothing else.

- [ ] **Step 1: Record the emitted baseline, before touching anything**

```bash
cd /tmp/claude-502/redlineapp-ts5-tests
npm run build:ts
cp out/test-smoke.js /tmp/claude-502/ts5-emit-before.js
wc -l /tmp/claude-502/ts5-emit-before.js
```

`out/test-smoke.js` is what `tsc` emits from the JS today. After the rename it is emitted from the TS by the same printer, so the two emitted files differ only by the edits you make. Step 7 diffs them.

- [ ] **Step 2: Write the new assertion first, and see it fail**

In `test-smoke.js`, in the first section, next to the existing assertions that `package.json`'s scripts point at `out/` (they start a little above line 60; find them with `grep -n "build:ts" test-smoke.js`), add:

```js
// The suite is checked like the code it tests. Left out of the project, a type error in it would be
// invisible, and a comment that switches the check off would say nothing at all.
const nodeProject = JSON.parse(text('tsconfig.node.json'));
assert.ok(nodeProject.include.includes('test-smoke.ts'), 'the suite is part of the node project');
assert.ok(
  !/@ts-(nocheck|ignore|expect-error)/.test(text('test-smoke.ts')),
  'and nothing in it turns the check off',
);
```

(`text` is the suite's existing helper that reads a repo file; if its name differs here, use the one the neighbouring assertions use. The regex does not match its own source text because `@ts-` is followed by `(`, not `n`/`i`/`e`; keep it that way.)

Run `npm test` (sandbox off). Expected: **FAIL** at the new `include.includes` assertion, or an `ENOENT` on `test-smoke.ts` before it. If it passes, the assertion is not testing anything.

- [ ] **Step 3: Rename and point the project at it**

```bash
git mv test-smoke.js test-smoke.ts
touch test-smoke.ts
```

In `tsconfig.node.json`, change `"test-smoke.js"` to `"test-smoke.ts"` in `include`. Do not change anything else in the file.

- [ ] **Step 4: Fix the type errors, class by class**

Run `npx tsc -b tsconfig.node.json` and work through the errors. A spike gave 321, all in `test-smoke.ts`; they fall into these classes. Each has one fix, and the fix goes at the *declaration* where there is one, not at every use.

| Errors | Cause | Fix |
| --- | --- | --- |
| ~97 `TS2339` on `backend`, `watch`, `fire` | the fake window `{ id, win, port, live, events, asked }` gains `backend`/`watch`/`fire` after it is created | declare a local `interface FakeWindow` beside the factory with every member the test later reads or adds. Members that come from evaluating the compiled page in a `vm` are `any` (no static type crosses that seam) |
| ~13 `TS2739` on a `Storage` | a literal `{ m: Map, getItem, setItem }` handed where `Storage` is expected | keep the literal, and cast where it is handed to the code under test: `as unknown as Storage` |
| ~16 `TS2339` on `.port`, and several `TS2345` | `server.address()` is `string \| AddressInfo \| null` | add one helper `const portOf = (s: { address(): string \| AddressInfo \| null }) => (s.address() as AddressInfo).port;` with `import type { AddressInfo } from 'node:net';` and replace each `x.server.address().port`. These servers listen on a TCP port, so the cast is a fact, not a hope |
| ~16 `TS2339` on `hidden`, `children`, `attrs`, `own`, `listeners` | the fake DOM class `El` (and a few elements built from it) is used with members its class never declares | declare those members on the class (typed, with the value the constructor already gives them), not `any` |
| ~11 `TS2339` on `state`, `asked`, `allow` | a fake file handle `{ kind, name, queryPermission, getFile }` that the test then decorates | a local `interface FakeHandle` with the decorations as members |
| ~48 `TS2554` "Expected 2 arguments, but got 1" | helpers written in JS whose callers omit trailing parameters: `clientFor`'s `(p, init)` (so `get`, `getW`), `httpP`, `refused`, `item`, the fake's `press` | make the omitted parameter optional (`init?`, `root?`, `give?`). **Do not pass dummy arguments at the call sites.** Not drift |
| 1 `TS2554` "Expected 3-4 arguments, but got 2" at `renderDocument(mdLines, src)` (about line 2243) | **the one real mismatch**: `base: string \| null` is required in the converted source, and this call omits it | pass `null` at the call site: `renderDocument(mdLines, src, null)`. `base != null` is false for `undefined` and for `null` alike, so behaviour is identical — but read `renderDocument` once to confirm `base` is only tested with `!= null` before you rely on it, and say what you found in the report. Do not change `src/` |
| ~47 `TS2339` on `history`, `removed`, `name`, `acked`, `id`, `svg`, … from `unknown` | values from `await res.json()`, `JSON.parse` or an `rpc` reply that the converted code types as `unknown` | narrow with `as` to the shape the test then reads, once per value, with a named local type if the shape is used more than twice |
| `TS2794` ×2 (about lines 2400, 2554) | `new Promise()` with no type argument | `new Promise<void>(...)` (or the resolved type, read from the `resolve(...)` calls) |
| `TS2322` ×8, `TS2769` ×14, `TS2551` ×8, `TS2488`/`TS2349` ×3, `TS2345`, `TS2741` ×4, `TS2740` ×3 | the long tail: `{ text, blocks }[]` against `AckedVersion[]` (about line 2356), a `NonSharedBuffer` against a string (about line 318), `string \| RegExp` (about lines 586–587), a `string[][]` call (about lines 786–787), and three more fakes handed to the code under test | each is read on its own: a local interface or a cast **at the boundary where the fake is handed to the code under test**, never on the code under test. If a mismatch is a real defect between the test and a converted signature (as the `renderDocument` one is), do not paper over it: list it in the report under "real drift" |

Rules for every fix:
- No `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- `as unknown as T` is for a *fake* handed to the code under test; use it at the one call that hands it over. A cast on the code under test's own value is a smell: narrow instead.
- Do not change a runtime expression to please the checker: no added `?.`, `!`-replacement logic, default values, `String(...)` wrappers or reordering. A type-only construct (`as`, `?`, `interface`, `import type`, a type argument) is the whole toolbox. The one exception is `null` in `renderDocument(mdLines, src, null)`, and `portOf`, which is a new helper whose body is a cast.
- Comments say why. A cast that needs a reason gets one line saying which fake or which `vm` seam it is.

Re-run `npx tsc -b tsconfig.node.json` after each class; the count should fall steeply, and it must end at exit 0 (read `$?`, do not pipe `tsc` through `head`/`tail`).

- [ ] **Step 5: Update the references inside the file**

```bash
grep -n "test-smoke" test-smoke.ts
```

- the `cited` list near line 6333, `'test-smoke.js'` → `'test-smoke.ts'` (it reads the file's *source* to check it cites no plan, a source-shape read);
- the regex near line 77, `/\bnode (scripts|bin)\/|\bnode test-smoke/`, stays as it is: it looks for the command line `node test-smoke…` in docs and scripts, which no one may run;
- any other hit that *names the file* as a path to read: decide per the read rule above (source shape → `.ts`).

- [ ] **Step 6: Build from a clean `out/`, then run the suite**

```bash
cd /tmp/claude-502/redlineapp-ts5-tests
rm -rf out
npm run build:ts          # exit 0, and it prints no errors
ls out/test-smoke.js
```

`rm -rf out` is scratch here: `out/` is gitignored and `build:ts` regenerates it. Then `npm test` (sandbox off). Expected: all assertions pass, including the two from Step 2.

- [ ] **Step 7: Diff the emitted JavaScript, before against after**

```bash
diff /tmp/claude-502/ts5-emit-before.js out/test-smoke.js > /tmp/claude-502/ts5-emit.diff; echo "diff exit $?"
wc -l /tmp/claude-502/ts5-emit.diff
```

Read the whole diff. Every hunk must be one of: the Step 2 assertion; the `'test-smoke.js'` → `'test-smoke.ts'` literal in `cited`; `renderDocument(mdLines, src, null)`; the `portOf` helper and its call sites; a comment you added. **Anything else is a runtime change and must be undone.** `tsc` erases `as`, `?`, `interface` and `import type`, so type-only fixes leave no hunk. If the diff is only whitespace or reprinting noise on lines you did not touch, say so; it should not be, because both files went through the same printer.

- [ ] **Step 8: Check line length and commit**

```bash
awk 'length > 100 {print FILENAME":"FNR}' test-smoke.ts
```

Lines over 100 columns that you added must be wrapped. (Pre-existing ones are not yours; compare with `git show HEAD:test-smoke.js | awk 'length > 100' | wc -l` against the same count on the new file, and report both numbers.)

```bash
git add test-smoke.ts tsconfig.node.json
git commit -F - <<'EOF'
Convert test-smoke.js to TypeScript

The last compiled JavaScript file. The suite is now part of the node project, checked
leniently: its fakes (window and port, El, a file handle, a Storage) are typed where they are
declared, helpers whose callers omit trailing arguments take them as optional, and
server.address() goes through one cast. The emitted file is still out/test-smoke.js, so
`npm test` and CI are unchanged.

One real mismatch surfaced: renderDocument is called without its `base`, which the converted
source types as required. The test passes null, which behaves the same.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
git status --short
git log --oneline -1
```

`git status --short` shows only the untracked `node_modules` and `shell/target` symlinks. If `git` reports the rename as a delete plus an add, that is `git`'s similarity heuristic and not a problem; check with `git show --stat -M HEAD`.

**Report (write to the report file you are given), including:** the `tsc` error count before and after, per class; every place a cast or interface was added and which class it belongs to; the `renderDocument` finding (what `base` is tested with); the full emit diff, hunk by hunk with a reason for each; "real drift" findings, if any; the line-length counts; the `npm test` summary line. Do not run `npm run bundle` here; the final check does.

---

### Task 2: Docs and comments say `test-smoke.ts`

**Files:**
- Modify: `docs/typescript.md`, `docs/architecture.md`, `docs/building.md`, `README.md`
- Modify (comment only): `wrangler.toml:19`, `bootstrap/heal-page-build.mjs:32`, `scripts/notices.mts:25`, `src/contract/payload.ts:3`

**Interfaces:**
- Consumes: Task 1's result — `test-smoke.ts` is in `tsconfig.node.json`'s `include`, emits `out/test-smoke.js`, is checked leniently, and its fakes are typed locally with casts at the boundary where they reach the code under test.
- Produces: nothing a later task reads. This is the last implementation task.

- [ ] **Step 1: List every reference**

```bash
cd /tmp/claude-502/redlineapp-ts5-tests
grep -rn "test-smoke" . -I --exclude-dir=node_modules --exclude-dir=target --exclude-dir=out --exclude-dir=.git --exclude-dir=.superpowers --exclude=test-smoke.ts
```

Expected hits: `README.md:237`; `wrangler.toml:19`; `bootstrap/heal-page-build.mjs:32`; `scripts/notices.mts:25`; `src/contract/payload.ts:3`; `docs/architecture.md` (102, 635, 879); `docs/typescript.md` (12, 24, 53, 67, 71, 145, 212, 366); `docs/building.md` (238, 271, 344, 540, 551, 566, 595, 644, 668, 734, 761, 767, 783); `package.json:36` (**leave it**: `node out/test-smoke.js` is the emitted name). Any other hit is yours to judge.

- [ ] **Step 2: Rename each reference that names the file as source**

Each `test-smoke.js` becomes `test-smoke.ts`, **except** where the text is about the *emitted* file or the command line: `node out/test-smoke.js`, "`pretest` compiles it into `out/` and `node` runs it from there" (`docs/building.md:271` — keep `out/test-smoke.js` where it names the output, and say `test-smoke.ts` where it names the source). The four comment-only code hits are one-word edits; change nothing else in those files.

- [ ] **Step 3: Make `docs/typescript.md` true**

Read the whole file; these are the claims to change, and then check it for any other sentence the rename makes false:
- the opening (line 12): "`test-smoke.js` is the only JavaScript left that is compiled" is no longer true. Say that step 5 converted the suite, that every file the build compiles is TypeScript, and that the two classic scripts stay JavaScript and are copied as they are. Keep the cross-reference links that are still true.
- the table at line 24 and the project table at line 67: `test-smoke.js` → `test-smoke.ts`.
- line 366, ladder item 5: "(done)" with one clause on what it was, like items 1–4.
- anywhere it says `allowJs` is on *because* of the suite: with the suite converted, check whether `allowJs` in `tsconfig.base.json` still compiles any JavaScript (`grep -rn "allowJs" tsconfig*.json`; `npx tsc -b --listFilesOnly 2>&1 | grep -v node_modules | grep '\.js$'`). **Do not change the config.** If nothing is compiled from `.js` any more, say so in the doc as an observation ("now only … ") and list it in your report as a follow-up, so the next step can decide.
- add a short paragraph where the doc describes the `node` project: the suite's fakes are typed where they are declared; a fake handed to the code under test is cast `as unknown as <real type>` at that one call; a value that comes out of a `vm` is `any`, because no static type crosses that seam; `// @ts-nocheck`, `@ts-ignore` and `@ts-expect-error` are asserted absent. Do not repeat what the code says.

In `docs/building.md` (the testing section around line 271) add one sentence that the suite is type-checked like the rest, so `npm test` fails on a type error before it runs anything. In `docs/architecture.md` change the module-map line 102 to `test-smoke.ts`.

- [ ] **Step 4: Add a Step 5 column to the cost table**

`docs/typescript.md` has a table "What `tsc -b` costs" with a column per step. Measure on a quiet machine:

```bash
cd /tmp/claude-502/redlineapp-ts5-tests
uptime                                   # record the load average
npm run build:ts
for i in 1 2 3; do /usr/bin/time -p node_modules/.bin/tsc -b --force 2>&1 | grep '^real'; done
for i in 1 2 3; do /usr/bin/time -p node_modules/.bin/tsc -b 2>&1 | grep '^real'; done
for i in 1 2 3; do /usr/bin/time -p npm run build:ts 2>&1 | grep '^real'; done
```

Add a `Step 5` column with "about X s" in the style of the others, and extend the sentence above the table ("step 4 over those and the page's three files and the five shims…") with "step 5 over those and `test-smoke.ts`, 7.3k lines". Say in the text what the load average was; if it was above about 2, say that the number is not a finding. The sentence about `strict` costing more stays: step 6 measures it.

- [ ] **Step 6: Run the suite and check length**

```bash
npm run build:ts
npm test        # sandbox off
awk 'length > 100 {print FILENAME":"FNR}' docs/typescript.md docs/building.md docs/architecture.md README.md
git diff --stat
```

The suite reads docs and comments (it asserts what they say about builds and the page), so a failure here is real: read it. Expected: green. Compare against the committed versions: `git show HEAD:docs/typescript.md | awk 'length > 100' | wc -l` (and the same for the other three), and report both numbers; you add none.

- [ ] **Step 7: Commit**

```bash
git add docs/typescript.md docs/architecture.md docs/building.md README.md wrangler.toml bootstrap/heal-page-build.mjs scripts/notices.mts src/contract/payload.ts
git commit -F - <<'EOF'
Docs and comments: test-smoke.ts

Step 5 of the TypeScript conversion left no compiled JavaScript but the two classic scripts. The
docs said test-smoke.js was the only one; they now say what is true, describe how the suite types
its fakes, and add a Step 5 column to the cost table.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
git status --short
```

**Report:** every reference changed, the ones deliberately left (and why), the cost-table numbers with the load average, whether `allowJs` still compiles anything, and the test summary line.
