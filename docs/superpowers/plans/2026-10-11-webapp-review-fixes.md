# Web App Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the gaps a code review of the web app found: four bugs (Part A) and three missing features that are clear enough to build (Part B). Part C lists four items that need a decision from the user before any code is written. Part D lists suspicions that cannot be checked without a browser and are not to be "fixed" on a guess.

**Where the review was done:** `main` at `e2573ea` (Merge pull request #27, the web theme). Every `file:line` below is from that commit. Lines will drift as you edit, so **find each place by the quoted code**, not by its number.

**Read first:** `CLAUDE.md`, then `docs/architecture.md` (the web app's reader), `docs/web-app.md` (the spec these fixes are measured against), and `skills/redline-testing/SKILL.md`.

## Global Constraints

- **Work in a fresh worktree off `origin/main`**, not in the main checkout:
  ```
  git fetch origin            # needs the sandbox off: github.com is not on its allowlist
  git worktree add "$TMPDIR/webapp-fixes" -b webapp-review-fixes origin/main
  ln -s /private/tmp/claude-502/web-files/node_modules "$TMPDIR/webapp-fixes/node_modules"
  ```
  `npm install` cannot reach the registry from here, so `node_modules` is a symlink to an existing install. It shows as untracked. **Never commit it.**
- **Do not touch** the main checkout `/Users/chau.vinh.tuan/ws/me/redlineapp` (it is on another branch, `count-steps-changes`) or any existing worktree under `/private/tmp/claude-502/` (`plan`, `redlineapp-ts`, `web-files`, `web-open`, `web-theme`). `web-files` is used only for its `node_modules`. **Never push `plan`.** `docs/superpowers/` is untracked; do not commit it.
- **One commit per task.** Each commit is the code, its test in `test-smoke.js` and its doc change, together. A stale `docs/` is worse than none.
- **Every behaviour that can be asserted from outside gets an assertion**, including a grep that it is *wired up* in `public/app.js` or `src/hosts/web/*.js`. A fix that is correct but unreachable must not pass.
- **`npm test` must run with the sandbox off** (`dangerouslyDisableSandbox: true`); it binds `127.0.0.1`. Run it after every task. Write logs under `$TMPDIR`.
- **Run `npm run bundle` (sandbox off) before you report done.** Tasks 3 and 5 change code the desktop app embeds.
- **Style:**
  - 2-space indent, single quotes, trailing commas, 100-column soft limit;
  - check width with `awk 'length > 100 {print FILENAME":"FNR}' <files>` (`npx prettier` does not work here);
  - comments say *why*, in prose, at the density of the file you are in (this codebase comments heavily);
  - no new dependency, no framework.
- **There is no browser here.** Say which checks you ran (tests, bundle, width) and say plainly that anything visual is unverified.
- **Commit, but do not push or open a pull request until the user says so.** End commit messages with the attribution line your session is given. Merge, never rebase or force-push.
- **Do not edit** `CLAUDE.md`, `skills/`, `.claude/` or any settings file.

## Where the existing tests are (in `test-smoke.js` at `e2573ea`)

| What | Around line | Find by |
| --- | --- | --- |
| Reader over an in-memory platform | 2026 | `createReader({ platform: memory, pollMs: 20 })` |
| The web host and backend, pages over a port | 3632 onward | `const { createWebHost } = await import('./src/hosts/web/worker.js')`, and the `openPage` helper |
| A reader that cannot be built | 4108 | `// --- a reader that cannot be built` |
| The welcome, with a fake DOM | 4439 | `page.backend.welcome(el, hooks)` |
| Open files | 4785 | `createOpenFiles({ tab: tabA, shared })` |
| Wiring greps of the web backend | 5144 | `openFiles: createOpenFiles\(` |

---

## Part A: bugs

### Task 1: If the reader can't start, the page is blank and says nothing

**What happens.**
- A browser that has `SharedWorker` but cannot run a *module* SharedWorker fails to load the script. `openPort` in `src/hosts/web/backend.js` (~line 86) hears it:
  ```js
  worker.onerror = () => fn('Redline could not start its reader');
  ```
  That calls `disconnect(why)`. In `src/rpc/client.js` (~line 53-58) this rejects every pending call with `new Error(why)` and tells `watcher?.onLive(...)`. At startup there is no watcher yet, so the message reaches nobody.
- The first `load()` in `public/app.js` (~line 287-305) re-throws anything that isn't `NoDocument` or `NeedsPermission`:
  ```js
  if (!welcome || !['NoDocument', 'NeedsPermission'].includes(err?.name)) throw err;
  ```
- The re-throw ends the module's top-level `await` (~line 3396, `} else if (await load({ keepScroll: false })) {`). The welcome is still `hidden` (`<section id="welcome" class="welcome" hidden>`, `index.html` ~431), so the user sees an empty page with the toolbar and no message.
- The same happens for any other reader failure on the first load: IndexedDB unavailable, a quota failure, or the worker's `conn.failure` in `acquire()`.
- **In-page fallback** (no `SharedWorker`): `openPort` does `await import(WORKER_URL.href)`. If that fails, `createWebBackend` throws, `createBackend` throws at `app.js` ~120 (`const backend = await createBackend(...)`), and the page stops before the welcome is even mounted.

**Fix (recommended).**
- In the web app only (the branch where `welcome` exists; the CLI and the desktop app must behave as now), a `load()` failure that is not `NoDocument`/`NeedsPermission` should:
  - show the welcome with a status line saying Redline could not start its reader, and why (the error's message);
  - also send the error to `console.error`.
- The welcome has no way to show a message from outside: `sync()` clears the status (`say('')`). Add one, for example an `error` field on `sync({ reopen, back, error })` that is shown in the status line. Keep `showWelcome`'s `welcomeSeen` key working: a repeat call must still not wipe a message the user is reading. Include the error in the key, or pass it separately.
- For the fallback import: catch the failure inside `openPort` and return a port that never answers plus an `onError` that fires `fn('Redline could not start its reader')` on the next microtask. Then the backend is built, the welcome mounts, and the first call rejects with the reason like the SharedWorker path. If the code shows a cleaner way, use it, and say why in a comment.

**Steps.**
- [ ] Write the test first:
  - in the "a reader that cannot be built" block, or a block beside it, a page whose first `doc` rejects with a plain error ends up with the welcome visible and the reason in its status;
  - a welcome-level test that `sync({ error: '…' })` shows the text and a later `sync({})` clears it;
  - a wiring grep that `app.js`'s first-load path handles the generic failure in the web branch.
- [ ] Implement it, and run `npm test`.
- [ ] Update `docs/web-app.md` § "When something does not work" with a bullet: the welcome says when the reader cannot start, and why.
- [ ] Commit.

### Task 2: In Copies mode, dropped files leave rows that can't be opened

Copies mode is Firefox and Safari: every browser without File System Access.

**What happens.**
- A copy (`drop:<name>`) lives only in the worker's `drops` Map (`src/hosts/web/worker.js` `createWebHost`, and `platform.js`). The worker deliberately does not remember a drop (`worker.js` ~288-290: "A drop is not remembered: it is gone with this worker").
- The open-files list is in sessionStorage plus localStorage, and a new tab starts from the shared copy: `let list = read(tab) ?? read(shared);` in `src/hosts/web/open-files.js` ~43.
- So once the worker restarts (every Redline tab closed, and sometimes just a reload), the left column still shows `drop: notes.md`.
- Clicking it goes through `switchTo` and then `openFile(t.path, { unopened: \`Could not open ${t.name}.\` })` (`app.js` ~624). The reader's `open_` throws `cannot read drop:notes.md`, the user sees "Could not open notes.md.", and the row stays until it is closed with ×.
- A reload with `?id=` of a copy reaches `NoDocument` and then `closeDocument()`, which shows the welcome but leaves the row there too.

**Fix (recommended).**
- (a) Add a host-only call to the worker's `extra` (`worker.js` ~358), for example `drops()`, returning the names it holds. In `createWebBackend` (`backend.js`), before returning, remove every `drop:` row whose name the worker does not hold.
  - This has to happen before `app.js` ~126 reads `openFiles.list()`, which runs right after `await createBackend(...)`.
  - `createOpenFiles` will need a way to drop rows without picking a neighbour, for example `forget(id)` or `keep(pred)`. `close()` exists but answers a neighbour.
  - `extra` calls do not wait on `readerP`, and `drops` exists at once, so this is fast.
  - In the no-SharedWorker fallback, a new page always has an empty `drops`. Pruning every copy there is correct, because they are gone.
- (b) If a `drop:` row still fails to open (a race), say why and take the row off the list. For example: "notes.md was a copy, and a copy is gone once every Redline tab has closed. Drop it again."
- Dropping the same file again must bring the row back as before: same name, same path, same id.

**Steps.**
- [ ] Write the tests:
  - a host holding no drops, plus shared storage with one `drop:` row and one `web:` row: after `createWebBackend` the list has only the `web:` row;
  - a host that holds the drop keeps its row;
  - the unit tests for the new open-files method;
  - a wiring grep that `createWebBackend` prunes before returning.
- [ ] Implement (a) and (b), and run `npm test`.
- [ ] Update `docs/web-app.md` § "Coming back, and a grant that has lapsed", last paragraph ("A copy lives in the reader's memory…"): the copy's row leaves the open files too.
- [ ] Commit.

### Task 3: A failed write while watching loses that edit without any message

This is in the shared reader (`src/reader/reader.js`), so it affects every host. The web app is where it actually happens: IndexedDB quota, or a transaction aborted because the connection closed on `versionchange` (`idb.js`).

**What happens.** In the poll inside `watch(d)` (`reader.js` ~171-178):
```js
if (content === d.current) return;
d.current = content;
await d.store.record(d.current);
```
- If `record` throws (it writes an object, then the index, and propagates any failure; see `store.js` `async record`), the rejection is unhandled inside a `setTimeout` callback.
- The `change` is never emitted.
- Because `d.current` has already moved, every later poll sees `content === d.current` and skips it. That edit is never recorded or announced; only the *next* edit is.

**Fix.**
- Record first, and set `d.current` only once `record` has succeeded.
- Catch the failure so it is not an unhandled rejection. The next poll then retries. `record` is safe to repeat: the object is keyed by hash, and the index update checks the last hash.
- Log the failure (`console.error`). Don't flood the log at every poll while a quota stays full: once per failure streak is enough.
- Keep the existing order after a successful record: the `docs.get(d.id) !== d` check, `emit(change)`, `git.info`, `importGitHistory`.
- `open_` (~249) also records, but there a throw is the right answer (the open fails), so leave it.

**Steps.**
- [ ] Write the test against the in-memory platform reader (~2026). Make `writeText` under the store fail once, change the file, then let writes succeed. Assert that a `change` event still arrives and that the history holds the version.
- [ ] Fix it, and run `npm test`.
- [ ] Check `docs/architecture.md` for a description of the poll's order. Update it if one is there; otherwise no doc change.
- [ ] Commit.

### Task 4: The worker never forgets a connection (low priority)

**What happens.**
- `worker.js` ~496 throws away the stop function `connect()` returns:
  ```js
  globalThis.onconnect = (e) => host.connect(e.ports[0]);
  ```
- `conns.delete(conn)` runs only inside that stop function, so every page load adds a connection for the life of the worker.
- The sweeper and `grant()` walk all of them. A pinned tab can keep a worker alive for days.

**Fix (recommended).**
- The page says when it is going for good. In `backend.js` `onPageHide`, when `!e.persisted`, send a final bye, for example `{ t: 'bye', final: true }`. That needs a parameter on `bye` in `src/rpc/client.js`.
- The worker then stops serving that connection: call the stop function, which also closes the port.
- **Do not** drop a connection because it has been silent. A page in the back/forward cache can be silent for hours and must still be heard when it comes back (see the `swept` logic in `connect()`).
- Update the message table in `src/rpc/protocol.js` and the `bye` description in `serve.js`/`worker.js` comments.

**Steps.**
- [ ] Write the test: a page that sends the final bye has its port closed by the host (`connect`'s stop calls `port.close?.()`, which a fake port can record). A plain `bye` does not close it.
- [ ] Implement it, and run `npm test`.
- [ ] Commit. This is internal, with no user-visible doc. Mention it in `docs/architecture.md` only if that file describes `bye`.

---

## Part B: missing features, clear enough to build

### Task 5: Settings don't follow from one tab to another

**What happens.**
- `writeSettings` (`app.js` ~3080) calls `applySettings()`, which saves `prefs.setItem('redline:settings', …)` (~3074).
- The desktop app syncs between windows through `native?.onSettings(...)` (~3284). A browser tab has nothing: there is no `storage` listener anywhere in `public/` or `src/`.
- With two web-app tabs open, changing Appearance (new in #27), the font or the size in one leaves the other unchanged until it is reloaded. The CLI's browser tab has the same gap.

**Fix.**
- In `initSettings`, when `!native`, listen for `storage` events. If `e.key === 'redline:settings'`, set `settings = { ...DEFAULT_SETTINGS, ...parsed }` and call `applySettings()`, the same as the native `onSettings` handler does.
- Make sure there is no ping-pong between tabs. `applySettings` writes `prefs` back, and `setItem` with an unchanged value fires no event, but don't rely on key order in `JSON.stringify`. Skip the write when the text is unchanged, or don't write from the listener path at all.
- Only `redline:settings`. The layout keys mirrored by the head script (`redline:side`, `redline:sidew`, `redline:toc`, …) are each tab's own layout, and must not move under another tab.

**Steps.**
- [ ] Write the test, in the style of the theme block (search `applyScheme` in `test-smoke.js`):
  - extract the listener, or a wiring grep that `app.js` listens for `storage`, checks the `redline:settings` key, and calls `applySettings`;
  - an assertion that it is not installed for the native host.
- [ ] Implement it, and run `npm test`.
- [ ] Docs: `docs/web-app.md` § "Where your data lives" ("Your settings are in the origin's `localStorage`"): add that a change in one tab applies to the others. Check `docs/reading.md`'s settings section for the matching sentence about windows.
- [ ] Commit.

### Task 6: External links replace the Redline tab

**Confirm the scope with the user first:** web app only (recommended), or the CLI's browser tab too.

**What happens.**
- In the document's click handler (`app.js` ~1416):
  ```js
  if (HAS_SCHEME.test(href)) {
    if (!native) return;
  ```
  Every host without a shell leaves the click to the browser, which navigates the Redline tab away.
- In Copies mode this can probably cost the user the copy. With one tab open, leaving the page can end the SharedWorker, and Back then finds the copy gone. **Unverified without a browser.** Don't claim it in a doc.
- (The other `HAS_SCHEME` use, ~1158 in `linkLabel`, is only the hover label. Leave it.)

**Fix (recommended).** In the web app (`backend.host.kind === 'web'`):
- open `http:`, `https:` and `mailto:` links in a new tab (`window.open(href, '_blank', 'noopener')` after `preventDefault()`);
- leave a click with ⌘, Ctrl, Shift or the middle button to the browser, which already opens a new tab or window for those.

The CSP and `Referrer-Policy: no-referrer` (`scripts/build-webapp.mjs`) need no change.

**Steps.**
- [ ] Write the test: a wiring grep for the web branch, plus an extracted-function test if the code lends itself to one.
- [ ] Implement it, and run `npm test`.
- [ ] Docs: `docs/web-app.md`, and wherever `docs/reading.md` says where a link goes.
- [ ] Commit.

### Task 7: One file per pick or drop

**Match the desktop app.** A drop of several files opens all of them, one tab each: the first is shown and the rest join the tabs behind it (`shell/src/main.rs` ~249-254, `win::open_batch` in `shell/src/win.rs` ~371).

**What happens.** In `src/hosts/web/welcome.js`:
- `showOpenFilePicker({ types, excludeAcceptAllOption })` has no `multiple: true` (~170);
- the `<input type="file">` has no `multiple` (~155);
- a drop takes only the first item (~296):
  ```js
  const item = [...(e.dataTransfer.items ?? [])].find((i) => i.kind === 'file');
  ```

**Fix (recommended).**
- Allow several in all three paths.
- For a drop, read every item's handle, entry and `File` **synchronously, before any `await`**. A `DataTransferItem` is empty once the handler returns; the existing comment says so.
- Skip a folder (`NOT_A_FOLDER`) or a non-markdown file with a notice naming it, and still open the rest.
- Use one `run()` for the whole batch (its `busy` guard).
- Show the first file. The rest need rows in the open files without being opened. `openFiles.note` needs `{ id, path, name, dir, label }`:
  - the id is the reader's `hashContent(abs).slice(0, 12)` (see `retain` in `reader.js`);
  - the labels come from `handles.label(abs)` in the worker.
- So add a worker `extra` call, for example `describe(path)`, that answers those fields without retaining the document. Clicking such a row then opens it through `switchTo` as usual.
- The simpler alternative, opening each file in turn and ending on the first, paints every document. Use it only if you write down why.

**Steps.**
- [ ] Write the tests:
  - a fake picker answering two handles leaves both files in the list, with the first on screen;
  - a fake drop of two files plus a folder opens the two files and gives the folder notice;
  - the same for the `<input>` fallback.
- [ ] Implement it, and run `npm test`.
- [ ] Docs: `docs/web-app.md` § "Opening something" and § "Open files".
- [ ] Commit.

---

## Part C: ask the user before writing any code

Each of these is a product decision. Present the options and wait.

8. **No view of what's stored.**
   - The answer to `navigator.storage.persist()` is thrown away (`welcome.js` ~127, `afterOpen`).
   - Nothing ever removes entries from `roots` or `opened` (`handles.js` has no delete), so closing a file doesn't forget its grant.
   - The Settings "Where versions are kept" section is `data-shell` (`index.html` ~616), so the web app shows no storage section at all.
   - Options: a web-only Settings section showing whether storage is persistent (`navigator.storage.persisted()`) and how much is used (`navigator.storage.estimate()`), and perhaps "forget this file" or "clear history". Safari's seven-day eviction (`docs/web-app.md` § "The browser may take it back") is the argument for at least the "not persistent" line.
9. **No offline or install support.** There's no manifest and no service worker, and `index.html` is `Cache-Control: no-cache` (`scripts/build-webapp.mjs` ~91), so a reader of local files needs the network to start. Being installable would also enable Chromium's "Open with". A service worker interacts with the `?v=` versioning, `_headers`, the CSP's `worker-src 'self'` and the SharedWorker naming (`workerName`, `sibling` in `backend.js`). This is big enough for its own plan.
10. **Two granted files with the same name look identical** in the column and the bar. `handles.js` ~185: `if (kind === 'file') return { pathLabel: w.rel, dirLabel: '' };`. The File System Access API gives no path. Options: a "(2)" suffix, or a tooltip with when each was granted.
11. **Legacy folder roots.**
    - `worker.js` ~37 `isHandle` still accepts `kind === 'directory'`.
    - `backend.js` `linkNote` still follows links inside a folder root ("A folder granted before the web app took only files still follows its own").
    - Removing this changes behaviour for anyone who granted a folder in an earlier build. Keep it, or decide what such a root becomes.

## Part D: do not fix without evidence from a real browser

Record these in your report as open questions. Don't change code for them.

- **No timeout on calls** (`src/rpc/client.js` ~25-31), and the worker never answers the `ping`. If a worker went away *without* an error event (say, one ended while its only tab sat in the back/forward cache), every call would wait for ever and the status dot would stay green. Whether a browser does this is unknown.
- **Mobile file pickers.** `accept: '.md,.markdown,.mdown,.mkd,.mdx,.txt'` (`welcome.js` ~157) lists extensions only. iOS and Android pickers may grey out `.md` files, which have no common MIME type.
- **Reading a copy after the file changes on disk.** In Firefox and Safari, a `File` read after the file changed may throw `NotReadableError`, which `platform.js` maps to "not there" (`NOT_THERE`), or may return the new text.

## Report back

When you're done, tell the user:
- which tasks you did, one commit each, with the hashes;
- the `npm test` and `npm run bundle` results;
- the width check;
- that anything visual (the welcome's error line, new rows) is unverified;
- the Part C questions, if you were not given answers.

Don't push.
