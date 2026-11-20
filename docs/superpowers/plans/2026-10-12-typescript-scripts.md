# TypeScript step 3: `bin/` and `scripts/` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the 13 files in `bin/` and `scripts/` to TypeScript, so that `tsc` checks the build and release tooling the way it already checks `src/`, with no change in what any npm script does.

**Architecture:** `bin/redline.js` becomes `bin/redline.ts` (it emits `out/bin/redline.js`, which `package.json`'s `bin` names) and each `scripts/*.mjs` becomes `scripts/*.mts` (it emits the same `out/scripts/*.mjs` that every npm script, `dev.mts`, `bundle.mts` and the tests already name). No tsconfig changes: `tsconfig.node.json` already includes `bin/` and `scripts/`. Files are renamed with `git mv` in the same commit as the annotations that make them compile. One PR into `typescript`, in two commits: the code, and the prose that describes it.

**Tech Stack:** TypeScript 5.9.3 (`tsc -b`, `strict: false`, NodeNext), `@types/node`, Node 22 in CI.

**Spec:** `docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` (§3 build order, §4 tests, §5 the ladder, step 3). Step 1's plan landed as PR #29, step 2's (`2026-10-11-typescript-src.md`) as PRs #31–#33.

## Global Constraints

- Behaviour does not change: `npm test` and `npm run bundle` are green at every commit.
- One PR into the long-lived branch `typescript`, **never `main`**. Merge it with a merge commit, like the others.
- `strict: false`. Annotate every function signature (that is the check), give an `interface` to an object that a closure or a `JSON.parse` hands around, and leave the rest inferred. `noImplicitAny` is step 6.
- **Extensions: `bin/redline.ts` and `scripts/*.mts`.** `.mts` is what emits `.mjs`, the names that `package.json`, the tests and the child-process strings in `dev.mts` and `bundle.mts` already use. This deviates from the spec's §3 example, `node out/scripts/build-web.js`, which was written before step 1 shipped `.mjs` names; say so in the PR.
- Imports keep their compiled extensions, as NodeNext asks: `../src/…/x.js` for `src/` and `./stage-page.mjs` for a sibling script (it resolves to `stage-page.mts`).
- `src/hosts/node/` is in the `node` project (`@types/node`), and so is every file converted here. Use `import type` for a type-only import.
- Source reads in `test-smoke.js` (`read('./scripts/x.mjs')`, `rootUrl('scripts/x.mjs')`, `fromRoot('scripts/x.mjs')`) name the file on disk and become `.mts`. `await import('./scripts/x.mjs')` loads compiled output from `out/`, and `out/scripts/x.mjs` in a string names compiled output: those stay.
- `tsc -b` never prunes `out/`. Nothing goes stale in this PR, because every output keeps its name, but that is also why the wrong-extension check in Task 8 moves `out/` aside first.
- 2-space indent, single quotes, trailing commas, 100 columns soft (`bin/redline.ts:69` and `:110` are pre-existing offenders). Comments say why, not what, and match the density of the file. Strip the `{type}` from a JSDoc `@param`/`@returns` when its TypeScript annotation goes in.
- Docs change in the same PR as the behaviour (`docs/typescript.md`, `docs/architecture.md`, `docs/building.md`).
- Run `node_modules/.bin/tsc` directly (`npx` tries the network). `npm test`, `npm run bundle` and anything that binds a port need `dangerouslyDisableSandbox: true`. The shell cwd resets every call, so `cd` first. BSD `sed -i` is unusable: edit with the Python helper below. Never `git add -A`: `node_modules` and `shell/target` are symlinks that `.gitignore`'s trailing-slash rules do not match.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not push or open a PR; that is the user's call.

**Working tree:** `/tmp/claude-502/redlineapp-ts3-scripts`, a new worktree on branch `typescript-scripts`, which already exists locally at `dc75d88`, the same commit as `origin/typescript` (the tip after PR #33). There is **no local `typescript` branch**: write `origin/typescript` wherever a diff or a compare needs the base. `node_modules` and `shell/target` are symlinked in from earlier worktrees. This plan and the spec are untracked in the main checkout (`/Users/chau.vinh.tuan/ws/me/redlineapp`) and are not in the worktree, so read them from there; `CLAUDE.md` and `skills/` are gitignored and absent too. Every command below starts with `cd /tmp/claude-502/redlineapp-ts3-scripts`.

**Measured before starting:** renaming the 13 files with nothing annotated gives **23** `tsc` errors in five files: `scripts/notices.mts` 16, `bin/redline.ts` 2, `scripts/serve-site.mts` 2, `scripts/serve-webapp.mts` 2, `scripts/dev.mts` 1. 21 are TS2339 and 2 are TS2345. A throwaway spike of every edit in Tasks 2–7 (`/tmp/claude-502/redlineapp-ts3`, branch `spike-scripts-ts`, uncommitted) gave `tsc -b` exit 0, `npm test` "all smoke tests passed" and `npm run bundle` built (`Redline.app` 8.7M, dmg 3.3 MB); it touched 25 files, +277/−171, before this plan added two comment renames in `test-smoke.js`. The first commit of this plan, run on a scratch tree, was 25 files, +279/−173 (the spike's figures plus the two comment renames in `test-smoke.js`), which Task 8 step 8 checks. Report the real final numbers in the PR.

## File Structure

| File | What changes |
| --- | --- |
| `bin/redline.js` → `bin/redline.ts` | `Options` interface, typed signatures, two imports (`Server`, `AddressInfo`), `ErrnoException` on the listen loop, one `AddressInfo` cast |
| `scripts/serve-site.mjs` → `.mts`, `serve-webapp.mjs` → `.mts` | `MIME` as `Record<string, string>`, typed `send`/`rel`/`createSiteServer`/`createWebappServer`/`ruleHeaders`, `ErrnoException`, one `AddressInfo` cast each |
| `scripts/dev.mjs` → `.mts` | typed `build`, `stage`, `changed`; `as const` on the signal list |
| `scripts/notices.mjs` → `.mts` | six interfaces (the lockfile entry and `cargo metadata`), every function typed, `encoding: 'utf8'` |
| `scripts/stage-page.mjs` → `.mts` | `HostName`, `HostSpec`, `HOSTS: Record<HostName, HostSpec>`, exported `StagedPage`, typed helpers |
| `scripts/build-webapp.mjs`, `build-web.mjs`, `bundle.mjs`, `make-icons.mjs`, `markdown-css.mjs` → `.mts` | typed signatures; JSDoc types dropped |
| `scripts/build-dist.mjs`, `build-site.mjs` → `.mts` | rename only (one comment in `build-dist`) |
| `test-smoke.js` | a guard for the new layout; 15 source reads, one message and two comments follow the rename |
| `.github/workflows/ci.yml`, `.gitignore`, `public/styles.css`, `src/hosts/{node/server,tauri/backend,web/backend}.ts`, `src/hosts/web/host.js` | a comment each, `.mjs` → `.mts` |
| `package-lock.json` | the root package's `bin` entry, stale since step 1: `bin/redline.js` → `out/bin/redline.js` |
| `docs/architecture.md`, `docs/building.md`, `docs/typescript.md` | every script name; commit 2 adds the narrative and the measured cost |

Not in the PR: `CLAUDE.md` and `skills/` (gitignored, local-only; the owner's to update).

---

### Task 1: Worktree, helper and baseline

**Files:**
- Create (outside the repository): `/tmp/claude-502/ts3sub.py`

**Interfaces:**
- Produces: `sub(path, old, new, count=1)` — replaces `old` with `new` in the file, and fails loudly unless `old` occurs exactly `count` times. Every edit below uses it, so a block that does not match stops the task instead of editing the wrong thing.

- [ ] **Step 1: The worktree**

```bash
cd /Users/chau.vinh.tuan/ws/me/redlineapp
git rev-parse --short origin/typescript typescript-scripts 2>&1 | tr '\n' ' '; echo   # dc75d88 dc75d88
git worktree add /tmp/claude-502/redlineapp-ts3-scripts typescript-scripts
cd /tmp/claude-502/redlineapp-ts3-scripts
ln -s /tmp/claude-502/redlineapp-ts/node_modules node_modules
ln -s /tmp/claude-502/redlineapp-ts2/shell/target shell/target
git status --short            # only the two symlinks: ?? node_modules, ?? shell/target
git ls-files bin scripts | wc -l    # 13
```
`rev-parse --short` with two revisions fails on some git versions; if it does, run it once per branch. Expected: both `dc75d88`.

- [ ] **Step 2: The helper**

```bash
cat > /tmp/claude-502/ts3sub.py <<'PY'
# Exact-count string replacement for the step 3 plan: a block that does not match fails loudly.
import pathlib


def sub(path, old, new, count=1):
    p = pathlib.Path(path)
    text = p.read_text(encoding='utf-8')
    found = text.count(old)
    assert found == count, f'{path}: expected {count} of {old[:70]!r}, found {found}'
    p.write_text(text.replace(old, new), encoding='utf-8')
PY
```

- [ ] **Step 3: Baseline**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected: `tsc exit 0`. Then, with the sandbox off:

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && npm test 2>&1 | tee /tmp/claude-502/ts3-base.log | grep -c '^✓'; tail -n 1 /tmp/claude-502/ts3-base.log
```
Expected: a count N (note it; the finished suite has N+1) and `all smoke tests passed`.

---

### Task 2: The layout guard (test first)

**Files:**
- Modify: `test-smoke.js` (a new block just above `const tmp = fs.mkdtempSync(...)`, after the imports)

**Interfaces:**
- Produces: a block that asserts (1) `bin/` and `scripts/` hold no `.js`/`.mjs`; (2) the file `package.json`'s `bin.redline` names exists; (3) every `out/….m?js` that an npm script runs exists; (4) every `*.mjs` that `dev.mts` and `bundle.mts` name in a string exists under `out/scripts/`; (5) the compiled CLI keeps its shebang. It reads `scripts/dev.mts` and `scripts/bundle.mts`, so it can only pass after Task 3 renames them.

- [ ] **Step 1: Write the guard**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

ANCHOR = "const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-'));\n"
GUARD = r"""// bin/ and scripts/ are TypeScript. A .js or .mjs left in either is compiled and never checked
// (checkJs is off), and nothing else would say it was forgotten. The other half is that every
// compiled path package.json hands to Node exists: scripts/ is .mts so that what it emits is
// the .mjs that every npm script, dev.mts and bundle.mts already name, and a file renamed to
// the wrong extension would otherwise be found by the first person to run that script.
{
  for (const dir of ['bin', 'scripts']) {
    const stray = fs.readdirSync(rootUrl(`${dir}/`)).filter((n) => /\.m?js$/.test(n));
    assert.deepStrictEqual(stray, [], `${dir}/ holds TypeScript only`);
  }
  const pkg = JSON.parse(fs.readFileSync(rootUrl('package.json'), 'utf8'));
  assert.ok(fs.existsSync(rootUrl(pkg.bin.redline)), `the CLI, ${pkg.bin.redline}, is emitted`);
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!/\bnode out\//.test(cmd)) continue;
    const named = cmd.match(/\bout\/[\w./-]+\.m?js\b/g);
    assert.ok(named, `${name} names a compiled file`);
    for (const rel of named) assert.ok(fs.existsSync(rootUrl(rel)), `${name}: ${rel} is emitted`);
  }
  // dev.mts and bundle.mts run their siblings by the compiled name, in a string tsc cannot check.
  for (const name of ['dev', 'bundle']) {
    const text = fs.readFileSync(rootUrl(`scripts/${name}.mts`), 'utf8');
    const siblings = [...text.matchAll(/'([\w-]+\.mjs)'/g)].map((m) => m[1]);
    assert.ok(siblings.length > 0, `${name}.mts runs a script by name`);
    for (const script of siblings) {
      assert.ok(fs.existsSync(rootUrl(`out/scripts/${script}`)), `${name} runs ${script}`);
    }
  }
  // tsc keeps a shebang, and npm marks the bin executable on install.
  const cli = fs.readFileSync(rootUrl(pkg.bin.redline), 'utf8');
  assert.ok(cli.startsWith('#!/usr/bin/env node\n'), 'the compiled CLI keeps its shebang');
  console.log('✓ bin/ and scripts/ are TypeScript, and the compiled paths npm runs exist');
}

"""
sub('test-smoke.js', ANCHOR, GUARD + ANCHOR)
PY
git diff --stat
```
Expected: `test-smoke.js | 33 +++…`, one file changed. (`rootUrl`, `fs` and `assert` are already imported at the top of the file.)

- [ ] **Step 2: Run it against the unconverted tree — it must fail**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && node_modules/.bin/tsc -b && node out/test-smoke.js 2>&1 | grep -m1 -A6 AssertionError
```
Expected: `AssertionError [ERR_ASSERTION]: bin/ holds TypeScript only`, with `'redline.js'` as the entry that should not be there. If it passes, the guard is not reading what it should: stop.

No commit yet: the suite is red, and a commit stays green.

---

### Task 3: Rename the 13 files and the test's source reads

**Files:**
- Rename: `bin/redline.js` → `bin/redline.ts`; `scripts/{build-dist,build-site,build-web,build-webapp,bundle,dev,make-icons,markdown-css,notices,serve-site,serve-webapp,stage-page}.mjs` → `.mts`
- Modify: `test-smoke.js` (15 source reads, one assertion message, two comments)

**Interfaces:**
- Consumes: nothing from earlier tasks but the guard.
- Produces: the 13 renamed files with nothing annotated, so that `tsc -b` shows the **23** errors the next two tasks remove.

- [ ] **Step 1: Rename**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
git mv bin/redline.js bin/redline.ts
for f in build-dist build-site build-web build-webapp bundle dev make-icons markdown-css notices serve-site serve-webapp stage-page; do
  git mv "scripts/$f.mjs" "scripts/$f.mts"
done
git ls-files bin scripts | grep -vcE '\.m?ts$'    # 0: nothing left that is not TypeScript
```
The last command prints `0` (and exits 1, since grep found no line: that is the answer wanted).

- [ ] **Step 2: Point the test's source reads at the new names**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
import pathlib, re
from ts3sub import sub

# A read of the source on disk: read('./scripts/x.mjs'), rootUrl('scripts/x.mjs'), fromRoot(...).
# Not import('./scripts/x.mjs') (compiled output, in out/) and not 'out/scripts/x.mjs' (a string).
RX = re.compile(r"""\b(read|rootUrl|fromRoot)\((['"])(\./)?scripts/([a-z-]+)\.mjs\2\)""")
p = pathlib.Path('test-smoke.js')
text, n = RX.subn(r'\1(\2\3scripts/\4.mts\2)', p.read_text(encoding='utf-8'))
assert n == 15, f'expected 15 source reads, found {n}'
p.write_text(text, encoding='utf-8')

sub('test-smoke.js', "where bundle.mjs leaves it", "where bundle.mts leaves it")
sub('test-smoke.js', "`stage-page.mjs` for the other two", "`stage-page.mts` for the other two")
sub('test-smoke.js', "// stage-page.mjs is the body of build:dist", "// stage-page.mts is the body of build:dist")
PY
grep -n "\.mjs" test-smoke.js | grep -E "(read|rootUrl|fromRoot)\(" ; echo "survivors above (expect none)"
```

- [ ] **Step 3: The bare compile — 23 errors**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
node_modules/.bin/tsc -b 2>&1 | grep -c 'error TS'
node_modules/.bin/tsc -b 2>&1 | grep -oE '^[a-z/.-]+\.m?ts' | sort | uniq -c
```
Expected: `23`, then

```
   2 bin/redline.ts
   1 scripts/dev.mts
  16 scripts/notices.mts
   2 scripts/serve-site.mts
   2 scripts/serve-webapp.mts
```
A different count means the baseline moved; stop and find out why before annotating anything.

---

### Task 4: `bin/redline.ts` and the two servers (23 → 17)

**Files:**
- Modify: `bin/redline.ts`, `scripts/serve-site.mts`, `scripts/serve-webapp.mts`

**Interfaces:**
- Produces: `interface Options { file: string | null; port: number; open: boolean; app: boolean; plantumlJar: string | null; help?: boolean }` (local to the CLI); `createSiteServer(root?: string): http.Server` and `createWebappServer(root: string): http.Server`, which the tests call.

- [ ] **Step 1: The CLI**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

B = 'bin/redline.ts'
sub(B, r"""import path from 'node:path';
import { spawn } from 'node:child_process';
""", r"""import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
""")
# `help` is set by one flag and read by main(), which an inferred options type has no key for.
sub(B, r"""function parseArgs(argv) {
  const opts = { file: null, port: 7391, open: true, app: false, plantumlJar: null };
""", r"""interface Options {
  file: string | null;
  port: number;
  open: boolean;
  app: boolean;
  plantumlJar: string | null;
  help?: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: null, port: 7391, open: true, app: false, plantumlJar: null };
""")
sub(B, "function openBrowser(url, appMode) {", "function openBrowser(url: string, appMode: boolean): void {")
sub(B, r"""function listen(server, port, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (err) => {
""", r"""function listen(server: Server, port: number, attempts = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number, left: number): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
""")
# A server listening on a TCP port has an AddressInfo; the type allows a pipe's string and null.
sub(B, "server.listen(p, '127.0.0.1', () => resolve(server.address().port));",
       "server.listen(p, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));")
PY
```
The two bare-compile errors in this file are the `help` key (read once and written once). `listen`'s `server` was an implicit `any` until it was typed, which is why the `ErrnoException` and the `AddressInfo` cast appear here without an error of their own: typing `server: Server` is what makes `err.code` and `.address().port` errors.

- [ ] **Step 2: The two servers**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

IMPORTS = r"""import path from 'node:path';
import { spawn } from 'node:child_process';
"""
IMPORTS_TYPED = r"""import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
"""
SEND = "    const send = (code, body, type = MIME['.txt']) => {"
SEND_TYPED = "    const send = (code: number, body: string | Buffer, type = MIME['.txt']): void => {"
REL = "    let rel;\n    try {\n"
REL_TYPED = "    let rel: string;\n    try {\n"
MIME = 'const MIME = {'
MIME_TYPED = 'const MIME: Record<string, string> = {'

S = 'scripts/serve-site.mts'
sub(S, IMPORTS, IMPORTS_TYPED)
sub(S, MIME, MIME_TYPED)
sub(S, r""" * @param {string} [root]  Default: site/.
 * @returns {import('node:http').Server}
 */
export function createSiteServer(root = SITE) {
""", r""" * @param root  Default: site/.
 */
export function createSiteServer(root = SITE): http.Server {
""")
sub(S, SEND, SEND_TYPED)
sub(S, REL, REL_TYPED)
sub(S, r"""  const port = await new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      server.once('error', (err) => {
""", r"""  const port = await new Promise<number>((resolve, reject) => {
    const tryPort = (p: number, left: number): void => {
      server.once('error', (err: NodeJS.ErrnoException) => {
""")
sub(S, "server.listen(p, '127.0.0.1', () => resolve(server.address().port));",
       "server.listen(p, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));")

W = 'scripts/serve-webapp.mts'
sub(W, IMPORTS, IMPORTS_TYPED)
sub(W, MIME, MIME_TYPED)
sub(W, "function ruleHeaders(root) {\n  let text;\n",
       "function ruleHeaders(root: string): Record<string, string> {\n  let text: string;\n")
sub(W, "  const headers = {};\n", "  const headers: Record<string, string> = {};\n")
sub(W, r""" * @param {string} root  The staged web app.
 * @returns {import('node:http').Server}
 */
export function createWebappServer(root) {
""", r""" * @param root  The staged web app.
 */
export function createWebappServer(root: string): http.Server {
""")
sub(W, SEND, SEND_TYPED)
sub(W, REL, REL_TYPED)
sub(W, "  server.once('error', (err) => {\n", "  server.once('error', (err: NodeJS.ErrnoException) => {\n")
sub(W, "${server.address().port}/`;", "${(server.address() as AddressInfo).port}/`;")
PY
```

- [ ] **Step 3: 23 → 17**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
node_modules/.bin/tsc -b 2>&1 | grep -c 'error TS'
node_modules/.bin/tsc -b 2>&1 | grep -oE '^[a-z/.-]+\.m?ts' | sort | uniq -c
```
Expected: `17`, then `1 scripts/dev.mts` and `16 scripts/notices.mts`. Nothing is committed yet.

---

### Task 5: `dev.mts` and `notices.mts` (17 → 0)

**Files:**
- Modify: `scripts/dev.mts`, `scripts/notices.mts`

**Interfaces:**
- Produces, in `notices.mts` (none exported, none used by another file): `LockEntry`, `NpmPackage`, `Notice`, `CargoPackage`, `CargoNode`, `CargoMetadata`. `inputsDigest(root?: string): string` stays the one export, which `test-smoke.js` calls.

- [ ] **Step 1: `dev.mts`**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

D = 'scripts/dev.mts'
sub(D, '@returns {boolean} Whether it succeeded', '@returns Whether it succeeded')
sub(D, 'const build = (script, quiet) => {', 'const build = (script: string, quiet: boolean): boolean => {')
sub(D, 'const stage = (quiet, web = true) =>', 'const stage = (quiet: boolean, web = true): boolean =>')
sub(D, 'const changed = (src) => (_event, file) => {',
       'const changed = (src: boolean) => (_event: string, file: string | null): void => {')
# process.on wants a signal name, and a literal array of strings is a string[].
sub(D, "for (const sig of ['SIGINT', 'SIGTERM']) {", "for (const sig of ['SIGINT', 'SIGTERM'] as const) {")
PY
```

- [ ] **Step 2: `notices.mts`**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

N = 'scripts/notices.mts'
INTERFACES = r"""/** The part of a package-lock.json entry this reads. */
interface LockEntry {
  name?: string;
  version: string;
  license?: string;
  dev?: boolean;
}

interface NpmPackage {
  dir: string;
  name: string;
  version: string;
  license?: string;
}

/** One row of the file, and the texts under it: what an npm package and a crate both come to. */
interface Notice {
  name: string;
  version: string;
  license?: string;
  source: string;
  texts: string[];
}

/** What `cargo metadata` answers, as far as this walks it. */
interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license?: string;
  repository?: string;
  manifest_path: string;
}

interface CargoNode {
  id: string;
  deps: { pkg: string; dep_kinds: { kind: string | null }[] }[];
}

interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { root: string; nodes: CargoNode[] };
}

"""
OUT_LINE = "const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');\n"
sub(N, OUT_LINE, INTERFACES + OUT_LINE)

sub(N, r"""function npmPackages(root = ROOT) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
""", r"""function npmPackages(root = ROOT): NpmPackage[] {
  const lock: { packages: Record<string, LockEntry> } = JSON.parse(
    fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
  );
""")
sub(N, 'function cargoLocked(root = ROOT) {', 'function cargoLocked(root = ROOT): string[] {')
sub(N, 'export function inputsDigest(root = ROOT) {', 'export function inputsDigest(root = ROOT): string {')
sub(N, 'function licenseTexts(dir) {\n  let names;\n',
       'function licenseTexts(dir: string): string[] {\n  let names: string[];\n')
sub(N, 'function npmEntries() {', 'function npmEntries(): Notice[] {')
sub(N, 'function cargoEntries() {\n  const found = new Map();\n',
       'function cargoEntries(): Notice[] {\n  const found = new Map<string, Notice>();\n')
sub(N, '    const meta = JSON.parse(\n', '    const meta: CargoMetadata = JSON.parse(\n')
# execFileSync answers a Buffer unless it is told an encoding, and JSON.parse wants a string.
sub(N, "{ cwd: path.join(ROOT, 'shell'), maxBuffer: 64 << 20 },",
       "{ cwd: path.join(ROOT, 'shell'), maxBuffer: 64 << 20, encoding: 'utf8' },")
sub(N, r"""    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
""", r"""    const byId = new Map(meta.packages.map((p): [string, CargoPackage] => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n): [string, CargoNode] => [n.id, n]));
""")
sub(N, '    const seen = new Set();\n', '    const seen = new Set<string>();\n')
sub(N, "const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);\n",
       "const byName = (a: Notice, b: Notice): number =>\n"
       "  a.name.localeCompare(b.name) || a.version.localeCompare(b.version);\n")
sub(N, "function render(npm, cargo) {\n  const out = [];\n  const line = (s = '') => out.push(s);\n",
       "function render(npm: Notice[], cargo: Notice[]): string {\n  const out: string[] = [];\n"
       "  const line = (s = ''): number => out.push(s);\n")
# A literal array of [string, Notice[]] pairs is inferred as (string | Notice[])[][], and
# destructuring that into a title and a list is the one thing it cannot do.
sub(N, r"""  for (const [title, list] of [
    ['The page (npm)', npm],
    ['The desktop shell (Rust crates)', cargo],
  ]) {
""", r"""  const sections: [string, Notice[]][] = [
    ['The page (npm)', npm],
    ['The desktop shell (Rust crates)', cargo],
  ];
  for (const [title, list] of sections) {
""")
sub(N, "  const texts = new Map();\n  const missing = [];\n",
       "  const texts = new Map<string, { text: string; who: string[] }>();\n  const missing: Notice[] = [];\n")
PY
```

- [ ] **Step 3: The compile is clean**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected: no output, then `tsc exit 0`. (Do not pipe `tsc` into `head` and then read `$?`: it is `head`'s status.)

---

### Task 6: Annotate the rest

**Files:**
- Modify: `scripts/stage-page.mts`, `scripts/build-webapp.mts`, `scripts/build-web.mts`, `scripts/bundle.mts`, `scripts/make-icons.mts`, `scripts/markdown-css.mts`

None of these has a compile error to fix, so nothing here is red-then-green: it is the part of the conversion that makes a later change to a signature fail at its caller. `stage-page.mts` goes first because `build-webapp.mts` imports a type from it.

**Interfaces:**
- Produces in `stage-page.mts`: `export type HostName = 'tauri' | 'web'`; `export interface StagedPage { dest: string; bytes: number; version: string | null }`; `HOSTS: Record<HostName, HostSpec>`; `stagePage(dest: string, { host }: { host: HostName }): StagedPage`; `buildVersion(): string`; `assertSafeDest(out: string, root?: string): void`; `bundleHash(buffers: Buffer[]): string`; `pageHash(dir: string, extra?: string): string`; `megabytes(bytes: number): string`.
- Consumes in `build-webapp.mts`: `StagedPage`, and gives back `buildWebapp(dest?: string): StagedPage`, `heldPaths(dir: string): string[]`, `headersFile(html: string, held?: string[]): string`.

- [ ] **Step 1: `stage-page.mts`**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

P = 'scripts/stage-page.mts'
sub(P, "const require = createRequire(import.meta.url);\n\n/**\n", r"""const require = createRequire(import.meta.url);

export type HostName = 'tauri' | 'web';

interface HostSpec {
  bundles: string[];
  shim: string | null;
  versioned: boolean;
}

/**
""")
sub(P, 'export const HOSTS = {', 'export const HOSTS: Record<HostName, HostSpec> = {')
sub(P, 'export const buildVersion = () =>', 'export const buildVersion = (): string =>')
sub(P, r""" * @param {string} out  Absolute.
 * @param {string} [root]  Default: this repository.
 */
export function assertSafeDest(out, root = ROOT) {
""", r""" * @param out  Absolute.
 * @param root  Default: this repository.
 */
export function assertSafeDest(out: string, root = ROOT): void {
""")
sub(P, r""" * @param {Buffer[]} buffers  In a fixed order.
 */
export function bundleHash(buffers) {
""", r""" * @param buffers  In a fixed order.
 */
export function bundleHash(buffers: Buffer[]): string {
""")
sub(P, r""" * @param {string} dir
 * @param {string} [extra]  What is part of the build and is not in `dir` yet.
 */
export function pageHash(dir, extra = '') {
  const h = crypto.createHash('sha256').update(`${extra.length}:${extra}`);
  const walk = (rel) =>
""", r""" * @param extra  What is part of the build and is not in `dir` yet.
 */
export function pageHash(dir: string, extra = ''): string {
  const h = crypto.createHash('sha256').update(`${extra.length}:${extra}`);
  const walk = (rel: string): string[] =>
""")
sub(P, r""" * @param {string} out  The staged page.
 * @param {string} version  From `pageHash`.
 */
function versionPage(out, version) {
""", r""" * @param out  The staged page.
 * @param version  From `pageHash`.
 */
function versionPage(out: string, version: string): void {
""")
sub(P, "/**\n * Write the page for `host` into `dest`, which is emptied first,", r"""export interface StagedPage {
  dest: string;
  bytes: number;
  version: string | null;
}

/**
 * Write the page for `host` into `dest`, which is emptied first,""")
sub(P, r""" * @param {string} dest  Relative to the repository root, or absolute. Not the repository.
 * @param {{ host: keyof typeof HOSTS }} opts
 * @returns {{ dest: string, bytes: number, version: string|null }}  The absolute path, what is
 *   in it, and the `?v=` its files are asked for by: null for a host that does not version them.
 */
export function stagePage(dest, { host }) {
""", r""" * @param dest  Relative to the repository root, or absolute. Not the repository.
 * @returns  The absolute path, what is in it, and the `?v=` its files are asked for by: null for
 *   a host that does not version them.
 */
export function stagePage(dest: string, { host }: { host: HostName }): StagedPage {
""")
sub(P, 'const size = (dir) =>', 'const size = (dir: string): number =>')
sub(P, 'export const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;',
       'export const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;')
PY
```

- [ ] **Step 2: `build-webapp.mts`**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

A = 'scripts/build-webapp.mts'
sub(A, "import { stagePage, megabytes } from './stage-page.mjs';",
       "import { stagePage, megabytes, type StagedPage } from './stage-page.mjs';")
sub(A, r""" * @param {string} dir  The staged page, before `_headers` is in it.
 */
export function heldPaths(dir) {
""", r""" * @param dir  The staged page, before `_headers` is in it.
 */
export function heldPaths(dir: string): string[] {
""")
sub(A, r""" * @param {string} html  The staged index.html.
 * @param {string[]} [held]  Paths a browser may keep for a year (`heldPaths`). Default: none.
 */
export function headersFile(html, held = []) {
""", r""" * @param html  The staged index.html.
 * @param held  Paths a browser may keep for a year (`heldPaths`). Default: none.
 */
export function headersFile(html: string, held: string[] = []): string {
""")
sub(A, r""" * @param {string} [dest]  Relative to the repository root, or absolute.
 * @returns {{ dest: string, bytes: number, version: string }}  `version` is the `?v=` the page's
 *   files are asked for by.
 */
export function buildWebapp(dest = WEB_DIST) {
""", r""" * @param dest  Relative to the repository root, or absolute.
 * @returns  `version` is the `?v=` the page's files are asked for by.
 */
export function buildWebapp(dest = WEB_DIST): StagedPage {
""")
PY
```

- [ ] **Step 3: `build-web.mts`, `bundle.mts`, `make-icons.mts`, `markdown-css.mts`**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

sub('scripts/build-web.mts', 'const kb = (n) => `${(n / 1024).toFixed(0)} KB`;',
                             'const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;')
sub('scripts/build-web.mts', '  const group = (file) => {', '  const group = (file: string): string => {')

U = 'scripts/bundle.mts'
sub(U, 'const env = (...names) => names.every((name) => process.env[name]);',
       'const env = (...names: string[]): boolean => names.every((name) => process.env[name]);')
sub(U, "const sh = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { stdio: 'inherit', cwd });",
       "const sh = (cmd: string, args: string[], cwd = ROOT) =>\n"
       "  execFileSync(cmd, args, { stdio: 'inherit', cwd });")
sub(U, r"""const du = (p) => execFileSync('du', ['-sh', p]).toString().split('\t')[0].trim();
const mb = (p) => (fs.statSync(p).size / 1e6).toFixed(1);
""", r"""const du = (p: string): string => execFileSync('du', ['-sh', p]).toString().split('\t')[0].trim();
const mb = (p: string): string => (fs.statSync(p).size / 1e6).toFixed(1);
""")

I = 'scripts/make-icons.mts'
sub(I, 'const ICNS_SIZES = [', 'const ICNS_SIZES: [string, number][] = [')
sub(I, 'function render(size) {', 'function render(size: number): Buffer {')
sub(I, 'function icns(entries) {', 'function icns(entries: [string, Buffer][]): Buffer {')
sub(I, "const entries = ICNS_SIZES.map(([type, size]) => [type, size === 1024 ? png1024 : render(size)]);\n",
       r"""const entries = ICNS_SIZES.map(([type, size]): [string, Buffer] => [
  type,
  size === 1024 ? png1024 : render(size),
]);
""")

sub('scripts/markdown-css.mts', r""" * @param {string} css  github-markdown-css's `github-markdown.css`.
 * @returns {string}
 */
export function keyToScheme(css) {
""", r""" * @param css  github-markdown-css's `github-markdown.css`.
 */
export function keyToScheme(css: string): string {
""")
PY
node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected: `tsc exit 0`. The annotations are the point of this task, so also check that they are in: `git diff HEAD --stat -- scripts bin | tail -n 1` should report `13 files changed`, about 170 insertions and 100 deletions.

---

### Task 7: Every other mention of the old names

**Files:**
- Modify: `.github/workflows/ci.yml`, `.gitignore`, `public/styles.css`, `src/hosts/node/server.ts`, `src/hosts/tauri/backend.ts`, `src/hosts/web/backend.ts`, `src/hosts/web/host.js`, `package-lock.json`, the comments in nine of the scripts, `docs/architecture.md`, `docs/building.md`, `docs/typescript.md`

A comment that names `scripts/build-web.mjs` sends a reader to a file that is no longer there, so it is renamed. What is **not** renamed is anything that names compiled output: an import specifier (`./stage-page.mjs`), `out/scripts/…`, and the strings that `dev.mts` and `bundle.mts` hand to a child process.

- [ ] **Step 1: The rest of the repository, the lockfile and the scripts' own comments**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

sub('.github/workflows/ci.yml', '`scripts/bundle.mjs`', '`scripts/bundle.mts`')
sub('.gitignore', '# Built by scripts/build-web.mjs, from src/.', '# Built by scripts/build-web.mts, from src/.')
sub('.gitignore', '# Copied into the landing page by scripts/build-site.mjs, from assets/.',
                  '# Copied into the landing page by scripts/build-site.mts, from assets/.')
sub('public/styles.css', 'dark palette (scripts/markdown-css.mjs)', 'dark palette (scripts/markdown-css.mts)')
sub('src/hosts/node/server.ts', "page's scheme (scripts/markdown-css.mjs)", "page's scheme (scripts/markdown-css.mts)")
sub('src/hosts/tauri/backend.ts', 'by scripts/build-web.mjs, and', 'by scripts/build-web.mts, and')
sub('src/hosts/web/backend.ts', '(`stage-page.mjs`, after `host.js`)', '(`stage-page.mts`, after `host.js`)')
sub('src/hosts/web/host.js', '(`stage-page.mjs`) so that', '(`stage-page.mts`) so that')

# The lockfile's root package has named the source file since before step 1 moved the CLI to out/.
sub('package-lock.json', '"redline": "bin/redline.js"', '"redline": "out/bin/redline.js"')

sub('scripts/build-dist.mts', 'stage-page.mjs does the staging', 'stage-page.mts does the staging')
sub('scripts/build-web.mts', "system's (markdown-css.mjs)", "system's (markdown-css.mts)")
sub('scripts/build-webapp.mts', '(stage-page.mjs) for a host', '(stage-page.mts) for a host')
sub('scripts/build-webapp.mts', '`stage-page.mjs` writes', '`stage-page.mts` writes')
sub('scripts/markdown-css.mts', '(scripts/markdown-css.mjs)', '(scripts/markdown-css.mts)')
sub('scripts/serve-webapp.mts', 'serve-site.mjs does not', 'serve-site.mts does not')
S = 'scripts/stage-page.mts'
sub(S, 'built by build-web.mjs, for every host', 'built by build-web.mts, for every host')
sub(S, 'keyed by markdown-css.mjs)', 'keyed by markdown-css.mts)')
sub(S, 'built by build-web.mjs, *this host', 'built by build-web.mts, *this host')
sub(S, 'stage-page.mjs is out of date', 'stage-page.mts is out of date')
PY
```

- [ ] **Step 2: The docs**

The docs name scripts constantly. A regex does the bulk, with a lookbehind so that `out/scripts/build-web.mjs` (the compiled path) is left alone, and each file's count is asserted: a different number means a mention this plan did not know about, which needs a human look, not a quiet rewrite.

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
import pathlib, re
from ts3sub import sub

RX = re.compile(r'(?<!out/scripts/)\b(build-dist|build-site|build-web|build-webapp|bundle|dev|'
                r'make-icons|markdown-css|notices|serve-site|serve-webapp|stage-page)\.mjs\b')
for doc, expected in [('docs/architecture.md', 20), ('docs/building.md', 13), ('docs/typescript.md', 4)]:
    p = pathlib.Path(doc)
    text, n = RX.subn(r'\1.mts', p.read_text(encoding='utf-8'))
    assert n == expected, f'{doc}: expected {expected} script names, renamed {n}'
    p.write_text(text, encoding='utf-8')

sub('docs/architecture.md', 'bin/redline.js          CLI:', 'bin/redline.ts          CLI:')
PY
git grep -n 'bin/redline\.js' -- docs README.md | grep -v 'out/bin/redline'
```
Expected: one line, `docs/typescript.md:24`, which Task 9 rewrites to `out/bin/redline.js`. The `.mjs` that remain in the docs are Mermaid's chunk files and the compiled `out/scripts/…` paths.

---

### Task 8: Verify, then commit the code

**Files:**
- Commit: the 13 renames, `test-smoke.js` and everything Task 7 touched (25 files)

- [ ] **Step 1: The compile, and line lengths**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
node_modules/.bin/tsc -b; echo "tsc exit $?"
awk 'length > 100 {print FILENAME":"FNR}' bin/redline.ts scripts/*.mts
git diff HEAD -U0 -- test-smoke.js | grep '^+' | awk 'length > 101' | wc -l
```
Expected: `tsc exit 0`; `bin/redline.ts:69` and `bin/redline.ts:110` (both were already over, and the rename does not move them), and `0` new long lines in the test.

- [ ] **Step 2: Nothing that should be renamed was missed**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
git grep -nE '(build-dist|build-site|build-web|build-webapp|bundle|dev|make-icons|markdown-css|notices|serve-site|serve-webapp|stage-page)\.mjs' \
  -- . ':!package.json' ':!package-lock.json' ':!docs/superpowers' | grep -vE "from '\./" | cut -d: -f1 | uniq -c
```
Expected: five files, `docs/building.md` 1, `docs/typescript.md` 1, `scripts/bundle.mts` 2, `scripts/dev.mts` 1 and `test-smoke.js` 12. The docs' one each is the `out/scripts/…` example in the table of compiled paths; `bundle.mts` and `dev.mts` are the names they hand to `node`; the test's twelve are seven `await import('./scripts/x.mjs')` and five `npm run`/`node out/scripts/x.mjs` strings, all of which name compiled output.

Every one of those names compiled output. A mention in a comment or a doc anywhere else is a miss.

- [ ] **Step 3: The suite, with the guard now green**

With the sandbox off:

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && npm test 2>&1 | tee /tmp/claude-502/ts3-after.log | grep -c '^✓'; tail -n 1 /tmp/claude-502/ts3-after.log
grep -n 'bin/ and scripts/ are TypeScript' /tmp/claude-502/ts3-after.log
```
Expected: the count from Task 1 plus one, `all smoke tests passed`, and the guard's line.

- [ ] **Step 4: A wrong extension must fail the guard**

The guard's `out/` checks only mean something on a clean `out/` (a stale one still has the old file), so this moves it aside instead of deleting it. It is one block, with its `cd` first, because the second half moves directories: run from the wrong place it would move some other checkout's `out/`.

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
KEEP=/tmp/claude-502/ts3-out-keep-$(date +%s)
mv out "$KEEP"
git mv scripts/make-icons.mts scripts/make-icons.ts      # emits make-icons.js, and package.json says .mjs
node_modules/.bin/tsc -b && node out/test-smoke.js 2>&1 | grep -m1 -A2 AssertionError

# Put everything back. The mutant's out/ is kept aside, not deleted.
mv out "$KEEP-mutant"
mv "$KEEP" out
git mv scripts/make-icons.ts scripts/make-icons.mts
node_modules/.bin/tsc -b; echo "tsc exit $?"; git status --short scripts | grep -c '^R'
```
Expected: first `AssertionError [ERR_ASSERTION]: icons: out/scripts/make-icons.mjs is emitted`; then `tsc exit 0` and `12` (the twelve renamed `scripts/`; `make-icons` is a rename again, and is counted in that twelve). If the `AssertionError` line is missing, the guard did not catch the wrong extension: the rest of the PR is not trustworthy until it does.

- [ ] **Step 5: `notices.mts` still writes the same file**

This is the one script that runs `cargo`, so it is the only check of `cargoEntries`, the edit with the most casts-by-annotation in it.

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
CARGO_NET_OFFLINE=true npm run notices 2>&1 | tail -n 1
git status --short THIRD-PARTY-NOTICES.md; echo "(nothing above: byte-identical)"
```
Expected: a `THIRD-PARTY-NOTICES.md: N npm, N crates, N KB` line and no status line. If cargo cannot run offline here, say so in the hand-over instead of claiming this was checked.

- [ ] **Step 6: The three servers listen**

The casts in the CLI and the two servers are on the code path that picks a port, and the suite reaches the servers' handlers and not their `main()`. With the sandbox off:

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
probe() {  # probe <port> <command...>: start it, ask for / over http, stop it
  local port=$1; shift
  "$@" >/tmp/claude-502/ts3-probe.log 2>&1 &
  local pid=$!
  sleep 2
  curl -s -o /dev/null -w "port $port: HTTP %{http_code}\n" "http://127.0.0.1:$port/"
  kill $pid
  wait $pid 2>/dev/null
}
probe 47391 node out/bin/redline.js --no-open -p 47391 sample.md
probe 47392 node out/scripts/serve-site.mjs --no-open -p 47392
npm run build:webapp 2>&1 | grep -v '^$' | tail -n 1
probe 47393 node out/scripts/serve-webapp.mjs --no-open -p 47393
npm run build:site 2>&1 | grep -v '^$' | tail -n 1

# build:site also points site/index.html's download link at package.json's version (it has always
# done that, and the file is tracked). That is not this PR's change: keep it as a patch, then undo it.
git diff --stat -- site/index.html | tail -n 1
git diff site/index.html > /tmp/claude-502/ts3-site-version.patch
git checkout -- site/index.html
git status --short -- site; echo "(nothing above: site/ is back as committed)"
```
Expected: three lines ending `HTTP 200`, with `dist/web  5.9 MB` (the size is the dry run's) between the second and the third and `site/icon.svg, site/icon.png` after them, then `1 file changed, 2 insertions(+), 2 deletions(-)` for `site/index.html`, and nothing under `site/` in the status: both builds end in a blank line, which is why they are filtered. The two lines in that diff are the version in the link and in the button (`0.6.0` to `0.7.0` here); if the diff is anything else, stop and look before undoing it. If a port is taken, pick another; the CLI would walk to the next one by design, and the other two exit.

- [ ] **Step 7: The bundle**

With the sandbox off:

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && CARGO_NET_OFFLINE=true npm run bundle 2>&1 | tail -n 6
```
Expected: it ends by printing `dist/Redline.app` (about 8.7M) and the `.dmg` (about 3.3 MB). `bundle.mts` runs `build-web.mjs` and `build-dist.mjs` by their compiled names, so this is also the check that those exist.

- [ ] **Step 8: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
git add bin/redline.ts scripts/*.mts test-smoke.js package-lock.json .gitignore \
  .github/workflows/ci.yml public/styles.css docs/architecture.md docs/building.md docs/typescript.md \
  src/hosts/node/server.ts src/hosts/tauri/backend.ts src/hosts/web/backend.ts src/hosts/web/host.js
git status --short | grep -v '^??' | cut -c1-2 | sort | uniq -c
git commit -F - <<'EOF'
Convert bin/ and scripts/ to TypeScript

bin/redline.js is bin/redline.ts and each scripts/*.mjs is a .mts, so tsc checks the
build and release tooling the way it already checks src/. A .mts compiles to the .mjs that
package.json, dev.mts, bundle.mts and the tests already name, so no script's path changes;
bin/redline.ts compiles to the out/bin/redline.js that package.json's bin already names.

The bare rename gave 23 errors in five files. 21 were a property the inferred type did not
have (read off an unknown, an Error, a server's address or an options object); the other two
were a string where a signal name was wanted and a Buffer where JSON.parse wanted a string.
They are fixed with interfaces for what is read (six in notices.mts, Options in the CLI),
typed signatures, NodeJS.ErrnoException on the three 'error' listeners, as const on a signal
list, encoding: 'utf8' where a Buffer was parsed as JSON, and three as AddressInfo casts
where a server listens on a TCP port.

A test holds the layout: no .js or .mjs left in bin/ or scripts/, and every compiled path
that package.json, dev.mts and bundle.mts hand to node exists.

Also corrects package-lock.json's bin entry, which still named the source file, and every
comment and doc that named a script by its old extension.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
git status --short | grep -v '^??'; git log --oneline -n 2
git show --stat --format= HEAD | tail -n 1
```
The last line is `25 files changed, 279 insertions(+), 173 deletions(-)`. The second line of the block prints the staged counts before the commit: `13 R` and `12 M`. After it, the status is empty and the log shows the new commit on `dc75d88`. (`git commit -F -` reads the message from the heredoc, because the macOS `bash` 3.2 cannot parse an apostrophe inside `$(cat <<EOF … )`, and this message has two.)

---

### Task 9: The prose, and what it cost

**Files:**
- Modify: `docs/typescript.md`

**Interfaces:**
- Consumes: the facts above — the extension decision, the 23 errors and where they came from, the guard.

- [ ] **Step 1: Measure**

Nothing else may be running that loads from `out/` (no suite, no bundle). Run each three times and take the middle value:

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
for i in 1 2 3; do /usr/bin/time -p node_modules/.bin/tsc -b --force 2>&1 | grep real; done
for i in 1 2 3; do /usr/bin/time -p node_modules/.bin/tsc -b 2>&1 | grep real; done
for i in 1 2 3; do /usr/bin/time -p npm run build:ts --silent 2>&1 | grep real; done
```
The dry run of this plan measured medians of 0.98 s, 0.06 s and 0.17 s (the three rows, in order). If yours are within 0.1 s, 0.02 s and 0.05 s of those, the table in the next step stands as written; otherwise change its Step 3 column to what you measured, and say so in the hand-over.

- [ ] **Step 2: Edit the page**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && python3 - <<'PY'
import sys; sys.path.insert(0, '/tmp/claude-502')
from ts3sub import sub

T = 'docs/typescript.md'

# Where the project is.
sub(T, r"""below. `bin/`,
`scripts/`, the test and the page are still JavaScript. A `.js` file is not type-checked
""", r"""below. Step 3
converted `bin/` and `scripts/`. The test and the page (`public/`, `site/`) are still
JavaScript. A `.js` file is not type-checked
""")
sub(T, "`node bin/redline.js` from a fresh", "`node out/bin/redline.js` from a fresh")

# The decision a reader of scripts/ has to know first.
sub(T, "## The projects\n", r"""## Extensions

`bin/redline.ts` and `scripts/*.mts`. A `.mts` compiles to `.mjs`, the names that every npm
script, `dev.mts` and `bundle.mts` ran when these were JavaScript (`node
out/scripts/build-web.mjs`), so nothing that names a script had to change; a plain `.ts` would
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
[Two things that look like bugs](#two-things-that-look-like-bugs).

## The projects
""")

# What step 3 needed.
sub(T, "## Finding the repository root\n", r"""Step 3 had less to find. Renaming `bin/` and `scripts/` and running `tsc` gave 23 errors in
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

## Finding the repository root
""")
sub(T, "Renaming every file at once and running `tsc` gave", "Renaming every file in `src/` at once and running `tsc` gave")

# The ladder.
sub(T, "3. `scripts/` and `bin/`.\n",
       "3. `scripts/` and `bin/` (done), as `.mts` and `.ts`; see [Extensions](#extensions).\n")

# The cost.
sub(T, r"""Measured with `tsc` 5.9.3 on an arm64 Mac at the end of step 2, over the 37 `.ts` files in
`src/` and the JavaScript that is compiled beside them, checked leniently:

| | Step 1 (50 files, none checked) | Step 2 |
| --- | --- | --- |
| Rebuild everything (`tsc -b --force`; step 1 was from no `out/`) | about 0.9 s | about 1.0 s |
| Up to date, `tsc -b` itself | about 0.06 s | about 0.06 s |
| Up to date, as `npm run build:ts` | about 0.16 s | about 0.18 s |
""", r"""Measured with `tsc` 5.9.3 on an arm64 Mac at the end of each step: step 2 over the 37 `.ts`
files in `src/`, step 3 over those and the 13 in `bin/` and `scripts/`, with the JavaScript
that is compiled beside them, checked leniently:

| | Step 1 (50 files, none checked) | Step 2 | Step 3 |
| --- | --- | --- | --- |
| Rebuild everything (`tsc -b --force`; step 1 was from no `out/`) | about 0.9 s | about 1.0 s | about 1.0 s |
| Up to date, `tsc -b` itself | about 0.06 s | about 0.06 s | about 0.06 s |
| Up to date, as `npm run build:ts` | about 0.16 s | about 0.18 s | about 0.17 s |
""")
sub(T, r"""the noise of the measurement, and does not touch a no-op. `strict` will cost more; step 6
measures it.
""", r"""the noise of the measurement, at step 2 or at step 3, and does not touch a no-op. `strict`
will cost more; step 6 measures it.
""")
PY
awk 'length > 100 {print FILENAME":"FNR}' docs/typescript.md
```
Expected: seven lines, all of them table rows, which do not wrap: the six that were already over 100 (the "Two homes" and contract tables) and the cost table's first row, which the new column took to 110. Any other line needs rewrapping.

- [ ] **Step 3: Read it once**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts && git diff -- docs/typescript.md
```
Check by eye that the new section reads as the page's neighbours do, that no sentence says more than the checks above showed, and that nothing says "step 3 will". Then:

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
git add docs/typescript.md
git commit -F - <<'EOF'
Document the .mts decision and what step 3 found

Why scripts/ is .mts, how an import names a compiled file, what the layout test holds, the 23
errors the rename gave and what fixed each, and what a rebuild costs now.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
git log --oneline -n 2
```

---

### Task 10: Evidence and hand-over

- [ ] **Step 1: Re-run what the claim rests on, on the committed tree**

```bash
cd /tmp/claude-502/redlineapp-ts3-scripts
git status --short | grep -v '^??'; echo "(clean above)"
node_modules/.bin/tsc -b; echo "tsc exit $?"
git ls-files bin scripts | sed 's/.*\.//' | sort | uniq -c
git diff --stat origin/typescript..HEAD | tail -n 1
git log --oneline origin/typescript..HEAD
```
Then `npm test` once more with the sandbox off (count, and `all smoke tests passed`), and `CARGO_NET_OFFLINE=true npm run bundle` if anything changed after Task 8's run (the second commit is prose only, so it does not need one).

Expected: a clean tree, `tsc exit 0`, `1 ts` and `12 mts`, a diffstat of about 25 files, and two commits.

- [ ] **Step 2: Hand over**

Say, in this order, and nothing the checks above did not show:

1. What was run, with its result: `tsc` exit 0, `npm test` and its count, `npm run bundle` (sizes), `npm run notices` byte-identical, the three servers answering 200, `build:site`.
2. What was **not** run and what that leaves open: the native window was never launched; nothing visual was looked at; `pages.yml` runs only on a push to the landing page and has not run (`npm run build:site` covers its compile); the Windows and Linux branches of `openBrowser` are compiled and not executed.
3. The decision for the PR description: `.mts`/`.ts`, why, and that it differs from the spec's §3 example (`out/scripts/build-web.js`), which predates step 1's `.mjs` names.
4. That `CLAUDE.md` and `skills/` are gitignored and were not touched: they still say `bin/redline.js` and that there is no transpiler, and are the owner's to update.
5. The PR base: **`typescript`**, not `main`, merged with a merge commit.

Then use **superpowers:finishing-a-development-branch**: verify the suite, present the options, and wait. Do not push, open the PR or delete the worktree unasked.

---

## Self-review

**Spec coverage.**

| Spec | Where |
| --- | --- |
| §1 compiled code lives in `out/`; `bin` points at `out/bin/redline.js` | Task 3 renames to what emits those names; Task 2 asserts `package.json`'s `bin` and every `out/…` an npm script names exist; Task 7 corrects the lockfile's `bin`, which still named the source |
| §2 `node` project holds `bin/`, `scripts/`; lenient, annotate signatures, no `noImplicitAny` | no tsconfig change is needed (Global Constraints); Tasks 4–6 |
| §3 build order: every script runs from `out/`, compiling first | already true from step 1; Task 8 steps 3, 6, 7 run them from `out/`. The spec's example `node out/scripts/build-web.js` is `.mjs` in the code step 1 shipped, and this plan keeps `.mjs`; stated in Global Constraints and Task 10 |
| §4 tests: `test-smoke.js` runs from `out/`, reads source by path | Task 3 renames its 15 source reads, one message and two comments; dynamic imports and `out/…` strings stay |
| §5 step 3, one PR with `npm test` and `npm run bundle`, docs in the same PR | Tasks 1–10; docs in Tasks 7 and 9 |
| §5 behaviour that must not change | no logic edit anywhere: every edit is an annotation, an interface, a cast with a stated reason, `as const`, one `encoding: 'utf8'`, or a rename; Task 8 steps 5–7 run the three things the suite does not reach |

**Placeholder scan.** No step says "similar to" or leaves an edit to the reader: every change is a `sub()` call with its old and new text, and `sub()` fails on a count other than the one expected, so a stale anchor stops the task instead of editing something else. The two measured values (the test count from Task 1, the cost figures in Task 9) are filled in from a command in the step before.

**Type consistency.** `StagedPage` is defined in `stage-page.mts` (Task 6, step 1) and imported by `build-webapp.mts` (step 2), in that order for that reason. `HostName` is used by `HOSTS` and `stagePage`; `Options` stays local to the CLI. `createSiteServer(root?: string): http.Server` and `createWebappServer(root: string): http.Server` are what the tests call. `inputsDigest(root?: string): string` is `notices.mts`'s only export. The `AddressInfo` import is `import type` in all three files.

**Known risks and what is not verified.**
- Everything that needs a window (the Tauri shell, the visual result of anything) was not run; this PR changes no page code.
- The guard's `out/` checks are only as honest as `out/` is clean. CI is; a local `out/` is not, which is why Task 8, step 4 moves it aside.
- `skills/redline-shipping` and `redline-testing` and `CLAUDE.md` describe `scripts/*.mjs`; they are gitignored, outside this PR and outside this agent's write access.
- Unverified, and outside this PR's scope: `Platform`'s docs say `spawn` always resolves, and `tauri/platform.ts` may reject when the program cannot start. `fonts.ts` catches that; `git.ts` does not, and `reader.ts` calls `git.info` when it opens a document, so a Tauri window with no `git` on `PATH` might fail to open a file. Raise it as its own issue.
- A local `typescript` branch does not exist: use `origin/typescript` wherever this plan compares against the base.