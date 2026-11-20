# Redline for VS Code

A Markdown preview that remembers what you last read. Run **Redline: Open Preview to the Side**
(from the editor title bar, the Explorer's context menu or the Command Palette) and the file opens
beside the editor, with the paragraphs that changed since you last read it marked, a **History** of
the versions Redline has seen, and **Contents**.

It is the same reader as the Redline CLI and desktop app and shares their store in `~/.redline`,
so a version read in one is read in all of them. Nothing is written next to your file.

There is no list of open files: the editor already has one.

Limits: relative images in a document are not loaded, and PlantUML needs `java` and a jar as
elsewhere.
