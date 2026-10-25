// @typecheck noImplicitAny
'use strict';
/**
 * pseudonymise: replace identifying columns by a code. The code is the
 * sha256 of a secret (a Solution variable) and the normalised values, so the
 * same person gets the same code in every run and in every table made with
 * the same secret, but nobody can work back from the code.
 */

const crypto = require('node:crypto');
const { PREVIEW_SALT, MIN_SALT_CHARS, SALT_VAR_RE } = require('../../../automationModel/tableOps/constants');
const { tableError, requireColumn, makeColumn } = require('./values');

/** @typedef {import('./index').TableOp & ReturnType<typeof import('../../../automationModel/tableOps/normalize').byOp.pseudonymise>} PseudonymiseOp */

/** @param {unknown} v */
const normalise = (v) => String(v ?? '').normalize('NFKC').trim().toLowerCase();

/**
 * The code for one set of values; null when every value is blank. Exported for tests.
 * @param {string} salt
 * @param {unknown[]} values
 * @param {number} length
 */
function pseudonymFor(salt, values, length) {
    const parts = values.map(normalise);
    if (parts.every((/** @type {string} */ p) => p === '')) return null;
    return crypto.createHash('sha256').update(`${salt}\u0000${parts.join('\u001f')}`).digest('hex').slice(0, length);
}

/**
 * @param {PseudonymiseOp} op
 * @param {import('./index').OpCtx} ctx
 */
function saltFor(op, ctx) {
    if (ctx.mode === 'preview') {
        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- PREVIEW_SALT is a fixed public placeholder for the preview, deliberately not a secret (the warning above says so)
        ctx.warn('The preview uses a fixed secret, so the codes differ from the codes a run makes.', 'preview_salt');
        return PREVIEW_SALT;
    }
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- SALT_VAR_RE is anchored with a bounded class {0,63}: linear
    const salt = SALT_VAR_RE.test(op.saltVar) ? /** @type {Record<string, unknown>|undefined} */ (ctx.runState?.vars)?.[op.saltVar] : undefined;
    if (typeof salt !== 'string' || salt.length < MIN_SALT_CHARS) {
        throw tableError('table_salt_missing',
            `The variable "${op.saltVar || '(none chosen)'}" is missing or shorter than ${MIN_SALT_CHARS} characters. `
            + 'Add a Solution variable with that name and a long random value.',
            { opId: op.id, field: 'saltVar' });
    }
    return salt;
}

/**
 * @param {PseudonymiseOp} op
 * @param {import('./index').OpInput} input
 * @param {import('./index').OpCtx} ctx
 */
function apply(op, input, ctx) {
    if (!op.columns.length) throw tableError('table_op_invalid', 'Pick the columns that identify a person.', { opId: op.id, field: 'columns' });
    const sources = op.columns.map((name, i) => requireColumn(input.columns, name, { opId: op.id, field: `columns[${i}]` }));
    const extra = op.dropColumns.map((name, i) => requireColumn(input.columns, name, { opId: op.id, field: `dropColumns[${i}]` }));
    const salt = saltFor(op, ctx);
    const gone = new Set([...(op.keepColumns ? [] : sources), ...extra].map((c) => c.key));
    gone.delete(op.output);
    const kept = input.columns.filter((c) => !gone.has(c.key));
    const at = kept.findIndex((c) => c.key === op.output);
    const columns = at >= 0 ? kept.map((c, i) => (i === at ? makeColumn(op.output, 'text') : c)) : [...kept, makeColumn(op.output, 'text')];
    const sourceKeys = sources.map((c) => c.key);

    async function* rows() {
        for await (const row of input.rows()) {
            await ctx.tick();
            /** @type {import('./index').TableRow} */
            const out = {};
            for (const c of kept) out[c.key] = row[c.key] === undefined ? null : row[c.key];
            out[op.output] = pseudonymFor(salt, sourceKeys.map((/** @type {string | number} */ k) => row[k]), op.length);
            yield out;
        }
    }
    return { columns, rows };
}

module.exports = { apply, pseudonymFor };
