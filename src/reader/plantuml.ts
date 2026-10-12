// PlantUML rendering, strictly local: a `plantuml` binary on PATH, or a
// plantuml.jar run through java. Nothing is ever sent to a remote renderer.
//
// Finding the renderer means reading the disk and running it means spawning a
// process, so both go through the platform (see ./platform.ts) and both are
// async. The jar and the JVM belong to the host either way — they are not
// things a webview could reach for itself.
import { hashContent } from '../core/hash.js';
import { storeRoot } from './store.js';
import type { Platform } from './platform.js';

/**
 * What one diagram came to. Both fields optional because the reader reads either off it and
 * turns it into the contract's `PlantumlResult`, which is the strict form a page is given.
 */
export interface RenderOutcome {
  svg?: string;
  error?: string;
}

/** A renderer, or what stands in for one: what `createReader` is given and `caps` reports on. */
export interface PlantumlRenderer {
  available: boolean;
  /** How it will run when it can, and what to do about it when it cannot. */
  hint: string;
  render: (code: string) => Promise<RenderOutcome | null>;
}

/** How to run a renderer that was found, or why there is none. */
type Found = { cmd: string; pre: string[]; how: string } | { error: string };

const RENDER_TIMEOUT_MS = 20000;

// No jar ships with redline: PlantUML is GPL, ~30 MB, and would still need a
// JVM and graphviz to be useful — so bundling one removes none of the setup.
// Instead: an explicit --plantuml-jar, whatever is installed system-wide, or a
// jar dropped into the store directory, which needs no flag.
const jarCandidates = (platform: Platform, root: string, home: string): string[] => [
  platform.join(root, 'plantuml.jar'),
  '/opt/homebrew/opt/plantuml/libexec/plantuml.jar',
  '/usr/local/opt/plantuml/libexec/plantuml.jar',
  '/usr/share/plantuml/plantuml.jar',
  '/usr/local/share/plantuml/plantuml.jar',
  platform.join(home, '.local/share/plantuml/plantuml.jar'),
];

async function onPath(cmd: string, platform: Platform): Promise<string | null> {
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

async function findRenderer(
  jarOption: string | undefined,
  platform: Platform,
): Promise<Found | null> {
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
function inlineSvg(svg: string): string {
  return svg
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>\s*/i, '')
    .replace(/<!DOCTYPE[\s\S]*?>\s*/i, '')
    .trim();
}

/** What a host that cannot run a program is given: a renderer that says so and draws nothing. */
export const NO_PLANTUML: PlantumlRenderer = Object.freeze<PlantumlRenderer>({
  available: false,
  hint: 'PlantUML needs a program to run, and this host has none.',
  render: async () => null,
});

export async function createPlantumlRenderer(
  { jar }: { jar?: string } = {},
  platform: Platform,
): Promise<PlantumlRenderer> {
  const found = await findRenderer(jar, platform);

  const unavailable = (hint: string): PlantumlRenderer => ({
    available: false,
    hint,
    render: async () => null,
  });
  if (!found) {
    return unavailable(
      'PlantUML is not installed — `brew install plantuml`, or point --plantuml-jar at a plantuml.jar.',
    );
  }
  // `in`, not `found.error`: it narrows the union with or without strictNullChecks.
  if ('error' in found) return unavailable(found.error);

  // Keyed by source, holding the promise rather than the result: the page asks
  // for every diagram at once, and the same diagram twice on one page should
  // start one JVM, not two.
  const cache = new Map<string, Promise<RenderOutcome>>();

  const run = async (source: string): Promise<RenderOutcome> => {
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
    render(code: string) {
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
