// The web app's host shim: the first script in the page, a classic script rather than a module
// so that it runs before the head script in index.html and before app.js.
//
// It says one thing, which is that there is no shell and no server to ask: `backend.js` reads the
// flag and loads `vendor/backend-web.js`, which finds the reader in a SharedWorker. Every other
// build's shim is `public/host.js`, empty, and so they never download that bundle.
//
// Not copied into `public/` -- the repository's own `public/host.js` stays the empty one, and the
// web app's build stages this file over it (`stage-page.mjs`, phase W4) so that a change here
// cannot reach the Mac app or the CLI.
globalThis.__REDLINE_WEB = true;
