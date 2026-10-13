// Shared ESLint building blocks for the Node packages (server/ and the small
// services that use scripts/eslint-service-config.cjs). Only plain rule
// objects and ignore globs live here, never plugins: a plugin has to resolve
// from the package that registers it, and the repository root has no
// node_modules of its own.
//
// Each package keeps its own severities, messages and extras on top of this;
// what is shared is the set that is identical everywhere.

/** Hard errors in every Node package: an undefined identifier is a
 *  ReferenceError waiting for its branch, the others are plain defects. */
const hardErrorRules = {
    'no-undef': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-unreachable': 'error',
    'no-const-assign': 'error',
    'valid-typeof': 'error',
    'use-isnan': 'error',
    'no-self-assign': 'error',
};

/** Ignore globs for the small services: dependencies and coverage output. */
const serviceIgnores = ['**/node_modules/**', 'coverage/**'];

module.exports = { hardErrorRules, serviceIgnores };
