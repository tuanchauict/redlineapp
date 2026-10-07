# The native window

Redline.app is a real Mac window rather than a browser tab — 8 MB of it, because the
shell is Rust and the WebKit is the one already on your machine. There is no OS
title bar: the traffic lights sit in the reader's own toolbar and the
whole strip is the window's title bar — drag it to move the window, double-click it
to zoom — the way VS Code does it. Window size,
position and **Always on Top** persist between launches.

Open a document with **⌘O** or **⌘T**, **File ▸ Open Recent**, by dropping a file on
the window, or with Finder's *Open With*. Links open in your real browser.

Make Redline the handler for `.md` and a double-click, or `open doc.md`, opens the
document in it — including when the app was not running, where the document arrives
*during* the launch rather than after it and waits the few milliseconds until there
is a window to put it in. See
[the desktop shell](architecture.md#the-desktop-shell) for why that is worth a note.

A document cannot reach past its own pane. Its HTML is sanitized before it is
drawn, the window runs under a content security policy, and the shell under the
page only writes into the snapshot store and only runs git, the font list and
PlantUML, each in the one form the reader uses. See
[What a document can do](architecture.md#what-a-document-can-do).

Pick several files in the open panel — or drop several on the window — and each
becomes a tab, in the order you picked them, with the first one on screen.

Launched with no file, it comes back to the files you were reading when you quit, on
the tab you were on — anything since deleted or moved is quietly dropped. Turn that
off in Settings and it asks for a file instead.

## Tabs

A file you open joins the window you are looking at, as another tab; **⌘N** starts a
new window instead. Naming several files at once — `open -a Redline a.md b.md` —
opens them as tabs of one window, and so does naming `other.md` again while the app
is up: another tab on the same instance, not a second copy of the app. Asking for a
file that is already open just brings it forward.

The tabs are **vertical**, in a sidebar on the left, the way Firefox and Chrome have
gone: a row across the top of a window this narrow turns every name into an initial.
**⌘B** (**View ▸ Sidebar**) shows and hides it, and the choice sticks. With it
hidden, the chevron next to the filename opens the same list as a menu. The
document's [contents](reading.md#the-contents-list) and
[versions](history.md) share the right-hand column instead, on **⌥⌘B**
(**View ▸ Contents**). See [The sidebars](reading.md#the-sidebars).

A tab is labelled with the file's name over the directory it is in, and the toolbar
says the same about the file on screen: a window's tabs can come from anywhere, and
the name alone does not say which `notes.md` you are reading. Paths under your home
directory are written with `~`; the line is clipped from the left, so the end of the
path — the part that differs — is the part you keep.

**⌃⇥** / **⇧⌃⇥** move between tabs, **⌘W** closes one — or its window, if it was the
last tab — and **⇧⌘W** closes the window outright. **Window ▸ Move Tab to New
Window** splits one out; **Merge All Windows** gathers everything back into one.
Each document keeps its own watcher, baseline and history however the windows are
arranged.

Switching tabs remembers where you were in each document — the scroll position, and
which version it was being compared against.

## Settings

**⌘,**, or **Redline ▸ Settings…**, opens a sheet over the window. Every control
takes effect as you change it; there is no OK to press. Settings belong to the app
rather than to a window, so every window agrees, and they survive a quit.

| | |
| --- | --- |
| **Appearance** | Follow the system, or pin light, sepia or dark. The window chrome, the document and the syntax highlighting all follow together. Sepia is warm paper for a long read: a light window with the document, code blocks, diagrams and change marks re-coloured for cream. |
| **On launch** | Reopen the files you left open, or ask which file to open. |
| **Files from Finder** | Whether *Open With* adds a tab to the window you are in or starts a new window. |
| **Typeface** | What the document is set in. The three built-ins first — the system sans, a serif (New York), monospace — then every font installed on this machine, drawn in its own face. A long read is easier in a serif, so the serif gets a little more leading with it. Only the prose changes: the toolbar and the sheet stay in the system font, and code stays code. |
| **Text size** | The document's own text, 11–24 px, a point at a time. The raw view tracks it a size down. |
| **Text width** | How wide the text column is allowed to get: narrow (680 px), medium (900), wide (1200). |
| **Show the change marks** | The same switch as picking the newest version in the history, set from either end. |
| **Compare against** | Which baseline a document opens on the *first* time — last read, or git HEAD where there is one. Picking a version in the history is kept for that file and takes over from this; changing this still applies at once to the document in front of you. |
| **History** | Where the snapshots live, with a button to reveal it in Finder. |
| **About** | Which version this is, and **Check for Updates**. See [below](#checking-for-updates). |

Under the reading rows is a line of the document's own type, at the size and in the
face you have just set, so the answer to "how will it look" is on screen rather
than behind the sheet.

The typeface list is the real one. A browser cannot enumerate fonts, so the app asks
macOS for the font panel's own list of families — the same names Font Book shows,
including anything you activated yourself — and offers those, minus the dingbats and
emoji nobody wants a document set in. A font set on one Mac and opened on another
that lacks it is kept, and shown under **Not on this machine** rather than quietly
dropped.

In a browser tab the same sheet appears — reached by the gear at the right of the
bar, since a tab has no app menu — minus the rows that are the desktop app's to
answer: there are no windows, no Finder and no launch. A browser's settings are kept
per browser rather than per app.

### Checking for updates

**Redline ▸ Check for Updates…**, or the button in the About row, asks whether there
is a newer release, and the answer lands in that row rather than in a dialog. It is
only ever asked: never on launch, never on a timer, and there is no badge to wait
for. It is the one request the app makes to anywhere but your Mac — a plain GET for
`https://github.com/tuanchauict/redlineapp/releases/latest/download/latest.json`, a
two-field file the release workflow attaches to every release, which GitHub
redirects to the copy on the newest one. There is no identifier and nothing about
your documents in it. Copies up to 0.5.0 ask `dl.iamtuna.org` instead, where the
releases used to live, and are told there about the first release on GitHub.

What it tells you depends on how this copy got here. Installed with
`brew install --cask`, it says to `brew upgrade --cask redline`, with a Copy button —
replacing a cask's app any other way leaves Homebrew believing the old version is
still installed. Dragged from the dmg, it offers the new dmg as a Download. It knows
which by Homebrew's Caskroom entry, not by where the app is: a cask moves the app
into /Applications, the same place a dragged copy goes.

A browser tab has no About row: run from a checkout, upgrading is `git pull`.
