// Types for `markdown-it-task-lists`, which ships none. No `@types` package exists for it, and a
// new dependency for one call site was ruled out, so what `src/core/render.ts` uses of it is
// declared here. It is a plugin, so `md.use(taskLists, { label: true })` has to type-check against
// markdown-it's own `PluginWithOptions`. A script file on purpose: a top-level `import` or
// `export` would make this a module, and the `declare module` below an augmentation of one.
declare module 'markdown-it-task-lists' {
  /**
   * The options `index.js` reads. It keeps them in module-level variables, so passing an object
   * sets all three (an omitted one is off) and passing none keeps what the last call left.
   * `render.ts` always passes one.
   */
  interface TaskListOptions {
    /** Leave the checkboxes clickable instead of `disabled`. */
    enabled?: boolean;
    /** Wrap each item's checkbox and text in one `<label>`, when `labelAfter` is off. */
    label?: boolean;
    /**
     * With `label`, give the text its own `<label for>` after the checkbox instead of one
     * `<label>` around both. Ignored without `label`.
     */
    labelAfter?: boolean;
  }

  const taskLists: import('markdown-it').PluginWithOptions<TaskListOptions>;
  export = taskLists;
}
