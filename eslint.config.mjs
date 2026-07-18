// Flat ESLint config. Intentionally lean: this is a small, dependency-light
// tool, so the rules catch real mistakes (unused vars, undeclared globals,
// accidental fallthrough) without imposing a style opinion — Prettier owns
// formatting.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'data/**', 'test-results/**', 'playwright-report/**'] },

  // Server, hooks, simulator — Node ESM.
  {
    files: ['server/**/*.js', 'sim/**/*.js', 'hooks/**/*.mjs', 'tests/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Empty catch blocks are a deliberate pattern here: the visualizer must
      // never break a real Claude session, so failures are swallowed on purpose.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // the server intentionally logs to the terminal
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
    },
  },

  // Browser UI.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module', // the UI ships as native ES modules
      globals: { ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Playwright specs. They run in Node, but page.evaluate() callbacks are
  // serialized into the browser, so both global sets are legitimately in play.
  {
    files: ['tests/**/*.spec.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
