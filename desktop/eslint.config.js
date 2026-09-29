// Flat config, eslint 9 — same generation as agent-hub's and mobile's.
//
// Two rule sets, because this package has two halves with different globals:
// the Node/Electron side (main, preload, build scripts) and the browser side
// (src/shell, which runs in a renderer with no Node at all).
const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

module.exports = [
    {
        ignores: ['dist/**', 'release/**', 'node_modules/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: {
            globals: { ...globals.node },
        },
        rules: {
            // The server's payload shapes are defined in JavaScript, not TypeScript.
            // `any` at that boundary is honest; `any` in the middle of a module is
            // not — so warn rather than error, and keep it visible.
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            // The main process has no UI to print to; console IS the log.
            'no-console': 'off',
            // `node --test` runs these files as TypeScript through Node's
            // strip-only type removal, which supports no syntax that needs
            // transforming. A parameter property or an enum compiles fine and
            // then fails at test time with a parse error, so ban both here
            // where the message can say why.
            '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
            '@typescript-eslint/no-namespace': 'error',
            'no-restricted-syntax': [
                'error',
                {
                    selector: 'TSEnumDeclaration',
                    message: "Use a union of string literals or an `as const` object — Node's strip-only TypeScript cannot run an enum, so `npm test` would fail on it.",
                },
            ],
        },
    },
    {
        files: ['src/shell/**/*.ts'],
        languageOptions: {
            globals: { ...globals.browser },
        },
    },
    {
        // This file, and it alone, is CommonJS: eslint's flat config loader
        // reads it with `require`, and the package has no "type": "module".
        files: ['eslint.config.js'],
        languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    },
    {
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: { ...globals.node },
            sourceType: 'module',
        },
    },
];
