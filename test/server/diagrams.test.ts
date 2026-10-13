import { test } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert';
import { rootUrl } from '../../src/hosts/node/root.js';
import { nodePlatform } from '../../src/hosts/node/platform.js';
import { clientFor, scratch, serve, type Reply } from '../support.js';
import { createPlantumlRenderer } from '../../src/reader/plantuml.js';

// The sample, copied, so that nothing a check does can reach the one in the repository.
const tmp = scratch();
const file = path.join(tmp, 'sample.md');
fs.copyFileSync(rootUrl('sample.md'), file);
const { base } = await serve(file);
const doc = await clientFor(base)('/api/doc');

test('diagram fences', async () => {
  assert.match(doc.html, /<pre class="mermaid">graph TD/, 'mermaid fence handed to the client');
  assert.ok(!/<code class="language-mermaid"/.test(doc.html), 'mermaid not left as a code block');
  // PlantUML is now a placeholder too: the jar cannot run in a webview, so the
  // render leaves the source in the page and the page asks for the SVG. What the
  // render has to get right is that the source survives intact — it is the only
  // copy the request will have to go on.
  assert.match(doc.html, /diagram-plantuml[\s\S]*<pre class="plantuml">/, 'plantuml fence left for the page');
  assert.match(doc.html, /Alice -&gt; Bob/, 'with its source, escaped');
  assert.ok(!/<code class="language-plantuml"/.test(doc.html), 'and not left as a code block');
  // The request the page makes for each one. Answers 200 either way: a diagram
  // that will not draw is something to show in the page, not a failed request.
  const puml = await createPlantumlRenderer({}, nodePlatform);
  const pumlRes = await fetch(base + '/api/plantuml', { method: 'POST', body: 'Alice -> Bob: hi' });
  assert.strictEqual(pumlRes.status, 200, 'the render endpoint answers');
  const pumlOut = (await pumlRes.json()) as Reply;
  if (puml.available) {
    assert.match(pumlOut.svg, /^<svg/, 'plantuml rendered to inline SVG');
    assert.ok(!pumlOut.svg.includes('<?xml'), 'XML prolog stripped from inlined SVG');
  } else {
    assert.match(pumlOut.error, /brew install plantuml/, 'or explains how to fix it');
    assert.ok(!pumlOut.svg, 'and offers no SVG');
  }
  assert.strictEqual(
    (await fetch(base + '/api/plantuml', { method: 'POST', body: '  ' })).status,
    400,
    'an empty diagram is a bad request, not an empty render',
  );
  console.log(`✓ diagram fences (plantuml ${puml.available ? 'via ' + puml.hint : 'not installed'})`);
});

// plantuml jar detection: bad path reports it, valid path is used, a jar that
// cannot actually run degrades to an in-page error rather than crashing.
test('plantuml jar detection + failure handling', async () => {
  const missingJar = await createPlantumlRenderer({ jar: path.join(tmp, 'nope.jar') }, nodePlatform);
  assert.strictEqual(missingJar.available, false);
  assert.match(missingJar.hint, /jar not found/, 'bad --plantuml-jar is reported');

  const fakeJar = path.join(tmp, 'fake.jar');
  fs.writeFileSync(fakeJar, 'not really a jar');
  const broken = await createPlantumlRenderer({ jar: fakeJar }, nodePlatform);
  assert.strictEqual(broken.available, true, 'an existing jar path is accepted');
  assert.match(broken.hint, /^java -jar /, 'runs the jar through java');
  const out = await broken.render('Alice -> Bob: hi');
  assert.ok(out.error && !out.svg, `a failing jar yields an error, not a crash: ${JSON.stringify(out)}`);

  // The same two failures one level down, where "not a crash" is load-bearing in
  // a way a jar cannot be relied on to show. A child that exits without reading
  // its stdin leaves the write with nowhere to go, and an unhandled EPIPE on a
  // stdin stream ends the process -- no rejection to catch, the whole run gone.
  // A bogus jar finds it only on a machine where java loses the race, so it is
  // provoked here directly: more than a pipe buffer of input, into a command that
  // is already finished. Without the handler in src/hosts/node/platform.ts this line does
  // not fail the suite, it kills it.
  const unread = await nodePlatform.spawn('true', [], { input: 'x'.repeat(1024 * 1024) });
  assert.strictEqual(unread.code, 0, 'a child that never reads its input is not a crash');
  const absent = await nodePlatform.spawn('redline-no-such-binary', [], { input: 'hi' });
  assert.strictEqual(absent.code, 'ENOENT', 'and a command that is not there is reported, not thrown');
});
