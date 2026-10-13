import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import { rootUrl } from '../src/hosts/node/root.js';
import { unbalanced } from './support.js';

const ci = fs.readFileSync(rootUrl('.github/workflows/ci.yml'), 'utf8');
const pagesCode = fs.readFileSync(rootUrl('.github/workflows/pages.yml'), 'utf8')
  .replace(/^\s*#.*$/gm, '');

// The landing page.
//
// site/ is hand-written HTML with no browser in this repository to open it in,
// so what can be asserted is what can be read: that it parses, that the things
// the script reaches for exist in the stylesheet, and that the picture it draws
// of the product is drawn in the product's own colours. The same reasoning as
// every other grep here -- a demo whose phases mean nothing in CSS is an
// animation that silently does nothing, and it would look exactly like the
// page working.
const siteHtml = fs.readFileSync(rootUrl('site/index.html'), 'utf8');
const siteCss = fs.readFileSync(rootUrl('site/landing.css'), 'utf8');
const ignore = fs.readFileSync(rootUrl('.gitignore'), 'utf8');

test('pages.yml builds in one job and deploys from another, token in one', async () => {
  const siteJs = fs.readFileSync(rootUrl('site/landing.ts'), 'utf8');

  // Comments go first: `unbalanced` does not know about them, and the page's own
  // prose mentions <html> while explaining why the theme script is where it is.
  const siteBody = siteHtml.replace(/<!--[\s\S]*?-->/g, '');
  const siteTag = unbalanced(siteBody);
  assert.strictEqual(siteTag, null, `the landing page is balanced: ${siteTag}`);

  let depth = 0;
  for (const ch of siteCss.replace(/\/\*[\s\S]*?\*\//g, '')) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  assert.strictEqual(depth, 0, 'the landing stylesheet closes every rule it opens');

  // The install command is one unbroken line (`white-space: pre`, so the
  // shown command is copy-pasteable verbatim) in a pill that goes full-width
  // on a narrow phone -- without `min-width: 0` a flex item's automatic
  // minimum is its content's own width, so the line would push the pill past
  // the edge of the screen instead of scrolling inside it.
  assert.match(
    siteCss,
    /\.copy code \{[^}]*min-width: 0[^}]*overflow-x: auto/,
    'the install command scrolls inside its pill on a narrow phone',
  );

  // The same rule the reader's own page lives by: anything that decides what the
  // first frame looks like is applied by an inline script in the head, not by the
  // module. Read the theme in landing.js instead and every open flashes white.
  const siteHead = siteHtml.slice(0, siteHtml.indexOf('</head>'));
  assert.match(siteHead, /redline:site-theme/, 'the theme is applied before first paint');
  assert.match(siteHead, /classList\.add\('js'\)/, 'and the scroll reveal is armed there too');
  // Which is what makes the page whole with the module blocked: the sections are
  // only hidden once something has said it can show them again.
  assert.match(siteCss, /\.js \.reveal \{/, 'so a reveal with no script is not an invisible page');

  // `marked` is the markup's own state -- the demo is written out finished, and
  // the other two phases are what take it away. That is why the page is correct
  // with no JavaScript at all, so the default being that one is load-bearing.
  assert.match(siteHtml, /data-phase="marked"/, 'the demo starts finished, not empty');
  for (const phase of ['clean', 'reload']) {
    assert.ok(siteJs.includes(`'${phase}'`), `the demo loop moves through ${phase}`);
    assert.ok(siteCss.includes(`[data-phase="${phase}"]`), `and the stylesheet draws ${phase}`);
  }
  // The removed block and the removed words are out of the flow while the
  // document is clean, so the marked state is the taller one and the hero would
  // change height on every lap without this.
  assert.match(siteJs, /offsetHeight/, 'the demo holds the height of its tallest phase');
  assert.match(siteCss, /\[data-measuring\]/, 'and re-measures with the transitions cut');

  // The demo is a picture of the product, so the three change colours are the
  // product's own rather than approximations of them. Light mode is the set both
  // files state literally, at the top, in a `:root` that comes first in each.
  const appCss = fs.readFileSync(rootUrl('public/styles.css'), 'utf8');
  const colourOf = (css, name) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6})`))[1];
  for (const name of ['add', 'del', 'mod']) {
    assert.strictEqual(
      colourOf(siteCss, name),
      colourOf(appCss, name),
      `the site's --${name} is the reader's --${name}`,
    );
  }

  // Below the hero the page shows no screenshots at all: each feature is played
  // out live, in markup the stylesheet animates. Same bargain as the demo, so the
  // same exposure -- a scene whose state nothing draws is a control that does
  // nothing, and from here that reads exactly like the page working.
  for (const attr of ['view', 'tone']) {
    assert.match(siteHtml, new RegExp(`id="sim-${attr}"`), `the page has the ${attr} scene`);
    assert.match(siteHtml, new RegExp(`data-${attr}="`), `in a state it names on the scene's root`);
    assert.match(siteCss, new RegExp(`\\[data-${attr}="`), `and the stylesheet draws that state`);
  }
  // Both of those are one driver: a pair of buttons, one attribute, and the
  // markup saying which attribute rather than the script knowing.
  assert.ok(siteJs.includes('.sim-view, .sim-tone'), 'one driver runs the two that are alike');
  assert.match(siteHtml, /data-set="view"/, 'because each control names what it sets');
  assert.match(siteCss, /\.seg button\.is-on/, 'and the pressed one of the pair is drawn pressed');

  // The tone scene keeps its own palette, and that is the one thing on this page
  // custom properties do not do by themselves: `body` resolves `var(--fg)` once,
  // and what everything under it inherits is the answer, not the question.
  // Redefining `--fg` on the scene turns the diagram, which asks for the property
  // by name, and leaves the heading and the filename -- which ask for nothing --
  // painted in the theme the scene exists to contradict. Dark on dark, with no
  // browser here to see it.
  const tone = siteCss.slice(siteCss.indexOf('.sim-tone {'));
  assert.match(
    tone.slice(0, tone.indexOf('}')),
    /color: var\(--fg\)/,
    'the tone scene states its text colour, so its palette reaches what inherits',
  );
  for (const t of ['light', 'dark']) {
    assert.match(
      siteCss,
      new RegExp(`\\.sim-tone\\[data-tone="${t}"\\] \\{[^}]*--fg:`),
      `and the ${t} tone gives that colour something to be`,
    );
  }

  // The two that are not alike. Both move `is-marked`, which is the inverse of
  // the demo's convention -- a scene starts clean and marks are turned on -- so
  // the class has to mean something in all three files or nothing happens twice.
  for (const id of ['sim-jump', 'sim-history']) {
    assert.match(siteHtml, new RegExp(`id="${id}"`), `the page has the ${id} scene`);
    assert.ok(siteJs.includes(`getElementById('${id}')`), `and a driver that finds it`);
  }
  assert.match(siteHtml, /class="chg[^"]*is-marked"/, 'a scene can start with a mark already on');
  assert.match(siteCss, /\.sim \.chg:not\(\.is-marked\)/, 'and without one is the clean paragraph');
  assert.match(siteJs, /'is-marked'/, 'which is what choosing a baseline turns on and off');
  for (const key of ['p', 'n', 'c']) {
    assert.match(siteHtml, new RegExp(`data-key="${key}"`),
      `jumping offers ${key}, as the app does`);
  }
  assert.match(siteJs, /translateY/, 'and moves the document under its window to get there');
  assert.match(siteCss, /\.sim \.chg\.is-at/, 'the change arrived at is the one tinted');
  assert.match(siteCss, /\.sim \.chg\.is-off/, 'and a checked-off one is drawn spent, not gone');
  assert.match(siteHtml, /data-counts="/, 'each baseline states the count it leaves on the bar');
  assert.match(siteJs, /data-left|\[data-c=/, 'and the bar is written from what is outstanding');

  // A scene that changes height moves the page under it, and both of these sit in
  // a `.split` that is `align-items: center`, so the copy beside them moves too --
  // twice a lap, unasked. So neither one may change state by taking anything out
  // of the flow. The panes share a grid cell, which makes the box the taller of
  // the two at every width with no number for anybody to maintain; the removed
  // paragraph keeps its space; and the block that comes and goes with the chosen
  // baseline carries no `w-del`, because one word leaving the flow can cost the
  // paragraph a line. Asserted here because the failure is a pulse, and a pulse is
  // exactly what cannot be seen from a repository with no browser in it.
  assert.match(siteCss, /\.sim-view \.sim-body \{\s*display: grid/, 'the two views share a cell');
  assert.match(
    siteCss,
    /\.sim-view\[data-view="raw"\] \.pane-rendered \{\s*visibility: hidden/,
    'so swapping them is a visibility change and not a reflow',
  );
  assert.match(
    siteCss,
    /\.sim \.chg-del:not\(\.is-marked\) \{\s*visibility: hidden/,
    'and a removed paragraph outside this baseline is hidden where it stands',
  );
  const history = siteHtml.slice(siteHtml.indexOf('id="sim-history"'));
  const picks = [...history.matchAll(/data-in="([^"]+)"([\s\S]*?)<\/div>/g)];
  assert.ok(picks.length >= 3, 'the history scene has blocks to pick between');
  for (const [, baselines, block] of picks) {
    // Three baselines means the block is in all of them and never toggles, so
    // what it does to the flow does not matter.
    if (baselines.split(' ').length === 3) continue;
    assert.ok(!block.includes('w-del'), `the ${baselines} block has no word that leaves the flow`);
  }

  // Nothing on the page draws a scene for someone who asked for stillness, and
  // nothing keeps playing under the hand that reached for it.
  assert.match(siteJs, /reduced\.matches/, 'a scene that plays itself respects reduced motion');
  assert.match(siteJs, /pointerdown/, 'and stops for good the first time it is touched');

  // And it has to be openable from here, which `file://` does not do: a module
  // script from that origin is refused by every browser, so the page renders
  // while every one of the things asserted above is silently dead. `npm run site`
  // is the answer to that, and `presite` is why it is one command -- an unstaged
  // site/ served from here is the page with no icon, which is the same trap one
  // step earlier.
  const serveSite = fs.readFileSync(rootUrl('scripts/serve-site.mts'), 'utf8');
  const scripts = JSON.parse(
    fs.readFileSync(rootUrl('package.json'), 'utf8'),
  ).scripts;
  assert.strictEqual(
    scripts.site,
    'node out/scripts/serve-site.mjs',
    'the page can be served from here',
  );
  assert.strictEqual(scripts.presite, 'npm run build:site', 'and is staged before it is');
  assert.match(serveSite, /'127\.0\.0\.1'/, 'on the loopback and nowhere else');
  assert.match(serveSite, /'cache-control': 'no-store'/, 'holding nothing between edits');
  // A static server over a directory in a repository full of things that are not
  // the landing page. `..` has to stop at site/, however it was spelt.
  assert.match(serveSite, /relative\(root, file\)\.startsWith\('\.\.'\)/, 'and serving only site/');
  assert.match(serveSite, /createSiteServer\(\);[\s\S]*server\.listen/,
    'npm run site is the server this tests, not another one beside it');

  // The icon is copied in rather than committed, so the deploy has to run the
  // script that copies it -- an unbuilt site/ is a page with no icon and no link
  // preview, and it would deploy perfectly happily.
  const pages = fs.readFileSync(rootUrl('.github/workflows/pages.yml'), 'utf8');
  const wrangler = fs.readFileSync(rootUrl('wrangler.toml'), 'utf8');
  assert.match(pages, /npm run build:site/, 'the deploy stages the icon and the og:image');
  assert.match(pages, /command: pages deploy/, 'before uploading anything');
  assert.match(wrangler, /pages_build_output_dir = "site"/,
    'from the directory wrangler.toml names');
  assert.match(wrangler, /^name = "redline"$/m, 'into the project it names');
  // Two jobs, for the reason the web app's deploy is two: building the page compiles a script, so
  // it needs `npm ci`, which runs every dependency's install scripts, and the job that has done
  // that must not hold the Cloudflare token.
  {
    assert.deepStrictEqual(
      pagesCode.slice(pagesCode.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
      ['  build:', '  deploy:'],
      'a job that builds the page, and a job that deploys what it built',
    );
    const buildJob = pagesCode.slice(
      pagesCode.indexOf('\n  build:'),
      pagesCode.indexOf('\n  deploy:'),
    );
    const deployJob = pagesCode.slice(pagesCode.indexOf('\n  deploy:'));
    assert.match(deployJob, /needs: build/, 'the deploy waits for the build');
    assert.match(
      buildJob,
      /run: npm ci\b[\s\S]*run: npm run build:site\b/,
      'built from a clean install',
    );
    assert.doesNotMatch(buildJob, /secrets\./, 'the job that runs npm ci holds no secret');
    assert.match(deployJob, /apiToken: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'the token');
    assert.match(deployJob, /accountId: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'the account');
    assert.doesNotMatch(deployJob, /actions\/checkout/, 'with no checkout, so no wrangler.toml');
    assert.doesNotMatch(deployJob, /\bnpm\b|\bnpx\b/, 'and no npm to run a dependency with');
    assert.strictEqual(deployJob.match(/^ {6}- /gm).length, 3, 'a node, the artifact, the deploy');
    // wrangler.toml is not there to be read, so the project and the directory are named here, and
    // they are the ones wrangler.toml names.
    assert.strictEqual(
      deployJob.match(/--project-name=(\S+)/)?.[1],
      wrangler.match(/^name = "(.+)"$/m)[1],
      "into the landing page's project",
    );
    assert.strictEqual(
      deployJob.match(/pages deploy (\S+) /)?.[1],
      wrangler.match(/^pages_build_output_dir = "(.+)"$/m)[1],
      'and the directory wrangler.toml names',
    );
    assert.match(deployJob, /command: pages deploy site --project-name=redline --branch=main/);
    // What is uploaded is what was built: the one directory, by the one name, and an empty one is
    // an error.
    assert.match(
      buildJob,
      /name: redline-site\n\s+path: \|\n\s+site\n\s+!site\/\*\.ts\n\s+if-no-files-found: error/,
      'site/ without the TypeScript beside its compiled script, or nothing',
    );
    assert.match(
      deployJob,
      /name: redline-site\n\s+path: site/,
      'which the deploy downloads to site/',
    );
  }
});

test('the landing page parses, is wired up, and deploys what it builds', async () => {
  assert.match(ignore, /^site\/icon\.svg$/m, 'the copied icon is build output, not source');
  assert.match(ignore, /^site\/icon\.png$/m, 'and so is the png of it');
  // Absolute, because a link preview does not resolve a relative og:image against
  // the page -- Slack drew an empty card for `images/hero.png` -- but still on
  // this site's own origin, so it is the file build:site copies in. The icon and
  // not a screenshot, which went stale with every change to the reader; a png,
  // because no unfurler draws an svg.
  assert.match(
    siteHtml,
    /property="og:image" content="https:\/\/redline\.iamtuna\.org\/icon\.png"/,
    'the card image is the app icon, as an absolute URL to a local file',
  );
  // The size a preview lays the card out at before it has the image, so it has to
  // be the png's own -- read out of its IHDR rather than written down twice.
  const iconPng = fs.readFileSync(rootUrl('assets/icon.png'));
  const ogSize = (k) => Number(siteHtml.match(new RegExp(`og:image:${k}" content="(\\d+)"`))?.[1]);
  assert.strictEqual(ogSize('width'), iconPng.readUInt32BE(16), 'at the width of the icon');
  assert.strictEqual(ogSize('height'), iconPng.readUInt32BE(20), 'and its height');
  assert.match(siteHtml, /name="twitter:card" content="summary"/,
    'on a square card, not a wide one');

  // Nothing the page loads carries a content hash, and the HTML sends no
  // Cache-Control at all -- so it revalidates while anything held by max-age
  // does not, and a returning reader gets this deploy's markup against the last
  // one's stylesheet. For an image that is a stale picture; for these two it is
  // the page with its styling and its scenes missing, which is what it looked
  // like. Either the filenames start carrying a version or these stay no-cache
  // (still cached, just revalidated -- the usual answer is a 304), and asserting
  // the pair means the day somebody adds the version, this line says so.
  const headers = fs.readFileSync(rootUrl('site/_headers'), 'utf8');
  for (const ext of ['css', 'js']) {
    const block = headers.match(new RegExp(`^/\\*\\.${ext}\\n((?:  .+\\n)+)`, 'm'));
    assert.ok(block, `_headers has a rule for ${ext}`);
    assert.match(block[1], /Cache-Control: no-cache/, `and revalidates the ${ext}`);
    assert.match(
      siteHtml,
      new RegExp(`(?:href|src)="landing\\.${ext}"`),
      `which is what lets landing.${ext} be named without a version`,
    );
  }

  // The page sells a download, and the project is open source, so GitHub is
  // linked twice over: the dmg on a release, and the repository itself -- from the
  // nav and from the footer, which is where the license is named. Nothing deeper:
  // a link into a file or a branch is one a rename or a force-push breaks quietly.
  const REPO = 'github.com/tuanchauict/redlineapp';
  const githubLinks = siteHtml.match(/github\.com[^"\s<]*/g) ?? [];
  assert.ok(
    githubLinks.every((u) => u === REPO || u.startsWith(`${REPO}/releases/download/v`)),
    'the page links nowhere on GitHub but the repository and the release dmg',
  );
  assert.ok(
    githubLinks.filter((u) => u === REPO).length >= 2,
    'and the repository from the nav and from the footer',
  );
  assert.match(siteHtml, /<p class="eyebrow">.*open-source/, 'the hero says it is open source');
  assert.match(siteHtml, /Open source, Apache 2\.0/, 'and the footer which license');
  assert.match(siteCss, /\.icon-btn \.i-gh \{\s*fill: currentColor/, 'the GitHub mark is filled');
  assert.ok(!/npm (install|start|run)/.test(siteHtml), 'and offers no install from a checkout');

  // The web app is the way in with nothing to install, so it is offered where the
  // download is -- the nav, the hero and the get section -- and at its own origin,
  // the one webapp.yml deploys to, not a path of this page's.
  assert.ok(
    (siteHtml.match(/href="https:\/\/app\.redline\.iamtuna\.org\/"/g) ?? []).length >= 3,
    'the web app is linked from the nav, the hero and the get section',
  );
  // A box under the get cards said the snapshots live under ~/.redline, which
  // stopped being true of every way in once the web app kept its history in the
  // browser. Where the store is belongs to docs/history.md and docs/web-app.md.
  assert.ok(!siteHtml.includes('~/.redline'), 'the page names no one place the history lives');
  assert.ok(!/get-foot/.test(siteHtml + siteCss), 'and the box that did is gone');

  // The hero's link is a ghost .btn, whose own height is the nav's 34px; beside
  // the 44px copy pill and Get it it sat visibly short.
  assert.match(siteCss, /\.cta \.btn \{[^}]*height: 44px/, 'the hero row is one height');
  // The get section's cards line their controls up through a subgrid of four
  // tracks, so each card has to be exactly the four children those tracks name;
  // a fifth would push its control into the subtitle's track.
  assert.match(siteCss, /\.install \{[^}]*grid-template-rows: subgrid[^}]*grid-row: span 4/,
    'the get cards share their rows, so their buttons start on one line');
  // And a column that can be narrower than the brew command, or the command's
  // min-content is the card's and the pill runs out past the card's edge.
  assert.match(siteCss, /\.install \{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    'a get card is as wide as its column, not as its longest line');
  const cards = siteHtml.match(/<article class="install reveal">[\s\S]*?<\/article>/g) ?? [];
  assert.strictEqual(cards.length, 3, 'there are three ways to get it');
  for (const card of cards) {
    const body = card
      .replace(/^<article[^>]*>|<\/article>$/g, '')
      .replace(/<svg[\s\S]*?<\/svg>/g, '');
    const kids = body.match(/^\s{12}<(?!\/)[a-z0-9]+/gm) ?? [];
    assert.strictEqual(kids.length, 4, `a get card is title, subtitle, control, note: ${kids}`);
  }

  // And it quotes no count of its own parts. A strip of big numbers stood under
  // the hero saying 0 files written, 0 requests, 50 commits read in, 6 vendored
  // dependencies; the two zeros are the promise this product makes and already
  // have a sentence at the foot of Get it, and the other two are the repository
  // talking about itself on a page that sells the app. Counted as a figure a
  // `0` invites the reader to work out what large would have meant. The numbers
  // that remain are all the product's own -- a version, a p99, a keystroke -- so
  // what this looks for is the shape the strip had: a standalone figure as the
  // whole of its element.
  const figures = [...siteHtml.matchAll(/<(b|strong)>\s*(\d[\d,.]*)\s*<\/\1>/g)];
  assert.deepStrictEqual(
    figures.map((m) => m[2]),
    [],
    'the page quotes no count of its own parts',
  );

  // The full-bleed band keeps its content in the page's column with padding, not
  // with `margin-inline: auto` on each child. The margin form is one `margin`
  // shorthand away from collapsing: a child that sets its own top gap that way --
  // `.sim-wrap` does -- resets the inline margins to 0 without mentioning them,
  // and lands against the left edge of the window while its siblings stay centred.
  // Nothing here can see that, and on a window the width of the one it was found
  // on the two were 400px apart.
  const alt = siteCss.slice(siteCss.indexOf('.band-alt {'));
  assert.match(
    alt.slice(0, alt.indexOf('}')),
    /padding-inline: calc\(.*max\(0px,/s,
    'the full-bleed band centres its column with padding',
  );
  assert.ok(
    !/\.band-alt > \*/.test(siteCss),
    'and not with a margin on each child, which a child can overwrite',
  );

  // The card's prose rules are the card's own. As a descendant selector they also
  // reached into the illustration, overriding the size it asks for and adding a
  // top margin inside a box that is padded evenly.
  assert.match(siteCss, /\n\.card > p \{/, "the card's prose rules stop at its own children");
  assert.ok(!/\n\.card p \{/.test(siteCss), 'and do not reach the illustration under it');

  // A group of four cards in a grid that fits three is three and an orphan, which
  // reads as a card that did not fit. The count has to be stated, because it is
  // derived from a width that is a clamp -- and a stated count cannot notice it
  // has run out of room, so the narrow case has to be taken back by hand.
  const wide = siteHtml.match(/class="cards[^"]*cards-wide[^"]*"([\s\S]*?)\n {8}<\/div>/);
  assert.ok(wide, 'the four-card group states its column count');
  assert.strictEqual(
    (wide[1].match(/<article class="card/g) || []).length,
    4,
    'and is still the group with four in it',
  );
  assert.match(siteCss, /\.cards-wide \{\s*grid-template-columns: repeat\(2, 1fr\)/, 'two across');
  const narrow = siteCss.slice(siteCss.indexOf('@media (max-width: 560px)'));
  assert.match(
    narrow,
    /\.cards-wide \{\s*grid-template-columns: minmax\(0, 1fr\)/,
    'and one across where two no longer fit',
  );

  // Cards in a row are stretched to the tallest, and where the slack lands is the
  // difference between three illustrations on one floor and three at three
  // heights over one line of prose. It goes above the illustration, not below it.
  assert.match(
    siteCss,
    /\.card > p:last-of-type \{\s*margin-bottom: auto/,
    'the slack in a stretched card opens above the illustration',
  );

  // A kbd is an inline-block, so a line may break in front of one and leave the
  // `(` of `(⌘B)` at the end of the line above its cap. That reads as a typo.
  assert.match(siteCss, /\.nb \{\s*white-space: nowrap/, 'a bracketed key cap is one word');
  for (const key of ['⌘B', '⌥⌘B']) {
    assert.ok(
      siteHtml.includes(`<span class="nb">(<kbd>${key}</kbd>)</span>`),
      `and ${key} is written as one`,
    );
  }

  // The dmg is published under a versioned filename, built from the tag -- so the
  // one thing on this page that goes stale on its own is the version it offers.
  // build:site is what refuses to stage a page naming a dmg that was never built;
  // this is the check that it still does.
  //
  // Not that the page as committed names package.json's version: build:site
  // overwrites it on every deploy, so holding the source to it would only make
  // every bump touch site/ for nothing. What the source must have is a link
  // build:site can find.
  const buildSite = fs.readFileSync(rootUrl('scripts/build-site.mts'), 'utf8');
  const RELEASE_DOWNLOADS = 'https://github.com/tuanchauict/redlineapp/releases/download';
  const dmgHref = siteHtml.match(/href="(https:\/\/[^"]+\/v(.+?)\/Redline-(.+?)-universal\.dmg)"/);
  assert.ok(dmgHref, 'the page offers the dmg over plain https');
  assert.strictEqual(dmgHref[2], dmgHref[3], 'from the release for the version it names');
  assert.ok(
    ci.includes(`Redline-\${VERSION}-universal.dmg`),
    'under the name the release step uploads',
  );
  assert.ok(dmgHref[1].startsWith(`${RELEASE_DOWNLOADS}/v`), 'on a GitHub release of this repo');
  assert.match(buildSite, new RegExp(RELEASE_DOWNLOADS.replaceAll('.', '\\.')),
    'the one build:site rewrites');
  assert.match(siteHtml, /<span class="dl-ver">[^<]+<\/span>/, 'with the version on the button');
  assert.ok(ci.includes(new URL(dmgHref[1]).host), 'from the host the release step prints');
  assert.match(buildSite, /pkg\.version/, 'and build:site writes the current one in rather than');
  assert.match(buildSite, /TAP\/redline/,
    'trusting it, though it still refuses the tap placeholder');
  // The og:image is a reference no browser would ever report broken, so build:site
  // checking content= is the only thing that would notice the card image being
  // renamed in assets/ -- and copying the png is what puts it there to find.
  assert.match(buildSite, /src\|href\|content/, 'and checks content= alongside src= and href=');
  assert.match(buildSite, /\['icon\.svg', 'icon\.png'\]/, 'after copying in both icons');
});
