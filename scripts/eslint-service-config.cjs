// The ESLint flat config shared by the small Node services:
// nextcloud-connector, hub-module-sdk, install-wizard and nc-login-mini.
// Each package's eslint.config.js calls serviceConfig() with its own
// `globals` (the root has no node_modules of its own to resolve it from).
//
// A correctness floor, not a style guide — server/eslint.config.js's rules
// minus `no-console`: in these services the console IS the log. Errors are
// defects; unused bindings warn and are counted under <pkg>/.eslint-budget.json
// (scripts/eslint-budget.mjs). Prefix an intentionally unused one with `_`.

const correctnessRules = {
    'no-undef': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-unreachable': 'error',
    'no-const-assign': 'error',
    'valid-typeof': 'error',
    'use-isnan': 'error',
    'no-self-assign': 'error',
    // A 5xx never echoes err.message: it is an internal (pg, Stripe, fs).
    // Where a message is written for the person who triggered the request,
    // say so next to an eslint-disable line.
    'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.property.name='json'][callee.object.callee.property.name='status'][callee.object.arguments.0.value>=500] > ObjectExpression > Property[key.name='error'] > MemberExpression[property.name='message']",
        message: 'A 5xx must not echo err.message; answer with an error code.',
    }],
    'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
        caughtErrors: 'none',
    }],
};

/**
 * @param {object} globals   the package's `globals` module
 * @param {object} [opts]
 * @param {'commonjs'|'module'} [opts.js]  how plain .js files load (package.json "type")
 * @param {string[]} [opts.ignores]        extra ignore globs
 * @param {object[]} [opts.extra]          extra flat-config entries, appended last
 */
function serviceConfig(globals, { js = 'commonjs', ignores = [], extra = [] } = {}) {
    const node = (sourceType) => ({
        ecmaVersion: 'latest',
        sourceType,
        globals: { ...globals.node },
    });
    return [
        { ignores: ['**/node_modules/**', 'coverage/**', ...ignores] },
        { files: ['**/*.js'], languageOptions: node(js), rules: correctnessRules },
        { files: ['**/*.cjs'], languageOptions: node('commonjs'), rules: correctnessRules },
        { files: ['**/*.mjs'], languageOptions: node('module'), rules: correctnessRules },
        ...extra,
    ];
}

module.exports = { serviceConfig, correctnessRules };
