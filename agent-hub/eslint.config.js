import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Every rule here is an error. The violations that predate that are recorded
// per file and per rule in eslint-suppressions.json (eslint's bulk
// suppressions): a NEW violation fails, a fixed one makes its suppression
// stale and fails until `npm run lint:suppress:prune` drops it. No rule is a
// warning, so nothing hides behind a total count.

// Long-file / long-function / complexity limits. Tests are exempt (see the
// override below): a describe block is a table of cases, not a function to split.
const sizeComplexityRules = {
    'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true, IIFEs: true }],
    complexity: ['error', { max: 15 }],
    'max-depth': ['error', 4],
    'max-params': ['error', 5],
    'max-statements': ['error', 25],
    'max-nested-callbacks': ['error', 4],
};

// One target for API calls, named the same way by this config and by the
// count ratchets (scripts/count-ratchet.mjs): api/typedRequest.ts.
const RAW_FETCH_MESSAGE = 'Call the API through api/typedRequest.ts (apiJson, apiRequest, apiFetch) or a React Query hook built on it instead of raw fetch().';

// typescript-eslint's no-unused-vars with every report dropped except an
// import binding (see the block that turns it on). The rule has no option for
// "imports only", and an unused local or parameter is not this gate's business.
const IMPORT_BINDINGS = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier']);
const unusedVars = tseslint.plugin.rules['no-unused-vars'];
const unusedImports = {
    meta: unusedVars.meta,
    create(context) {
        const importsOnly = Object.create(context, {
            report: {
                value(descriptor) {
                    if (IMPORT_BINDINGS.has(descriptor.node?.parent?.type)) context.report(descriptor);
                },
            },
        });
        return unusedVars.create(importsOnly);
    },
};

export default [
    {
        // dist-embed is the Nextcloud embed build (see the Dockerfile's embed
        // stage); like dist, it is build output and never linted. The api types
        // are generated from docs/static/openapi.json (scripts/gen-api-types.mjs).
        ignores: ['dist', 'dist-embed', 'dist-runtime', 'build', 'node_modules', 'coverage', '.vite', 'src/api/apiTypes.generated.ts'],
    },
    {
        // A disable comment that silences nothing is dead weight and hides the
        // day the rule it names stops firing.
        linterOptions: { reportUnusedDisableDirectives: 'error' },
    },
    {
        files: ['**/*.{js,jsx}'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
        },
        plugins: {
            // eslint-plugin-react is registered for exactly one rule
            // (react/jsx-no-undef, below). Its recommended set is deliberately
            // NOT spread in — it would bury the errors we do care about under a
            // few thousand new warnings.
            react,
            'react-hooks': reactHooks,
            'react-refresh': reactRefresh,
            'import': importPlugin,
        },
        settings: {
            'import/resolver': {
                node: { extensions: ['.js', '.jsx', '.ts', '.tsx'] },
            },
        },
        rules: {
            ...js.configs.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            ...sizeComplexityRules,

            // React rules — keep rules-of-hooks strict, demote the new
            // React-Compiler rules to warn for now.
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'error',
            'react-hooks/set-state-in-effect': 'error',
            'react-hooks/immutability': 'error',
            'react-hooks/preserve-manual-memoization': 'error',
            'react-hooks/static-components': 'error',
            'react-hooks/purity': 'error',
            'react-hooks/refs': 'error',
            'react-hooks/error-boundaries': 'error',
            'react-hooks/component-hook-factories': 'error',
            'react-hooks/incompatible-library': 'error',
            'react-hooks/unsupported-syntax': 'error',

            'react-refresh/only-export-components': [
                'error',
                { allowConstantExport: true, allowCompoundComponents: true },
            ],

            // A JSX element name is not a reference as far as core `no-undef`
            // is concerned, so `<Foo />` with no import for Foo lints clean and
            // then throws ReferenceError in the browser — minified to something
            // like "X is not defined", from inside whatever .map() rendered it.
            // That shipped to production once (BFSF-351: a missing lucide `X`
            // import crashed the notebook editor on every table click). Error,
            // not warn: there is no legitimate undefined JSX element.
            'react/jsx-no-undef': 'error',

            // Demote a handful of recommended JS rules to warn so CI is green
            // today. Promote back to 'error' as the codebase is cleaned up.
            //   no-dupe-keys     → 14 instances; these ARE real bugs, fix later.
            //   no-case-declarations → 16 instances, mostly cosmetic.
            //   no-useless-escape → 4 instances, minor.
            //   no-irregular-whitespace → narrow case.
            //   no-shadow-restricted-names → narrow case.
            //   no-constant-binary-expression → narrow case.
            'no-dupe-keys': 'error',
            'no-case-declarations': 'error',
            'no-useless-escape': 'error',
            'no-irregular-whitespace': 'error',
            'no-shadow-restricted-names': 'error',
            'no-constant-binary-expression': 'error',

            // Promoted back to 'error': the check turned up exactly one
            // violation repo-wide and it was a genuine crash (an unimported
            // constant referenced in a since-deleted admin panel). Every hit
            // here is a runtime ReferenceError waiting for the right render
            // path.
            'no-undef': 'error',

            'no-unused-vars': [
                'error',
                { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true },
            ],
            'no-empty': ['error', { allowEmptyCatch: true }],

            // Import ordering.
            // Newly written or refactored files naturally pick up the
            // convention via editor auto-fix. The order keeps node builtins
            // / externals / parent / sibling / index groups separated and
            // alphabetizes within each group.
            'import/order': [
                'error',
                {
                    groups: [
                        'builtin',
                        'external',
                        'internal',
                        ['parent', 'sibling', 'index'],
                    ],
                    pathGroups: [
                        { pattern: '@/**', group: 'internal', position: 'before' },
                    ],
                    'newlines-between': 'ignore',
                    alphabetize: { order: 'asc', caseInsensitive: true },
                },
            ],

            // alert() and confirm() are browser boxes the app cannot style, word
            // or test; the shared toast and useConfirm replaced every one.
            'no-restricted-globals': ['error',
                { name: 'alert', message: 'Use the shared toast (components/shared/Toast) instead of alert().' },
                { name: 'confirm', message: 'Use the shared confirm dialog (components/shared/useConfirm) instead of confirm().' },
            ],

            // Forbid raw fetch(): a call to the API goes through
            // api/typedRequest.ts (or a React Query hook built on it), the
            // one target the ratchets and the authFetch freeze below name
            // too. The existing call sites are in eslint-suppressions.json.
            // A rule has one severity, so this entry lives here rather than
            // beside the alert/confirm errors above.
            'no-restricted-syntax': ['error', {
                selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
                message: RAW_FETCH_MESSAGE,
            }],
        },
    },
    {
        // The window.* spellings of the same two boxes. Tests are exempt: they
        // reference window.confirm to assert it is never called.
        files: ['**/*.{js,jsx}'],
        ignores: ['**/*.test.{js,jsx}', 'src/test/**'],
        rules: {
            'no-restricted-properties': ['error',
                { object: 'window', property: 'alert', message: 'Use the shared toast (components/shared/Toast) instead of window.alert().' },
                { object: 'window', property: 'confirm', message: 'Use the shared confirm dialog (components/shared/useConfirm) instead of window.confirm().' },
            ],
        },
    },
    {
        // TS/TSX were previously unlinted. Apply only the size/complexity budgets
        // here (syntax-only via the TS parser, no type-check) to avoid a rule flood.
        files: ['**/*.{ts,tsx}'],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
            },
            parserOptions: {
                ecmaFeatures: { jsx: true },
            },
        },
        rules: {
            ...sizeComplexityRules,
        },
    },
    {
        // An import nobody reads, in TypeScript, tests included. tsc runs with
        // noUnusedLocals and noUnusedParameters off (some 300 unused locals and
        // parameters still stand) and no-unused-vars is JS-only, so until this
        // block nothing looked at the imports of a .ts/.tsx file. On the day it
        // landed the rule named the same import bindings as
        // `tsc --noUnusedLocals`, one for one.
        //   - A name that starts with `_` is unused on purpose, as tsc reads it.
        //   - jsxPragma null: with the automatic runtime (tsconfig `jsx:
        //     react-jsx`) JSX does not read `React`, so that import is unused.
        //   - No autofix, on purpose: the post-edit hook runs `eslint --fix`
        //     after every edit and would delete an import written one edit
        //     before its first use. `node scripts/ts-remove-unused-imports.mjs
        //     <files>` removes them with TypeScript's own quick fix.
        // What eslint-suppressions.json still holds for this rule, and why:
        //   - files mobile's jest executes (scripts/deep-imports.exclude.json):
        //     clean them together with the mobile suite;
        //   - editor/collab/ySync.ts, an input of the server's generated
        //     editorCollab.cjs: clean it with the next rebuild of that bundle;
        //   - an import that is the last reader of an export (mostly a type in
        //     a `*.types.ts` file). Removing it leaves the export dead and knip
        //     (`npm run lint:dead`) fails: delete the export and the import
        //     together, or use the import.
        files: ['**/*.{ts,tsx}'],
        languageOptions: { parserOptions: { jsxPragma: null } },
        plugins: { 'bee-flow': { rules: { 'no-unused-imports': unusedImports } } },
        rules: {
            'bee-flow/no-unused-imports': ['error', { varsIgnorePattern: '^_' }],
        },
    },
    {
        // The JS block's policy rules, for TS source too: files converted from
        // .jsx kept their alert/confirm errors, raw-fetch and react-hooks
        // warnings only while they were .jsx. Syntax rules that tsc already
        // covers (no-undef, react/jsx-no-undef) and no-unused-vars stay JS-only.
        // Test harnesses call hooks from helper functions and reference
        // window.confirm to assert it is never called, so tests stay out.
        files: ['**/*.{ts,tsx}'],
        ignores: ['**/*.test.{ts,tsx}', 'src/test/**'],
        plugins: { 'react-hooks': reactHooks },
        rules: {
            ...reactHooks.configs.recommended.rules,
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'error',
            'react-hooks/set-state-in-effect': 'error',
            'react-hooks/immutability': 'error',
            'react-hooks/preserve-manual-memoization': 'error',
            'react-hooks/static-components': 'error',
            'react-hooks/purity': 'error',
            'react-hooks/refs': 'error',
            'react-hooks/error-boundaries': 'error',
            'react-hooks/component-hook-factories': 'error',
            'react-hooks/incompatible-library': 'error',
            'react-hooks/unsupported-syntax': 'error',
            'no-restricted-globals': ['error',
                { name: 'alert', message: 'Use the shared toast (components/shared/Toast) instead of alert().' },
                { name: 'confirm', message: 'Use the shared confirm dialog (components/shared/useConfirm) instead of confirm().' },
            ],
            'no-restricted-properties': ['error',
                { object: 'window', property: 'alert', message: 'Use the shared toast (components/shared/Toast) instead of window.alert().' },
                { object: 'window', property: 'confirm', message: 'Use the shared confirm dialog (components/shared/useConfirm) instead of window.confirm().' },
            ],
            'no-restricted-syntax': ['error', {
                selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
                message: RAW_FETCH_MESSAGE,
            }],
        },
    },
    {
        // authFetch is frozen per file. It is the transport under the typed
        // calls, and the files that import it themselves are recorded for
        // this one rule in eslint-suppressions.json: a file that starts
        // importing it fails, inside src/api too (the count ratchet
        // authfetch-outside-api only sees files outside it). The suppression
        // counts the import, so a recorded file can still add calls.
        // The three files the typed calls and apiClient run on are the
        // transport's own layer, not callers of it.
        // scripts/rq-codemod.mjs keeps authFetch inside the queryFn it
        // writes: a hook it adds to a recorded file passes, a NEW hook file
        // from it fails here until its call goes through the typed request.
        files: ['src/**/*.{js,jsx,ts,tsx}'],
        ignores: [
            '**/*.test.{js,jsx,ts,tsx}', 'src/test/**',
            'src/api/mutate.ts', 'src/api/typedRequest.ts', 'src/api/client.ts',
        ],
        rules: {
            'no-restricted-imports': ['error', {
                patterns: [{
                    // utils/helpers defines it, api/mutate re-exports it; any relative spelling.
                    group: ['**/helpers', '**/mutate'],
                    importNames: ['authFetch'],
                    message: 'Call the API through api/typedRequest.ts with an operation key: apiJson for the parsed body, apiRequest for the Response (it throws on a non-2xx), apiFetch where the caller reads res.ok itself, as authFetch did.',
                }],
            }],
        },
    },
    {
        // Accessibility: jsx-a11y's recommended set, every rule an error. The
        // violations that predate it are in eslint-suppressions.json, so a new
        // unlabelled control or a clickable div without a role fails. Test
        // fixtures render throwaway markup to drive a component, not UI a
        // person uses, so tests stay out.
        files: ['**/*.{jsx,tsx}'],
        ignores: ['**/*.test.{jsx,tsx}', 'src/test/**'],
        plugins: { 'jsx-a11y': jsxA11y },
        // The recommended set has every rule it enables at 'error' already.
        rules: { ...jsxA11y.flatConfigs.recommended.rules },
    },
    {
        // A promise nobody awaits, returns or catches loses its rejection. The
        // api layer is where requests start, so the type-aware check runs
        // there, against a program of src/api only (tsconfig.eslint-api.json):
        // the whole-src program is too heavy for every lint run.
        files: ['src/api/**/*.ts'],
        ignores: ['src/api/**/*.test.ts'],
        languageOptions: {
            parserOptions: {
                project: './tsconfig.eslint-api.json',
                tsconfigRootDir: import.meta.dirname,
            },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: { '@typescript-eslint/no-floating-promises': 'error' },
    },
    {
        // Tests are exempt from the size and complexity limits: a describe
        // block is a table of cases and splitting it buys nothing.
        files: ['**/*.test.{js,jsx,ts,tsx}', 'src/test/**'],
        rules: {
            ...Object.fromEntries(Object.keys(sizeComplexityRules).map((rule) => [rule, 'off'])),
            'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
        },
    },
    // NOTE: scoping 'react-hooks/exhaustive-deps' to error inside src/hooks/
    // was attempted, but useChatEngine has intentional dep omissions
    // (documented inline) that the rule flags. Promote per-file once the
    // Phase 5.B7 split of useChatEngine into hooks/chat/ lands and the
    // contract becomes verifiable. Until then, the warn-level rule from the
    // base config keeps new code on the right side.
];
