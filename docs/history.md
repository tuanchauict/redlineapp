# History

**History**, under Contents in the right sidebar (**⌥⌘B**), is every version of
the document on screen, newest first. A row is **named by its commit subject**, or — for a version
you only saved — by the clock time it was taken; under the name sit how long ago it
was, and how much bigger or smaller the file was than the version before it. The
name is the half that holds still: *9 hours ago* reads differently every time you
look at it and an evening of saves says it four times over, so it is the second line
rather than the first. The tooltip gives the exact time and the short hash, and the
whole of a subject the column had to cut short.

Two words mark the rows that matter — `now` for the file as it stands on disk,
`read` for the version the change marks are measured from — set in the row's own
quiet type rather than as a filled badge, so it says so without shouting. **Click a
row** to
compare the file against that version; the row you are comparing against is filled
in. The choice is **kept for that file**, including across a restart, so a document
you are working through against one particular version opens there again rather than
having to be found in the list every time. Clicking the `read` row is the way back:
it means "whatever counts as read", which moves as you read instead of staying on
one version. See
[Change marks ▸ Comparing against something else](changes.md#comparing-against-something-else).

Everything about versions is asked here, and only here: which one to compare
against, whether to compare at all, which counts as read, and which to forget. A
history gets long, and a row has room to say what a version actually *is* where a
one-line bar has room for none of it — so the bar keeps what the document is and how
it is being shown, and a second, shorter list of the same versions is one list too
many. The sidebar works in a browser tab too, with the open-files section left out —
there, the versions are the whole of it.

## Reading a version by itself

The **eye** at the end of the History heading, or **`v`**, switches the list from
*comparing against* a version to **reading** it. With it on, clicking a row shows
that version as it was, rendered plainly with no marks, rather than the file marked
up against it. It stays on as you click from row to row, so a history can be stepped
through one version at a time, until you switch it off again.

- The filled row is always the text on screen. Click the `now` row to read the file
  as it is, without leaving the mode.
- **The bar names the version you are reading**, beside the same eye and filled
  the way its row is. With no marks, nothing else in the window tells last week's
  text from today's. Clicking that name switches the eye off.
- **Off, you see what changed since.** The version you were reading is already
  what the file is compared against, so switching off goes straight to its changes.
- The bar's title stays the file's own. Contents, find, the raw view and printing
  all follow the version on screen.
- There is nothing to check off or walk with `n` / `p` in an old version on its
  own, so the counter and the ruler go while you read one.
- The mode lasts as long as the window and is never saved. A window that opened
  on an old version with no marks would look exactly like the file as it is now.
  Which version is *picked* is saved, as above, because that is the same choice.

## From git

The first time a file tracked by git is opened, its **committed history is folded
into the list** — up to the last 50 commits that touched it, read with `--follow` so
a rename does not end the trail. Those rows are named by their commit: the subject
the author wrote, with the short SHA under it. So a file that has been in a
repo for a year opens with a year of versions to compare against, rather than
starting from "no earlier versions".

It is a catch-up, not a one-off: the commits already folded in are remembered, so a
file committed to while you were not looking at it is brought up to date the next
time you open it, and a `git pull` or checkout while it *is* open is picked up by the
watcher. Only commits that are new are read, so the usual case costs one `git log`.

Importing adds versions to compare against — it does not move your baseline, so it
never decides for you that you have or have not read something. The read is done in
the background: the file opens immediately and the rows appear a moment later.

## Cleaning up

The **cut icon** on a row forgets that version and every version older than it — it
cuts the list at that point rather than takes a row out of the middle of it. **Point
at it and the rows that would go turn grey**, so the scope is readable before the
click and not only in the sentence after it. The row then turns into its own
confirmation, since it is the one thing here that cannot be undone, and the rows stay
grey while it asks.

It used to be a bin, which was the wrong sign: a bin on a row offers to remove that
row, and no amount of wording in a tooltip undoes what the icon has already promised.
It was open scissor blades after that — cutting is the right verb — but at the size of
a row they read as a stray mark more than a tool. What it draws now is the line you'd
cut along rather than the tool that cuts it: a perforation, angled so it still reads
as an edge and not a row of dots.

**Clear history**, under the list, is the same act on the second row — forget
everything but the version on disk — and previews itself the same way. It sits under
the list rather than on a row because it is about all of them.

The current version is never dropped: it is what everything else is compared
against. If the baseline was one of the versions you forgot, it falls back to the
*oldest* version still in the list rather than to the newest, so tidying up never
quietly hides a change you have not seen. If the version you were *comparing*
against went, that choice is forgotten with it and the file goes back to the
default — rather than being left pointing at something that is not there. The
objects those versions pointed at are swept from the store if no other file still
references them.

### Checked changes and the versions they name

A [checked-off change](changes.md#checking-a-change-off) is stored as its key, the
version it was checked in and which block of that version it was. That is how a
checked block that is edited again can be diffed against the text you read: the
version is split again to find it, so no text is copied into the index.

Clearing history does **not** delete the object behind a version that a check-off
names. The version leaves the list, but its object stays on disk so the check-off
still works. Without that, clearing history would turn every check-off made in that
version back into "added the whole thing". Marking a version read clears the
check-offs, and with them these references. An object that has gone anyway, such as
one deleted by hand, makes that check-off show the block as plain *added* again,
with no error.

A check-off written by an older Redline is a bare key with no version. It is kept
and behaves as it always did.

## Where it lives

Outside your project, in `~/.redline`:

```
~/.redline/
  objects/<hash>.md     every distinct version of every file it has seen
  docs/<hash>.json      per-file history, baseline pointer, the version you last
                        compared against, checked-off changes, commits already
                        imported
  plantuml.jar          optional, picked up automatically if you drop one here
```

History is capped at 100 versions per file, and unreferenced objects are pruned on
startup and after a clean-up — except any younger than ten minutes, which may be a
version another window has written and not yet filed. Set `REDLINE_HOME` to move the store elsewhere.
Nothing is ever written next to your markdown file, and the file itself is only ever
read — including the git import, which only ever reads the repository.

### The same file in two windows or two programs

The store can be open in more than one process at once: the app and a tab beside your
editor, two editor windows, the command line next to the app. They share the history
rather than each keeping its own. A version marked read in one is marked read in the
other within a second or two, a change checked off in one stays checked off when the
other saves, and history cleared in one does not come back from the other.

Two writes in the very same few milliseconds can still lose the earlier one; if that
ever happens the cost is one mark, not the history.

A `~/.md-reader` left by the app's old name is **moved to `~/.redline`** the first
time one is found, so a rename of the app costs you no history. If the move cannot be
made — a permission, a mount — the old directory goes on being used where it lies
rather than the reader starting again from nothing.
