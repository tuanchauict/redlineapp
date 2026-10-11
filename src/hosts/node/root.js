// Where the repository is, found from the file asking and not counted in `..`s.
//
// Node-run code compiles into out/, which mirrors the repository (out/src/hosts/node/,
// out/scripts/), so a `..` count that is right in src/ lands in out/ when the same file
// runs compiled. Walking up to the first package.json gives one answer from both: out/
// holds only what tsc emitted, and tsc does not emit a package.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The directory at or above the file `metaUrl` names (an `import.meta.url`) that has a
 * package.json.
 */
export function repoRoot(metaUrl) {
  const from = fileURLToPath(metaUrl);
  let dir = path.dirname(from);
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no package.json at or above ${from}`);
    dir = up;
  }
  return dir;
}

export const ROOT = repoRoot(import.meta.url);

/**
 * A file: URL under the root, for what used to be `new URL('./x', import.meta.url)` in a file
 * that sat at the root. A trailing slash is kept, so `rootUrl('src/')` is a directory.
 */
export const rootUrl = (name = '') => new URL(name, pathToFileURL(ROOT + path.sep));
