// The VS Code extension: `redline.open` puts a Redline preview beside the editor.
//
// One reader for the whole editor, in the extension host, over the files through the editor's own
// file system (platform.ts) and sharing `~/.redline` with the CLI and the apps, so a version read
// here is a version read there. One webview per preview, each pinned to its own document
// (panel.ts). There is no list of open files and no tab strip: the editor has both already, and
// what this adds to its Markdown preview is the history and the contents.
import * as vscode from 'vscode';

import { createReader } from '../../reader/reader.js';
import { createSession } from '../../reader/session.js';
import { attachPanel } from './panel.js';
import type { Panel, PrefsStore } from './panel.js';
import { createVscodePlatform, fromUri } from './platform.js';
import type { NodeBits } from './platform.js';

const VIEW_TYPE = 'redline.preview';
const PREFS_KEY = 'redline.prefs';

const isDark = (): boolean => {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
};

/**
 * `node` is what only node can answer (extension-node.ts, which is the entry point and passes it
 * in), so that this file, and the project it is checked in, has no node built-in in reach.
 */
export async function activateWith(
  context: vscode.ExtensionContext,
  node: NodeBits,
): Promise<void> {
  const platform = createVscodePlatform(vscode, node);
  const reader = await createReader({ platform });
  const session = createSession(reader);

  const pageRoot = vscode.Uri.joinPath(context.extensionUri, 'page');
  // Read per panel and not once: the file is small, and a rebuild during development is picked
  // up by the next panel without reloading the window.
  const pageHtml = async (): Promise<string> =>
    new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(pageRoot, 'index.html')),
    );

  const prefs: PrefsStore = {
    all: () => context.globalState.get<Record<string, string>>(PREFS_KEY, {}),
    set(key, value) {
      const next = { ...this.all() };
      if (value === null) delete next[key];
      else next[key] = value;
      void context.globalState.update(PREFS_KEY, next);
    },
  };

  // Each Panel beside the editor panel it drives, to bring the one a file is already in to the
  // front instead of opening a second copy of it.
  const panels = new Set<Panel>();
  const shown = new Map<Panel, vscode.WebviewPanel>();

  const attach = async (panel: vscode.WebviewPanel, path: string): Promise<void> => {
    try {
      const attached = await attachPanel(
        {
          panel,
          reader,
          session,
          page: { html: await pageHtml(), base: panel.webview.asWebviewUri(pageRoot).toString() },
          prefs,
          dark: isDark,
        },
        path,
      );
      panels.add(attached);
      shown.set(attached, panel);
      panel.onDidDispose(() => {
        panels.delete(attached);
        shown.delete(attached);
      });
    } catch (err) {
      // Nothing was retained, and the panel has nothing in it: it goes, and the reason is said.
      panel.dispose();
      void vscode.window.showErrorMessage(`Redline: ${(err as Error).message}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('redline.open', async (uri?: vscode.Uri) => {
      const path = uri ? fromUri(uri) : activeMarkdown();
      if (!path) {
        void vscode.window.showInformationMessage('Redline: open a Markdown file first.');
        return;
      }
      // `path` is live: a panel that followed a link is on the file it moved to.
      for (const [attached, existing] of shown) {
        if (attached.path === path) {
          existing.reveal();
          return;
        }
      }
      const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'Redline',
        // The pane the file is in, not beside it: Redline has its own raw view, and nothing here
        // edits, so a second pane of the same text has nothing to show.
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          localResourceRoots: [pageRoot],
          // Re-rendering a long document and replaying its diff on every tab switch is slow, and
          // the page holds scroll and folded state that a rebuild would lose.
          retainContextWhenHidden: true,
        },
      );
      await attach(panel, path);
    }),

    // After a restart the editor hands each panel back with what `host.js` stored in its state.
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: { path?: string } | undefined) {
        if (!state?.path) {
          panel.dispose();
          return;
        }
        panel.webview.options = { enableScripts: true, localResourceRoots: [pageRoot] };
        await attach(panel, state.path);
      },
    }),

    vscode.window.onDidChangeActiveColorTheme(() => {
      const dark = isDark();
      for (const p of panels) p.setDark(dark);
    }),
    { dispose: () => reader.closeAll() },
  );
}

function activeMarkdown(): string | null {
  const doc = vscode.window.activeTextEditor?.document;
  // By name as well as by language: another extension can claim a file such as SKILL.md for a
  // language of its own, and the menus (package.json) match the name too.
  const markdown = doc && (doc.languageId === 'markdown' || /\.(md|markdown)$/i.test(doc.uri.path));
  return doc && markdown ? fromUri(doc.uri) : null;
}
