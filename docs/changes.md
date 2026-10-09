# Change marks

Redline snapshots every version of a file it has ever seen and renders the current
one against a **baseline** — by default the version present when you last marked the
file read. What moved since then is marked in the margin.

- a thin bar in the left margin: **green** added, **blue** changed, **red** removed
- inside a changed paragraph, the words that moved: the old wording struck through,
  the new wording tinted, in place
- everything else keeps its normal colour, so the document still reads as a document
- hover a marked block to tint it and name the change — `added`, `changed`,
  `removed` — in the right margin
- `+3 ~1 −2` on the bar is how much is still outstanding; clicking it opens the
  [history](history.md), which is where "changed since *what*?" is answered

![A blue bar beside a paragraph whose changed words are struck through and
tinted in place, the CHANGED label lit at its top corner; a table with one changed
cell below it, and a removed paragraph struck out](images/changes.png)

`n` / `j` and `p` / `k` walk the marks. `d` puts them away and leaves a clean
document; nothing is forgotten while they are hidden — the baseline keeps tracking,
and turning them back on costs no round trip.

## The ruler

Down the right edge, in the track the scrollbar runs in, is every change in the
file at once — the same three colours, at document scale rather than screen
scale.

The marks in the margin only speak for the screen you are on and the counter only
says how many there are altogether. Neither answers the first question you have
about a file someone has handed you: is it edited throughout, or is it three
paragraphs near the end. A mark on the ruler is level with the scrollbar thumb
that reaches it, so it is also how far you have to go.

It is drawn over the scrollbar, not instead of it: the scrollbar still takes every
click and drag, except on a mark itself, which takes the click instead. (A
left-gutter version was tried in between, to stay off the scrollbar's own
pixels entirely, but that gutter already belongs to the thin bar `.chg::before`
draws beside every changed block — a second set of marks there read as
clutter, not an overview, which is the worse trade.) The scrollbar itself is
pinned to a fixed width rather than left to the platform's own grow-on-hover,
because its grown state is wide enough to swallow several marks at once — a
moving target the ruler cannot share a track with.

The click and hover target is wider than the mark looks: the hit area spans
the whole track, same as a bigger first pass at this did, but the colour
itself is a narrower stripe centred inside it, widening only for the one
mark `n` / `p` or a hover has made current. A hit area that was also the
full width of its own colour read as a thick bar down the margin the moment it
was made easy to land a pointer on; keeping the two separate gets both. Runs of
changed lines merge into one band rather than becoming a row of hairlines, a
change you check off fades to a trace the way its margin mark does, and the whole
strip goes when the marks do. `n` / `p` widen and brighten whichever mark they
just took you to, so the ruler also answers "where am I" — not only "where are
the changes." Hovering a marked block does the same: the mark for the paragraph
under the pointer widens the moment the margin tint does, without waiting for
`n` / `p` to catch up to it, and fades back down rather than snapping when the
pointer moves on.

A mark also answers back: clicking one lands on the change it stands for, the
same smooth scroll and brief flash `n` / `p` land with, and hovering one runs the
tint the other way — the block or blocks the mark stands for brighten, the same
way the mark itself brightens when you hover the block. A band that merges forty
touching lines brightens all forty at once. A click on a band with nothing to
check off — a removed line in the raw view, or a change already checked off,
both of which the ruler still draws — still scrolls and flashes, just with no
change left for `c` to act on once you arrive.

## How the diff works

Two passes. The first compares **top-level blocks** — paragraphs, headings, list
blocks, code fences, tables, blockquotes — and marks each one added, removed, or,
when a removal and an addition line up and are similar enough, changed.

The second pass goes **inside** a changed block and diffs it word by word, so the
paragraph reads normally except for the part that actually moved. Edits separated by
a word or two merge into one phrase, so a rewritten sentence reads as a sentence
rather than a row of single-word marks.

The word diff runs on the *rendered* HTML rather than the markdown source — marking
up source would cut through emphasis runs, link destinations and fences — and it
never lets a mark straddle a tag it does not own, so the rendering stays intact.

It bows out when marking up the text would be less readable than not, and the block
falls back to showing the new version with the old behind a **before** disclosure:

- the block was rewritten rather than edited (under ~40% of it survived)
- the change is scattered across more than a dozen separate spots
- what was removed is structure — a whole list item, a table row — which has no
  valid place to sit inline
- the block is a diagram

A file's [`---` header block](reading.md#the-header-block) is one block to all of
this, which is why it reports a reworded `description` as a word diff in that one
value and leaves the fields around it plain.

In the [raw view](reading.md#rendered-and-raw) the diff is by line instead of by
block, over the highlighted source.

## Checking a change off

A change you have looked at and are done with can be put away one block at a time.
**Hover the block and click the word in the margin** that names the change, or press
`c`. Its mark goes, it stops counting towards `+3 ~1 −2`, and `n` / `p` walk past it.

So reading a heavily edited file is a matter of working down the marks until there
are none left, rather than reading around a page of highlighting that stays exactly
as loud as when you started.

- The tag on a checked block reads **checked ✓**, and clicking it again brings the
  change back. The marker bar stays in the margin at a trace: a mark you cannot see
  at all is one you would never think to take back.
- `✓ 3` appears on the bar to say how many you have put away. **Click it**, or press
  **⇧C**, to bring them all back at once.
- `c` acts on the change under the pointer — the one the ruler is showing as
  current — and otherwise on the change you were last taken to by `n` / `p`, and
  otherwise on the first one still on screen. So working through a run of edits is
  `n`, `c`, `n`, `c` without having to point at each mark.
- The checked list belongs to the document, not to the window: it is kept in the
  [store](history.md#where-it-lives) and survives a quit. Up to 400 per file.
- Only in the rendered view. The raw view is the file's own lines and has no blocks
  to check off, but the counter still reads the same in both views — it is counted
  from the change list, not from what is on screen.

A change is named by its own content rather than by its position, so checking one
off survives the document moving around it: check off an edit near the end, add a
paragraph at the top, and it stays checked. The price is the other way round — edit
that same wording again and it is a new, unchecked change, which is right, because
it is something else to read.

### A checked block that is edited again

What it comes back as is **what moved since you checked it**, not the whole block
again. Check off an addition, have a clause added to it, and it returns as
**changed**, with only that clause marked. If you had checked off a change and it is
edited again, you get the newest edit rather than the first one replayed from the
baseline. Everything else is still measured from the baseline; this applies only to
the blocks you checked off.

- **Blue means two things here, and the counter counts what is drawn.** Usually
  *changed* means changed since the baseline, and History tells you which baseline
  that is. A block that is blue because you checked it off is changed since *you
  read it*, which History cannot show. It counts as `~` in `+3 ~1 −2`, because a
  `~` is what is drawn.
- **"The same block, edited" uses the same test that pairs a removal with an
  addition**: at least 35% of it in common. A block checked as it stands is still
  what you read and is left alone. A checked block still in the file word for word
  has not moved, so it cannot be matched to some other block. Each check-off is
  matched at most once. When the block is also an edit against the baseline, the
  baseline wins unless what you checked off is at least as close to the file.
- A check-off remembers the version it was made in and which block of that version
  it was. The text you read is found again by re-reading that version from the
  [store](history.md#checked-changes-and-the-versions-they-name), so nothing extra is
  copied. If that version cannot be read, the block goes back to plain **added**.
- **Marking a version read clears every check-off.** "All of this is seen" includes
  every "that bit is seen". A check-off left behind would name a version and a block
  that could be matched against edits made long after the read.
- Only check-offs from the 20 most recent versions they were made in are used this
  way. Older ones still hide their own marks; an edit to one of those comes back as
  if it had never been checked.
- The raw view has no blocks, so none of this applies there.
- **One gap:** if a checked-off change is then rewritten so heavily that the block
  pass no longer pairs it with its baseline text, the rewrite is still diffed against
  what you checked, but the baseline's text comes back once more as a separate
  **removed** block. Nothing in a check-off records what that text was, so it cannot
  be told apart from a real removal.

### Not the same as marking read

Marking a version read says "I have seen all of this" and moves what everything is
measured from. Checking a change off says only "I have seen that bit": the file has
still moved, and the rest of what moved is still worth marking.

## Comparing against something else

The **history** in the left sidebar (**⌘B**) is where the baseline is chosen; there
is no dropdown on the bar. Click a version to compare the file against it, and that row
fills in to say so. Two rows answer the questions that are not about one particular
version:

| Row | Meaning |
| --- | --- |
| the newest, tagged `now` | The file as it stands on disk — nothing to compare it against, so the document renders plainly with the marks put away |
| whichever carries `read` | The version present when you last marked the file read. The default, and it moves as you read rather than naming a fixed version |

**The choice sticks.** A version you pick is remembered for that file and put back
the next time you open it, across a restart — it is a reading position, like where
you had scrolled to, not a mode you have to set again every morning. It is kept per
file, so opening a second document does not inherit the first one's choice, and the
`read` mark is untouched: what you are comparing against and what counts as read are
two different things.

**Compare against** in [Settings](native-window.md#settings) picks which baseline a
document opens on *the first time* — last read, or git HEAD where there is one. It is
the fallback for a file you have never chosen a version for; once you have, that file
keeps your choice and the setting stops applying to it. Changing the setting still
takes effect at once on the document in front of you, which is also how you put a
file back on `read`: click the row that carries the `read` mark.

To read a version as it was rather than the file marked against it, switch History
to [reading a version by itself](history.md#reading-a-version-by-itself) (`v`).

Forgetting the version you were comparing against — with the **cut icon** on its row,
or **Clear history** — forgets the choice with it, and the file falls back rather
than pointing at something that is no longer there.

## Marking read

`m`, ⇧⌘M, or **View ▸ Mark Read** moves the `read` mark to the version on disk and
clears the highlights: the "I've seen these changes" key. The `read` chip in the
history then sits on the newest row, which is where you see it landed.

There is deliberately **no button for this in the list**. The row it would sit on is
the row you click to compare against that version, and from an inch apart the two did
very nearly the same thing — a clean document either way. What the list cannot do is
say "I have seen this" without being open, so that is all the key is for.

It is not undoable and does not need to be: the version the mark came off is still in
the history, and clicking its row compares against it again.
