// Build a Redline.app you can hand to somebody, and a .dmg to hand it in.
//
//   npm run bundle            # this machine's architecture
//   npm run bundle -- --universal   # runs on both Intel and Apple silicon
//
// Three steps, and the first two are the ones that are easy to forget: the page
// is generated (build-web), staged into shell/dist (build-dist), and only then
// compiled into the binary. Tauri embeds shell/dist at compile time, so a
// change to public/ that has not been through both staging steps is a change
// that is not in the app — which looks exactly like the change not working.
// They run from here rather than from a `prebundle` hook so that there is no
// way to ask for a bundle and get a stale one.
//
// Everything the reader needs ends up inside the bundle, including the mermaid
// renderer, so the recipient installs nothing. PlantUML stays out — see the
// README for why.
//
// Signing is Tauri's, not a codesign call from here: the dmg is built around
// the app in the same pass, so anything that has to be true of the app has to be
// true before Tauri starts.
//
// Who signs it depends on what is in the environment, and both answers are
// real. `signingIdentity: "-"` in tauri.conf.json is the local one -- ad hoc,
// which is the least macOS will launch on Apple silicon and nothing like enough
// for a machine that downloaded it. A Developer ID in `APPLE_SIGNING_IDENTITY`
// replaces it, and credentials alongside it get the build notarized on the way
// past. The note printed at the end says which of the three happened, because
// that is what decides what the recipient has to do on first launch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = path.join(ROOT, 'shell');
const OUT = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const universal = process.argv.includes('--universal');
const arch = universal ? 'universal' : process.arch;

// A real identity arrives as a `--config` patch and not as the environment
// variable Tauri would also read, because tauri.conf.json has an answer in it
// already -- the ad hoc `-` -- and this one has to be the one that wins. `-c`
// merges, last value over first, which is a documented promise rather than a
// guess about which source the CLI prefers.
//
// Notarization needs no flag: Tauri does it when it finds a whole set of
// credentials, by Apple ID or by App Store Connect key. All this does is report
// it, so the two halves cannot be reported as one -- signed without being
// notarized is still an app that Gatekeeper refuses, and it should not say
// otherwise.
//
// A whole set, because a part of one is worth nothing and `APPLE_ID` on its own
// is a variable people have exported for other reasons entirely. Guessing from
// it would mean printing "notarized" over a build that was not, which is the
// one error here that is only discovered on somebody else's Mac.
const env = (...names) => names.every((name) => process.env[name]);
const identity = process.env.APPLE_SIGNING_IDENTITY;
const notarized = Boolean(
  identity &&
    (env('APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID') ||
      env('APPLE_API_KEY', 'APPLE_API_ISSUER')),
);
const signing = identity
  ? ['--config', JSON.stringify({ bundle: { macOS: { signingIdentity: identity } } })]
  : [];

const sh = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { stdio: 'inherit', cwd });

sh('node', [path.join('scripts', 'build-web.mjs')]);
sh('node', [path.join('scripts', 'build-dist.mjs')]);

// Run from shell/, which is where tauri.conf.json and Cargo.toml are. A
// universal build is two compiles and a lipo, so it is asked for rather than
// assumed: on this machine the arm64 one is what gets tested.
sh(
  'npx',
  [
    'tauri',
    'build',
    ...(universal ? ['--target', 'universal-apple-darwin'] : []),
    ...signing,
  ],
  SHELL,
);

// Where Tauri leaves it: under the target triple when one was named, and
// directly under target/release when it was not.
const built = path.join(
  SHELL,
  'target',
  ...(universal ? ['universal-apple-darwin'] : []),
  'release',
  'bundle',
);
const dmgs = fs.readdirSync(path.join(built, 'dmg')).filter((f) => f.endsWith('.dmg'));
if (!dmgs.length) throw new Error(`no .dmg under ${path.relative(ROOT, built)}/dmg`);

// Copied into dist/ under names that say what they are, because Tauri names the
// dmg after the target triple and the app after the product. Both are build
// output; dist/ is not in the repository.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const app = path.join(OUT, 'Redline.app');
const dmg = path.join(OUT, `Redline-${pkg.version}-${arch}.dmg`);
sh('cp', ['-R', path.join(built, 'macos', 'Redline.app'), app]);
fs.copyFileSync(path.join(built, 'dmg', dmgs[0]), dmg);

/** What the app weighs on disk, which is not the sum of its files on APFS. */
const du = (p) => execFileSync('du', ['-sh', p]).toString().split('\t')[0].trim();
const mb = (p) => (fs.statSync(p).size / 1e6).toFixed(1);
console.log(`\n  ${path.relative(ROOT, app)}  (${du(app)})`);
console.log(`  ${path.relative(ROOT, dmg)}  (${mb(dmg)} MB)  ← share this\n`);

// Three outcomes, and only the first of them opens without being argued with.
// Said here rather than in a readme because this is the moment somebody is
// about to send the file to a person who will double-click it.
const QUARANTINE =
  '  right-click the app ▸ Open, or  xattr -dr com.apple.quarantine /Applications/Redline.app\n';
if (notarized) {
  console.log(`  Signed as ${identity}, and notarized: it opens where it lands.\n`);
} else if (identity) {
  console.log(`  Signed as ${identity}, but not notarized -- no credentials in the`);
  console.log('  environment -- so a Mac that downloaded it still refuses the first launch:');
  console.log(QUARANTINE);
} else {
  console.log('  Signed ad hoc, so on the machine it lands on:');
  console.log(QUARANTINE);
}
