// Types for `markdown-it-task-lists`, which ships none. No `@types` package exists for it, and a
// new dependency for one call site was ruled out, so what `src/core/render.ts` uses of it is
// declared here. It is a plugin, so `md.use(taskLists, { label: true })` has to type-check against
// markdown-it's own `PluginWithOptions`. A script file on purpose: a top-level `import` or
// `export` would make this a module, and the `declare module` below an augmentation of one.
declare module 'markdown-it-task-lists' {
  /** The options `index.js` reads. Omitted ones are off: checkboxes disabled, no label. */
  interface TaskListOptions {
    /** Leave the checkboxes clickable instead of `disabled`. */
    enabled?: boolean;
    /** Wrap each item's text and checkbox in a `<label>`. */
    label?: boolean;
    /** With `label`, put the checkbox after the text instead of before it. */
    labelAfter?: boolean;
  }

  const taskLists: import('markdown-it').PluginWithOptions<TaskListOptions>;
  export = taskLists;
}
