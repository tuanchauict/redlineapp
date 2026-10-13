// Open files: the left column's list, one row per file, the current one lit.
//
// Drawn from `state.tabs` and `state.docId`, so switching to another file relights a row and
// nothing has to say so. Which files there are is not decided here: in the desktop app the shell
// pushes the list, and in the web app `noteOpen` in main.ts keeps it, and either way it lands in
// `state.tabs`. Picking and closing are the host's too, so a row only says which one was meant.
import { render } from 'preact';
import { state } from '../state.js';
import { TabLabel, type Tab } from './TabLabel.js';

export interface FilesActions {
  select(id: string): void;
  close(id: string): void;
}

function Files({ actions }: { actions: FilesActions }) {
  return (
    <>
      {(state.tabs as Tab[]).map((t) => {
        const on = t.id === state.docId;
        return (
          <button
            key={t.id}
            type="button"
            class={on ? 'tab on' : 'tab'}
            title={t.label ?? t.path}
            aria-current={on ? 'true' : 'false'}
            onClick={() => actions.select(t.id)}
            // The middle button closes, as it does a browser's tab.
            onAuxClick={(e) => e.button === 1 && actions.close(t.id)}
          >
            <TabLabel tab={t} />
            {/* A span, not a button: a button inside a button is not allowed, and the
                row is the button. */}
            <span
              class="x"
              role="button"
              title={`Close ${t.name}`}
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation();
                actions.close(t.id);
              }}
            >
              <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
              </svg>
            </span>
          </button>
        );
      })}
    </>
  );
}

/** Draw the list into `root`, which it owns from here on: nothing else may touch its children. */
export function mountFiles(root: HTMLElement, actions: FilesActions) {
  render(<Files actions={actions} />, root);
}
