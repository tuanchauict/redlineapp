# The web app

Redline in a browser tab, with nothing to install and no server of yours to run. It is the
same reader the Mac app and the command line use: the same renderer, the same diff, the same
[change marks](changes.md) and [history](history.md), running in your browser rather than
behind a server. **It reads your files and never writes to them**, as the others do: a file is
granted read-only. It is the smaller of the two: one file at a time, with no git
([What is off](#what-is-off)).

Nothing you open leaves the browser. The page may make requests only to the address it came
from, so a document cannot be posted anywhere, and what Redline remembers is kept in the
browser too ([Where your data lives](#where-your-data-lives)). The exception is what a
document itself asks for: an image a README links is loaded from where it is, as it is in the
Mac app.

It is at [app.redline.iamtuna.org](https://app.redline.iamtuna.org/), which the landing
page links from its nav, its hero and its *Get it* section. To run it yourself, `npm run webapp`
serves it on `http://127.0.0.1:8081`; see [Building and testing](building.md#the-web-app).

## Opening something

A web page cannot be handed a file the way a program is. Everything it may read, you put in
front of it, so the first visit opens on a welcome with two ways in:

- **Open file…** grants one markdown file, which Redline then watches for edits.
- **Drop** a markdown file anywhere on the window. Where the browser allows it, a drop is the
  same as a pick.

The web app opens **files, not folders**. Nothing offers to pick a folder, and one dropped is
refused with a note that the Mac app opens it. A file granted by itself has no folder around
it, so its links to other files cannot be followed either: clicking one says so. A file that is
not markdown is refused before anything is granted.

The welcome says what the web app leaves out before you go looking for it, with a link to
[the Mac app](https://redline.iamtuna.org/#get), which has all of it
([What is off](#what-is-off)).

There is no menu. With a document open, **⌘O** (Ctrl+O elsewhere) and **Open file…** at the
foot of the left column are the browser's file picker, and the file you pick joins the open
files ([the keys](keyboard.md#in-the-web-app)). A file dropped on the window joins them too; a
folder dropped there is refused with a notice, and the document stays where it was.

### Open files

The left column lists the files the tab has open, as the Mac app's tabs do
([The sidebars](reading.md#the-sidebars)). Whatever you open joins the end: a file picked or
dropped, or the document a bare visit reopens. Click a row to go back to a file,
where you left it; × or a middle click closes one, and closing the file on screen shows its
neighbour, or the welcome if it was the last. The list is the tab's own and a reload keeps it.

### Which browsers

What a browser can do decides which of two ways Redline reads your files.

| | **Live** | **Copies** |
| --- | --- | --- |
| Browsers | Chrome, Edge and the other Chromium-based desktop browsers that have the File System Access API | Firefox, Safari, and anything else without it |
| **Open file…** | grants the file | reads a copy of it |
| A drop | a file, kept as a grant | a file, read once |
| Shows an edit made elsewhere | yes, within about a second and a half | no. Drop the file again |
| History across visits | yes | yes, by file name |
| A bare visit reopens the last document | yes | no. A copy is gone with the reader |

In **Copies**, Redline reads a copy of each file you give it and keeps no link to the original.
It can still tell you what changed: drop the file again tomorrow and the marks show what is
different from the version you last read. That is this mode's version of watching.

A copy has no path to be known by, so a **name is the whole of its identity**. Two different
files both called `README.md` are one history, and the path in the header reads
`drop: README.md` so that this is not hidden. It holds across tabs, too: a different `notes.md`
dropped in a second tab replaces the first tab's, and the first tab shows it as a change.

Where a browser has no `SharedWorker`, each tab runs its own reader over the same stored
history instead of sharing one, so a file open in two tabs is read twice.

### Coming back, and a grant that has lapsed

The address carries the document's id, `?id=…`, so a reload opens the same document again. A
visit to the bare address, a bookmark or a new tab, opens the last document a tab showed, and
goes the way a reload does. There is one such document for the browser profile, not one per
tab: a new tab is not the one that was closed. A document opened from a granted file is
remembered. A copy is not, because it lives only in the reader's memory. A new tab starts its
open files from the list a tab last had, and a tab whose files you all closed starts at the
welcome instead of reopening the last of them.

A browser decides how long a file you granted stays granted. If it has lapsed, the page says
*Redline needs your permission to read* the file *again*, with a **Reopen** button named for
it. It takes a click because a browser asks you only in answer to one. Chromium may offer to
keep a grant on every visit; either way the flow is the same. Where the file is not the one on
screen, such as an open file you went back to, the welcome also offers **Back to the
document**, and Escape does the same.

If you take a grant back in the site's settings while a document is open, the page stops being
live and offers the same button. If the grant is denied, or the browser no longer has it, the
page goes back to the welcome and clears the id from the address.

A copy lives in the reader's memory, so it is gone when the reader is: when every tab of the
app has been closed, and a reload may be enough. The history stays, and dropping the file again
carries on from it.

## What is off

The web app reads one file at a time, and what it leaves out is what a browser cannot give it.
The Mac app has all of it: [get the Mac app](https://redline.iamtuna.org/#get), as the welcome
says.

| | |
| --- | --- |
| Folders | Not opened. The web app opens files, and a folder dropped is refused |
| Links between files | Not followed. A file granted by itself has nothing around it to read a link from, and a click on one says so |
| Git | There is no git to run, so the git import is not offered, and neither is **Compare against ▸ git HEAD**. A saved choice of git shows as **Last read** |
| PlantUML | Not drawn. A PlantUML fence stays as highlighted source, with a note saying why. [Mermaid](diagrams.md) draws as it does everywhere |
| Fonts | Settings offers the usual choices, not a list of the fonts installed on your machine, which a browser only gives after a permission prompt |
| Updates | There is no **Check for Updates…**. A reload is the latest version: your browser keeps the app's files and asks only whether the page itself has changed, so a release is fetched on the next load, and nothing is downloaded twice. A tab left open stays on the version it started with until you reload it |
| Shell settings | **On launch** and **Files from Finder** belong to the Mac app's windows and are not shown. **Appearance** is: the page draws light, sepia and dark itself |

## Where your data lives

In the browser's **IndexedDB**, in a database called `redline`, which belongs to the
**origin** — the address the page is served from. There are three stores:

| | |
| --- | --- |
| `files` | The same files `~/.redline` holds, laid out the same way ([History ▸ Where it lives](history.md#where-it-lives)): every version Redline has read, and each file's history, baseline and checked-off changes |
| `roots` | The files you have granted, as the handles the browser gave |
| `opened` | Which granted file each document came from, so that a reload can find it, and the last document a tab showed, so that a bare visit can |

Your settings are in the origin's `localStorage`. A tab's open files are in its own
`sessionStorage`, under `redline:open`, and the last list any tab wrote is in `localStorage`
too, for a new tab to start from.

What follows from that:

- **It stays in that browser, on that origin.** Another browser, another profile, a private
  window and another address each start with nothing. `http://127.0.0.1:8081` and
  `http://localhost:8081` are different origins; so are a deployed copy and the one you serve
  yourself.
- **The deployed app has an origin of its own**, `https://app.redline.iamtuna.org`, apart from
  the landing page's, so nothing the landing page runs can reach your history or your grants.
- **It is not the Mac app's history.** The same file opened in both has two histories, and
  neither knows about the other.
- **Clearing the site's data clears all of it**: the history, the grants and the settings
  together.

### The browser may take it back

Browser storage is not a disk. Unless a site is marked persistent, a browser is free to
evict its data when the machine runs short of room, and it does so a whole origin at a time.
After the first document opens from a click, Redline asks the browser to make its storage
persistent. Whether it does is the browser's answer: Chromium decides from how you have used
the site, and Firefox asks you.

**Safari has a rule of its own.** WebKit deletes a site's script-writable storage, IndexedDB
included, after seven days of using Safari without interacting with that site. In Safari that
is the history of a file you read now and then. Safari reads copies
([Which browsers](#which-browsers)), and for a copy the history is the whole of what Redline
keeps, which is exactly what a week away erases. This is WebKit's published rule and has not
been tried against this app. If the record of changes matters, the Mac app keeps its history on
disk.

## When something does not work

- **The reader has its own console.** It runs in a worker, so its messages are not in the
  page's. In Chromium, open `chrome://inspect/#workers` and inspect the shared worker. Its
  name is `redline@<version>+<hash>`, and its address ends in the build's `?v=`, because after an
  update a tab left open on the old build keeps the old reader, and a new tab gets a new one.
- **A file you opened before will not open.** Its grant has probably lapsed: the page says
  so and offers **Reopen**.
- **The page opens with no history.** Check the address first: another origin has another
  store ([Where your data lives](#where-your-data-lives)).
