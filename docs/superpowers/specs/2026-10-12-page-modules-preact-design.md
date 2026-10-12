# Splitting the page into modules, with Preact — design

Status: phase 1 (the build), the signal-backed `state` of phase 2, and the History component of
phase 4 are implemented, on `preact-history`.

## Goal and decisions

**Goal:** a page whose files each have one responsibility. `public/app.ts` is 3.5k lines in one
file, held together by one mutable `state` object and a `paint()` that calls every section by
name. Size is not the problem; that nobody can hold the file in their head is.

Decisions made while designing this, by the owner:

| Question | Decision |
| --- | --- |
| What a framework is for | Reactive UI for the chrome — sidebars, tabs, History, settings. Not speed |
| The document body | Stays an imperative island. markdown-it and the diff write it as today |
| Framework | Preact, with `@preact/signals` for state |
| Order | Signals and the split first; components after, one panel at a time |

This reverses two written conventions — "No framework. One compiler, `tsc`"
(`docs/architecture.md`, Conventions) and "no framework, nothing transpiled" (`CLAUDE.md`).
Both are reworded in the change that adds the dependency, with the reason: the page's chrome is
state kept in sync with the DOM by hand, in 280-odd lines of `classList`, `hidden =`,
`textContent =` and `createElement`, and that is the code a component re-rendering from state
replaces.

## 1. Where the page's source lives, and what is served

The served page does not change shape: **one `app.js`**, importing exactly what it imports today
(the renderer, DOMPurify, the backend, Mermaid). The suite counts those four imports, the
`?v=` rewrite in `stage-page.mts` versions them, the staged page's file list names `app.js`, and
the dmg ships it. Twenty modules served as twenty files would touch every one of those.

- Source moves from `public/app.ts` to `public/app/`, entry `public/app/main.ts`.
- **esbuild bundles it into `public/app.js`**, in `build-web.mts`, the step every host already
  runs first. `./vendor/*.js` and `./backend.js` are marked external, so they stay separate
  files and the import count stays four. Preact and signals are bundled in.
- **Not minified**, so a webview console stack trace names the function it is in. Not
  `keepNames`, which wraps every arrow in `__name(…)` and buys nothing unminified.
- **`tsc` type-checks the page and no longer emits `app.js`.** The page project splits: a new
  `tsconfig.app.json` holds `public/app/`, with `noEmit`, `"jsx": "react-jsx"` and
  `"jsxImportSource": "preact"`; `tsconfig.page.json` keeps `backend.ts` and `site/landing.ts`,
  compiled in place as now. `tsc -b` still fails the build on a type error before esbuild runs.
- Imports inside `public/app/` are written `./ui/History.js`, as everywhere else. `NodeNext`
  resolves that to the `.tsx`, and so does esbuild.
- `.gitignore` already ignores `public/app.js`; it stays a build output.

**Rejected:** serving the modules unbundled. The one-`app.js` shape is not sacred — the lists
above could be taught to read a directory — but the modules cannot run as `tsc` emits them:
JSX compiles to `import … from 'preact/jsx-runtime'`, a bare name a browser cannot resolve, and
`@preact/signals` imports `preact` the same way. Serving them needs an import map or a rewrite
of every emitted file, which is the problem `build-web.mts` already explains it bundles to
avoid. Bundling solves it once, and keeping the shape is then free.

**Open question:** the node server serves `public/` as it is, so `public/app/*.ts` becomes
fetchable from a CLI tab. Harmless — it is the source of the page already being served — but
if it is unwanted, the source goes under `page/` at the root instead and `rootDirs` follows it.

## 2. State: one module of signals

`public/app/state.ts` holds what `state` (`app.ts:72`) and `settings` hold today, as signals:

```ts
export const docId = signal(new URLSearchParams(location.search).get('id') || '');
export const diff = signal(prefs.getItem('redline:diff') !== '0');
export const side = signal(document.documentElement.classList.contains('side-open'));
export const data = signal<Payload | null>(null);
// … view, solo, baseline, caps, changeIndex, acked, toc, tocAt, tabs, tocSide, pruneAsk
```

- **Initial values are read the way they are now** — from `prefs`, or from the classes the head
  script put on `<html>`. The head script is untouched, and stays the only code that runs
  before first paint. Gotcha #2 in `CLAUDE.md` still holds: a new layout preference goes in the
  head script *and* here.
- **Remembering is an `effect`**, one per key, in `state.ts`:
  `effect(() => prefs.setItem('redline:diff', diff.value ? '1' : '0'))`. That replaces the
  `remember` parameters on `setSide` and its siblings, and the scattered `setItem` calls.
- `state.ts` imports nothing from the page. Every other module imports it; that one direction
  is what makes the split hold.
- `acked` is a `Set` mutated in place today. As a signal it is replaced, not mutated
  (`acked.value = new Set(...)`), or nothing re-runs.

## 3. The document pass stays ordered

`paint()` (`app.ts:450`) writes the document, then `applyMarks`, `applyAcks`, `paintHistory`,
`paintToc`, `paintSolo`, `paintCount`, `paintRuler`, `paintFindCount`, then restores the scroll.
The document half of that is **order-dependent** — the ruler and Contents measure nodes the
render just wrote and the marks just classed — and effects do not promise an order.

So it splits in two:

- **The document pass stays an explicit sequence**, in `doc/paint.ts`. It imports the document
  modules (`render`, `acks`, `toc`, `ruler`, `find`, `anchor`) and calls them in today's order.
  They do not import it back. One module that knows the order is the honest form of an ordered
  thing.
- **The chrome reacts.** `paintHistory`, `paintSolo` and `paintCount` leave the sequence: their
  components read `data`, `solo`, `changeIndex` and re-render on their own. Nothing calls them.
- `doc/paint.ts` re-runs from one effect on the signals that change the document — `data`,
  `diff`, `view`, `solo`, `baseline` — which replaces the calls to `rerender()` that
  `setDiff`, `setView` and `setSolo` each make by hand.

## 4. The layout

```
public/app/
  main.ts           boot: mount the components, connect the host, live reload
  state.ts          signals, and the effects that remember them
  ui/               Preact components — the chrome
    History.tsx  VersionMenu.tsx  PruneAsk.tsx  Settings.tsx  Tabs.tsx  TabMenu.tsx
    Welcome.tsx  Notice.tsx  About.tsx  Doc.tsx
  doc/              imperative, over the rendered document
    paint.ts  render.ts  diagrams.ts  toc.ts  ruler.ts  acks.ts  navigate.ts
    find.ts  peek.ts  anchor.ts
  layout/
    widths.ts  toc-height.ts  keys.ts  native.ts  fonts.ts
```

Most files land at 100–300 lines. `Doc.tsx` is the island: it renders one
`<div class="markdown-body" ref={el}>` and hands `el.current` to `doc/paint.ts`; Preact never
diffs inside it, so gotcha #4 — renders per block, the inline word diff tag-for-tag — is
untouched.

`widths.ts` keeps `fitWidths`, and `toc-height.ts` keeps `tocHMax`, verbatim: the head script
duplicates their arithmetic, and the comments in `index.html` that say "this mirrors `fitWidths`
in app.js" are updated to name the module.

## 5. The suite

`test-smoke.ts` reads the page two ways today, and both move.

- **Greps on the source** (`pageJs`, `appJs` — `readFileSync('public/app.ts')`) become greps on
  a `pageSrc`: every file under `public/app/`, concatenated. An assertion that named the file
  says what it means instead. The "it is wired up" greps gain one kind: each component in
  `ui/` is mounted in `main.ts`.
- **Functions lifted into a vm** (`fn`, `konst`, `applySchemeSrc` over `pageRun`: `stepIndex`,
  `goToChange`, `changeNodes`, `changeKind`, `continuesRun`, `LANDING_MS`, `applyScheme`) are
  lifted from `main.ts` with its types stripped by esbuild's `transform`, not from the bundle.
  In the bundle, esbuild renames the page's top-level names wherever they meet Preact's
  minified ones (`$` becomes `$2`), so a lifted function calls a helper the vm's fakes do not
  name. The better end state is still that the pure ones move to a DOM-free module the suite
  imports directly; that is a later, separate change.
- Unchanged: the four-imports count, the staged file list, `?v=` versioning — the point of §1.

## 6. The phases

Each is one pull request, green on `npm test` and `npm run bundle`, with its docs in the same
commit.

1. **The build, and nothing else.** `public/app.ts` moves to `public/app/main.ts` as one file;
   esbuild bundles it to `public/app.js`; `tsconfig.app.json`. No behaviour change. Proves §1
   and the lifting in §5.
2. **Signals.** Add `preact` and `@preact/signals`; `state.ts`; the remember-effects; the
   document effect of §3. Still one big `main.ts` besides `state.ts`. `npm run notices`
   regenerates `THIRD-PARTY-NOTICES.md` (both MIT).
3. **The mechanical split.** `doc/` and `layout/` move out, function by function, with no
   rewrites. The diff is mostly moves.
4. **Components, one per pull request**, History first: it has real state (versions, baselines,
   the selection, prune), it is contained, and it shows whether the pattern holds before
   anything shared is touched. Then VersionMenu and PruneAsk, Settings, Tabs and TabMenu,
   Welcome, Notice, About.

Every `.thing` toggled with `hidden` keeps its `.thing[hidden] { display: none }` (gotcha #3);
a component that renders `hidden={…}` is still toggling the attribute.

## 7. Docs to change

- `docs/architecture.md` — the module map, the Conventions line on frameworks and compilers.
- `docs/building.md` — `build-web` now bundles the page; the page project split.
- `docs/typescript.md` — `tsconfig.app.json`, JSX, `app.js` no longer emitted by `tsc`.
- `CLAUDE.md` — Layout, Conventions, and the head-script note naming `app.js`.
- `skills/redline-client/SKILL.md` — the page's structure. Committed with the code like the
  others.

## 8. What cannot be verified here

There is no browser here. The builds, the suite, a tag-balance parse of `index.html` and a
probe run of the Tauri shell (`REDLINE_PROBE=1`) can be checked; whether a panel looks right, or
flashes on open, cannot, and each phase's pull request says so. Phase 4's components are the
ones to open by hand, in a browser tab and in the window, with two windows open (gotcha #6).

## Rejected

- **React.** Ten times Preact's size for an API this page would use the same subset of.
- **Lit.** Also compiles with plain `tsc`, but components default to shadow DOM, which fights
  the one stylesheet.
- **Svelte, Solid, Vue single-file components.** Each needs its own compiler in front of `tsc`.
- **Signals without Preact.** Untangles the state, but the chrome would still be built by
  `createElement` by hand. Phase 2 is that state, as a step rather than the end.
