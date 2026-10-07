# Command line

Two ways in, and they are different programs: the native app is a compiled binary,
`redline` is node.

## The native window

```
open -a Redline <file.md>...           # an installed copy
npm run app -- <file.md>...            # from a checkout
```

One tab per file, in the order you named them, in the window you are looking at —
or a new one if the app is not running. See
[The native window](native-window.md).

`$REDLINE_HOME` and `$PLANTUML_JAR` are honoured, but only as the app process
actually receives them: launched from Finder or the dock it has no shell
environment, so a setting made in `.zshrc` is not there. `npm run app` is a run
from your shell and does get them.

## `redline` — in your browser

On your `$PATH` after `npm link`; from a checkout, `npm start --`.

```
redline <file.md> [options]

  -p, --port <n>        Port to listen on (default 7391, next free port if taken)
      --no-open         Do not open a browser
      --app             Open in a chromeless Chrome/Edge window (nice for side-by-side)
      --plantuml-jar <p>  Path to plantuml.jar (also read from $PLANTUML_JAR)
  -h, --help            Show this help
```

`--app` looks for Chrome, then Edge, then Brave, and falls back to a normal tab.

## Environment

| | |
| --- | --- |
| `REDLINE_HOME` | Where the snapshot store lives, instead of `~/.redline`. See [History](history.md#where-it-lives). |
| `PLANTUML_JAR` | Path to `plantuml.jar`, if it is not on your `PATH` and not in the store directory. See [Diagrams](diagrams.md#plantuml). |

## The network

The server binds to `127.0.0.1` only and makes no outbound requests: the markdown
renderer, the syntax highlighting, the CSS and the mermaid bundle are all served
from `node_modules`, so a document renders the same with the network off. An
image the document itself links to is fetched by the browser, as it would be on
GitHub.

Binding `127.0.0.1` keeps other machines out, but not other pages in the same
browser, so the server answers only its own page. A request under any name but
`127.0.0.1` or `localhost`, or one that the browser says came from another site,
gets a 403. That includes a link to the reader from another website: the page
opens whatever path its address names, so such a link could otherwise open any
file you can read. Typing the address, or the CLI opening it, works as always,
and so do curl and scripts on this machine. A document's own HTML is sanitized
before it is drawn, so a `<script>` or an `onerror=` in a markdown file does
nothing. See
[Architecture](architecture.md#what-a-document-can-do).

The desktop app has no server and no port: the same code runs inside the webview
and reaches the disk over the shell's IPC. Nothing there listens on a socket
either. It makes exactly one outbound request, and only when asked: **Check for
Updates…** fetches a static `latest.json` from the newest GitHub release — see
[Checking for updates](native-window.md#checking-for-updates). Nothing in it
identifies you or the documents, and nothing fetches it on its own.
