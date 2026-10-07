# Security

## Reporting a vulnerability

Please report it privately, through
[GitHub's private vulnerability reporting](https://github.com/tuanchauict/redlineapp/security/advisories/new),
rather than in a public issue. Say what you did, what happened, and which version
(Settings shows it in the app). You will get an answer within a week, and credit in
the release that fixes it if you want it.

Only the newest release is supported. A fix ships as a new release, not as a patch
to an old one.

## What is in scope

Redline exists to open markdown files, and a markdown file is often someone else's
text. So **a document that does anything beyond being read is a vulnerability**:

- A document that runs script, in the app or in the browser tab, or that changes
  the page around it.
- A document, or a diagram in one, that gets the app to write a file, run a
  command, or read a file other than the ones it was opened with and their
  images, without your clicking a link to it.
- A web page, or another program on the same machine, that can drive the
  `redline` command-line server: open a file in it, read a document through it, or
  write to the snapshot store.
- Anything that sends something about your documents off your machine. The only
  request the app makes on its own account is the update check, and only when you
  ask for it.

[What a document can do](docs/architecture.md#what-a-document-can-do) describes the
defences that are meant to hold, and is a good map of where to push.

## What is not

- Remote images in a document load, the same as in any markdown preview, and that
  tells the image's host that the document was opened. This is a choice, not a bug.
- Someone who can already write to your home folder can change your snapshot store
  or your settings.
- PlantUML is run only if you installed it, and is as safe as the copy you installed.
