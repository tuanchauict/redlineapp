# The VS Code extension

A Markdown preview with Redline's change marks, **History** and **Contents**. It is the editor's
own Markdown preview with a memory: the paragraphs that moved since you last read the file are
marked, and the versions Redline has seen are a click away. There is no list of open files and no
tabs; the editor has both.

`Redline: Open Preview to the Side` (`redline.open`) is, for a file named `.md` or `.markdown` whatever its language mode (an agent extension can make `SKILL.md` "Skill"), in the editor title bar and the
Explorer's context menu for a Markdown file, and in the Command Palette while one is active. Each
call opens a panel; two panels on two files are two documents, and the same file twice is one
document held twice.

It reads and writes the same store as the CLI and the apps, `~/.redline` (or `REDLINE_HOME`), so
a version read in one is read in all of them. Nothing is written next to your file.

## How it is put together

The fourth shell on the one reader ([architecture](architecture.md)): the reader is in the
**extension host**, next to the files, and the page is in a **webview**, reached over
`postMessage` with the same protocol as the web app's worker (`src/rpc/`).

- **Files** go through `vscode.workspace.fs`, so a document in a remote window or a container is
  read where it lives. A file the editor reaches through another provider goes by its URI;
  a local one by its path, which is what git and `~` need. `platform.ts` is handed the `vscode`
  module rather than importing it, so that the suite runs it over a stand-in.
- **A panel is pinned to its document** (`panel.ts`). A page that names no document is answered
  by the reader with the first one opened, which would show a second panel the first panel's
  file. So the id is the panel's, and the page's is ignored; opening a link moves it.
- **Preferences** live in the editor's global state, not the webview's `localStorage`, which is
  not kept between sessions or shared between panels. `host.js` reads them from a `<meta>` the
  extension host wrote, synchronously, because the head script reads them before first paint, and
  posts a change back as `{ t: 'pref' }`.
- **The theme** is the editor's. `prefers-color-scheme` in a webview is the operating system's,
  so `host.js` answers that one query from the editor's theme and passes a change on as
  `{ t: 'scheme' }`, so *System* in Settings follows the editor.
- **The policy** is `core/csp.ts`'s with the editor's `cspSource` in place of `'self'` and
  `connect-src 'none'`: the page never talks to anything but the extension host (`html.ts`).
- **A restart** brings each panel back: `host.js` keeps the file in the webview's state and the
  serializer reopens it.

## The page in the panel

`host.js` puts a `vscode` class on the root, and `styles.css` keys on it. The editor's tab already
names the file, so the bar goes to the bottom edge and drops the title, the icon, the Beta tag and
Open; the top offset (`--bar-h`) becomes nothing and `--bar-b` (30px) is taken from the bottom of
the document, the columns and the ruler. The bar's height is also in
`public/app/layout/toc-height.ts` and the head script of `index.html`. `scrollbar-color` is set
on the root because the webview's default stylesheet sets its own, and Chromium then ignores the
`::-webkit-scrollbar` rules, leaving the editor's dark track beside a light page.

## Building it

```
npm run build:vscode          # -> dist/vscode/
cd dist/vscode && npx @vscode/vsce package
```

## Releasing it

On its own tag and with its own version, apart from the app's: `vscode/package.json` carries the
version, `.github/workflows/vscode.yml` packages the `.vsix` on every pull request (so a manifest
the Marketplace would refuse fails there) and, on a tag `ext-vN.N.N`, publishes it as publisher
`tuanchauict`. The tag must equal the manifest's version or the run stops. The tag is not `v*`
because that is the app's, and `vscode-v1` would match it and cut a Mac release.

```
# edit "version" in vscode/package.json, merge, then
git tag ext-v0.0.2 && git push origin ext-v0.0.2
```

The token is the repository secret `VSCE_PAT`: an Azure DevOps token with scope Marketplace >
Manage and "All accessible organizations", used by the publish step alone. It expires (the first
one on 2027-11-19) and publishing then fails with a 401; make a new one and replace the secret.
It is published as a **pre-release** while the extension is alpha (`--pre-release` on both
`package` and `publish`, which must agree), so the editor offers it only to those who opt in; drop
the flag from `vscode.yml` to make it the default.

The display name has to be unique, and not merely close to another extension's: "Redline" was
taken and "Redline Markdown Preview" was refused as too like "Offline Markdown Preview", so it is
"Redline: spot what an AI agent edited in your docs". Nothing was uploaded under 0.0.1 or 0.0.2
(the name was refused each time), so 0.0.3 is the first version. The Marketplace refuses a version
it already has, so a failed publish after the upload needs a new number.

## Not there, and not verified

- Relative images in a document are not loaded: the webview may only read the extension's own
  files.
- PlantUML needs `java` and a jar, as everywhere else.
- **None of this has been run in VS Code.** The suite covers the policy, the platform, the panel's
  pinning and preferences over a stand-in editor and a fake webview, and that the pieces are
  wired. That the editor accepts the manifest, serves Mermaid's `.mjs` chunks, and draws the page
  is unchecked, and so is how it looks.
- The `vscode` types are `types/vscode.d.ts`, a stand-in of what is used, not `@types/vscode`.
