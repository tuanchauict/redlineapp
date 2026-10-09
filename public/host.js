// The host shim: the first script in the page, a classic script rather than a module so
// that it runs before the head script in index.html and before app.js.
//
// The CLI and the Mac app need nothing from it -- the shell hands the app its facts through
// an initialisation script, and the CLI has none -- so here it is empty. The web app and the
// VS Code extension ship their own in its place, to put things on `globalThis` (such as
// `__REDLINE_PREFS`) that the page has to have before its first line runs.
