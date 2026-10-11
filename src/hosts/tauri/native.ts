// `window.mdNative`, over Rust.
//
// The page was written against a preload script: one object on the window with
// a method per thing only a native process can do, and a handful of `onX`
// registrations for the things it announces. That shape is kept exactly, so
// public/app.js needs to know nothing about which shell it is running in -- it
// is the same surface, reimplemented on Tauri's IPC instead of Electron's.
//
// One difference is worth spelling out, because it is the whole reason the
// reader can live in the page. The shell keeps a window's tabs as *paths*: it
// has no reader to ask what a document id means. The page works in ids, because
// that is what it asks the backend for. So this file is where the two meet -- it
// retains each path the shell names, which is what turns it into an id, and
// releases the ones the shell stops naming.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

import type { Reader } from '../../reader/reader.js';
import { storeRoot } from '../../reader/store.js';
import { tauriPlatform } from './platform.js';
import type { Handoff } from './platform.js';

/** One tab as the page is given it: the shell's path, and the id the reader made of it. */
export interface TabRow {
  id: string;
  path: string;
  name: string;
  /** Where the file is, with `~` for home. */
  dir: string;
}

/** A window's tabs and the one on screen: as paths from the shell, as rows for the page. */
interface TabList<Tab> {
  tabs: Tab[];
  active: string | null;
}

/** The preferences, as the shell keeps them: JSON, and the page knows which keys it wrote. */
export type Settings = Record<string, unknown>;

/** What `check_update` answers: `Update` in shell/src/cmds.rs. */
export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  url: string;
  /** Installed by Homebrew, so the upgrade has to go through Homebrew too. */
  brew: boolean;
}

/** `~/Projects/atlas/docs`, the way a person would say it. */
function homeRelative(abs: string | null | undefined, home: string | undefined): string {
  if (!home || !abs) return abs ?? '';
  if (abs === home) return '~';
  return abs.startsWith(home + '/') ? '~' + abs.slice(home.length) : abs;
}

/**
 * Install the shell bridge on the window, and answer with the one part of it
 * the caller needs to drive: the tab list.
 *
 * `reader` is already created, and ours to hold documents in.
 */
export function installNative({ reader }: { reader: Reader }) {
  const host: Partial<Handoff> = globalThis.__REDLINE_HOST ?? {};

  /** The documents this window holds, path -> id, one reference each. */
  const held = new Map<string, string>();
  const pathOf = (id: string): string | null => [...held].find(([, of]) => of === id)?.[0] ?? null;

  /**
   * Make the documents this page holds match the list the shell names.
   *
   * The reference counting is the reason this is one function rather than a
   * retain here and a release there: every path is retained exactly once, so a
   * file that arrives twice does not need two closes to be let go of, and a
   * window that loses a tab actually stops polling it.
   */
  async function sync(paths: string[]): Promise<TabRow[]> {
    // One `retain` apiece, at once rather than in a line: each opens its own
    // file, store and git subprocess, so a window restoring four tabs was
    // paying for them one after another -- the sidebar sitting empty for the
    // sum of four opens instead of the slowest one.
    await Promise.all(
      paths.map(async (abs) => {
        if (held.has(abs)) return;
        try {
          held.set(abs, await reader.retain(abs));
        } catch {
          // The shell checked it was a file before offering it, so this is a
          // document that cannot be read rather than one that is not there.
          // Either way it is not a tab: take the row back off the window.
          invoke('close_tab', { path: abs });
        }
      }),
    );
    for (const [abs, id] of [...held]) {
      if (paths.includes(abs)) continue;
      held.delete(abs);
      reader.release(id);
    }
    return paths
      .filter((abs) => held.has(abs))
      .map((abs) => ({
        id: held.get(abs),
        path: abs,
        name: tauriPlatform.basename(abs),
        // A window's tabs can come from anywhere, and two directories can hold
        // the same filename; the row says which one this is.
        dir: homeRelative(tauriPlatform.dirname(abs), host.home),
      }));
  }

  // Every registration so far. A registration is itself a message to the other
  // side, so asking for something immediately after registering for the answer
  // is a race -- `requestTabs` waits these out rather than assuming an order.
  const listening: Promise<UnlistenFn>[] = [];

  /**
   * Register for one of the shell's announcements -- the ones meant for *this*
   * window.
   *
   * The `target` is not optional, and leaving it off is a bug that only shows
   * up once a second window exists. Tauri resolves an absent target to
   * `EventTarget::Any`, and an `Any` listener is exempt from the filter an
   * `emit_to` carries: `match_any_or_filter` short-circuits on it, so every
   * window's page receives every window's events. The shell addresses almost
   * all of these by name -- a window's tab list, the menu commands, which
   * window went fullscreen -- so what looks like a broadcast API is really a
   * page that signed up for more than was sent to it. Naming our own label
   * makes `emit_to` mean what it says.
   *
   * An app-wide `emit` still arrives: that one passes no filter at all, and a
   * listener with no filter to fail matches everything. So `md:settings`, which
   * really is for every window, keeps working.
   */
  const on = <T>(event: string, cb: (payload: T) => void): (() => void) => {
    const off = listen<T>(event, ({ payload }) => cb(payload), { target: host.label });
    listening.push(off);
    return () => off.then((f) => f()).catch(() => {});
  };

  const mdNative = {
    // 'darwin' | 'win32' | 'linux' -- the same spelling node uses, because the
    // page turns it straight into a class name.
    platform: host.os ?? 'darwin',

    // --- documents ---------------------------------------------------------
    openPaths: (paths: string[]) => invoke<void>('open_paths', { paths }),
    pickFile: () => invoke<void>('pick_file'),
    requestTabs: async () => {
      await Promise.allSettled(listening);
      return invoke<void>('tabs');
    },
    selectTab: (id: string) => invoke<void>('select_tab', { path: pathOf(id) }),
    closeTab: (id: string) => invoke<void>('close_tab', { path: pathOf(id) }),

    onTabs(cb: (state: TabList<TabRow>) => void) {
      const off = on<TabList<string>>('md:tabs', async ({ tabs, active }) => {
        const rows = await sync(tabs);
        // Answered in ids, because that is what the page asks the backend for.
        cb({ tabs: rows, active: held.get(active) ?? rows[0]?.id ?? null });
      });
      return off;
    },

    // --- preferences -------------------------------------------------------
    settings: () => invoke<Settings>('settings'),
    setSettings: (patch: Settings) => invoke<Settings>('set_settings', { patch }),
    onSettings: (cb: (settings: Settings) => void) => on('md:settings', cb),
    storeRoot: () => storeRoot(tauriPlatform),
    revealStore: async () => invoke<void>('reveal', { path: await storeRoot(tauriPlatform) }),

    // --- this copy ---------------------------------------------------------
    version: host.version ?? '',
    /** The one request this app makes off the machine; see cmds::check_update. */
    checkUpdate: () => invoke<UpdateInfo>('check_update'),
    onCheckUpdate: (cb: () => void) => on('md:check-update', () => cb()),

    // --- the menu, and the window ------------------------------------------
    onOpenSettings: (cb: () => void) => on('md:open-settings', () => cb()),
    onFullscreen: (cb: (on: boolean) => void) => on('md:fullscreen', cb),
    onToggleSide: (cb: () => void) => on('md:toggle-side', () => cb()),
    onToggleToc: (cb: () => void) => on('md:toggle-toc', () => cb()),
    onToggleView: (cb: () => void) => on('md:toggle-view', () => cb()),
    onToggleDiff: (cb: () => void) => on('md:toggle-diff', () => cb()),
    onMarkRead: (cb: () => void) => on('md:mark-read', () => cb()),
    onNextChange: (cb: () => void) => on('md:next-change', () => cb()),
    onPrevChange: (cb: () => void) => on('md:prev-change', () => cb()),
    onFind: (cb: () => void) => on('md:find', () => cb()),

    /**
     * A file is being dragged over the window, or is not any more.
     *
     * Told rather than seen: the drop belongs to the window, and the webview is
     * handed the paths only once they land -- which is also why there is no
     * `pathForFile` here. A dropped `File` in a webview has no path at all.
     */
    onDrag: (cb: (over: boolean) => void) => on('md:drag', cb),

    /** A link out of the document, opened where links belong. */
    openExternal: (url: string) => invoke<void>('open_external', { url }),

    /** Something is on screen, so the window can stop being hidden. */
    ready: () => invoke<void>('ready'),
  };

  window.mdNative = mdNative;
  return { sync, mdNative };
}

/** The window's half of the shell, which is all the page knows of which shell it is on. */
export type MdNative = ReturnType<typeof installNative>['mdNative'];

declare global {
  interface Window {
    /** Left by `installNative`, for the page to find. Absent in a browser tab. */
    mdNative?: MdNative;
  }
}
