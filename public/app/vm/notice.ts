// The notice: one line said once, for long enough to read it, where the user is already looking.
//
// What it says is a signal and ui/chrome.ts keeps `#notice` to it. It is markup rather than a
// component because it is a live region, which has to be in the page before anything is put in
// it for a screen reader to announce the change.
import { signal } from '@preact/signals';

/** What the notice is saying, or null while it is down. */
export const notice = signal<string | null>(null);

let timer = 0;

/** Say something once, for long enough to read it, where the user is already looking. */
export function notify(text: string) {
  notice.value = text;
  clearTimeout(timer);
  timer = setTimeout(() => {
    notice.value = null;
  }, 6000);
}
