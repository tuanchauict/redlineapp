// Settings: the sheet ⌘, puts over the window.
//
// Every control here takes effect as you change it: there is no OK to press, the way a Mac
// preference pane works. Sections and rows marked data-shell are the desktop app's to answer and
// are not shown in a browser tab, which has no windows, no Finder and no launch (the stylesheet's
// `html:not(.native) [data-shell]`). Appearance is not one of them: the page draws it
// (`data-scheme`).
//
// Two or three short answers are a segmented control, not a popup: the choices are worth seeing
// without a click, and they fit. A popup is for the lists that do not -- the typefaces on this
// machine above all.
//
// Drawn from `shownSettings` and the signals beside it. What is not here is applying a setting:
// `writeSettings` in vm/settings.ts puts it on <html>, redraws the diagrams it recolours and
// tells the shell, and only then does the sheet see it, so the sheet always shows what the
// window is.
import { render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import {
  docMeasure,
  fontGroups,
  prefsOpen,
  shownSettings,
  state,
  storeRoot,
  update,
  type Settings,
} from '../state.js';
import { cleanFontName, SIZE_MIN, SIZE_MAX } from '../vm/settings.js';

/**
 * What the typeface popup is on. A picked face is stored as `font: 'custom'` with its name beside
 * it -- and `custom` with nothing named renders as the system font, so that is what the popup
 * should say it is.
 */
const fontValue = (s: Settings) => {
  if (s.font !== 'custom') return s.font;
  const named = cleanFontName(s.fontName);
  return named ? `name:${named}` : 'sans';
};

export interface SettingsActions {
  /** Take a change, apply it and keep it. */
  write(patch: Partial<Settings>): void;
  /** One step up or down in text size, kept inside `SIZE_MIN`..`SIZE_MAX`. */
  step(by: number): void;
  /** Change what a document is compared against, and the one on screen with it. */
  baseline(value: string): void;
  /** Show the store in Finder. */
  reveal(): void;
  /** Ask whether there is a newer copy. */
  check(): void;
  /** Do what the update row says: download the file, or copy the command shown in `cmd`. */
  go(cmd: HTMLElement): void;
}

interface Choice {
  value: string;
  text: string;
  /** For the one option a host may not offer, which a test and the caps look up by id. */
  id?: string;
  hidden?: boolean;
}

/** A segmented control: a radio group, read and written by option value. */
function Seg(props: {
  id: string;
  label: string;
  name: string;
  value: string;
  choices: Choice[];
  pick(value: string): void;
}) {
  return (
    <div class="seg" id={props.id} role="radiogroup" aria-label={props.label}>
      {props.choices.map((c) => (
        <label key={c.value} id={c.id} hidden={c.hidden}>
          <input
            type="radio"
            name={props.name}
            value={c.value}
            checked={c.value === props.value}
            onChange={() => props.pick(c.value)}
          />
          <span>{c.text}</span>
        </label>
      ))}
    </div>
  );
}

function Body({ s, version, actions }: { s: Settings; version: string; actions: SettingsActions }) {
  const cmd = useRef<HTMLElement>(null);
  const u = update.value;
  // A choice the host cannot honour is not left looking made: with no git to read, what the
  // page compares against is the last read, and that is what the control should say. Unknown is
  // treated as unavailable, because the welcome, which has no payload to be told by, is only ever
  // the web app's, and the web app has no git.
  const git = Boolean(state.caps?.git);
  return (
    <div class="sheet-body">
      <section>
        <h3>General</h3>
        <div class="group">
          <div class="row">
            <span class="lab">Appearance</span>
            <Seg
              id="setAppearance"
              label="Appearance"
              name="pAppearance"
              value={s.appearance}
              choices={[
                { value: 'system', text: 'System' },
                { value: 'light', text: 'Light' },
                { value: 'sepia', text: 'Sepia' },
                { value: 'dark', text: 'Dark' },
              ]}
              pick={(v) => actions.write({ appearance: v })}
            />
          </div>
          <div class="row" data-shell="">
            <span class="lab">
              On launch
              <small>Come back to the files you left open, or ask which to open</small>
            </span>
            <Seg
              id="setReopen"
              label="On launch"
              name="pReopen"
              value={s.reopenLast ? '1' : '0'}
              choices={[
                { value: '1', text: 'Reopen' },
                { value: '0', text: 'Ask' },
              ]}
              pick={(v) => actions.write({ reopenLast: v === '1' })}
            />
          </div>
          <div class="row" data-shell="">
            <span class="lab">Files from Finder</span>
            <Seg
              id="setFinder"
              label="Files from Finder"
              name="pFinder"
              value={s.finderOpensIn}
              choices={[
                { value: 'tab', text: 'New tab' },
                { value: 'window', text: 'New window' },
              ]}
              pick={(v) => actions.write({ finderOpensIn: v })}
            />
          </div>
        </div>
      </section>

      <section>
        <h3>Reading</h3>
        <div class="group">
          {/* The families are filled in from the fonts this machine actually has: naming one by
              hand means knowing how it is spelled, and being told nothing when you get it
              wrong. */}
          <label class="row">
            <span class="lab">Typeface</span>
            {/* A select has nowhere to draw a chevron of its own: it takes no pseudo-element.
                The wrapper exists to hold one. */}
            <span class="popup">
              <select
                id="setFont"
                class="select"
                value={fontValue(s)}
                onChange={(e) => {
                  const picked = (e.target as HTMLSelectElement).value;
                  // A built-in is a stylesheet rule and a picked face is a name; the name is
                  // kept either way, so going to Serif and back does not lose your choice.
                  if (picked.startsWith('name:')) {
                    actions.write({ font: 'custom', fontName: picked.slice(5) });
                  } else actions.write({ font: picked });
                }}
              >
                <optgroup label="Built in">
                  <option value="sans">System</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Monospace</option>
                </optgroup>
                {/* Each entry is drawn in its own face where the platform lets a popup do
                    that, and the specimen under the section answers for it where it does not. */}
                {fontGroups.value.map(([label, names]) => (
                  <optgroup key={label} label={label}>
                    {names.map((n) => (
                      <option key={n} value={`name:${n}`} style={{ fontFamily: JSON.stringify(n) }}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </span>
          </label>
          <div class="row">
            <span class="lab">Text size</span>
            <span class="stepper" role="group" aria-label="Text size">
              <button
                id="setSizeDown"
                class="step"
                type="button"
                aria-label="Smaller text"
                disabled={s.textSize <= SIZE_MIN}
                onClick={() => actions.step(-1)}
              >
                {'\u2212'}
              </button>
              <output id="setSizeOut" class="step-out" aria-live="polite">
                {`${s.textSize} px`}
              </output>
              <button
                id="setSizeUp"
                class="step"
                type="button"
                aria-label="Larger text"
                disabled={s.textSize >= SIZE_MAX}
                onClick={() => actions.step(+1)}
              >
                +
              </button>
            </span>
          </div>
          <div class="row">
            <span class="lab">
              Text width
              {/* Named widths say which is wider, not how wide. */}
              <small id="setWidthHint">
                {`${docMeasure.value} of text, centred in the window`}
              </small>
            </span>
            <Seg
              id="setWidth"
              label="Text width"
              name="pWidth"
              value={s.width}
              choices={[
                { value: 'narrow', text: 'Narrow' },
                { value: 'medium', text: 'Medium' },
                { value: 'wide', text: 'Wide' },
              ]}
              pick={(v) => actions.write({ width: v })}
            />
          </div>
        </div>
        {/* All three rows above are about how the document looks, and the honest answer to
            "how will it look" is to show it. Set from the same two variables the document is,
            so it needs no script. */}
        <p class="sample">Sphinx of black quartz, judge my vow — 0123456789.</p>
      </section>

      <section>
        <h3>Changes</h3>
        <div class="group">
          <label class="row">
            <span class="lab">
              Show the change marks
              <small>The bars in the margin, the ruler, and the count on the bar</small>
            </span>
            <span class="switch">
              <input
                id="setMarks"
                type="checkbox"
                checked={s.marks}
                onChange={(e) => actions.write({ marks: (e.target as HTMLInputElement).checked })}
              />
              <span class="track" aria-hidden="true"></span>
            </span>
          </label>
          <div class="row">
            <span class="lab">
              Compare against
              <small>What a document opens on — the history overrides it</small>
            </span>
            <Seg
              id="setBaseline"
              label="Compare against"
              name="pBaseline"
              value={s.baseline === 'git' && git ? 'git' : 'read'}
              choices={[
                { value: 'read', text: 'Last read' },
                // Offered only where the reader can read a repository (`caps.git`).
                { value: 'git', text: 'git HEAD', id: 'setBaselineGit', hidden: !git },
              ]}
              pick={actions.baseline}
            />
          </div>
        </div>
      </section>

      <section data-shell="">
        <h3>History</h3>
        <div class="group">
          <div class="row">
            <span class="lab">
              Where versions are kept
              <small>Every version of every file it has seen, outside your project</small>
            </span>
            <button id="setReveal" class="btn" type="button" onClick={actions.reveal}>
              Reveal in Finder
            </button>
          </div>
          <div class="row">
            <span id="setStore" class="path">
              {storeRoot.value}
            </span>
          </div>
        </div>
      </section>

      {/* Which copy this is, and whether there is a newer one. Checked only when asked -- this
          button, or Check for Updates… in the app menu -- and answered here rather than in a
          dialog of its own. The second row is the answer when there is something to do about
          it: a command for a Homebrew install, a download for a dragged one. */}
      <section id="aboutSec" data-shell="">
        <h3>About</h3>
        <div class="group">
          <div class="row">
            <span class="lab">
              Redline <span id="setVersion">{version}</span>
              <small id="updateNote">
                {u ? u.note : 'Checks only when you ask, and sends nothing about you'}
              </small>
            </span>
            <button
              id="checkUpdate"
              class="btn"
              type="button"
              disabled={Boolean(u?.checking)}
              onClick={actions.check}
            >
              Check for Updates
            </button>
          </div>
          <div id="updateRow" class="row" hidden={!u?.go}>
            <code id="updateCmd" class="path" ref={cmd}>
              {u?.cmd}
            </code>
            <button id="updateGo" class="btn" type="button" onClick={() => actions.go(cmd.current)}>
              {u?.go}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function Sheet({ version, actions }: { version: string; actions: SettingsActions }) {
  const sheet = useRef<HTMLDialogElement>(null);
  const at = prefsOpen.value;
  const s = shownSettings.value;
  // `showModal` and not an `open` attribute: only the method makes it modal, with the backdrop,
  // the focus held inside and Escape to shut it. Escape and Done both end in the dialog's own
  // `close` event, which is where the signal is told, so there is one way shut and not three.
  useLayoutEffect(() => {
    const dialog = sheet.current;
    if (at === null) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();
    if (at) {
      dialog.querySelector(`#${at}`)?.scrollIntoView({ block: 'nearest' });
      prefsOpen.value = '';
    }
  }, [at]);

  return (
    <dialog id="prefs" class="sheet" ref={sheet} onClose={() => (prefsOpen.value = null)}>
      <div class="sheet-head">
        <h2>Settings</h2>
      </div>
      {s && <Body s={s} version={version} actions={actions} />}
      <div class="sheet-foot">
        <button id="prefsDone" class="btn" onClick={() => sheet.current.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}

/**
 * Draw the sheet into `root`, which it owns from here on. `version` is the desktop app's, and
 * empty in a browser tab, where the section it is in is not shown.
 */
export function mountSettings(root: HTMLElement, version: string, actions: SettingsActions) {
  render(<Sheet version={version} actions={actions} />, root);
}
