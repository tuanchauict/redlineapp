// Rasterise assets/icon.svg into the formats the platforms want:
//
//   assets/icon.png    1024px, the window and dock icon
//   assets/icon.icns   macOS icon, every size drawn from the vector
//
// The outputs are committed, so this only runs when the SVG changes — nobody
// needs librsvg installed to run or package the reader.
//
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');

// Every size .icns carries, as the four-character type macOS files it under.
// Sizes repeat because a 512px image is both "512" and "256 at 2x", and the
// system picks by type, not by measuring.
const ICNS_SIZES = [
  ['icp4', 16],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

function render(size) {
  try {
    return execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), SVG], {
      maxBuffer: 64 << 20,
    });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('rsvg-convert not found — brew install librsvg');
    throw err;
  }
}

/**
 * Pack PNGs into an .icns.
 *
 * Written here rather than shelled out to `iconutil`, which rejects a PNG with
 * no alpha channel — and cairo, so rsvg-convert, drops the alpha channel when
 * the artwork happens to be fully opaque, as this one is. The container itself
 * is trivial: a magic word, a length, then one length-prefixed chunk per size.
 */
function icns(entries) {
  const chunks = entries.map(([type, png]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const png1024 = render(1024);
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), png1024);
console.log('assets/icon.png');

const entries = ICNS_SIZES.map(([type, size]) => [type, size === 1024 ? png1024 : render(size)]);
fs.writeFileSync(path.join(ROOT, 'assets', 'icon.icns'), icns(entries));
console.log('assets/icon.icns');
