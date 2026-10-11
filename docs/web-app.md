# The web app

Redline in a browser tab, with nothing to install and no server of yours to run. It is the
same reader the Mac app and the command line use: the same renderer, the same diff, the same
[change marks](changes.md) and [history](history.md), running in your browser rather than
behind a server. **It reads your files and never writes to them**, as the others do: a folder
or a file is granted read-only.

Nothing you open leaves the browser. The page may make requests only to the address it came
from, so a document cannot be posted anywhere, and what Redline remembers is kept in the
browser too ([Where your data lives](#where-your-data-lives)). The exception is what a
document itself asks for: an image a README links is loaded from where it is, as it is in the
Mac app.

To run it yourself, `npm run webapp` serves it on `http://127.0.0.1:8081`; see
[Building and testing](building.md#the-web-app).

## Opening something

A web page cannot be handed a file the way a program is. Everything it may read, you put in
front of it, so the first visit opens on a welcome with three ways in:

- **Open folder…** is the main one. You grant a folder, once, and the welcome lists the
  markdown files in it, three folders down and at most 500, without looking inside folders
  that start with a dot or are called `node_modules`. Pick one. The links between the
  documents in that folder open in place, which is why this is the way in to use for a set of
  notes.
- **Open file…** grants one file. It is watched like a file in a folder, but it has no
  folder around it, so its links to other files cannot be followed. Clicking one says so, and
  says to open the folder that holds the file instead.
- **Drop** a markdown file or a folder anywhere on the window. Where the browser allows it, a
  drop is the same as a pick.

A file that is not markdown is refused before anything is granted.

There is no menu. With a document open, the **folder button** before its name and **⌘O**
(Ctrl+O elsewhere) put the welcome up over it, with the same three ways in and a **Back to the
document**. The button again, that link or Escape takes it down. Dropping a file or folder on
the window opens it too, and so does a new tab ([the keys](keyboard.md#in-the-web-app)).

### Which browsers

What a browser can do decides which of two ways Redline reads your files.

| | **Live** | **Copies** |
| --- | --- | --- |
| Browsers | Chrome, Edge and the other Chromium-based desktop browsers that have the File System Access API | Firefox, Safari, and anything else without it |
| **Open folder…** | yes | not offered |
| **Open file…** | grants the file | reads a copy of it |
| A drop | a folder or a file, kept as a grant | a file, read once |
| Shows an edit made elsewhere | yes, within about a second and a half | no. Drop the file again |
| Follows links between files | yes, inside a granted folder | no. A click says why |
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
tab: a new tab is not the one that was closed. A document opened from a granted folder or file
is remembered. A copy is not, because it lives only in the reader's memory.

A browser decides how long a folder you granted stays granted. If it has lapsed, the page says
*Redline needs your permission to read* the folder *again*, with a **Reopen** button named for
it. It takes a click because a browser asks you only in answer to one. Chromium may offer to
keep a grant on every visit; either way the flow is the same.

If you take a grant back in the site's settings while a document is open, the page stops being
live and offers the same button. If the grant is denied, or the browser no longer has it, the
page goes back to the welcome and clears the id from the address.

A copy lives in the reader's memory, so it is gone when the reader is: when every tab of the
app has been closed, and a reload may be enough. The history stays, and dropping the file again
carries on from it.

## What is off

| | |
| --- | --- |
| Git | There is no git to run, so the git import is not offered, and neither is **Compare against ▸ git HEAD**. A saved choice of git shows as **Last read** |
| PlantUML | Not drawn. A PlantUML fence stays as highlighted source, with a note saying why. [Mermaid](diagrams.md) draws as it does everywhere |
| Fonts | Settings offers the usual choices, not a list of the fonts installed on your machine, which a browser only gives after a permission prompt |
| Updates | There is no **Check for Updates…**. A reload is the latest version |
| Shell settings | The ones that belong to the Mac app's window are not shown |

## Where your data lives

In the browser's **IndexedDB**, in a database called `redline`, which belongs to the
**origin** — the address the page is served from. There are three stores:

| | |
| --- | --- |
| `files` | The same files `~/.redline` holds, laid out the same way ([History ▸ Where it lives](history.md#where-it-lives)): every version Redline has read, and each file's history, baseline and checked-off changes |
| `roots` | The folders and files you have granted, as the handles the browser gave |
| `opened` | Which granted folder each document came from, so that a reload can find it, and the last document a tab showed, so that a bare visit can |

Your settings are in the origin's `localStorage`.

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
is the history of a file you read now and then. Safari reads copies and not folders
([Which browsers](#which-browsers)), and for a copy the history is the whole of what Redline
keeps, which is exactly what a week away erases. This is WebKit's published rule and has not
been tried against this app. If the record of changes matters, the Mac app keeps its history on
disk.

## When something does not work

- **The reader has its own console.** It runs in a worker, so its messages are not in the
  page's. In Chromium, open `chrome://inspect/#workers` and inspect the shared worker. Its
  name is `redline@<version>+<hash>`, because after an update a tab left open on the old build
  keeps the old reader, and a new tab gets a new one.
- **A folder is listed but a file will not open.** Its grant has probably lapsed: the page
  says so and offers **Reopen**.
- **The page opens with no history.** Check the address first: another origin has another
  store ([Where your data lives](#where-your-data-lives)).
