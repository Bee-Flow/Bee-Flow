// The size limits from ARCHITECTURE.md and the budget of files allowed over
// them (quality-budget.json), in one place: eslint.config.js turns them into
// rules, and src/meta/qualityBudget.test.ts measures the budget against the
// same numbers, so the two cannot disagree about what "over the limit" means.
/* global __dirname */
const path = require('path');

const budget = require('./quality-budget.json');

const MOBILE = __dirname;

/** Code lines: blank lines and comments do not count. */
const LINE_RULES = new Set(['max-lines', 'max-lines-per-function']);

/** Every rule the budget may relax, with its default for one file. */
function limitsFor(file) {
    const rel = path.relative(MOBILE, path.resolve(MOBILE, file)).replace(/\\/g, '/');
    const inApp = rel.startsWith('app/');
    return {
        complexity: 15,
        'max-depth': 4,
        'max-params': 4,
        // Components get more room than plain functions: JSX is tall.
        'max-lines-per-function': rel.endsWith('.tsx') ? 120 : 80,
        'max-lines': rel === 'app/_layout.tsx' ? 150 : inApp ? 60 : 300,
    };
}

/** The ESLint rule entry for one limit. */
function ruleEntry(rule, max) {
    return LINE_RULES.has(rule) ? ['error', { max, skipBlankLines: true, skipComments: true }] : ['error', max];
}

module.exports = { budget, limitsFor, ruleEntry, RULES: Object.keys(limitsFor('src/x.ts')) };
