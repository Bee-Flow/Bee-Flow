// Flat config, matching agent-hub's eslint 9 setup. `eslint-config-expo/flat`
// brings the React, React Hooks, import and typescript-eslint rules the Expo
// toolchain expects; the blocks below add the house rules.
//
// Note the split: in flat config a rule can only be set in a config object that
// also registers its plugin. eslint-config-expo registers @typescript-eslint
// ONLY for its TS block (files: **/*.ts, **/*.tsx), so a TS rule set in a
// blanket object fails to resolve the plugin — with an error that reads as a
// missing dependency rather than a scoping mistake. Hence the `files` key on
// the TypeScript block below.
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const expo = require('eslint-config-expo/flat');

module.exports = [
    ...expo,
    {
        ignores: ['android/**', 'ios/**', '.expo/**', 'node_modules/**', 'expo-env.d.ts', 'dist/**'],
    },
    {
        // TypeScript-only rules, with the plugin registered alongside them.
        files: ['**/*.ts', '**/*.tsx'],
        plugins: { '@typescript-eslint': typescriptPlugin },
        rules: {
            // The app talks to a server whose payload shapes are defined in JS,
            // not TS. `any` at the boundary is honest; `any` in the middle of a
            // screen is not — so warn rather than error, and keep it visible.
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    },
    {
        // Jest's globals are not in scope for eslint otherwise, and the setup
        // file is nothing but them.
        files: ['jest.setup.js', '**/*.test.ts', '**/*.test.tsx'],
        languageOptions: {
            globals: {
                jest: 'readonly',
                describe: 'readonly',
                it: 'readonly',
                test: 'readonly',
                expect: 'readonly',
                beforeAll: 'readonly',
                beforeEach: 'readonly',
                afterAll: 'readonly',
                afterEach: 'readonly',
                global: 'readonly',
                require: 'readonly',
                module: 'writable',
                __DEV__: 'readonly',
            },
        },
    },
    {
        rules: {
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            // Import order keeps the diff on a screen file readable when six
            // people touch it — which, on this package, they did.
            'import/order': [
                'warn',
                {
                    groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index']],
                    'newlines-between': 'always',
                    alphabetize: { order: 'asc', caseInsensitive: true },
                },
            ],
        },
    },
    // LAST on purpose. Flat config resolves later objects over earlier ones, so
    // an override has to come after the blanket rules it is overriding — this
    // block sat above them at first and its `no-console: off` silently did
    // nothing.
    {
        // Build-time scripts run in Node, not on the device — and
        // generate-icons.mjs imports sharp, which is deliberately NOT a
        // dependency of this package (see the file's header).
        files: ['scripts/**/*.mjs', 'scripts/**/*.js', 'plugins/**/*.js'],
        languageOptions: {
            globals: {
                Buffer: 'readonly',
                process: 'readonly',
                console: 'readonly',
                require: 'readonly',
                module: 'writable',
                __dirname: 'readonly',
            },
        },
        rules: {
            'import/no-unresolved': 'off',
            // A build script reporting what it generated is its user interface.
            'no-console': 'off',
        },
    },
];
