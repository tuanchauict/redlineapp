// Set the version, everywhere it is written.
//
//   npm run bump -- 0.8.0
//   npm run bump -- minor        (or major, or patch: from package.json's)
//
// The version is in five files: package.json and shell/tauri.conf.json, shell/Cargo.toml, and
// the two lockfiles' copies of it, which `npm install` and `cargo build` would otherwise
// rewrite later, in some unrelated commit. test/release.test.ts fails until they agree; this
// is so they never have to be made to by hand.
//
// Each file is edited as text, one line of it, so its formatting is left exactly as it was. A
// pattern that no longer finds its line stops the bump before anything is written: a bump
// that lands in four files out of five is the mismatch this exists to prevent.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/hosts/node/root.js';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

// The line holding the version in each file, with the version itself as the second group.
const SITES: [string, RegExp][] = [
  ['package.json', /^(  "version": ")([^"]+)"/m],
  ['package-lock.json', /^(  "version": ")([^"]+)"/m],
  // The root package's own entry, the second copy npm keeps.
  ['package-lock.json', /("": \{\n\s+"name": "redline",\n\s+"version": ")([^"]+)"/],
  ['shell/tauri.conf.json', /^(  "version": ")([^"]+)"/m],
  // The first `version =` is [package]'s; a dependency's is in a table of its own further down.
  ['shell/Cargo.toml', /^(version = ")([^"]+)"/m],
  ['shell/Cargo.lock', /(\[\[package\]\]\nname = "redline"\nversion = ")([^"]+)"/],
];

const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const current = JSON.parse(read('package.json')).version as string;

function next(arg: string | undefined): string {
  if (arg && SEMVER.test(arg)) return arg;
  const [major, minor, patch] = current.split(/[.-]/).map(Number);
  if (arg === 'major') return `${major + 1}.0.0`;
  if (arg === 'minor') return `${major}.${minor + 1}.0`;
  if (arg === 'patch') return `${major}.${minor}.${patch + 1}`;
  console.error('usage: npm run bump -- <x.y.z | major | minor | patch>');
  process.exit(1);
}

const version = next(process.argv[2]);
if (version === current) {
  console.error(`already ${current}`);
  process.exit(1);
}

// Every edit is made in memory first, so a pattern that misses writes nothing at all.
const texts = new Map<string, string>();
for (const [file, site] of SITES) {
  const text = texts.get(file) ?? read(file);
  const found = site.exec(text);
  if (!found) {
    console.error(`${file}: no version line where one was expected; nothing written`);
    process.exit(1);
  }
  if (found[2] !== current) {
    console.error(`${file}: says ${found[2]}, package.json says ${current}; nothing written`);
    process.exit(1);
  }
  texts.set(file, text.replace(site, `$1${version}"`));
}
for (const [file, text] of texts) fs.writeFileSync(path.join(ROOT, file), text);

console.log(`${current} -> ${version}: ${[...texts.keys()].join(', ')}`);
