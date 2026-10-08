// Stage the landing page's shared assets.
//
//   npm run build:site
//
// The page in site/ is hand-written and ships as it is written -- there is no
// bundler here and nothing is compiled. What this script does is copy in the
// two things the page points at that belong to the project rather than to the
// page: an image or two out of docs/images, and the app icon.
//
//   images/*.png   docs/images/   whatever the page names, and only that
//   icon.svg       assets/        the favicon, the nav mark, the footer mark
//
// Copied rather than committed twice, and site/images is in .gitignore, for the
// same reason public/vendor is: these are bytes that already exist in this
// repository, and a second copy is a second thing to remember to update. A
// screenshot regenerated for the README is then the one the site hands to a
// link preview, with nothing to keep in step by hand.
//
// Only the named ones, because the page itself shows none of them: every
// feature on it is played out live in markup and CSS, and the single png left
// is the card a chat window draws when someone pastes the link. Copying the
// rest would be uploading three screenshots nothing links to.
//
// Linking straight at ../docs/images would have been simpler still, but the
// deploy uploads one directory and a link out of it does not survive that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const IMAGES = path.join(SITE, 'images');
const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');

// content= as well as src= and href=, because the one image the page still
// wants is an og:image -- a reference no browser would ever report broken,
// since the only thing that resolves it is somebody else's link preview. That
// one is written with the site's own origin in front, because an unfurler will
// not resolve a relative og:image, so the origin is optional here and dropped.
const ORIGIN = 'https://redline.iamtuna.org/';
const LOCAL =
  /(?:src|href|content)="(?:https:\/\/redline\.iamtuna\.org\/)?([^":#]+?\.(?:png|svg|css|js))"/g;
const refs = [...html.matchAll(LOCAL)].map((m) => m[1]);

// A relative og:image passes every check below and still draws an empty card.
if (!html.includes(`property="og:image" content="${ORIGIN}images/`)) {
  throw new Error(`site/index.html's og:image has to be an absolute ${ORIGIN}images/ URL`);
}

// Emptied first, so a screenshot that stops being part of the page stops being
// deployed. Only ever what this script wrote: site/images is build output.
fs.rmSync(IMAGES, { recursive: true, force: true });
fs.mkdirSync(IMAGES, { recursive: true });

for (const rel of new Set(refs.filter((r) => r.startsWith('images/')))) {
  const from = path.join(ROOT, 'docs', 'images', path.basename(rel));

  if (!fs.existsSync(from)) {
    throw new Error(`site/index.html wants ${rel}, and docs/images has no ${path.basename(rel)}`);
  }

  fs.copyFileSync(from, path.join(SITE, rel));
}

fs.copyFileSync(path.join(ROOT, 'assets', 'icon.svg'), path.join(SITE, 'icon.svg'));

// And then every local reference, images or not, has to resolve to something
// that is now on disk. A stylesheet renamed on one side only would otherwise
// reach the deploy as a page with no styles at all -- and this is the one check
// available here, since there is no browser in this repository to open it in.
const missing = refs.filter((rel) => !fs.existsSync(path.join(SITE, rel)));

if (missing.length) {
  throw new Error(`site/index.html points at files that are not there: ${missing.join(', ')}`);
}

// The one thing the page cannot know on its own. Left as a sentinel rather than
// as a guess, and the build refuses to stage a page that still has it: a brew
// command nobody can run is worse than a page that failed to deploy.
if (html.includes('TAP/redline')) {
  throw new Error(
    'site/index.html still says TAP/redline. Replace it with the Homebrew tap,\n' +
      'as in `brew install --cask you/tap/redline`.',
  );
}

// The dmg is attached to a GitHub release under a versioned filename -- the
// release job in ci.yml builds it out of the version -- so the download
// button has to name a version. Substituted from package.json rather than
// hand-edited, so a release is a version bump and a build, not two strings kept
// in step by eye across two files.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RELEASES = 'https://github.com/tuanchauict/redlineapp/releases/download';
const dmgHref = new RegExp(
  `href="${RELEASES.replaceAll('.', '\\.')}/v(.+?)/Redline-\\1-universal\\.dmg"`,
);
const dlVer = /<span class="dl-ver">(.+?)<\/span>/;

if (!dmgHref.test(html)) {
  throw new Error('site/index.html has no download link to the dmg on the GitHub release');
}
if (!dlVer.test(html)) {
  throw new Error('site/index.html has no version next to the download button');
}

const versioned = html
  .replace(dmgHref, `href="${RELEASES}/v${pkg.version}/Redline-${pkg.version}-universal.dmg"`)
  .replace(dlVer, `<span class="dl-ver">${pkg.version}</span>`);

if (versioned !== html) {
  fs.writeFileSync(path.join(SITE, 'index.html'), versioned);
  console.log(`  site/index.html -> Redline ${pkg.version}`);
}

const bytes = fs
  .readdirSync(IMAGES)
  .reduce((n, f) => n + fs.statSync(path.join(IMAGES, f)).size, 0);

const count = fs.readdirSync(IMAGES).length;
console.log(`\n  site/images  ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);
