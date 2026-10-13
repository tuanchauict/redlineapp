// Stage the page for the native shell.
//
//   npm run build:dist
//
// The desktop app has no server, so everything the page asks for over a URL has
// to be a file sitting next to it: the same files, in the same layout, that
// the web app is served from. stage-page.mts does the staging and says what
// the layout is; this is the desktop's end of it, which tauri.conf.json names
// as the front end and Tauri serves from inside the bundle.
//
// It stages the Tauri backend and leaves out the web app's two bundles, which
// the app has no use for and which would be bytes it only carries.
import { stagePage, megabytes } from './stage-page.mjs';

const { bytes } = stagePage('shell/dist', { host: 'tauri' });

console.log(`\n  shell/dist  ${megabytes(bytes)}\n`);
