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
/* global __dirname */
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const expo = require('eslint-config-expo/flat');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Size and layering rules from ARCHITECTURE.md, as errors. The numbers live in
// eslint.quality.js; a file over them today is in quality-budget.json at its
// measured size, and src/meta/qualityBudget.test.ts keeps that budget exact.
// ---------------------------------------------------------------------------
const { budget, limitsFor, ruleEntry } = require('./eslint.quality.js');

const TESTS = ['**/*.test.ts', '**/*.test.tsx'];
const SOURCE = ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'];

// `../../` (or deeper) crosses an area; the `@/` alias says which one. Paths
// into the native `modules/` folder are exempt: no alias reaches outside src/.
const PARENT_OF_PARENT = {
    regex: '^(\\.\\./){2,}(?!(\\.\\./)*modules/)',
    message: "Import across areas with the '@/' alias; '../../' is not allowed.",
};
// Only core/api talks HTTP; everything else calls api.* from core/api/client.
const EXPO_FETCH = { name: 'expo/fetch', message: 'Only core/api talks HTTP; use api.* from @/core/api/client.' };
const restrictImports = ({ groups = [], http = false } = {}) => ({
    'no-restricted-imports': [
        'error',
        {
            paths: http ? [] : [EXPO_FETCH],
            patterns: [PARENT_OF_PARENT, ...groups],
        },
    ],
});
const FEATURE_INTERNALS = {
    group: ['@/features/*/**'],
    message: "Another feature is imported through its index ('@/features/x'), never its internals.",
};
// A feature's own folders are not "another feature". A file two folders deep
// in a big feature (flow-editor/components/outline/…) cannot reach its sibling
// model/ relatively without `../../`, so it names it with the alias instead:
// `@/features/flow-editor/model/…`. One block per feature, each exempting
// itself; the list is read from disk so a new feature needs no edit here.
const FEATURE_NAMES = fs
    .readdirSync(path.join(__dirname, 'src', 'features'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
const OTHER_FEATURES_INTERNALS = (name) => ({ ...FEATURE_INTERNALS, group: ['@/features/*/**', `!@/features/${name}/**`] });
const CORE_LAYER = { group: ['@/shared/**', '@/features/**'], message: 'core never imports shared or features.' };
const SHARED_LAYER = { group: ['@/features/**'], message: 'shared never imports features.' };

/** One rules object for a limit set, e.g. the defaults for `src/**.tsx`. */
const sizeRulesFrom = (limits) => Object.fromEntries(Object.entries(limits).map(([rule, max]) => [rule, ruleEntry(rule, max)]));

const sizeRules = [
    { files: ['src/**/*.ts'], ignores: TESTS, rules: sizeRulesFrom(limitsFor('src/x.ts')) },
    { files: ['src/**/*.tsx'], ignores: TESTS, rules: sizeRulesFrom(limitsFor('src/x.tsx')) },
    { files: ['app/**/*.ts'], ignores: TESTS, rules: sizeRulesFrom(limitsFor('app/x.ts')) },
    { files: ['app/**/*.tsx'], ignores: TESTS, rules: sizeRulesFrom(limitsFor('app/x.tsx')) },
    { files: ['app/_layout.tsx'], rules: sizeRulesFrom(limitsFor('app/_layout.tsx')) },
    // The budget: each file keeps the defaults except where it is recorded over.
    ...Object.entries(budget.files).map(([file, over]) => ({ files: [file], rules: sizeRulesFrom(over) })),
];

// Imports point down the stack: app -> features -> shared -> core. A test may
// reach across to exercise what it tests. Later blocks replace the rule's
// options, so each area restates the `../../` and HTTP bans. Nothing imports
// app/: it has no alias, and the `../../` ban covers the relative way in.
const layerRules = [
    { files: SOURCE, rules: restrictImports() },
    {
        files: ['app/**/*.{ts,tsx}'],
        ignores: TESTS,
        rules: restrictImports({
            groups: [{ ...FEATURE_INTERNALS, message: "app/ imports a feature through its index ('@/features/x')." }],
        }),
    },
    { files: ['src/core/**/*.{ts,tsx}'], ignores: TESTS, rules: restrictImports({ groups: [CORE_LAYER] }) },
    { files: ['src/core/api/**/*.{ts,tsx}'], ignores: TESTS, rules: restrictImports({ groups: [CORE_LAYER], http: true }) },
    { files: ['src/core/api/**/*.test.{ts,tsx}'], rules: restrictImports({ http: true }) },
    { files: ['src/shared/**/*.{ts,tsx}'], ignores: TESTS, rules: restrictImports({ groups: [SHARED_LAYER] }) },
    {
        files: ['src/shared/lib/**/*.{ts,tsx}'],
        ignores: TESTS,
        rules: restrictImports({
            groups: [{ group: ['@/**'], message: 'shared/lib has no dependencies, so any layer may use it.' }],
        }),
    },
    ...FEATURE_NAMES.map((name) => ({
        files: [`src/features/${name}/**/*.{ts,tsx}`],
        ignores: TESTS,
        rules: restrictImports({ groups: [OTHER_FEATURES_INTERNALS(name)] }),
    })),
    {
        // A file at a feature's root is one `../` from its neighbours, which
        // would walk into another feature past both bans above.
        files: ['src/features/*/*.{ts,tsx}'],
        ignores: TESTS,
        rules: restrictImports({
            groups: [FEATURE_INTERNALS, { regex: '^\\.\\./', message: "Import another feature as '@/features/x'." }],
        }),
    },
];

module.exports = [
    ...expo,
    {
        // `src/shared/expr/vendor` and `src/shared/mapping/vendor` are the
        // server's shared modules copied byte for byte (npm run gen:shared;
        // the *Vendor.lockstep tests); linting them here would only ask for an
        // edit the lockstep tests forbid. They are linted where they are
        // written, in server.
        ignores: [
            'android/**', 'ios/**', '.expo/**', 'node_modules/**', 'expo-env.d.ts', 'dist/**',
            'src/shared/expr/vendor/**', 'src/shared/mapping/vendor/**',
        ],
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
    ...sizeRules,
    ...layerRules,
];
