# TypeScript step 2: `src/` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert all of `src/` to `.ts` (except one classic-script shim) and give the three hosts one set of shared types — the document payload, the reader events, the session, the page-facing `Backend`, `Platform` and the rpc messages — so that drift between Node, Tauri and the web fails `tsc`.

**Architecture:** A new type-only layer, `src/contract/`, holds what the layers agree on (payload, events, `Session`, `Backend`); every layer may `import type` from it and it imports only itself. `Platform` lives in `src/reader/platform.ts` and the rpc messages in `src/rpc/protocol.ts`, each next to the code that owns them. Three stacked stages, each its own branch and PR into `typescript` and each green on its own: **A** contract + core + page + rpc, **B** reader, **C** the three hosts. Files are renamed with `git mv` in the same commit as the annotations that make them compile; `allowJs` lets converted and unconverted files coexist between commits.

**Tech Stack:** TypeScript 5.9.3 (`tsc -b`, `strict: false`), esbuild 0.28 (bundles `src/` directly, never reads `out/`), Node 22 in CI.

**Spec:** `docs/superpowers/specs/2026-10-11-typescript-conversion-design.md` (§2 the contract and the ratchet, §4 tests, §5 the ladder). Step 1's plan, `2026-10-11-typescript-scaffolding.md`, landed as PR #29.

## Global Constraints

- Behaviour does not change at any step: `npm test` and `npm run bundle` are green at the end of every task that commits.
- `strict: false`. Annotate what crosses a layer (exported functions, the contract) and what `tsc` refuses; leave internals inferred. `noImplicitAny` is a later PR (step 6).
- The `src` project has **no node types** (`types: []`): nothing under `core/`, `page/`, `reader/`, `rpc/`, `contract/` or `hosts/{tauri,web}/` may name a node global. `src/hosts/node/` is in the `node` project.
- Layering (`test-smoke.js`, "layering"): `core/` imports `core/`; `page/` adds `page/`; `reader/` imports `core/` and `reader/`; `rpc/` imports only `rpc/`; hosts import any layer and themselves, never another host. **This plan adds `contract/`: importable by every layer as `import type`, imports only itself.**
- Imports keep the `.js` extension in `.ts` sources (NodeNext). esbuild resolves `./x.js` to `x.ts` from either kind of importer (verified).
- **`src/hosts/web/host.js` stays JavaScript.** It is a classic script that `scripts/stage-page.mjs` copies verbatim into the page; `tsc` treats every file in this package as a module and appends `export {};` to its output (verified), a `SyntaxError` in a classic script.
- Source reads in `test-smoke.js` (`rootUrl('src/…')`, `read('./src/…')`) name the file on disk, so they change to `.ts` when a file is renamed. `import('./src/….js')` in the test loads compiled output from `out/` and does not change.
- `tsc -b` never prunes `out/`. A renamed file keeps its `.js` output name, so a rename leaves nothing stale; if a file is ever deleted, `rm -rf out` before the next build.
- 2-space indent, single quotes, trailing commas, 100 columns soft. Comments say why, not what. Check line length with `awk 'length > 100 {print FILENAME":"FNR}' <files>`; `npx prettier` does not work here.
- Docs change in the same commit as the code they describe (`docs/architecture.md` module map and layering paragraph, `docs/typescript.md` ladder).
- Run `node_modules/.bin/tsc` directly (`npx` tries the network). `npm test` and `npm run bundle` need `dangerouslyDisableSandbox: true` (the test binds `127.0.0.1`). The shell cwd resets every call, so `cd` first.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not push or open a PR; that is the user's call.

**Working tree:** `/tmp/claude-502/redlineapp-ts2` (worktree, `node_modules` symlinked). Stage A on branch `typescript-core-types` (at `69d375e`, the merged step 1); stage B on `typescript-reader` cut from A; stage C on `typescript-hosts` cut from B. Every command below starts with `cd /tmp/claude-502/redlineapp-ts2`.

**Measured before starting:** renaming all 36 files at once with no annotations gives **116** `tsc` errors in 19 files (95 × TS2339 property-does-not-exist, 9 × TS2554 arity, 4 × TS2353, 2 × TS2349, 2 × TS2304, one each of TS2591, TS2488, TS2345, TS2322). Report the real final number in the PR.

---

## Stage A: contract, core, page, rpc (`typescript-core-types`)

### Task 1: The layering test learns `contract/` and `.ts` (test first)

**Files:**
- Modify: `test-smoke.js:375-458` (the layering block)

**Interfaces:**
- Produces: `forbidden(file, spec)` that allows `contract` as an import target from every layer and allows `contract/` itself to import nothing; a walk that sees `.ts`; an assertion that `contract/` exports only types and is only ever imported with `import type`.

- [ ] **Step 1: Record the baseline**

```bash
cd /tmp/claude-502/redlineapp-ts2 && git switch typescript-core-types && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Then run `npm test 2>&1 | tee /tmp/claude-502/ts2-base.log | grep -c '^✓'` with the sandbox off. Expected: `tsc exit 0`, and a count N; note N (the suite had 116 checks at the end of step 1).

- [ ] **Step 2: Write the failing assertions**

In `test-smoke.js`, replace the walk, the `forbidden` rule and the existence check:

```js
const srcFiles = (dir = '') =>
  fs.readdirSync(path.join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? srcFiles(rel) : /\.(js|ts)$/.test(rel) ? [rel] : [];
  });
```

In `forbidden`, the package branch and the table:

```js
  if (!spec.startsWith('.')) {
    return ['reader', 'rpc', 'contract'].includes(from)
      ? 'reader/, rpc/ and contract/ import no packages'
      : null;
  }
  const to = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
  const target = layerOf(to);
  if (to.startsWith('..')) return 'leaves src/';
  // `contract/` is in every list: it is types only, and an `import type` of it costs a bundle
  // nothing. It imports only itself, so that it can be reached from the layers that may import
  // almost nothing.
  const allowed = {
    contract: ['contract'],
    core: ['core', 'contract'],
    page: ['core', 'page', 'contract'],
    reader: ['core', 'reader', 'contract'],
    rpc: ['rpc', 'contract'],
  }[from] ?? ['core', 'page', 'reader', 'rpc', 'contract', from];
```

The existence check, because a `./x.js` specifier is now `x.ts` on disk:

```js
const there = (to) =>
  [to, to.replace(/\.js$/, '.ts')].some((f) => fs.existsSync(path.join(SRC, f)));
```
and use `if (!there(to)) layerBreaks.push(...)` in place of the `fs.existsSync` line. Widen the layer assertion's regex to `^(core|page|reader|rpc|contract)\/|^hosts\/[a-z]+\/`.

Add to the "has to be able to fail" lists: refused `['contract/payload.ts', '../core/diff.js']`, `['contract/payload.ts', 'markdown-it']`, `['rpc/client.ts', '../reader/session.js']` (already there, keep); allowed `['rpc/client.ts', '../contract/seam.js']`, `['core/diff.ts', '../contract/payload.js']`, `['hosts/tauri/backend.ts', '../../contract/seam.js']`.

After the `console.log('✓ the import graph obeys the layers');` line add:

```js
// contract/ is types and nothing else, so importing it adds nothing to a bundle: it exports no
// value, and everything that imports it says `import type`, which tsc and esbuild both erase.
const contractFiles = layered.filter((f) => f.startsWith('contract/'));
assert.ok(contractFiles.length >= 2, 'the contract layer exists (payload.ts, seam.ts)');
const valueExports = [];
const valueImports = [];
for (const f of layered) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  if (f.startsWith('contract/')) {
    for (const m of text.matchAll(/^export\s+(?!type\b|interface\b|declare\b)(\w+)/gm)) {
      valueExports.push(`src/${f} exports a value: ${m[1]}`);
    }
  }
  for (const m of text.matchAll(
    /^\s*import\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"]*\/contract\/[^'"]+)['"]/gm,
  )) {
    valueImports.push(`src/${f} imports ${m[1]} without \`type\``);
  }
}
assert.deepStrictEqual(valueExports, [], 'contract/ exports only types');
assert.deepStrictEqual(valueImports, [], 'contract/ is imported with import type');
console.log('✓ contract/ is types only, and imported as such');
```

- [ ] **Step 3: Run it and watch it fail**

`npm test` (sandbox off). Expected: FAIL at `the contract layer exists (payload.ts, seam.ts)`.

- [ ] **Step 4: Commit the red test? No.** Leave it uncommitted; Task 2 turns it green and they land together.

### Task 2: Write the contract

**Files:**
- Create: `src/contract/payload.ts`
- Create: `src/contract/seam.ts`

**Interfaces:**
- Produces (all `export`ed types, no values):
  - from `payload.ts`: `Caps`, `GitRef`, `HistoryRow`, `AckedVersion`, `DocPayload`, `PrunedPayload`, `ReaderEvent`, `PlantumlResult`
  - from `seam.ts`: `AckOptions`, `WatchHandlers`, `Session`, `Backend`

- [ ] **Step 1: `src/contract/payload.ts`**

```ts
// The shapes the reader produces and every page consumes, written down once.
//
// Types only, and kept that way by a test (test-smoke.js, "layering"): any layer may import this,
// including the ones that may import almost nothing, and importing it adds nothing to a bundle.
// What the payload *means* is in docs/architecture.md and docs/changes.md; this is its shape,
// which `buildDoc` in src/reader/reader.js is checked against.

/** What this host can do at all, as opposed to `tracked`, which is about one file. */
export interface Caps {
  git: boolean;
  plantuml: boolean;
}

/** The commit a version came from, when git is where the history found it. */
export interface GitRef {
  sha: string;
  subject: string;
}

/** One version in the history list. `current` and `baseline` follow the file; the rest is the version. */
export interface HistoryRow {
  hash: string;
  ts: number;
  size: number | null;
  /** Bytes against the version before it, or null when either size is not known. */
  delta: number | null;
  current: boolean;
  baseline: boolean;
  git: GitRef | null;
}

/** A version that check-offs were made in, with the blocks checked in it. */
export interface AckedVersion {
  hash: string;
  text: string;
  blocks: string[];
}

/** The document as the reader sends it. The page renders it; the reader never does. */
export interface DocPayload {
  id: string;
  path: string;
  name: string;
  dir: string;
  dirLabel: string;
  pathLabel: string;
  hash: string;
  mtime: number | null;
  text: string;
  /** Null when there is nothing to compare against, which is not the same as an empty baseline. */
  base: string | null;
  acked: string[];
  ackedFrom: AckedVersion[];
  /** Which comparison was honoured: `read`, `none`, `git:HEAD` or `snap:<hash>`. */
  baseline: string;
  baselineAvailable: boolean;
  history: HistoryRow[];
  tracked: boolean;
  caps: Caps;
}

/** `prune`'s answer: the document rebuilt, and how many versions went. */
export type PrunedPayload = DocPayload & { removed: number };

/**
 * What a reader tells whoever is watching a document. `hash` is the version on disk; a host that
 * only wants the page to look again (a tab woken from the back/forward cache, a document taken
 * back after a sweep) sends `change` without one, and the page does not read it.
 */
export type ReaderEvent =
  | { type: 'change'; hash?: string }
  | { type: 'history' }
  | { type: 'file'; path: string }
  | { type: 'unreadable'; name: string; why: string }
  | { type: 'readable' };

/** One PlantUML fence, drawn or refused. */
export type PlantumlResult = { svg: string } | { error: string };
```

- [ ] **Step 2: `src/contract/seam.ts`**

```ts
// The two surfaces the page's front end is written against, and the one a transport serves.
//
// `Session` is the reader as a page may ask for it (src/reader/session.js): every call names a
// document by id. `Backend` is what the page holds: the same calls with the id taken out, because
// a page is on one document and the backend remembers which. There are three implementations of
// `Backend` -- public/backend.js over http, src/hosts/tauri/backend.js over direct calls and
// src/rpc/client.js over messages -- and what is declared here is what they have to agree on.
import type { DocPayload, PlantumlResult, PrunedPayload, ReaderEvent } from './payload.js';

/** What `ack` takes. `key` names the change; `clear` brings every one back instead. */
export interface AckOptions {
  key?: string;
  on?: boolean;
  clear?: boolean;
  /** The version the page was showing when it clicked. */
  at?: string;
  /** The change's `block` from that render. */
  block?: string;
}

/**
 * Who to tell. `onLive(false)` says the watch is not running right now; `needs` is a host's hint
 * of what would fix it (`'permission'`), and absent from the ones that have no such thing.
 */
export interface WatchHandlers {
  onEvent(e: ReaderEvent): void;
  onLive(on: boolean, why?: string, needs?: string): void;
}

/** The reader in the form a transport serves. Ids may be stale or null; the session resolves them. */
export interface Session {
  doc(id: string | null, baseline?: string): Promise<DocPayload>;
  markRead(id: string | null, at?: string): Promise<DocPayload>;
  /** Answers `{ acked }`, the checked keys, which is all a check-off changes. */
  ack(id: string | null, opts?: AckOptions): Promise<{ acked: string[] }>;
  open(id: string | null, path: string): Promise<{ id: string; path: string }>;
  prune(id: string | null, upto: string, baseline?: string): Promise<PrunedPayload>;
  plantumlSvg(code: string): Promise<PlantumlResult>;
  fonts(): Promise<{ fonts: string[] }>;
  /** Throws `Closed` when there is no such document. Returns the function that stops. */
  watch(id: string | null, onEvent: (e: ReaderEvent) => void): () => void;
}

/** What the page calls. The same document throughout, so no ids. */
export interface Backend {
  doc(baseline?: string): Promise<DocPayload>;
  markRead(at?: string): Promise<DocPayload>;
  /** The checked keys. The `{ acked }` wrapper is the session's and does not reach the page. */
  ack(opts: AckOptions): Promise<string[]>;
  /** Absent where the shell, not the page, opens files: the desktop app has tabs for that. */
  open?(path: string): Promise<{ id: string; path: string }>;
  prune(upto: string, baseline?: string): Promise<PrunedPayload>;
  plantumlSvg(code: string): Promise<PlantumlResult>;
  fonts(): Promise<string[]>;
  /** Follow the document until the returned function is called. */
  watch(handlers: WatchHandlers): () => void;
}
```

- [ ] **Step 3: Check it**

```bash
cd /tmp/claude-502/redlineapp-ts2 && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected: `tsc exit 0`. Then `npm test` (sandbox off); expected: every check from the baseline plus the two new layering lines, all `✓`.

- [ ] **Step 4: Commit**

```bash
cd /tmp/claude-502/redlineapp-ts2 && awk 'length > 100 {print FILENAME":"FNR}' src/contract/*.ts test-smoke.js | head
git add src/contract test-smoke.js
git commit -m "Add src/contract, the types every layer shares

A type-only layer that the layering test lets every other layer import and that imports
nothing: the document payload, the reader's events, the Session a transport serves and the
Backend a page holds. Nothing uses it yet; the conversions that follow check the three hosts
against it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 3: `core/` and `page/` to `.ts`

**Files:**
- Rename (`git mv`, `.js` → `.ts`): `src/core/{csp,diff,document,front-matter,hash,hljs,inline-diff,links,paths,render}.js`, `src/page/sanitize.js`
- Modify: the renamed files (annotations below), `scripts/build-web.mjs:54-55` (entry points), `test-smoke.js` (source reads of these files)
- Docs: `docs/architecture.md`, `docs/building.md`, `docs/typescript.md` wherever they name these files

**Interfaces:**
- Consumes: `AckedVersion` from `src/contract/payload.ts`.
- Produces: `RenderEnv`, `Block`, `Checked` (exported from `core/render.ts` and `core/diff.ts`), typed exports for everything in `core/`.

- [ ] **Step 1: Rename**

```bash
cd /tmp/claude-502/redlineapp-ts2 && for f in src/core/*.js src/page/*.js; do git mv "$f" "${f%.js}.ts"; done
node_modules/.bin/tsc -b 2>&1 | grep -c 'error TS'
```
Expected: 14 errors (csp 1, diff 11, hash 1, plus the cascade shown below); every one is in `core/`.

- [ ] **Step 2: Fix `core/hash.ts` (`Buffer`)**

The `src` project has no node types on purpose, and this is the one place a node global is named. It is the fallback for a runtime with no `TextEncoder`, so declare what it uses rather than pull node's types into every browser-side file:

```ts
// Node's Buffer, reached by name so that this file needs no node types: it is only used where
// there is no TextEncoder, and the `src` project deliberately has none (tsconfig.src.json).
declare const Buffer: { from(text: string, encoding: 'utf8'): Uint8Array };

const utf8 = (text: string): Uint8Array =>
  typeof TextEncoder === 'undefined'
    ? new Uint8Array(Buffer.from(text, 'utf8'))
    : new TextEncoder().encode(text);
```
Annotate the exports: `sha256Hex(text: string): string`, `sha1Hex(text: string): string`, `hashContent(text: string): string`, `docKey(abs: string): string`, `byteLength(text: string): number`.

- [ ] **Step 3: Fix `core/render.ts` (the `{}` that `env` was inferred as)**

Almost every `core/diff.ts` error is `env` being `{}`. Declare what a block's env carries, and use it where `splitBlocks` and `renderPlain` make one:

```ts
/**
 * What markdown-it threads through one `render` call. Each diff block is rendered on its own, so
 * what markdown-it would accumulate across a document is carried here by hand: the link
 * reference definitions (per side), the heading ids (a queue, given only to the new side) and
 * where the block starts in the file (the line the source map is shifted by).
 */
export interface RenderEnv {
  references?: unknown;
  slugs?: string[];
  lineOffset?: number;
}

/** A top-level block of the source: its text, and the line it starts on. */
export interface Block {
  text: string;
  line: number;
}
```
`splitBlocks(md, src: string): { blocks: Block[]; env: RenderEnv }` with `const env: RenderEnv = {}` and `const blocks: Block[] = []`. `renderPlain(md, src: string, env: RenderEnv = {}): string`. Annotate the other exports: `createMarkdown()`, `slugify(text: string): string`, `escapeHtml(s: string): string`, `highlightSource(src: string): string`, `splitHighlightedLines(html: string): string[]`; `md` parameters are `any` for now (markdown-it's own type is a ratchet-time decision, and `@types/markdown-it` is installed for it).

- [ ] **Step 4: Fix `core/diff.ts`**

```ts
import type { AckedVersion } from '../contract/payload.js';
import { splitBlocks, type Block, type RenderEnv /* … the existing imports … */ } from './render.js';

/** What `renderDiff` knows about check-offs: the keys, and the versions they were made in. */
export interface Checked {
  keys?: Iterable<string>;
  from?: AckedVersion[];
}
```
`renderDiff(md, oldSrc: string, newSrc: string, slugs: string[] = [], checked: Checked = {})`; `renderRawDiff(oldSrc: string | null, newSrc: string)`; in `renderDiff`:

```ts
  const oldEnv: RenderEnv = { references: oldDoc.env.references };
  const newEnv: RenderEnv = { references: newDoc.env.references, slugs };
  const renderOld = (text: string, line?: number, env: RenderEnv = oldEnv) => {
```
and `const fromNew = (start: number, n: number | null, opts?: object) =>` (TS2554 ×3 at `fromNew`, `renderOld`'s optional `line`). `seenBlocks(md, from: AckedVersion[])`.

- [ ] **Step 5: Fix `core/csp.ts`**

```ts
type Policy = Record<string, string[]>;

export function inlineScriptHashes(html: string): string[] {
```
`directives(overrides: Record<string, string[] | null> = {}): Policy` and `serialize(policy: Policy): string`. (TS2488 at `serialize` was `[name, ...sources]` over an `unknown`.) Give `core/document.ts`'s `renderDocument(md, current: string, base: string | null, checked: Checked = {})` the same `Checked` (import it from `./diff.js`), and `titleOf(md, src: string): string`.

- [ ] **Step 6: Everything else in `core/` and `page/`**

`inlineDiff(oldHtml: string, newHtml: string): string`, `parseFrontMatter(body: string)`, `looksLikeFrontMatter(rows)`, `headerTitle(rows)`, `makePaths(sep: string)`, `walkPath(dir: string, rel: string)`, `shorten(abs: string, d: string)`, `sanitizeDocument = (html: string): string`, `sanitizeSvg = (svg: string): string`. Read each function's JSDoc for the shape, move the type out of the braces into the annotation, and delete the duplicated `{…}` from the `@param` line (a `.ts` file ignores it, and two statements of one type will drift). Do not annotate locals.

- [ ] **Step 7: Check**

```bash
cd /tmp/claude-502/redlineapp-ts2 && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected: `tsc exit 0`.

- [ ] **Step 8: The build and the test follow the rename**

`scripts/build-web.mjs`: `{ entry: 'src/core/document.ts', out: 'render.js' }` and `{ entry: 'src/page/sanitize.ts', out: 'sanitize.js' }`; fix the header comment's file names to match. In `test-smoke.js`, run `npm test` (sandbox off) and for each `ENOENT` on a `src/core/*.js` or `src/page/*.js` read, change that literal to `.ts`. Do not touch `import('./src/…')` lines. Then:

```bash
cd /tmp/claude-502/redlineapp-ts2 && grep -rnE "src/(core|page)/[a-z-]+\.js" docs README.md CLAUDE.md | cut -c1-120
```
and change each hit in `docs/` to `.ts` (they are file names, in the module map and in prose). Expected final `npm test`: all `✓`, count = baseline + 2.

- [ ] **Step 9: Bundle, then commit**

`npm run bundle` (sandbox off); expected: `dist/Redline.app` and the `.dmg` are written. Check `public/vendor/render.js` and `public/vendor/sanitize.js` exist. Then:

```bash
cd /tmp/claude-502/redlineapp-ts2 && awk 'length > 100 {print FILENAME":"FNR}' src/core/*.ts src/page/*.ts | head
git add -A src scripts test-smoke.js docs
git commit -m "Convert src/core and src/page to TypeScript

Renamed in place, annotated only where tsc refused or where a function is exported across a
layer. The one change a reader might not expect is core/hash.ts, which declares the Buffer it
falls back on instead of pulling node's types into the browser-side project.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 4: `rpc/` to `.ts`, and the protocol typed

**Files:**
- Rename: `src/rpc/{protocol,client,serve}.js` → `.ts`
- Modify: the three files, `test-smoke.js` (rpc source reads), the docs that name them

**Interfaces:**
- Consumes: `Session`, `Backend`, `AckOptions`, `WatchHandlers` from `src/contract/seam.ts`; `ReaderEvent`, `DocPayload` from `payload.ts`.
- Produces: `PageMessage`, `ReaderMessage`, `WireError`, `SessionMethod`, `SESSION_METHODS`, `Closed`, `encodeError`, `decodeError` (`rpc/protocol.ts`); `RpcBackend`, `RpcBackendOptions`, `HostInfo`, `createRpcBackend` (`rpc/client.ts`); `serveRpc` over a `Session`.

- [ ] **Step 1: Rename and see the errors**

```bash
cd /tmp/claude-502/redlineapp-ts2 && for f in src/rpc/*.js; do git mv "$f" "${f%.js}.ts"; done
node_modules/.bin/tsc -b 2>&1 | grep 'error TS'
```
Expected: 7 errors, in `client.ts` (49, 67, 71) and `protocol.ts` (60 ×3, 64).

- [ ] **Step 2: `rpc/protocol.ts`**

Fix the header comment so it says what the code does (it listed three event types and no `ping`): the `ev` line becomes `a reader event (see ReaderEvent in src/contract/payload.ts)`, and add to the page → reader list `{ t: 'ping' }  the web page's liveness signal; the worker answers it itself and serveRpc never sees it`. Then:

```ts
import type { ReaderEvent } from '../contract/payload.js';
import type { Session } from '../contract/seam.js';

/** page -> reader. */
export type PageMessage =
  | { t: 'hello'; doc: string | null }
  | { t: 'call'; id: number; m: string; a: unknown[] }
  | { t: 'bye' }
  | { t: 'ping' };

/** An error as it travels: its name and what it said, and a root when a host's error is about one. */
export interface WireError {
  name: string;
  message: string;
  rootId?: string;
}

/** reader -> page. */
export type ReaderMessage =
  | { t: 'ret'; id: number; v: unknown }
  | { t: 'err'; id: number; e: WireError }
  | { t: 'ev'; e: ReaderEvent }
  | { t: 'live'; on: boolean; why?: string; needs?: string }
  | { t: 'command'; name: string };

/** The session's methods a page may call. `watch` is the connection's own and is not one. */
export type SessionMethod = Exclude<keyof Session, 'watch'>;

export const SESSION_METHODS = Object.freeze([
  'doc',
  'markRead',
  'ack',
  'open',
  'prune',
  'plantumlSvg',
  'fonts',
] as const);

// A method added to `Session` and left out of the list above is a method no page can call, and a
// name in the list that `Session` does not have is a call that can only fail. Both are the drift
// this file exists to prevent, and neither is visible at runtime until a page asks.
type Assert<T extends true> = T;
type Listed = (typeof SESSION_METHODS)[number];
export type SessionMethodsAreListed = Assert<
  [SessionMethod] extends [Listed] ? ([Listed] extends [SessionMethod] ? true : false) : false
>;

export const encodeError = (err: any): WireError => ({
```
(body unchanged). `decodeError({ name, message, rootId }: Partial<WireError> = {}): Error`, with `const err: Error & { rootId?: string } = new Error(message);` so the `rootId` assignment type-checks.

- [ ] **Step 3: `rpc/client.ts`**

```ts
import type { Backend } from '../contract/seam.js';
import { decodeError, type PageMessage, type ReaderMessage } from './protocol.js';

/** What a host says about itself for the page to branch on. Each host's literal is its own. */
export type HostInfo = Record<string, unknown>;

export interface RpcBackendOptions {
  /** The document being shown, read per call. */
  docId: () => string | null;
  post: (msg: PageMessage) => void;
  /** May return the function that stops listening. */
  onMessage: (handler: (msg: ReaderMessage) => void) => (() => void) | void;
  /** Told when the other end has gone: every call still waiting is rejected. */
  onDisconnect?: (handler: (why?: string) => void) => void;
  host: HostInfo;
}

/**
 * The page's `Backend`, plus what only a message transport has: the host's description, the
 * generic `call` a host's wrapper reaches its own methods through, and the command channel.
 * `open` is required here, though the `Backend` it extends leaves it out for the desktop app.
 */
export interface RpcBackend extends Backend {
  host: HostInfo;
  open: NonNullable<Backend['open']>;
  call<T = any>(m: string, ...a: unknown[]): Promise<T>;
  onCommand(fn: (name: string) => void): () => void;
  bye(): void;
}

export function createRpcBackend({ docId, post, onMessage, onDisconnect, host }: RpcBackendOptions): RpcBackend {
```
Inside: `const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();`, `let watcher: WatchHandlers | null = null;`, `const commands = new Set<(name: string) => void>();`, `let gone: string | null = null;`, `const call = <T = any>(m: string, ...a: unknown[]) => new Promise<T>(…)`, and the two `.then`s: `call<{ acked?: string[] }>('ack', docId(), opts).then((r) => r.acked ?? [])` and `call<{ fonts?: string[] }>('fonts').then((r) => r.fonts ?? [])`. The returned object is now checked against `RpcBackend`, which is the conformance this task exists for.

- [ ] **Step 4: `rpc/serve.ts`**

```ts
import type { Session } from '../contract/seam.js';
import { SESSION_METHODS, encodeError, type PageMessage, type ReaderMessage, type SessionMethod } from './protocol.js';

export interface ServeOptions {
  session: Session;
  post: (msg: ReaderMessage) => void;
  /** May return the function that stops listening. */
  onMessage: (handler: (msg: PageMessage) => void) => (() => void) | void;
  /** Calls that belong to the host and not to the reader. Tried first. */
  extra?: Record<string, (...args: any[]) => any>;
  onHello?: (doc: string | null) => void;
  onBye?: () => void;
}

export function serveRpc({ session, post, onMessage, extra = {}, onHello, onBye }: ServeOptions): () => void {
```
and `if ((SESSION_METHODS as readonly string[]).includes(m)) return session[m as SessionMethod](...(a as [any, any, any]));`. Keep the JSDoc prose that says why (`onBye`'s paragraph), delete the `{type}` braces it duplicates.

- [ ] **Step 5: Check, test, docs, commit**

```bash
cd /tmp/claude-502/redlineapp-ts2 && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected `0`. Run `npm test` (sandbox off) and for each `ENOENT` on `src/rpc/*.js` change the literal to `.ts`. In `docs/architecture.md` find the rpc section (`grep -n "rpc" docs/architecture.md`), change the file names to `.ts`, and make the message list match the type (add `ping`; the event list is `ReaderEvent`). Then `npm run bundle` (sandbox off) and:

```bash
cd /tmp/claude-502/redlineapp-ts2 && awk 'length > 100 {print FILENAME":"FNR}' src/rpc/*.ts | head
git add -A src test-smoke.js docs
git commit -m "Convert src/rpc to TypeScript, and type the protocol

PageMessage and ReaderMessage are the two directions written down, and SESSION_METHODS is
checked against Session in both directions, so a method added to one and not the other fails
tsc instead of failing the first page that asks for it. createRpcBackend returns RpcBackend,
which is Backend plus what only a message transport has.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 5: Close stage A

**Files:**
- Modify: `docs/architecture.md` (the directory map and the layering rule), `docs/typescript.md` (the ladder)

- [ ] **Step 1: Document the new layer**

In `docs/architecture.md` add `contract/` to the directory map ("types only: the payload, the events, `Session`, `Backend`; every layer may `import type` from it, it imports only itself, and a test holds both to that") and add `contract` to the layering rule's list of what each layer may import. In `docs/typescript.md`, mark step 2 in the ladder "in progress: `core/`, `page/`, `rpc/` and `contract/` done" and say why `src/hosts/web/host.js` will stay JavaScript.

- [ ] **Step 2: Full verification**

`npm test` and `npm run bundle` (sandbox off); `node_modules/.bin/tsc -b; echo $?` → `0`. Expected: all `✓`; `dist/Redline.app` built.

- [ ] **Step 3: Commit, and stop for a decision**

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A docs && git commit -m "Document src/contract and where step 2 stands

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git switch -c typescript-reader
```
Stage B continues on `typescript-reader`. Stage A is a branch ready for a PR into `typescript`; **do not push**.

---

## Stage B: the reader (`typescript-reader`)

### Task 6: `Platform` as a real interface, and the leaf modules

**Files:**
- Rename: `src/reader/{platform,git,fonts,plantuml}.js` → `.ts`
- Modify: those four, `test-smoke.js` source reads, `docs/` names

**Interfaces:**
- Produces: `Platform`, `SpawnOptions`, `SpawnResult` (exported interfaces from `reader/platform.ts`); `homeRelative(p: string, home: string): string`; `Git = ReturnType<typeof createGit>`; `PlantumlRenderer = Awaited<ReturnType<typeof createPlantumlRenderer>>`.

- [ ] **Step 1: Rename `platform.ts` and write the interface**

The JSDoc `@typedef` in `.js` was what hosts were checked against; in `.ts` it is ignored, so it becomes the interface. Keep every paragraph of the prose; they are the contract's documentation. Property style (not method style), so that `const nodePlatform: Platform = { readText: (p) => … }` contextually types each parameter:

```ts
export interface SpawnOptions {
  cwd?: string;
  /** Written to stdin. */
  input?: string;
  /** Milliseconds. */
  timeout?: number;
}

export interface SpawnResult {
  /** Exit status; null if it was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Platform {
  /** File contents as UTF-8, or null if it is not there. (…the existing paragraph, verbatim…) */
  readText: (p: string) => Promise<string | null>;
  /** Replaces the file **whole**: … (…verbatim…) */
  writeText: (p: string, text: string) => Promise<void>;
  mkdirp: (p: string) => Promise<void>;
  /** File names, not paths. */
  readDir: (p: string) => Promise<string[]>;
  remove: (p: string) => Promise<void>;
  /** Whether it worked. … (…verbatim…) */
  rename: (from: string, to: string) => Promise<boolean>;
  exists: (p: string) => Promise<boolean>;
  /** Last-modified time in ms, or null if it is not there. */
  modified: (p: string) => Promise<number | null>;
  /** Call `onChange` whenever the file at `p` may have changed; … Watch the directory. */
  watch: (p: string, onChange: () => void) => Promise<() => void>;
  homeDir: () => Promise<string>;
  env: (name: string) => string | undefined;
  /** 'darwin' | 'win32' | 'linux'. */
  os: string;
  /** Run a program to completion. **Optional.** … **Always resolves, whatever happened** … (…verbatim…) */
  spawn?: (cmd: string, args: string[], opts?: SpawnOptions) => Promise<SpawnResult>;
  join: (...parts: string[]) => string;
  dirname: (p: string) => string;
  basename: (p: string) => string;
  /** An absolute path. … (…verbatim…) */
  resolve: (p: string) => string;
}
```
Move each `@property` paragraph onto the member it describes as a `/** */` comment, whole. Delete the `@typedef` block. Keep the file's opening prose. `homeRelative(p: string, home: string): string` unchanged otherwise.

- [ ] **Step 2: `git.ts`, `fonts.ts`, `plantuml.ts`**

`createGit(platform: Platform)`, `systemFonts(platform: Platform): Promise<string[]>`, and in `plantuml.ts`:

```ts
export async function createPlantumlRenderer(
  { jar }: { jar?: string } = {},
  platform: Platform,
) {
```
(TS2339 at `plantuml.ts(73)`: the `{}` default had no `jar`.) Export the two derived types where they are defined: `export type Git = ReturnType<typeof createGit>;` in `git.ts` and `export type PlantumlRenderer = Awaited<ReturnType<typeof createPlantumlRenderer>>;` in `plantuml.ts`, each with a one-line comment that `createReader` takes anything shaped like these.

- [ ] **Step 3: Check, test, commit**

```bash
cd /tmp/claude-502/redlineapp-ts2 && for n in platform git fonts plantuml; do git mv src/reader/$n.js src/reader/$n.ts; done
node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected `0` after Steps 1–2. `npm test` (sandbox off): fix `ENOENT` reads of `src/reader/{platform,git,fonts,plantuml}.js` in `test-smoke.js` to `.ts`; update docs names (`grep -rnE "src/reader/(platform|git|fonts|plantuml)\.js" docs`). Also the Rust comments in `shell/src/host.rs` name `src/reader/platform.js`, `fonts.js` and `plantuml.js`; change those words too (comments only; `grep -n "src/reader/" shell/src/*.rs`). Then:

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A src test-smoke.js docs shell/src
git commit -m "Make Platform an interface, and convert the reader's leaves

The typedef in platform.js was documentation a .ts file cannot read, so it is an interface now
with every paragraph kept on the member it describes. Hosts are checked against it in step 2c.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 7: `store.ts`

**Files:**
- Rename: `src/reader/store.js` → `store.ts`
- Modify: `store.ts`, `test-smoke.js`, docs names

**Interfaces:**
- Produces: `GitRef` is imported from the contract; `VersionEntry`, `AckRecord`, `Index` (exported from `store.ts`), a `DocStore` with declared fields.

42 of the spike's 116 errors are here, and about 40 are one thing: a class that assigns `store.platform = …` in `static open` and never declares the fields.

- [ ] **Step 1: Declare the index and the fields**

```ts
import type { GitRef } from '../contract/payload.js';
import type { Platform } from './platform.js';

/** One version in the index. `size` is absent from indexes written before it was kept. */
export interface VersionEntry {
  hash: string;
  ts: number;
  size?: number;
  git?: GitRef | null;
}

/** A check-off. A bare string in an old index reads as `{ key }`; see `ackRecords`. */
export interface AckRecord {
  key: string;
  at?: string;
  block?: string;
}

/** The document's index file, as it is on disk. */
export interface Index {
  path: string;
  history: VersionEntry[];
  baseline: string | null;
  compare?: string | null;
  acked?: (string | AckRecord)[];
  gitSeen?: string[];
}
```
and in the class, above `static async open`:

```ts
  // Set by `open`, which is the only way to get one: a constructor cannot wait for the disk.
  platform: Platform;
  root: string;
  objects: string;
  docs: string;
  abs: string;
  file: string;
  data: Index;
```
Then `#known: string | null = null; #mtime: number | null = null; #drifted = false;` and the queue, which is what TS2322 at line 217 was about (`next.catch(() => {})` is `Promise<boolean | void>`, the field was inferred `Promise<void>`):

```ts
  // Changes to the index run one at a time. (…the existing comment…)
  #queue: Promise<unknown> = Promise.resolve();
```
`#update<T>(change: (d: Index) => T | Promise<T>): Promise<T | false>`; `#parse(raw: string): Index | null`; `get ackRecords(): AckRecord[]`; `setAcked(key: string, on: boolean, { at, block }: { at?: string; block?: string } = {}): Promise<string[]>`; `importGit(versions: { text: string; ts: number; git: GitRef }[]): Promise<number>`; `record(text: string, ts = Date.now()): Promise<…>` (read the body for the return and write it down); `prune(upto: string): Promise<number>`; `read(hash: string): Promise<string | null>`; `static async open(absPath: string, platform: Platform): Promise<DocStore>`; `static async gc(platform: Platform)`; `storeRoot(platform: Platform): Promise<string>`.

- [ ] **Step 2: Check, test, commit**

```bash
cd /tmp/claude-502/redlineapp-ts2 && git mv src/reader/store.js src/reader/store.ts && node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected `0`. `npm test` (sandbox off), fixing `ENOENT` reads of `src/reader/store.js` to `.ts`; `grep -rnE "reader/store\.js" docs shell/src` and update. Then:

```bash
cd /tmp/claude-502/redlineapp-ts2 && awk 'length > 100 {print FILENAME":"FNR}' src/reader/store.ts | head
git add -A src test-smoke.js docs shell/src
git commit -m "Convert the snapshot store to TypeScript

DocStore declares its fields, which it assigned in open() and never named, and the index file
gets a type. The one real finding was the update queue: next.catch(() => {}) resolves to
boolean | void, and the field had been inferred as Promise<void>.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 8: `reader.ts` and `session.ts`, and the session checked against the contract

**Files:**
- Rename: `src/reader/{reader,session}.js` → `.ts`
- Modify: both, `test-smoke.js`, docs

**Interfaces:**
- Consumes: `Platform`, `Git`, `PlantumlRenderer`, `DocStore`, and from the contract `DocPayload`, `HistoryRow`, `AckedVersion`, `PlantumlResult`, `PrunedPayload`, `ReaderEvent`, `AckOptions`, `Session`.
- Produces: `ReaderOptions`, `Reader = Awaited<ReturnType<typeof createReader>>`, `createSession(reader: Reader): Session`.

- [ ] **Step 1: `reader.ts`**

```ts
export interface ReaderOptions {
  platform: Platform;
  plantumlJar?: string;
  /** Shaped like `createGit(platform)`. Default: that, when the platform can spawn, else NO_GIT. */
  git?: Git;
  /** `false` turns it off. Default: the usual discovery, when the platform can spawn. */
  plantuml?: false | PlantumlRenderer;
  /** Default: the system's, which already answers `[]` off macOS. */
  fonts?: () => Promise<string[]>;
  /** How a path is shown. Default: `~` for home. */
  label?: (abs: string) => { dirLabel: string; pathLabel: string };
  pollMs?: number;
}

export async function createReader({
  platform,
  plantumlJar,
  git: gitProvider,
  plantuml: plantumlProvider,
  fonts: fontsProvider,
  label: labelProvider,
  pollMs = POLL_MS,
}: ReaderOptions) {
```
The old `= {}` default is dropped: the first line of the body read `platform.spawn`, so `createReader()` threw a `TypeError` before and after; it just no longer pretends to be callable that way. Keep the existing paragraph that said what `spawn` being optional means, on the `platform` member.

Then the other declarations the spike named:

```ts
  interface Listener {
    id: string;
    fn: (e: ReaderEvent) => void;
  }
  const listeners = new Set<Listener>();
  const emit = (id: string, event: ReaderEvent) => {
```
`subscribe(id: string, fn: Listener['fn'])`, `historyPayload(doc): HistoryRow[]`, `ackedFrom(doc, base: string | null): Promise<AckedVersion[]>`, `buildDoc(doc, wanted: string): Promise<DocPayload>` (this is the line that checks the producer against the contract: a field `buildDoc` stops returning, or a type it changes, fails here), `ack(id: string, { key, on = true, clear = false, at, block }: AckOptions = {})`, `plantumlSvg(code: string): Promise<PlantumlResult>`, `prune(id: string, upto: string, baseline = 'last:read'): Promise<PrunedPayload>`. Leave the `docs` Map and the document record loosely typed (`any` values); a `Doc` type is the `noImplicitAny` ratchet's work. Export `export type Reader = Awaited<ReturnType<typeof createReader>>;`.

- [ ] **Step 2: `session.ts`**

```ts
import type { Session } from '../contract/seam.js';
import { Closed, type Reader } from './reader.js';

export function createSession(reader: Reader): Session {
```
The returned literal is now checked against the contract, member by member. The `ack` default destructure becomes `async ack(id, { key, on = true, clear = false, at, block }: AckOptions = {})`, which also clears the three TS2339s the spike raised there. `class BadRequest extends Error` and `MAX_DIAGRAM_SOURCE` unchanged.

- [ ] **Step 3: Check, test, docs, commit**

```bash
cd /tmp/claude-502/redlineapp-ts2 && for n in reader session; do git mv src/reader/$n.js src/reader/$n.ts; done
node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected `0`. If `createSession`'s literal disagrees with `Session` anywhere, that is the finding: fix the contract only if the contract is wrong about what the code has always done, and say which in the commit message. `npm test` (sandbox off), fixing `ENOENT` reads; update docs (`grep -rnE "reader/(reader|session)\.js" docs shell/src`). `npm run bundle` (sandbox off). Then:

```bash
cd /tmp/claude-502/redlineapp-ts2 && awk 'length > 100 {print FILENAME":"FNR}' src/reader/*.ts | head
git add -A src test-smoke.js docs shell/src
git commit -m "Convert the reader and the session, and check them against the contract

buildDoc returns DocPayload and createSession returns Session, so the payload every host
relays and the surface every transport serves are enforced at their one source.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 9: Close stage B

- [ ] **Step 1: Docs.** `docs/typescript.md` ladder: "`core/`, `page/`, `rpc/`, `contract/`, `reader/` done"; `docs/architecture.md`: the `reader/` paragraph says `Platform` is an interface in `platform.ts`.
- [ ] **Step 2: Verify.** `tsc -b` exit `0`; `npm test`; `npm run bundle` (sandbox off).
- [ ] **Step 3: Commit and cut stage C.**

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A docs && git commit -m "Document where step 2 stands after the reader

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git switch -c typescript-hosts
```

---

## Stage C: the hosts (`typescript-hosts`)

### Task 10: `hosts/node/`

**Files:**
- Rename: `src/hosts/node/{root,platform,server}.js` → `.ts`
- Modify: those, `test-smoke.js`, `scripts/*.mjs` and `bin/redline.js` only if a literal names these (the imports resolve `.js` to `.ts` and do not change), docs

These are in the `node` project (`types: ["node"]`), so `node:` imports and `Buffer` are fine.

- [ ] **Step 1: Rename and annotate**

`nodePlatform` is annotated, which is the contract check for this host and also types every parameter contextually (`spawn`'s `{ cwd, input, timeout } = {}` stops being `{}`):

```ts
import type { Platform } from '../../reader/platform.js';

export const nodePlatform: Platform = {
```
`root.ts`: `repoRoot(metaUrl: string): string`, `rootUrl = (name = ''): URL`. `server.ts`:

```ts
export interface ServerOptions {
  file?: string;
  plantumlJar?: string;
  platform?: Platform;
}

export async function createServer({ file, plantumlJar, platform = nodePlatform }: ServerOptions = {}) {
```
and `contentSecurityPolicy(html: string): string`. The handler's `ack` call now type-checks against `AckOptions` (this was the TS2353 at `server.ts(183)`).

- [ ] **Step 2: Check, test, commit**

```bash
cd /tmp/claude-502/redlineapp-ts2 && for n in root platform server; do git mv src/hosts/node/$n.js src/hosts/node/$n.ts; done
node_modules/.bin/tsc -b; echo "tsc exit $?"
```
Expected `0`. `npm test` (sandbox off); it imports `./src/hosts/node/root.js` from `out/`, which is fine, and reads `rootUrl('src/hosts/node/server.js')` and `…/platform.js` as source: change those two to `.ts`. `bin/redline.js` and every `scripts/*.mjs` import `../src/hosts/node/root.js`, which still resolves. Then `npm run bundle`, and:

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A src test-smoke.js docs
git commit -m "Convert the Node host, and check nodePlatform against Platform

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 11: `hosts/tauri/`

**Files:**
- Rename: `src/hosts/tauri/{platform,native,backend}.js` → `.ts`
- Modify: those, `test-smoke.js` (`rootUrl('src/hosts/tauri/native.js')`), `scripts/build-web.mjs:56`, docs

- [ ] **Step 1: `platform.ts`:** `export const tauriPlatform: Platform = {` replaces the `@type {import(…).Platform}` line. The `spawn` TS2339s go with it.

- [ ] **Step 2: `native.ts`:** `window.mdNative` is the shell's handshake and is read by the page, so declare it once, in this file, where it is assigned:

```ts
declare global {
  interface Window {
    /** The window's half of the shell (src/hosts/tauri/native.ts), left for the page to find. */
    mdNative: ReturnType<typeof installNative>['native'] | unknown;
  }
}
```
Use whatever precise type falls out of reading `mdNative`'s literal (it is the object returned two lines above the assignment); `unknown` is the fallback and is better than `any` for a thing the page checks for existence. `installNative({ reader }: { reader: Reader })`.

- [ ] **Step 3: `backend.ts`:** this is the Tauri end of the seam, so it returns the contract:

```ts
import type { Backend } from '../../contract/seam.js';

export async function createTauriBackend({ docId }: { docId: () => string | null }): Promise<Backend> {
```
`ack: (opts) => reader.ack(docId(), opts)` returns the checked keys directly, as `Backend.ack` says; `fonts: () => reader.fonts()`. It has no `open`, and `Backend.open` is optional for exactly this reason.

- [ ] **Step 4: Check, test, bundle, commit**

`git mv` the three; `tsc -b` exit `0`; `scripts/build-web.mjs`: `src/hosts/tauri/backend.ts`; `npm test` fixing `ENOENT` literals; `npm run bundle` and confirm `public/vendor/backend-tauri.js` is rebuilt.

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A src scripts test-smoke.js docs shell/src
git commit -m "Convert the Tauri host, and check its backend against Backend

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 12: `hosts/web/` leaves

**Files:**
- Rename: `src/hosts/web/{idb,kv-files,open-files,handles,platform,welcome}.js` → `.ts`
- Not renamed: `src/hosts/web/host.js` (see Global Constraints)

- [ ] **Step 1: `handles.ts`:** `NeedsPermission` assigned two fields it never declared:

```ts
export class NeedsPermission extends Error {
  root: string;
  rootId?: string;
  constructor(name: string, rootId?: string) {
```
`NoDocument` is the same shape if it assigns anything.

- [ ] **Step 2: `platform.ts`:** the TS2345 at `exists` was `route()` returning a union the type did not know about, so `handleOf(r)` could not tell which member it had been handed:

```ts
type Route =
  | { kind: 'drop'; name: string }
  | { kind: 'web'; rootId: string; rel: string }
  | { kind: 'store'; path: string }
  | { kind: 'none' };

  function route(p: string): Route {
```
`createWebPlatform({ kv, root, drops }: { kv: Kv; root: (rootId: string) => any; drops: Map<string, { text(): Promise<string>; lastModified: number }> }): Platform`: this is the web host's conformance check, and the `@returns {import(…).Platform}` JSDoc it replaces was invisible to `tsc`.

- [ ] **Step 3: `welcome.ts`:** `getAsFileSystemHandle` is in Chromium and not yet in `lib.dom`. Declare what is used, where it is used:

```ts
// Not in lib.dom yet: the File System Access API's handle for a dropped item (Chromium only, which
// is why it is tried and the `File` is the fallback).
type DroppableItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
const item = [...(e.dataTransfer.items ?? [])].find((i): i is DroppableItem => i.kind === 'file');
```

- [ ] **Step 4: `idb.ts`, `kv-files.ts`, `open-files.ts`:** no errors in the spike; rename and annotate exported signatures only (`createIdbKv(storeName: string): Kv`, `createKvFiles(kv: Kv, root: string)`, `createOpenFiles({ tab, shared }: { tab: Storage; shared: Storage })`). Export `Kv` from `idb.ts` as `{ get(key: string): Promise<any>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void>; … }` matching what the file's methods are; read the file and write down exactly those.

- [ ] **Step 5: Check, test, commit**

`tsc -b` exit `0`; `npm test` fixing `ENOENT` literals (`src/hosts/web/{platform,idb,…}.js` source reads) to `.ts`; the `read('./src/hosts/web/host.js')` read stays `.js`. Commit:

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A src test-smoke.js docs
git commit -m "Convert the web host's leaves, and check createWebPlatform against Platform

host.js is left as JavaScript: it is a classic script that stage-page.mjs copies into the page
verbatim, and tsc would make it a module and append export {}.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 13: `hosts/web/worker.ts` and `backend.ts`

**Files:**
- Rename: `src/hosts/web/{worker,backend}.js` → `.ts`
- Modify: both, `scripts/build-web.mjs:57-58`, `test-smoke.js`, docs

**Interfaces:**
- Consumes: `RpcBackend` and `createRpcBackend`; `Backend`; `Session`; `ReaderEvent`.
- Produces: `WebBackend`, `WebHostOptions`, `Conn`.

- [ ] **Step 1: `worker.ts`**

```ts
export interface WebHostOptions {
  /** The three IndexedDB stores, as `idb.ts` makes them. Default: those. */
  stores?: { files: Kv; roots: Kv; opened: Kv };
  /** Passed to the reader. */
  pollMs?: number;
  silentMs?: number;
  sweepMs?: number;
  now?: () => number;
  /** For a test. (…the existing paragraph, verbatim…) */
  makeReader?: typeof createReader;
}

export function createWebHost({
  stores, pollMs, silentMs = SILENT_MS, sweepMs = SWEEP_MS, now = Date.now, makeReader = createReader,
}: WebHostOptions = {}) {
```
(The spike's `stores`/`pollMs` TS2339s were the destructure being checked against only the defaulted keys.) One connection per port, with its fields written where `connect` builds it:

```ts
  /** One page's connection. */
  interface Conn {
    docId: string | null; // what the page said it shows
    held: string | null; // the reader's id for it, once taken
    pending: { rootId: string } | null; // taken, once the user says so
    failure: Error | null;
    gen: number;
    busy: number;
    ready: Promise<unknown>;
    seen: number;
    swept: boolean;
  }
  const conns = new Set<Conn>();
```
and `const conn: Conn = { … }` in `connect` (the `unknown` errors at `conns` lines 386, 465-467 go with it). The three arity errors (`live`, `acquire`) are parameters the callers leave off: make them optional where the callers do (`live(on: boolean, why?: string, needs?: string)`, `acquire(conn: Conn, opts: { remember?: boolean } = {})`). `post` is `(msg: ReaderMessage) => void`, so the two `{ type: 'change' }` literals are checked against `ReaderEvent` (hash optional; that is why `payload.ts` says so). `sweeper.unref?.()`: a DOM `setInterval` is a `number`; write `(sweeper as unknown as { unref?(): void }).unref?.();` with the one-line reason (Node, in the tests, hands back a `Timeout`). The worker-scope check:

```ts
// The one place a worker's own scope is named, and lib.dom has none for it.
declare const SharedWorkerGlobalScope: { new (): unknown } | undefined;
if (typeof SharedWorkerGlobalScope !== 'undefined' && globalThis instanceof SharedWorkerGlobalScope) {
  const host = createWebHost();
  (globalThis as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e) => host.connect(e.ports[0]);
}
```

- [ ] **Step 2: `backend.ts`**

```ts
import type { Backend } from '../../contract/seam.js';
import { createRpcBackend, type RpcBackend } from '../../rpc/client.js';

/** What the web app's page gets: the rpc backend without its `call`, plus the browser's own. */
export interface WebBackend extends Omit<RpcBackend, 'call'> {
  /** Ask the user for the folder again. Call it from the click; answers whether it was granted. */
  reopen(): Promise<boolean>;
  /** A file or folder handle from a picker or a drop. */
  addRoot(handle: FileSystemHandle): Promise<{ rootId: string; name: string; kind: string }>;
  /** A `File` that came with no handle. Answers the path to `open`. */
  addDrop(file: File): Promise<string>;
  welcome(el: HTMLElement, hooks: object): { sync(…): unknown } | undefined;
  linkNote(path: string | null | undefined): Promise<string | null>;
  openFiles: ReturnType<typeof createOpenFiles>;
  onNeedsPermission(fn: (info: { name: string }) => void): () => void;
  close(): void;
}

export async function createWebBackend({ docId, connect = openPort, stores, win = globalThis, pingMs = PING_MS }: WebBackendOptions): Promise<WebBackend> {
```
Fix `welcome`'s return type from `mountWelcome`'s own (`ReturnType<typeof mountWelcome>`) rather than the guess above. The `disconnect` slot is `let disconnect: (why?: string) => void = () => {};` (TS2554 at line 131), `needsPermission(rootId?: string)` (TS2554 at 219), `askers = new Set<(info: { name: string }) => void>()` (TS2349 at 165), and the lifecycle's `watching` is `let watching: { start(): void; off: (() => void) | null; cbs: WatchHandlers } | null = null;` (TS2339 at 215, 224). `pinger.unref?.()` gets the same cast as the sweeper. `api` is declared `const api: WebBackend = { … }`, which is the web host's conformance check against `Backend`.

- [ ] **Step 3: Check, test, bundle, commit**

`tsc -b` exit `0`. `scripts/build-web.mjs`: `src/hosts/web/backend.ts` and `src/hosts/web/worker.ts`; the `test-smoke.js` source reads of `worker.js`, `backend.js` under `src/hosts/web/` become `.ts`. `npm test`, then `npm run bundle` (sandbox off), and confirm `public/vendor/backend-web.js` and `reader-worker.js` were rebuilt and `grep -c "export {}" public/vendor/backend-web.js` is unchanged from before (esbuild strips type-only exports; it must not have started emitting one).

```bash
cd /tmp/claude-502/redlineapp-ts2 && awk 'length > 100 {print FILENAME":"FNR}' src/hosts/web/*.ts | head
git add -A src scripts test-smoke.js docs
git commit -m "Convert the web worker and backend, and check them against the contract

createWebBackend returns WebBackend, which is RpcBackend (and so Backend) plus the browser's own
methods; the worker's connection record and its messages are typed. The fake 'change' that wakes
a page from the back/forward cache has no hash, which is what ReaderEvent now says.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 14: The contract has to be able to fail

**Files:**
- Modify: `test-smoke.js` (a new block after the layering one)
- Modify: `docs/typescript.md`, `docs/architecture.md`

A contract that is never shown to reject anything is a comment. The layering test proves its rule against forbidden pairs; this does the same for the types.

- [ ] **Step 1: Write the assertions**

```js
// The contract is checked by tsc, so what a test can say is that it is wired -- each backend
// names it in its signature -- and that it can fail: a fixture that leaves out a method must be
// rejected by the same compiler the build runs.
for (const [file, sig] of [
  ['src/hosts/tauri/backend.ts', /Promise<Backend>/],
  ['src/rpc/client.ts', /\): RpcBackend\b/],
  ['src/hosts/web/backend.ts', /Promise<WebBackend>/],
  ['src/reader/session.ts', /\): Session\b/],
  ['src/reader/reader.ts', /Promise<DocPayload>/],
  ['src/hosts/node/platform.ts', /: Platform = /],
  ['src/hosts/tauri/platform.ts', /: Platform = /],
  ['src/hosts/web/platform.ts', /\): Platform\b/],
]) {
  assert.match(fs.readFileSync(fileURLToPath(rootUrl(file)), 'utf8'), sig, `${file} says what it is`);
}
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-contract-'));
try {
  const seam = path.relative(fixture, fileURLToPath(rootUrl('src/contract/seam.ts'))).replace(/\.ts$/, '.js');
  fs.writeFileSync(
    path.join(fixture, 'bad.ts'),
    `import type { Backend } from '${seam}';\n` +
      // no markRead, and a `fonts` that answers the session's shape and not the page's
      'export const b: Backend = { doc: async () => null, ack: async () => [], prune: async () => null,\n' +
      '  plantumlSvg: async () => ({ svg: "" }), fonts: async () => ({ fonts: [] }), watch: () => () => {} };\n',
  );
  const tsc = fileURLToPath(rootUrl('node_modules/.bin/tsc'));
  const r = spawnSync(tsc, ['--noEmit', '--strict', 'false', '--skipLibCheck', '--module', 'nodenext',
    '--moduleResolution', 'nodenext', '--target', 'es2022', path.join(fixture, 'bad.ts')], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'a Backend with a method missing is refused by tsc');
  assert.match(r.stdout, /markRead|fonts/, 'and for the reason it is wrong');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
console.log('✓ the contract is wired into every host, and can fail');
```
Use whichever of `os`, `spawnSync` the file already imports (`grep -n "^import" test-smoke.js`); add only what is missing.

- [ ] **Step 2: Run it**

`npm test` (sandbox off). Expected: `✓ the contract is wired into every host, and can fail`. If `tsc` cannot resolve the relative import of a `.ts` file as `.js` from a fixture outside the repo, the assertion fails for the wrong reason: `r.stdout` then says `Cannot find module`. In that case write the fixture under `out/` instead (`path.join(fileURLToPath(rootUrl('out/')), 'contract-fixture')`) and remove it in `finally`, and say in the commit message that it moved and why.

- [ ] **Step 3: Docs.** `docs/typescript.md`: step 2 done; list what the contract covers and the one file that stays JavaScript and why; record the measured error count (116 on the all-at-once spike) and what the final conversion needed in annotations. `docs/architecture.md`: every remaining `.js` name in the module map for the files that are now `.ts` (`grep -nE "src/[a-z/-]+\.js" docs/architecture.md`), the opening's "no transpiler" claim (the convention in `CLAUDE.md` says the same and is a follow-up for the owner, since this agent may edit `CLAUDE.md` but the step-1 patch for it is still waiting to be applied; say so in the report instead of editing it twice).

- [ ] **Step 4: Verify and commit**

`node_modules/.bin/tsc -b; echo $?` → `0`; `npm test`; `npm run bundle` (sandbox off). Then:

```bash
cd /tmp/claude-502/redlineapp-ts2 && git add -A test-smoke.js docs
git commit -m "Show that the contract can fail, and finish step 2's docs

A fixture Backend with a method missing and a fonts() in the session's shape must be refused by
tsc, and each host must name the type it implements; without the first, the contract would be
unfalsifiable, and without the second a host could simply stop claiming it.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

### Task 15: Finish

- [ ] **Step 1:** Final evidence on the tip of `typescript-hosts`: `tsc -b` exit `0`; `npm test` all `✓` (count); `npm run bundle` built; `git diff --stat typescript..HEAD | tail -n 1`; `git ls-files 'src/**/*.js'` lists only `src/hosts/web/host.js`.
- [ ] **Step 2:** Use superpowers:finishing-a-development-branch. The base is `typescript`, never `main`; the three stage branches are stacked, so present them as three PRs, A into `typescript`, then B and C retargeted as each merges (the same move as PR #29). Do not push.

---

## Self-review

**Spec coverage** (§5 step 2: "`src/core` and `src/rpc` with the shared payload and rpc types; then `src/reader` (`Platform`, `Session`); then the three hosts"): core → Task 3; rpc types → Task 4; shared payload → Task 2; reader → Tasks 6–8 (`Platform` Task 6, `Session` Task 8); the three hosts → Tasks 10–13; the "the contract bites" requirement in §2 and the "new assertions" in §4 → Tasks 1 and 14; docs "in the same PRs" → every task has a docs step and Tasks 5, 9, 14 close them. Not in this plan and why: `markdown-it-task-lists` declaration and `types/vendor/` shims (no error in lenient mode, and the shims belong to step 4's page project), `public/backend.js` as the third `Backend` (a page-project file, step 4; it will `satisfies Backend` there), the ratchet flags (step 6).

**Placeholder scan:** the "(…verbatim…)" marks in Task 6 Step 1 mean "move the existing paragraph from the `@property` it described onto the member", which names exactly what to copy; the two `Kv` and `WebBackend.welcome` shapes in Tasks 12–13 say to read the file and write down exactly what it has because the file's own signature is the source of truth and a guess here would be worse than the instruction. Task 7 Step 1 leaves `record`'s return type to be read from its body for the same reason.

**Type consistency:** `Backend.open?` optional and `RpcBackend.open` required (Tasks 2, 4, 11, 13); `WatchHandlers.onLive(on, why?, needs?)` is the one shape in Tasks 2, 4 and 13; `ReaderEvent.change.hash?` in Tasks 2 and 13; `Session.ack` answers `{ acked }` and `Backend.ack` the list (Tasks 2, 4, 8, 11); `Reader` is exported in Task 8 and consumed in Tasks 8 and 11; `Platform` is defined in Task 6 and consumed in 7, 8, 10, 11, 12; `Kv` is exported by `idb.ts` in Task 12 and consumed by `worker.ts` in Task 13.

**Known risks:** (1) the Task 14 fixture lives outside the repo and relies on `tsc` resolving a `.js` specifier to a `.ts` file by relative path; the fallback is written in the step. (2) `WebBackend.welcome` and `installNative`'s return type are guessed from the call sites and must be confirmed against the files. (3) `tsc -b` after a rename on a machine that built a previous layout leaves old `.d.ts`; `rm -rf out` once if a stale type is suspected.
