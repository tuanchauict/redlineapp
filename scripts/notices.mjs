// Third-party notices, for the app and the page.
//
//   npm run notices
//
// Writes THIRD-PARTY-NOTICES.md: every package that ends up in something we
// hand out, with its version, its license and its license text. The .app is a
// binary made of 200-odd crates and a page bundled from a hundred-odd npm
// packages, and most of their licenses ask for exactly one thing in return --
// that their notice travels with the copy. tauri.conf.json puts this file in
// the bundle's Resources, next to LICENSE and NOTICE.
//
// What counts as shipped:
//
//   npm    every package in package-lock.json that is not dev-only. A few of
//          them never reach the page (markdown-it's CLI pulls in argparse), and
//          listing those costs a paragraph, where leaving one out that does
//          reach it would cost the notice it was owed.
//   cargo  everything the shell links on macOS, both architectures, followed
//          from the shell through normal dependencies only -- a build script's
//          own dependencies run on the machine that builds and are not in the
//          binary.
//
// Generated rather than written because it is the kind of list that goes
// stale without anyone deciding it should. The file records a digest of the
// two lockfiles' dependency lists, and test-smoke.js recomputes it from the
// lockfiles alone -- no cargo needed -- so a dependency added without
// regenerating fails the suite instead of shipping without its notice.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)/i;

/** Every non-dev package in package-lock.json, as `{ dir, name, version, license }`. */
function npmPackages(root = ROOT) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  return Object.entries(lock.packages)
    .filter(([dir, e]) => dir && !e.dev)
    .map(([dir, e]) => ({
      dir: path.join(root, dir),
      name: e.name || dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: e.version,
      license: e.license,
    }));
}

/** Every crate in shell/Cargo.lock but the shell itself, as `name@version`. */
function cargoLocked(root = ROOT) {
  const lock = fs.readFileSync(path.join(root, 'shell', 'Cargo.lock'), 'utf8');
  return [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
    .filter(([, name]) => name !== 'redline')
    .map(([, name, version]) => `${name}@${version}`);
}

/**
 * What this file was generated from, as one hash. The whole of Cargo.lock and
 * not just the macOS part, because which crates a platform needs is cargo's
 * question and asking it needs cargo; a Windows-only crate changing makes this
 * stale for nothing, and regenerating is one command.
 */
export function inputsDigest(root = ROOT) {
  const npm = npmPackages(root).map((p) => `${p.name}@${p.version}`);
  const list = [...npm.sort(), '--', ...cargoLocked(root).sort()].join('\n');
  return crypto.createHash('sha256').update(list).digest('hex');
}

/** The texts of the license files in a package's folder; none where it ships none. */
function licenseTexts(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => LICENSE_FILE.test(n)).sort();
  } catch {
    return [];
  }
  return names
    .filter((n) => fs.statSync(path.join(dir, n)).isFile())
    .map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim());
}

function npmEntries() {
  return npmPackages().map((p) => {
    let source = `https://www.npmjs.com/package/${p.name}/v/${p.version}`;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(p.dir, 'package.json'), 'utf8'));
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
      if (repo) source = repo.replace(/^git\+/, '').replace(/\.git$/, '');
    } catch {}
    return { ...p, source, texts: licenseTexts(p.dir) };
  });
}

function cargoEntries() {
  const found = new Map();
  for (const target of TARGETS) {
    const meta = JSON.parse(
      execFileSync(
        'cargo',
        ['metadata', '--locked', '--format-version', '1', '--filter-platform', target],
        { cwd: path.join(ROOT, 'shell'), maxBuffer: 64 << 20 },
      ),
    );
    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const todo = [meta.resolve.root];
    const seen = new Set();
    while (todo.length) {
      const id = todo.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of nodes.get(id).deps) {
        if (dep.dep_kinds.some((k) => k.kind === null)) todo.push(dep.pkg);
      }
    }
    for (const id of seen) {
      const p = byId.get(id);
      if (p.name === 'redline') continue;
      found.set(`${p.name}@${p.version}`, {
        name: p.name,
        version: p.version,
        license: p.license,
        source: p.repository || `https://crates.io/crates/${p.name}/${p.version}`,
        texts: licenseTexts(path.dirname(p.manifest_path)),
      });
    }
  }
  return [...found.values()];
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

function render(npm, cargo) {
  const out = [];
  const line = (s = '') => out.push(s);
  line('# Third-party notices');
  line();
  line('Redline is Apache-2.0 (see `LICENSE` and `NOTICE`). The desktop app and the page');
  line('it draws include the packages below, each under its own license. Generated by');
  line('`npm run notices` from `package-lock.json` and `shell/Cargo.lock`; do not edit.');
  line();
  line(`<!-- inputs: ${inputsDigest()} -->`);
  line();
  line('## Where to find the source');
  line();
  line('Every package below is used unmodified, and its source is at the link in its');
  line('row. That is the whole of what is owed for the weak-copyleft ones -- **elkjs**');
  line('(EPL-2.0) in the page, and the MPL-2.0 crates in the shell -- whose terms ask');
  line('that a recipient be told where the source is. **DOMPurify** is offered as');
  line('MPL-2.0 OR Apache-2.0; Redline takes it under Apache-2.0.');

  for (const [title, list] of [
    ['The page (npm)', npm],
    ['The desktop shell (Rust crates)', cargo],
  ]) {
    line();
    line(`## ${title}`);
    line();
    line('| Package | Version | License | Source |');
    line('| --- | --- | --- | --- |');
    for (const p of list) {
      const license = p.license || 'not declared (see its text below)';
      line(`| ${p.name} | ${p.version} | ${license} | ${p.source} |`);
    }
  }

  // One copy of each distinct text, with everyone it covers -- per file, since
  // a crate under MIT OR Apache-2.0 ships one of each, and its MIT file has its
  // own name in it while its Apache file is the same 11 KB as a hundred other
  // crates'. Compared with the whitespace flattened, because the copies differ
  // in indentation and line endings and in nothing a reader would call a
  // difference. Printing each once is the difference between a file a person
  // could read and one nobody would.
  const texts = new Map();
  const missing = [];
  for (const p of [...npm, ...cargo]) {
    if (!p.texts.length) missing.push(p);
    for (const text of p.texts) {
      const key = text.replace(/\s+/g, ' ');
      if (!texts.has(key)) texts.set(key, { text, who: [] });
      const who = texts.get(key).who;
      const name = `${p.name} ${p.version}`;
      if (!who.includes(name)) who.push(name);
    }
  }
  line();
  line('## License texts');
  for (const { text, who } of texts.values()) {
    line();
    line(`### ${who.join(', ')}`);
    line();
    line('```');
    line(text.replace(/```/g, "'''"));
    line('```');
  }
  if (missing.length) {
    line();
    line('### Packages that ship no license file');
    line();
    line('Their license is the one named in their row, in its standard text, and their');
    line('copyright notice is in their source at the link given:');
    line();
    for (const p of missing) line(`- ${p.name} ${p.version} (${p.license || 'not declared'})`);
  }
  line();
  return out.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const npm = npmEntries().sort(byName);
  const cargo = cargoEntries().sort(byName);
  fs.writeFileSync(OUT, render(npm, cargo));
  const size = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`THIRD-PARTY-NOTICES.md: ${npm.length} npm, ${cargo.length} crates, ${size} KB`);
}
