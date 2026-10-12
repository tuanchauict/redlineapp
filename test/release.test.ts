import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { rootUrl } from '../src/hosts/node/root.js';

// The version is written in three places, and nothing but this keeps them in
// step: package.json is what the tag and the landing page's download link are
// built from, tauri.conf.json is what the dmg is named and what the About row
// shows, and Cargo.toml is the crate. A mismatch is otherwise only noticed by
// whoever downloads the result — or now, by a copy told it is out of date
// against a version it already is.
// (JSON.parse is handed a Buffer and reads its text; only its `string` parameter type objects.)
test('the version agrees in all three places', async () => {
  const pkgVersion = JSON.parse(
    fs.readFileSync(rootUrl('package.json')) as unknown as string,
  ).version;
  const confVersion = JSON.parse(
    fs.readFileSync(rootUrl('shell/tauri.conf.json')) as unknown as string,
  ).version;
  const cargoVersion = fs
    .readFileSync(rootUrl('shell/Cargo.toml'), 'utf8')
    .match(/^version = "([^"]+)"/m)?.[1];
  assert.strictEqual(confVersion, pkgVersion, 'tauri.conf.json has the version package.json has');
  assert.strictEqual(cargoVersion, pkgVersion, 'and so does shell/Cargo.toml');
  console.log(`✓ the version agrees in all three places (${pkgVersion})`);
});

// The license, and everyone else's.
//
// The Apache text is a legal document and has to be the one apache.org
// publishes, to the byte: a retyped copy that differs is a copy of something
// else. This is the digest of LICENSE-2.0.txt as published.
test('the license, the notices, and the bundle identifier', async () => {
  const fromRoot = (name) => fs.readFileSync(rootUrl(`${name}`));
  assert.strictEqual(
    crypto.createHash('sha256').update(fromRoot('LICENSE')).digest('hex'),
    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
    'LICENSE is the Apache 2.0 text, unaltered',
  );
  assert.match(String(fromRoot('NOTICE')), /^Redline\nCopyright 2026 Tuan Chau\n/, 'NOTICE');
  const pkgJson = JSON.parse(fromRoot('package.json') as unknown as string);
  assert.strictEqual(pkgJson.license, 'Apache-2.0', 'package.json names the license');
  assert.match(
    String(fromRoot('shell/Cargo.toml')),
    /^license = "Apache-2.0"$/m,
    'and so does the crate',
  );
  const bundleConf = JSON.parse(
    fromRoot('shell/tauri.conf.json') as unknown as string,
  ).bundle;
  assert.strictEqual(bundleConf.license, 'Apache-2.0', 'and the bundle');
  assert.strictEqual(bundleConf.copyright, 'Copyright 2026 Tuan Chau', 'with the copyright');
  // What goes into Contents/Resources: the license, the notice, and everyone
  // else's. tauri-build refuses a resource that is not there, so a rename shows
  // up as a failed bundle -- but only on the machine that bundles.
  assert.deepStrictEqual(
    Object.entries(bundleConf.resources).sort(),
    [
      ['../LICENSE', 'LICENSE'],
      ['../NOTICE', 'NOTICE'],
      ['../THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
    ],
    'the app carries its license and the third-party notices',
  );
  for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md', 'SECURITY.md']) {
    assert.ok(fs.existsSync(rootUrl(`${name}`)), `${name} is there`);
  }
  const readmeMd = String(fromRoot('README.md'));
  assert.match(readmeMd, /^## License\n[\s\S]*\(LICENSE\)[\s\S]*\(THIRD-PARTY-NOTICES\.md\)/m,
    'the README says what the license is and where the others are');

  // The notices are generated, and a dependency added without regenerating them
  // would ship without its notice. The file records a digest of both lockfiles'
  // dependency lists; recomputed here from the lockfiles alone, so the check
  // needs no cargo.
  const notices = String(fromRoot('THIRD-PARTY-NOTICES.md'));
  const { inputsDigest } = await import('../scripts/notices.mjs');
  assert.strictEqual(
    notices.match(/<!-- inputs: ([0-9a-f]{64}) -->/)?.[1],
    inputsDigest(),
    'THIRD-PARTY-NOTICES.md is current -- run `npm run notices`',
  );
  assert.match(notices, /^\| elkjs \| [^|]+ \| EPL-2\.0 \| https:\/\/github\.com\/kieler\/elkjs \|$/m,
    'elkjs is named, with where its source is');
  assert.match(notices, /^\| dompurify \| [^|]+ \| \(MPL-2\.0 OR Apache-2\.0\) \|/m,
    'and DOMPurify');
  assert.match(notices, /^\| tauri \| /m, 'and the crates are in it as well as the page');
  assert.strictEqual(
    pkgJson.scripts.notices,
    'npm run build:ts && node out/scripts/notices.mjs',
    'npm run notices',
  );
  // Kept by build:web, so the notices that sit with their code still do.
  assert.match(String(fromRoot('scripts/build-web.mts')), /legalComments: 'eof'/,
    "the bundles keep their license comments");
  assert.match(String(fromRoot('public/vendor/sanitize.js')), /@license DOMPurify/,
    'and DOMPurify\'s is in the bundle');

  // The bundle identifier. Everything the app remembers apart from the snapshot
  // store -- window.json, and the webview's storage under ~/Library/WebKit -- is
  // filed under it, so changing it would make an upgrade look like a fresh install.
  const shellConfig = JSON.parse(fromRoot('shell/tauri.conf.json') as unknown as string);
  assert.strictEqual(shellConfig.identifier, 'com.redline.reader', 'the bundle identifier');
});
