// @typecheck strict
'use strict';
/** select: keep, drop and rename columns. Lazy. */

const { tableError, requireColumn, uniqueKey } = require('./values');

/**
 * @param {import('./index').TableOp & ReturnType<typeof import('../../../automationModel/tableOps/normalize').byOp.select>} op
 * @param {import('./index').OpInput} input
 * @param {import('./index').OpCtx} ctx
 */
function apply(op, input, ctx) {
    /**
     * @param {string} field
     */
    const where = (field) => ({ opId: op.id, field });
    if (op.keep && op.drop) throw tableError('table_op_invalid', 'Choose either the columns to keep or the columns to drop, not both.', where('keep'));
    let picked = input.columns;
    if (op.keep) {
        const seen = new Set();
        picked = [];
        op.keep.forEach((name, i) => {
            const col = requireColumn(input.columns, name, where(`keep[${i}]`));
            if (!seen.has(col.key)) { seen.add(col.key); picked.push(col); }
        });
    } else if (op.drop) {
        const gone = new Set(op.drop.map((name, i) => requireColumn(input.columns, name, where(`drop[${i}]`)).key));
        picked = input.columns.filter((c) => !gone.has(c.key));
    }
    const renames = new Map();
    op.rename.forEach((r, i) => {
        const col = requireColumn(picked, r.from, where(`rename[${i}].from`));
        if (!r.to) throw tableError('table_op_invalid', `Give the column "${col.key}" a new name.`, where(`rename[${i}].to`));
        renames.set(col.key, r.to);
    });
    const taken = new Set(picked.filter((c) => !renames.has(c.key)).map((c) => c.key));
    const mapping = picked.map((c) => {
        const to = renames.has(c.key) ? uniqueKey(renames.get(c.key), taken) : c.key;
        taken.add(to);
        return { from: c.key, to, column: { ...c, key: to, label: renames.has(c.key) ? to : c.label } };
    });
    async function* rows() {
        for await (const row of input.rows()) {
            await ctx.tick();
            /** @type {Record<string, unknown>} */
            const out = {};
            for (const m of mapping) out[m.to] = row[m.from] === undefined ? null : row[m.from];
            yield out;
        }
    }
    return { columns: mapping.map((m) => m.column), rows };
}

module.exports = { apply };
