// `npm run lint`, and the `lint` job in ci.yml. What tsc already says -- types, a name that is not
// defined -- is left to tsc; this is the rest of what ESLint's and typescript-eslint's
// recommended sets catch: a statement that does nothing, an escape that does nothing, a binding
// nobody reads. Not type-aware: the codebase is `strict: false`, and the type-aware rules are a
// second type checker arguing with the first.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Built, vendored, or somebody else's: what is linted is what is written here.
    ignores: [
      'out/',
      'dist/',
      'node_modules/',
      'shell/',
      'public/vendor/',
      'public/app.js',
      'public/backend.js',
      'site/landing.js',
      'types/vendor/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // `strict: false` is a choice (docs/typescript.md): an `any` at a boundary -- a message off
      // the wire, a handle the browser hands over, a stand-in in a test -- is how this codebase
      // says "not typed here", and a rule against the word would only move it into casts.
      '@typescript-eslint/no-explicit-any': 'off',
      // `const { dropped: _, ...rest } = x` is how a key is left out, and `_` is a loop that
      // only counts.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, varsIgnorePattern: '^_' },
      ],
      // The tests match source text, and two spaces in `/\n  check: checkUpdate,/` are the
      // indentation being matched. ` {2}` says the same thing less readably.
      'no-regex-spaces': 'off',
    },
  },
  {
    files: ['public/**', 'site/**', 'src/hosts/tauri/**', 'src/hosts/web/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    // The fake DOM walks its tree from the node it is called on, and `let n: Node = this` is
    // that walk's first step, not an alias kept to get round an arrow function.
    files: ['test/support.ts'],
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
);
