import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rootUrl } from '../src/hosts/node/root.js';
import { scratch } from './support.js';

// The CLI as it is run: the compiled bin, a real process, its exit code and what it prints. Its
// options are parsed at the top of a script that then starts a server, so they are said here from
// outside rather than by importing it. `--no-open` throughout, or every run would open a browser.
const BIN = fileURLToPath(rootUrl('out/bin/redline.js'));
const tmp = scratch('redline-cli-');
const md = path.join(tmp, 'notes.md');
fs.writeFileSync(md, '# Notes\n');
const uml = path.join(tmp, 'uml.md');
fs.writeFileSync(uml, '# Diagram\n\n```plantuml\nA -> B\n```\n');
// Its own home and store, so a sweep of old snapshots on start is a sweep of nothing of yours.
const env = { ...process.env, HOME: tmp, REDLINE_HOME: path.join(tmp, 'home'), PLANTUML_JAR: '' };

/**
 * Run the CLI to the end, or -- for one that serves -- until it has said where, and stop it there.
 * What it said, and how it ended.
 */
function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd: tmp });
    let out = '';
    let err = '';
    const timer = setTimeout(() => (p.kill(), reject(new Error(`timed out: ${out}${err}`))), 15e3);
    p.stdout.on('data', (b) => {
      out += b;
      // The second line is the address; a third, about PlantUML, is printed straight after it.
      if (/ctrl-c to stop/.test(out)) setTimeout(() => p.kill('SIGTERM'), 200);
    });
    p.stderr.on('data', (b) => (err += b));
    p.on('exit', (code) => (clearTimeout(timer), resolve({ code, out, err })));
  });
}
const portOf = (out: string) => Number(out.match(/127\.0\.0\.1:(\d+)\//)?.[1]);

/** A port that is taken, and held for the length of `fn`. */
async function holding<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  try {
    return await fn((s.address() as net.AddressInfo).port);
  } finally {
    s.close();
  }
}

test('the CLI says how to use it, and refuses what it cannot', async () => {
  const bare = await run([]);
  assert.strictEqual(bare.code, 1, 'with no file, it fails');
  assert.match(bare.out, /redline <file\.md> \[options\]/, 'saying how it is used');
  for (const flag of ['-h', '--help']) {
    const help = await run([md, flag]);
    assert.deepStrictEqual([help.code, /Options:/.test(help.out)], [0, true],
      `${flag} with a file is asked for, so it succeeds`);
  }
  assert.strictEqual((await run(['--help'])).code, 1, 'without one, it is still no file');

  for (const args of [[md, '--bogus'], [md, md]]) {
    const r = await run(args);
    assert.strictEqual(r.code, 1, `${args.at(-1)} is refused`);
    assert.match(r.err, new RegExp(`Unknown argument: ${args.at(-1)!.replace(/[.\\/]/g, '\\$&')}`),
      'by name, a second file as much as an unknown flag');
  }
  for (const what of [path.join(tmp, 'missing.md'), tmp]) {
    const r = await run([what, '--no-open']);
    assert.deepStrictEqual([r.code, r.err.trim()], [1, `Not a file: ${what}`],
      'a path that is not there, or is a directory, is not a file');
  }
});

test('the CLI serves the file, on the port asked for or the next free one', async () => {
  await holding(async (taken) => {
    for (const args of [['-p', String(taken)], ['--port', String(taken)], [`--port=${taken}`]]) {
      const r = await run([md, '--no-open', ...args]);
      assert.strictEqual(portOf(r.out), taken + 1, `${args.join(' ')}: a port taken is stepped past`);
      assert.match(r.out, new RegExp(`redline  ${md.replace(/[.\\/]/g, '\\$&')}`),
        'and it says which file');
      assert.strictEqual(r.code, 0, 'and a SIGTERM closes it cleanly');
    }
  });
  const free = await holding(async (p) => p);
  const r = await run([md, '--no-open', '--port', String(free), '--app']);
  assert.strictEqual(portOf(r.out), free, 'a free port is used as given, --app or not');
  assert.doesNotMatch(r.out, /plantuml/, 'a document with no PlantUML hears nothing of it');
});

test('the CLI names a PlantUML that will not run, only for a document that needs one', async () => {
  const jar = path.join(tmp, 'gone.jar');
  for (const args of [['--plantuml-jar', jar], [`--plantuml-jar=${jar}`]]) {
    const r = await run([uml, '--no-open', '--port=0', ...args]);
    assert.match(r.out, new RegExp(`plantuml: PlantUML jar not found: ${jar.replace(/[.\\/]/g,
      '\\$&')}`), `${args[0].split('=')[0]}${args.length > 1 ? ' <p>' : '=<p>'}: the jar is named`);
  }
  const r = await run([md, '--no-open', '--port=0', `--plantuml-jar=${jar}`]);
  assert.doesNotMatch(r.out, /plantuml:/, 'and a document without a diagram is not told');
});
