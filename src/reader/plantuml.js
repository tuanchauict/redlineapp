// PlantUML rendering, strictly local: a `plantuml` binary on PATH, or a
// plantuml.jar run through java. Nothing is ever sent to a remote renderer.
//
// Finding the renderer means reading the disk and running it means spawning a
// process, so both go through the platform (see ./platform.js) and both are
// async. The jar and the JVM belong to the host either way — they are not
// things a webview could reach for itself.
import { hashContent } from '../core/hash.js';
import { storeRoot } from './store.js';

const RENDER_TIMEOUT_MS = 20000;

// No jar ships with redline: PlantUML is GPL, ~30 MB, and would still need a
// JVM and graphviz to be useful — so bundling one removes none of the setup.
// Instead: an explicit --plantuml-jar, whatever is installed system-wide, or a
// jar dropped into the store directory, which needs no flag.
const jarCandidates = (platform, root, home) => [
  platform.join(root, 'plantuml.jar'),
  '/opt/homebrew/opt/plantuml/libexec/plantuml.jar',
  '/usr/local/opt/plantuml/libexec/plantuml.jar',
  '/usr/share/plantuml/plantuml.jar',
  '/usr/local/share/plantuml/plantuml.jar',
  platform.join(home, '.local/share/plantuml/plantuml.jar'),
];

async function onPath(cmd, platform) {
  const win = platform.os === 'win32';
  const exts = win ? (platform.env('PATHEXT') || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (platform.env('PATH') || '').split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = platform.join(dir, cmd + ext);
      if (await platform.exists(p)) return p;
    }
  }
  return null;
}

async function findRenderer(jarOption, platform) {
  const jar = jarOption || platform.env('PLANTUML_JAR');
  if (jar) {
    if (!(await platform.exists(jar))) return { error: `PlantUML jar not found: ${jar}` };
    return { cmd: 'java', pre: ['-jar', jar], how: `java -jar ${jar}` };
  }
  const bin = await onPath('plantuml', platform);
  if (bin) return { cmd: bin, pre: [], how: bin };

  const candidates = jarCandidates(platform, await storeRoot(platform), await platform.homeDir());
  for (const p of candidates) {
    if ((await platform.exists(p)) && (await onPath('java', platform))) {
      return { cmd: 'java', pre: ['-jar', p], how: `java -jar ${p}` };
    }
  }
  return null;
}

/** Strip the XML prolog/doctype so the SVG can be inlined into the page. */
function inlineSvg(svg) {
  return svg
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>\s*/i, '')
    .replace(/<!DOCTYPE[\s\S]*?>\s*/i, '')
    .trim();
}

/** What a host that cannot run a program is given: a renderer that says so and draws nothing. */
export const NO_PLANTUML = Object.freeze({
  available: false,
  hint: 'PlantUML needs a program to run, and this host has none.',
  render: async () => null,
});

export async function createPlantumlRenderer({ jar } = {}, platform) {
  const found = await findRenderer(jar, platform);

  if (!found || found.error) {
    return {
      available: false,
      hint:
        found?.error ??
        'PlantUML is not installed — `brew install plantuml`, or point --plantuml-jar at a plantuml.jar.',
      render: async () => null,
    };
  }

  // Keyed by source, holding the promise rather than the result: the page asks
  // for every diagram at once, and the same diagram twice on one page should
  // start one JVM, not two.
  const cache = new Map();

  const run = async (source) => {
    const r = await platform.spawn(found.cmd, [...found.pre, '-tsvg', '-pipe', '-charset', 'UTF-8'], {
      input: source,
      timeout: RENDER_TIMEOUT_MS,
    });
    if (r.stdout.includes('<svg')) return { svg: inlineSvg(r.stdout) };
    const said = (r.stderr || '').trim();
    return { error: said.slice(0, 500) || 'PlantUML produced no SVG output.' };
  };

  return {
    available: true,
    hint: found.how,
    render(code) {
      const source = /@start\w+/.test(code) ? code : `@startuml\n${code}\n@enduml`;
      const key = hashContent(source);
      if (!cache.has(key)) {
        // A transport failure is worth another try; a diagram that would not
        // draw is not, and comes back as { error } rather than a rejection.
        cache.set(
          key,
          run(source).catch((err) => {
            cache.delete(key);
            throw err;
          }),
        );
      }
      return cache.get(key);
    },
  };
}
