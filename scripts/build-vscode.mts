// Stage the VS Code extension: a directory that is the extension, ready to be packaged.
//
//   npm run build:vscode         # -> dist/vscode/
//   npx @vscode/vsce package     # in dist/vscode/, for the .vsix; not a dependency of this repo
//
// The page is the one every host has, staged by the same code (stage-page.mts) for a host with no
// server and a reader on the far side of `postMessage`; the extension host's side is bundled
// into `extension.js`, as CommonJS because that is what the editor loads, with `vscode` left for
// the editor to provide. The manifest is `vscode/package.json`, copied as it is: the extension has a version of its
// own, released on its own tag (`ext-vN.N.N`, .github/workflows/vscode.yml), apart from the app's.
//
// `dist/vscode/` is gitignored, and emptied on every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { ROOT } from '../src/hosts/node/root.js';
import { megabytes, stagePage } from './stage-page.mjs';

export const VSCODE_DIST = 'dist/vscode';

export async function buildVscode(dest = VSCODE_DIST): Promise<{ dest: string; bytes: number }> {
  // Staging empties `dest`, so everything else goes in after it.
  const staged = stagePage(path.join(dest, 'page'), { host: 'vscode' });
  const out = path.dirname(staged.dest);

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/hosts/vscode/extension-node.ts')],
    outfile: path.join(out, 'extension.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    minify: true,
    legalComments: 'eof',
  });

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'vscode', 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const f of ['.vscodeignore', 'README.md', 'icon.png']) {
    const from = path.join(ROOT, 'vscode', f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(out, f));
  }
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'));

  const bytes = fs.readdirSync(out, { recursive: true, withFileTypes: true }).reduce(
    (n, e) => n + (e.isFile() ? fs.statSync(path.join(e.parentPath, e.name)).size : 0),
    0,
  );
  return { dest: out, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { bytes } = await buildVscode();
  console.log(`\n  ${VSCODE_DIST}  ${megabytes(bytes)}\n`);
}
