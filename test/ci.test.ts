import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import { rootUrl } from '../src/hosts/node/root.js';

// CI runs the suite on every change, and builds the dmg.
//
// The same reason everything above greps `public/` for its wiring: a check that
// exists and is never reached is worse than no check, because it reads as
// coverage. A workflow is exactly that shape. So this file asserts what runs,
// on what, and where it leaves the thing you would hand somebody.
const ci = fs.readFileSync(rootUrl('.github/workflows/ci.yml'), 'utf8');
const triggers = (yml) => yml.match(/^on:\n([\s\S]*?)\n(?=\S)/m)?.[1] ?? '';
const onEvents = (yml) => triggers(yml).match(/^ {2}[a-z_]+:/gm);
const ciCode = ci.replace(/^\s*#.*$/gm, '');
const webappYml = fs.readFileSync(
  rootUrl('.github/workflows/webapp.yml'),
  'utf8',
);
const webappCode = webappYml.replace(/^\s*#.*$/gm, '');
const bundleJob = ciCode.slice(ciCode.indexOf('\n  bundle:'), ciCode.indexOf('\n  release:'));
const releaseJob = ciCode.slice(ciCode.indexOf('\n  release:'));

test('CI tests every change on two OSes, and signs only what a fork cannot reach', async () => {
  const pagesYml = fs.readFileSync(
    rootUrl('.github/workflows/pages.yml'),
    'utf8',
  );
  assert.match(ci, /path: dist\/\*\.dmg/, 'the dmg is kept where bundle.mts leaves it');
  assert.match(ci, /if-no-files-found: error/, 'loudly, rather than uploading nothing');

  const workflows = fs.readdirSync(rootUrl('.github/workflows/'));
  assert.deepStrictEqual(
    workflows.sort(),
    ['ci.yml', 'pages.yml', 'webapp.yml'],
    'three workflows, no more',
  );
  // Every change is tested, because a check that runs only when somebody thinks
  // to start it is the check that did not run on the change that broke things.
  assert.deepStrictEqual(
    onEvents(ci),
    ['  push:', '  pull_request:', '  workflow_dispatch:'],
    'ci.yml runs on a push, a pull request, and by hand',
  );
  assert.match(triggers(ci), /branches: \[main\]/, 'a push to main');
  assert.match(triggers(ci), /tags: \['v\*'\]/, 'or of a version tag');
  const pagesCode = pagesYml.replace(/^\s*#.*$/gm, '');
  // The one trigger that must never appear: `pull_request_target` runs a fork's
  // code with the repository's secrets and a write token. Comments may name it.
  for (const [name, code] of [
    ['ci.yml', ciCode],
    ['pages.yml', pagesCode],
    ['webapp.yml', webappCode],
  ]) {
    assert.doesNotMatch(code, /pull_request_target/, `${name} never hands a fork the secrets`);
  }

  assert.deepStrictEqual(
    ci.slice(ci.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
    ['  lint:', '  test:', '  bundle:', '  release:'],
    'the lint, the suite, the dmg, and the release',
  );
  const lintJob = ciCode.slice(ciCode.indexOf('\n  lint:'), ciCode.indexOf('\n  test:'));
  assert.match(lintJob, /run: npm run lint/, 'the lint is the npm script, as it is run by hand');
  assert.match(lintJob, /runs-on: ubuntu-latest/, 'on Linux, the text being the same on either');
  assert.doesNotMatch(lintJob, /secrets\./, 'with no secret in reach of it');
  assert.doesNotMatch(lintJob, /needs:/, 'and beside the suite, not in front of it');
  const testJob = ciCode.slice(ciCode.indexOf('\n  test:'), ciCode.indexOf('\n  bundle:'));
  // Both platforms: the font checks only really run on the Mac, and the Linux leg
  // is what notices a macOS assumption in code meant to be portable.
  assert.match(testJob, /os: \[ubuntu-latest, macos-latest\]/, 'the suite runs on Linux and macOS');
  assert.match(testJob, /fail-fast: false/, 'and one leg failing does not hide the other');
  assert.match(testJob, /run: npm test/, 'it is the suite');
  assert.match(testJob, /run: cargo test --locked/, "and the shell's own tests");
  // generate_context! will not compile without shell/dist, and a runner starts
  // with none, so the page is staged before the shell's tests are built.
  const stageDist = testJob.indexOf('run: npm run build:dist');
  assert.ok(
    stageDist > testJob.indexOf('run: npm test') && stageDist < testJob.indexOf('run: cargo test'),
    'shell/dist is built after the suite (which builds vendor/) and before cargo test',
  );
  assert.match(testJob, /working-directory: shell/, 'run where the shell is');
  assert.doesNotMatch(testJob, /secrets\./, 'with no secret in reach of the code under test');
  assert.deepStrictEqual(
    ciCode.match(/needs: .*/g),
    ['needs: [lint, test]', 'needs: bundle'],
    'a dmg only from a reader that lints and passes, a release only from that dmg',
  );

  // A pull request from a fork runs a stranger's code. GitHub withholds secrets
  // from it anyway, but the workflow should not be relying on that: no step a
  // pull request can reach is handed the Apple credentials.
  const steps = (job) => job.split(/\n {6}- /).slice(1);
  const bundleSteps = steps(bundleJob);
  assert.doesNotMatch(
    bundleJob.slice(0, bundleJob.indexOf('\n    steps:')),
    /secrets\./,
    'the bundle job puts no secret in its own env, where every step would see it',
  );
  const signed = bundleSteps.filter((step) => /secrets\.APPLE_/.test(step));
  assert.ok(signed.length, 'some step signs');
  for (const step of signed) {
    assert.match(
      step,
      /if: github\.event_name != 'pull_request'/,
      'and only off a pull request',
    );
  }
  const adhoc = bundleSteps.filter((step) => /if: github\.event_name == 'pull_request'/.test(step));
  assert.strictEqual(adhoc.length, 1, 'a pull request gets a dmg of its own');
  assert.doesNotMatch(adhoc[0], /secrets\./, 'signed ad hoc, with nothing to sign with');
  assert.strictEqual(
    ci.match(/^\s+run: npm run bundle \$\{\{ env\.BUNDLE_ARGS \}\}$/gm).length,
    2,
    'the two are one command, and the arch is a variable both read',
  );
  // Universal for anything that is not a hand-started run: the artifact has to
  // run on whichever Mac it lands on, and a release's filename says universal.
  // By hand it is off unless ticked -- one arch is half the compile and proves
  // the same two things, the release profile builds and the bundle assembles.
  const universal = ci.match(/BUNDLE_ARGS: >-\n([\s\S]*?)\n {4}steps:/);
  assert.ok(universal, 'set once at the job level, where the condition can be read');
  assert.match(universal[1], /github\.event_name != 'workflow_dispatch'/,
    'universal unless by hand');
  assert.match(universal[1], /inputs\.deploy/, 'or for a release by hand');
  assert.match(universal[1], /inputs\.universal/, 'or when the run asked for it');
  assert.match(universal[1], /'-- --universal' \|\| ''/, 'and one architecture otherwise');
  assert.match(ci, /universal:\n(\s+[^\n]*\n)*?\s+type: boolean\n\s+default: false/, 'unticked');
  assert.match(ci, /key: cargo-release-/, 'the release build is cached');
  assert.match(ci, /key: cargo-test-/, 'and the test build, apart from it');

  // The landing page never deploys on a push. Its download button names
  // package.json's version, which is ahead of every release from the moment a
  // bump merges, so a push to site/ in that window -- or one alongside the tag --
  // would publish a link to a dmg that is not up yet. A release deploys it as its
  // last step; anything else is somebody choosing Run workflow.
  assert.deepStrictEqual(
    onEvents(pagesYml),
    ['  workflow_dispatch:'],
    'pages.yml runs by hand, and on nothing else',
  );
  const releaseSteps = steps(releaseJob);
  assert.match(
    releaseSteps[releaseSteps.length - 1],
    /run: gh workflow run pages\.yml --ref main/,
    'or as the last step of a release, after the dmg, the cask and Latest',
  );
  assert.strictEqual(
    ciCode.match(/gh workflow run pages\.yml/g).length,
    1,
    'and from nowhere else in ci.yml',
  );

  // Signing, which is a thing that fails quietly in the direction of looking
  // fine: an app signed and not notarized is refused by Gatekeeper exactly like
  // an unsigned one, and the only place the difference shows is a dialog on
  // somebody else's Mac. So the identity has to reach the build, and it has to
  // reach it as a `--config` patch -- tauri.conf.json has the ad hoc `-` in it,
  // and a patch is the one route whose precedence is documented rather than
  // guessed at.
  const bundleJs = fs.readFileSync(rootUrl('scripts/bundle.mts'), 'utf8');
  assert.match(bundleJs, /APPLE_SIGNING_IDENTITY/, 'the bundle takes an identity from the env');
  assert.match(bundleJs, /signingIdentity: identity/, 'and patches it over the ad hoc one');
  assert.match(bundleJs, /'--config'/, 'through the flag that merges last over first');
  // Signed and notarized are told apart off a *whole* set of credentials. Half a
  // set notarizes nothing, and `APPLE_ID` on its own is a variable people have
  // exported for other reasons -- on this machine, as it happens, which is how
  // the loose version of this check was caught saying "notarized" over a build
  // that was not. That is the one error here only discovered on another Mac.
  assert.ok(
    bundleJs.includes("env('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID')"),
    'notarized means the whole Apple ID set was there',
  );
  assert.ok(
    bundleJs.includes("env('APPLE_API_KEY', 'APPLE_API_ISSUER')"),
    'or the whole App Store Connect one',
  );
  for (const secret of ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD', 'APPLE_TEAM_ID']) {
    assert.ok(ci.includes(`secrets.${secret}`), `CI hands the build ${secret}`);
  }
});

// The web app is published by a workflow of its own, and the things that go wrong with it go
// wrong quietly: a deploy to the landing page's project replaces the landing page with the app and
// reports success, a token in a job that has run `npm ci` is in reach of every dependency's
// install script, and a trigger on a push puts out every merge. None of it fails a build, so each
// is a line here. That the workflow runs at all, and that Pages takes what it sends, is for the
// first deploy to say (docs/building.md, Publishing the web app).
test('webapp.yml deploys dist/web on a tag, to its own project, token in one job', async () => {
  assert.deepStrictEqual(
    onEvents(webappYml),
    ['  push:', '  workflow_dispatch:'],
    'webapp.yml runs on a push and by hand, and on no pull request',
  );
  assert.match(triggers(webappYml), /tags: \['v\*'\]/, 'the push is of a version tag');
  assert.doesNotMatch(triggers(webappYml), /branches:/, 'and never of a branch, main included');
  assert.doesNotMatch(webappCode, /\bwrite\b/, 'it can write nothing to the repository');
  assert.match(webappCode, /^permissions:\n {2}contents: read$/m, 'only read it');
  assert.match(webappCode, /cancel-in-progress: false/, 'and a deploy is never cut off halfway');

  assert.deepStrictEqual(
    webappCode.slice(webappCode.indexOf('\njobs:')).match(/^ {2}[a-z]+:$/gm),
    ['  build:', '  deploy:'],
    'a job that builds, and a job that deploys what it built',
  );
  const buildJob = webappCode.slice(
    webappCode.indexOf('\n  build:'),
    webappCode.indexOf('\n  deploy:'),
  );
  const deployJob = webappCode.slice(webappCode.indexOf('\n  deploy:'));
  assert.match(deployJob, /needs: build/, 'the deploy waits for the build');

  // The token is in one job, and it is the one that runs nothing of the repository's.
  assert.doesNotMatch(buildJob, /secrets\./, 'the job that runs npm ci holds no secret');
  assert.match(deployJob, /apiToken: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/, 'the token');
  assert.match(deployJob, /accountId: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/, 'the account');
  assert.doesNotMatch(deployJob, /actions\/checkout/, 'with no checkout, so no wrangler.toml');
  assert.doesNotMatch(deployJob, /\bnpm\b|\bnpx\b/, 'and no npm to run a dependency with');
  assert.strictEqual(deployJob.match(/^ {6}- /gm).length, 3, 'a node, the artifact, the deploy');

  // The project is named on the command line, and is not the landing page's.
  const project = deployJob.match(/--project-name=(\S+)/)?.[1];
  const landingPage = fs.readFileSync(rootUrl('wrangler.toml'), 'utf8');
  assert.strictEqual(project, 'redline-app', 'into the web app\'s project');
  assert.notStrictEqual(
    project,
    landingPage.match(/^name = "(.+)"$/m)[1],
    'which is not the one wrangler.toml names, whose page it would replace',
  );
  assert.match(deployJob, /command: pages deploy web --project-name=redline-app --branch=main/);

  // What is built is what is uploaded: the one directory, by the one name, and an empty one is
  // an error.
  assert.match(buildJob, /run: npm run build:web\b[\s\S]*run: npm run build:webapp\b/,
    'the bundles, then the page staged around them');
  assert.match(buildJob, /path: dist\/web\n\s+if-no-files-found: error/, 'dist/web, or nothing');
  assert.match(buildJob, /name: redline-app/, 'under a name');
  assert.match(deployJob, /name: redline-app\n\s+path: web/, 'which the deploy downloads to web/');
  assert.match(
    buildJob,
    /if: github\.ref_type == 'tag'[\s\S]*?GITHUB_REF_NAME#v[\s\S]*?package\.json/,
    'and a tag that disagrees with package.json is refused, as ci.yml refuses it',
  );

  // Independent of the release, so that neither can hold the other up.
  assert.doesNotMatch(ciCode, /webapp\.yml/, 'ci.yml does not start it');
  assert.doesNotMatch(webappCode, /workflow_run|needs: .*(test|bundle|release)/, 'or waits on it');
});

// The dev loop, which is the one piece of tooling here whose failure mode is
// that it quietly stops saving you anything. `npm run dev` is worth having only
// because the page comes out of the binary: `tauri dev` serves shell/dist over
// a static server of its own, so a page edit is a restage and a ⌘R instead of a
// relink. Four things hold that up, and three of them break silently.
test('the dev loop serves the page instead of embedding it, and shuts down', async () => {
  const devJs = fs.readFileSync(rootUrl('scripts/dev.mts'), 'utf8');
  const devScripts = JSON.parse(
    fs.readFileSync(rootUrl('package.json'), 'utf8'),
  ).scripts;
  assert.strictEqual(
    devScripts.dev,
    'npm run build:ts && node out/scripts/dev.mjs',
    'the dev loop is one command',
  );
  assert.match(devJs, /'tauri', 'dev'/, 'and it is `tauri dev`, not a cargo run');
  // Staged from in here rather than from a `predev` hook, the same way the bundle
  // does its own: there is to be no way to ask for this and get a stale page.
  assert.match(devJs, /build-web\.mjs/, 'the page is bundled before the window opens');
  assert.match(devJs, /build-dist\.mjs/, 'and staged, or the window shows the last run');
  // `tauri dev -- [runnerArgs] -- [appArgs]`: one `--` short and `sample.md` is
  // handed to cargo, which fails in a way that looks nothing like the cause.
  assert.match(devJs, /'--', '--', \.\.\.appArgs/, 'a file to open reaches the app, not cargo');
  // tsc emits nothing for public/app/, so skipping a `.ts` there would be waiting forever.
  assert.match(devJs, /const page = !src && file\?\.startsWith\(`app\$\{path\.sep\}`\);/,
    'an edit to the page\'s source is noticed');
  assert.match(devJs, /touchedSrc \|\|= src \|\| page;/, 'and rebundles it, as a src/ edit does');

  // The load-bearing one. Tauri's dev watcher honours .gitignore, and shell/dist
  // being ignored is the only reason restaging the page does not trip the Rust
  // rebuild the whole exercise exists to avoid. Un-ignore it and `npm run dev`
  // still works -- it just silently costs what `npm run app` costs.
  const devIgnore = fs.readFileSync(rootUrl('.gitignore'), 'utf8');
  assert.match(
    devIgnore,
    /^(shell\/)?dist\/$/m,
    'shell/dist is ignored, so a restage is not a rebuild',
  );

  // public/vendor/ is build:web's output, not source. Without the filter a src/
  // edit restages twice: once for the module, once for the bundle it produced.
  assert.match(devJs, /vendor\$\{path\.sep\}/, 'the watcher ignores what build:web just wrote');

  // The page is TypeScript, and the window loads what tsc emits beside it: an edit to a `.ts` is
  // worth a restage only once the compile has landed. Restaging on the edit stages the previous
  // compile and then again on the emit, which is the quiet kind of wrong -- the window is one
  // save behind and nothing says so.
  assert.ok(
    /spawn\('npx', \['tsc', '-b', '--watch'/.test(devJs),
    'npm run dev compiles the page as you edit it',
  );
  assert.ok(
    /file\.endsWith\('\.ts'\)/.test(devJs),
    'and restages on what tsc emitted, not on the edit that caused it',
  );

  // And it has to die when told. A watcher left behind has no window and is not
  // idle: two of them restaging one shell/dist race, because build:dist empties
  // the directory before it refills it, and the loser fails inside the mermaid
  // tree. Found by leaving one.
  assert.match(devJs, /tauri\.kill\(sig\)/, 'ctrl-c reaches the window');
  assert.match(devJs, /tauri\.kill\('SIGKILL'\)/,
    'and a child that ignores it gets no third chance');
  assert.ok(/tsc\?\.kill\(sig\)/.test(devJs), 'and takes the compiler down with the window');
  assert.match(devJs, /tsc\?\.kill\(\)/, 'and when the window is closed instead of interrupted');
});

// A run started on a `vN.N.N` tag, or with Deploy ticked, is a release: the
// upload-artifact above needs a GitHub login to fetch, which a Homebrew cask
// can't do. So the dmg goes onto a GitHub release, which `curl` can reach
// without credentials -- and only then, never from a branch somebody wanted a
// dmg of.
test('a run on a version tag publishes the dmg where a cask formula can reach it', async () => {
  assert.match(
    releaseJob,
    /if: startsWith\(github\.ref, 'refs\/tags\/v'\) \|\| inputs\.deploy/,
    'the release job only runs for a tag or a ticked Deploy',
  );
  assert.match(releaseJob, /gh release create "v\$\{VERSION\}"/,
    'and attaches the dmg to a release');
  assert.match(releaseJob, /--clobber/, 'or replaces it on one that is already there');
  assert.match(releaseJob, /sha256sum/,
    'and the hash a cask formula needs is computed in the open');
  assert.match(releaseJob, /GITHUB_REPOSITORY" != tuanchauict\/redlineapp/, 'from redlineapp only');
  // It is the one job that writes, so it is the one that may: the bundle job runs
  // `npm ci` beside the Apple credentials, and a write token there would be in
  // reach of every install script in the tree.
  assert.match(releaseJob, /permissions:\n\s+contents: write/, 'the release job may write');
  assert.strictEqual(ciCode.match(/contents: write/g).length, 1, 'and no other job may');
  assert.match(releaseJob, /runs-on: ubuntu-latest/, 'and needs no Mac to');
  assert.doesNotMatch(bundleJob, /contents: write|TAP_REPO_TOKEN/, 'the bundle job holds neither');
  assert.doesNotMatch(ci, /R2_|r2\.cloudflarestorage|dl\.iamtuna\.org/, 'and nothing goes to R2');
});

// The cask itself lives outside this repository, so the only way this build
// can update what `brew install` reads is a cross-repo push -- which only a
// tagged release should ever make.
test('and also updates the Homebrew cask with the new version and hash', async () => {
  assert.match(ci, /github\.com\/tuanchauict\/homebrew-tap\.git/, 'the tap repo is cloned by URL');
  assert.match(ci, /tap\/Casks\/redline\.rb/, 'and the cask file in it is edited in place');
  assert.match(ci, /secrets\.TAP_REPO_TOKEN/, 'authenticated with a token scoped to that repo');
  assert.match(ci, /dmg_sha256/, 'reusing the hash the staging step computed, not recomputing it');
  assert.ok(
    ci.includes('/v#{version}/Redline-#{version}-universal.dmg'),
    'and the url line pointed at the release, so the cask cannot go on naming R2',
  );
});

// And, last, says so to the copies already out there. Order is the point: the
// app reads the manifest on whichever release is marked Latest, so marking it is
// the claim that a release exists, and it happens only once the dmg it names
// and the cask a Homebrew copy will be told to upgrade from are both in place.
// Marked first, a copy could be sent after a version nobody has yet.
test('a release announces itself in a manifest the app can read', async () => {
  const cmdsRs = fs.readFileSync(rootUrl('shell/src/cmds.rs'), 'utf8');
  assert.match(ci, /--latest=false/, 'the release is published without being marked Latest');
  assert.ok(
    ci.indexOf('gh release edit "v${VERSION}" --latest') > ci.indexOf('git -C tap push'),
    'and is marked only after the cask is pushed',
  );
  // The landing page links this version's dmg, so it is redeployed from here,
  // once the dmg is up and Latest -- not on the version bump, which comes first.
  assert.ok(
    ci.indexOf('gh workflow run pages.yml') > ci.indexOf('gh release edit "v${VERSION}" --latest'),
    'and the landing page is redeployed only after that',
  );
  assert.match(releaseJob, /actions: write/, 'which the release job is allowed to start');
  assert.match(ci, /latest\.json --clobber/, 'with a latest.json attached to every release');
  assert.match(ci, /printf '\{"version":"%s","url":"%s"\}\\n' "\$VERSION" "\$url"/,
    'naming the version and the dmg it can be fetched from');
  assert.ok(
    ci.includes('url="https://github.com/tuanchauict/redlineapp/releases/download/v${VERSION}/'),
    'which is the dmg on the same release',
  );
  const latestUrl = cmdsRs.match(/const LATEST: &str = "([^"]+)"/)?.[1];
  assert.strictEqual(
    latestUrl,
    'https://github.com/tuanchauict/redlineapp/releases/latest/download/latest.json',
    'and the app reads it from whichever release is Latest',
  );
  assert.match(cmdsRs, /"--location"/, 'following the redirect GitHub answers that URL with');
});
