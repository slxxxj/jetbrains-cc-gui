import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    // First-rollout baseline: every rule below already fires on the current
    // tree, so it is pinned to warn to keep `eslint .` at zero errors without
    // mass-editing sources. Tighten rules back to error individually later.
    rules: {
      'no-unused-vars': 'warn',
      'no-empty': 'warn',
      'no-case-declarations': 'warn',
      'require-yield': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
    },
  },
];
