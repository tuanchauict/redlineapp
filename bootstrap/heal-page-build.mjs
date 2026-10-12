// Runs before `tsc -b`, from `npm run build:ts`: if the page's compiled files have gone missing,
// forget the page project's build record so the compile that follows writes them again.
//
// Why it exists: `tsc -b` decides a project is up to date from its tsbuildinfo, which holds the
// hash of every input, and never looks to see that the outputs are there. The page's outputs are
// gitignored files beside their sources (public/app.js, public/backend.js, site/landing.js), and
// they are also tracked files on the branches that predate the page being TypeScript. Check one
// of those branches out and back, and git deletes the three, leaves out/ alone, and `tsc -b`
// answers "Updating unchanged output timestamps" and writes nothing. Everything that serves or
// stages the page then fails or serves a blank one, and the advice it prints (run the build
// again) changes nothing. Touching the .ts does not help, because the hash has not changed.
//
// What it does about it is the one thing that does help, which is removing the record. A project
// with no record is built from scratch, and the rest of out/ is untouched. A checkout that has
// never built has no record and so nothing to remove; it is rebuilt anyway.
//
// It is plain JavaScript, here and not in scripts/, because it runs before the compile that
// makes scripts/ runnable and so cannot be one of the things that compile produces. It has no
// list of files: the sources and the record's name are read from tsconfig.page.json, which is
// where the page project says what it builds. Each `public/*.ts` emits a `.js` beside it
// (outDir is "."), and a `.d.ts` emits nothing.
//
//   node bootstrap/heal-page-build.mjs [root]   root defaults to this file's parent directory
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Plain JSON, like the check in test-smoke.ts that reads the same file; a comment in it would
// fail here, at the start of the build, rather than quietly heal nothing.
const config = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.page.json'), 'utf8'));

// `public/*.ts` and `site/*.ts` name a directory each; `types` is declarations and emits nothing.
const dirs = (config.include ?? [])
  .map((pattern) => pattern.match(/^([^*]+)\/\*\.ts$/)?.[1])
  .filter(Boolean);

const missing = [];
for (const dir of dirs) {
  let names;
  try {
    names = fs.readdirSync(path.join(root, dir));
  } catch (err) {
    if (err.code === 'ENOENT') continue;
    throw err;
  }
  for (const name of names) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
    const js = `${dir}/${name.slice(0, -3)}.js`;
    if (!fs.existsSync(path.join(root, js))) missing.push(js);
  }
}

const record = path.join(root, config.compilerOptions.tsBuildInfoFile);
if (missing.length > 0 && fs.existsSync(record)) {
  fs.rmSync(record);
  console.log(`build:ts: ${missing.join(', ')} missing; rebuilding the page project`);
}
