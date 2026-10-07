# Reading a document

Redline renders with `github-markdown-css` and `highlight.js`: tables, task lists,
`> [!NOTE]`-style alerts, and syntax highlighting in fenced code. Light and dark
follow the system theme unless you pin one in [Settings](native-window.md#settings),
which also offers **Sepia** in the desktop app — cream paper and dark-brown ink,
with code blocks, table stripes and Mermaid diagrams tinted to match rather than
left as white cards. The change marks get their own green, blue and red for it:
GitHub's were picked against white and go muddy on cream, so each is darkened until
it reads at 4.5:1 on the page and on its own wash, as the light ones do. A browser
tab has no appearance setting; it follows the system.

There is no edit mode. Redline reads the file and never writes to it.

A table too wide for the column scrolls inside itself, the way it does on GitHub.
One exception: a cell holding something with no spaces in it — a path, a long URL —
is allowed to break mid-token rather than set the width of its column. Left to
itself that cell pins the table wider than the prose, and the rest of the row ends
up behind a scrollbar that on macOS is invisible until something scrolls it, so the
text is simply gone as far as the reader can tell. A wrapped path is the lesser
evil in something you are reading rather than copying out.

## The header block

A file that opens with a `---` fence — a skill's `name` and `description`, a post's
`title` and `date`, whatever the tool that reads the file wants — gets that block set
as a **card of labels and values** above the first heading, not as prose.

Values are shown **exactly as the file writes them**, and the card is set in a
**monospace** face — a header is machine-facing text, and `Skill(ste-style)` should
not be ambiguous about its own punctuation. The font is the fixed mono stack rather
than the document's, so a custom [document font](native-window.md#settings) cannot
drag the card around with it; the same opt-out the tooling labels take.

Nothing in the card is rendered as markdown, because the question a reader has about
a header is what the consuming tool will see: a `description` containing `_id_` has
underscores in it, and showing it in italics would be answering a question nobody
asked. Lists and nested fields keep their shape, and a `|` block keeps its line
breaks.

The card is **one block** as far as the rest of Redline is concerned, which is what
makes it behave:

- Reword a `description` and you get a word diff **inside that one value**, with the
  fields around it left alone — see [changes](changes.md).
- It contributes **no row to the contents list**. Before this, markdown read `---`,
  a line of text, `---` as a giant setext heading, so a header's `description` took
  the top of the outline and pushed the document's real first heading down.
- It lines up between the rendered and raw views like any other block.

A header that declares a `title` — or a `name`, which is what a skill file calls the
same thing — is also [what the bar calls the document](#what-the-bar-calls-it).

Only the very first thing in a file is a header. A `---` further down is still a
horizontal rule, and `---`, a line of prose, `---` is still the `<h2>` that markdown
says it is — the test is whether the first line inside the fence is a named field.
A line inside a header that is *not* a field is shown as written, in grey, rather
than guessed at.

## What the bar calls it

The big line at the top left is **what the document calls itself**, not the name of
the file. `SKILL.md`, `README.md`, `CLAUDE.md` are the conventions the tool reading
the file insists on, not what the document is, and three windows of them are three
windows with the same title.

Two ways of saying it, in order of how deliberate they are:

1. **A `title` in the header block** — or a `name`, which is what a skill file calls
   the same thing. Someone has written down what to call this document.
2. **A lone `# ` heading.** A document with *exactly one* `<h1>` is named by it,
   which is the usual shape of a README or a design note.

Exactly one, because the count is the whole of the evidence. Several `<h1>`s are a
document of equal parts, and the first of them is a section heading that happens to
be at the top — calling the document by it would be picking one chapter's name for
the book. No `<h1>` says the same thing in the other direction. Either way the file's
own name is the better answer, and that is what the bar goes back to.

The filename is never lost, only put behind the title rather than under it: **hover
the name to see where the file is** — its directory, or, when there is a title, the
full path with the filename on the end. That line clips from the left, so the name
is the part that stays visible when the path is too long for the bar. The swap is in
place, so the bar stays one line tall whether or not a document has a title.

Only the bar reads this. The open-files rows and the native window title still go by
filename — naming those means reading the header, and counting the headings, of every
file that is open rather than just the one on screen.

## Rendered and raw

One two-state button on the right of the bar, or `r`. The icon shows the view you
will get — `≡` for rendered, `</>` for raw.

The raw view is the file's own markdown, syntax-highlighted and numbered, with
change marks on the lines that moved rather than on the blocks. It tracks the
document text size a size down.

The view you were last in is remembered per browser or per app, and switching keeps
your place — the line of the file you are on, not the number of pixels you had
scrolled, which is a different part of the document once the same text is set as
prose rather than as the markdown it was written in.

## Find in a document

`⌘F`, or **Edit ▸ Find…** in the desktop app, opens a bar in the top right: type
into it and every match in the document on screen is marked as you type, with a
count and a way to step through them — next on Enter, previous on ⇧Enter, or the
arrows in the bar itself. Escape, or the bar's own close button, puts it away.

This is **find in the open document**, not a filename filter and not a search
across every file that has been opened — there is no index behind it, only the
text already on screen. It looks in whichever view is up, rendered or raw, and
stays correct across a repaint: a change mark checked off, the file saved and
reloaded, switching rendered and raw — the search is redone against whatever is
on screen rather than trusting a match found before it changed.

A case-insensitive match can cross the boundary inside a styled run — searching
`release notes` finds it even where the markdown reads `**release** notes` — but
it will not cross out of a code block into the prose around it, or the other way,
since neither is written as if it were next to the other.

## Printing

`⌘P`, or **File ▸ Print…** in the desktop app, prints whatever the window is
showing: the rendered view with its change marks, or the raw view, whichever you
are on. A browser tab needs nothing from Redline for this — `⌘P` is the browser's
own — but the app has no such shortcut of its own, so the menu supplies one. It
drives wry's own `print()` on the window directly rather than the page's
`window.print()`, which WKWebView does not implement.

The bar, the sidebars, find and the change ruler all go: none of them is part of
the document, and none survives onto paper. The text width in
[Settings](native-window.md#settings) — Narrow, Medium, Wide — is set aside too
and the document prints at the full width of the page: those are measures for a
window you scroll, in pixels that answer to nothing about the sheet a printer
feeds, and **Wide** in particular would run a column off the edge of it. Dark and
sepia appearance are set aside the same way, for the same reason ink is not pixels:
a printed page is always light, whatever the window is set to.

A browser tab's own print dialog would supply a page margin on its own; wry's
native `print()` has no dialog in front of it and otherwise runs the text to
the edge of the sheet. The margin can't be set in CSS either — WebKit's print
pagination decides how much content fits on a page from the system's own
margin, not from `@page`, so a margin asked for only in CSS runs every page's
content off its own bottom edge instead of leaving a gap at the top. So the
app sets a real one-inch margin natively, the same way a print dialog would,
before handing the window to WebKit to paginate — see `print_window` in
`shell/src/menu.rs`.

## Live reload

The file is watched. When it is saved the page updates in place, keeping your scroll
position — so an editor on one side and Redline on the other stay in step without a
reload.

There is nothing on the bar while that is working, which is all of the time — a light
that is always on tells you nothing. A red dot appears at the left of the bar only if
the watch drops, which is the one state worth knowing about: what is on screen has
stopped following the file. The connection comes back by itself, and the dot goes
when it does.

## The sidebars

There are two, one down each side of the document, and the two buttons at the far
right of the bar show and hide them. Each is an outline of the window with the
column it stands for marked off, so which one a button means is the picture rather
than the tooltip — and **the state is in the picture too**: that column is filled
in while it is open and empty while it is closed.

Which is the same thing VS Code does, and it is the better answer twice over. A
selected *background* on a 16 px frame icon puts a filled rounded square around a
drawing of a rounded square, which reads as a smudge rather than as a state. And
it tells you "this button is on", when what you want told is "that column is
open". The icon says the second thing.

**⌘B — the left column**, which is where you came from:

- **Open files** — the tabs of this window, and nothing else. Desktop app only;
  see [Tabs](native-window.md#tabs).

It is the one list you stop needing once you have picked a file, and it gets the
column to itself so that choice fades once it is made instead of sitting next to
the document asking to be looked at again.

**⌥⌘B — the right column**, which is where you are in what you are reading:

- **Contents** — the document's own headings. See [below](#the-contents-list).
- **History** — every version of the document, and the only place the baseline is
  chosen. See [History](history.md).

Both answer a question about *this* file, not about the window, which is why they
share a column: following a long document through a review means asking where am
I in this and what has changed since when *at the same time*, and putting one of
them on the other side of the window makes you pick.

Both have their own disclosure triangle, so either can hand its room to the
other: fold **Contents** once you know a document's shape, or fold **History**
once a review has settled and nothing in it is moving any more. **Contents**
opens tall enough to place a document's shape without a fold, under a line
that is also a handle: **drag it** to give Contents more room or hand more
back to History, **double-click** it to put it back where it started, and
with it focused ↑ / ↓ move it a step at a time. History never gives up its
last few rows to the drag — past a point the handle stops rather than crush
the list under it.

The document is centred in what is left of the window, so a single column down
one side pushes it off-centre; a pair puts it back, and opening the one you were
missing no longer slides the text sideways under your eyes.

Both are remembered and applied before the first paint, so nothing flips or
unfolds on open. If you were on **Contents** when this change landed, the right
column is open the first time you start — an update that quietly took away the
list you had up would read as a bug.

With the left column hidden, the chevron next to the filename opens the file list
as a menu. The `+3 ~1 −2` counter opens the right column instead — "changed since
what?" is a question about versions — and clicking it again puts it away.

**Drag either inner edge** to make that column wider or narrower. 236 px is where
each starts, not what it is: a path over a filename, a commit subject and a
heading three levels deep all want different amounts of room. Double-click an edge
to put it back. With the edge focused, ← and → move it and Home / End take it to
its limits — the arrows follow the edge, so on the right-hand one it is ← that
widens.

Both widths are remembered — per browser, and across every window of the app. Two
columns that are each a reasonable width can still leave no document between them,
so the document keeps 320 px of the window whatever they were set to, and
**Contents** is the one that gives way first: the prose and the files you are
moving between are worth more of a narrow window than the map of one of them. None
of this is permanent. Widen the window and the widths you chose come back.

## The contents list

The right column is the document's own headings, in order, indented by level. It
is how you move about a file that is too long to scroll — and the shape of one at
a glance, which no single screen of it shows.

- **Click a row** to jump to that heading, put at the top of the pane.
- The heading you are reading under is marked, and follows you as you scroll.
- Indentation is measured against the shallowest heading in *that* document, so a
  file that starts at `##` does not sit in from the edge for no reason. Depth is
  capped, so a deeply nested document does not spend the column on whitespace.
- A document whose only heading is its title has no contents — one row saying what
  the toolbar already says is not a list. The column stays and says so rather than
  closing itself: whether it is open is your standing choice, not something each
  document gets a vote on, and a column that shut itself on one file and came back
  on the next would be the window rearranging itself as you read.

Headings get ids in the rendered view, which also makes the document's own in-page
links work: `[see below](#notes)` lands on the heading, in either view. In the raw
view there are no ids to land on, so a row finds the line the heading is written on
instead.

## Link peek

Hover a link and its destination appears in the bottom-left corner, the way a
browser shows it. A window with no address bar otherwise gives you no way to find
out where "the design doc" goes short of clicking it.

It is written the way the document's author would recognise it: a URL in full, an
in-page jump as the anchor it lands on, and a link to a file beside this one as that
file's path — not the loopback address the reader happens to serve it from.

## Links to other files

A link to another markdown file opens it. Relative links — `./api.md`,
`../adr/0004.md`, `notes/todo.md` — are resolved against the directory the
document you are reading came out of, which is the only thing they were ever
written against. An absolute path is taken as it stands.

- **In the desktop app** the file opens in a window of its own, and the document
  you came from stays open behind it.
- **In a browser tab** it opens in place, and the address updates so Reload comes
  back to what is on screen.

A relative link to anything else — an image, a directory, a file this reader does
not open — does nothing rather than navigating the page off the document.

`http:` and `mailto:` links go to your browser and mail client. In a browser tab
they behave exactly as they always do.

## Scrolling

The document is the scroll area and takes the usual keys without a click first:
Space / ⇧Space, Page Up / Page Down, ↑ / ↓, Home / End.

See [Keyboard](keyboard.md) for the rest.
