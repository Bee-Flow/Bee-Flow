'use strict';

/**
 * Shared flag parsing for the ops scripts in server/scripts (the ones an
 * operator runs by hand against a live database).
 *
 * Fail-closed on purpose:
 *   - `--apply` is the only way to mutate; without it a script is a dry run.
 *   - parsing is node:util parseArgs in strict mode, so a typo (`--aply`,
 *     `--apply=yes`, `--orgs` with no value, `--orgs --apply`) stops the
 *     script before it touches anything, instead of silently running as a dry
 *     run (harmless but confusing) or treating the next flag as a value.
 *
 * Each script keeps its own flag names and output; this module only replaces
 * the hand-rolled `process.argv.includes(...)` / `indexOf(...)` lookups.
 */

const { parseArgs } = require('node:util');

const APPLY_OPTION = { apply: { type: 'boolean', default: false } };

/**
 * Parse argv strictly. Throws on an unknown flag, a missing value or a stray
 * positional. `apply` is always present and is true only when `--apply` was
 * passed.
 *
 * @param {Record<string, {type: 'string'|'boolean', default?: any, short?: string}>} [options]
 * @param {{ argv?: string[], positionals?: boolean }} [opts]
 * @returns {Record<string, any> & { apply: boolean, _positionals: string[] }}
 */
function parseOpsArgs(options = {}, { argv = process.argv.slice(2), positionals = false } = {}) {
    const { values, positionals: rest } = parseArgs({
        args: argv,
        options: { ...APPLY_OPTION, ...options },
        strict: true,
        allowPositionals: positionals,
    });
    return { ...values, apply: values.apply === true, _positionals: rest };
}

/**
 * parseOpsArgs for a script's top level: on a parse error print the reason
 * (and the usage line, when given) to stderr and exit 1 before anything runs.
 */
function parseOpsArgsOrExit(options, { usage, ...opts } = {}) {
    try {
        return parseOpsArgs(options, opts);
    } catch (err) {
        console.error(`${err.message}. Nothing was changed.`);
        if (usage) console.error(usage);
        process.exit(1);
    }
}

module.exports = { parseOpsArgs, parseOpsArgsOrExit };
