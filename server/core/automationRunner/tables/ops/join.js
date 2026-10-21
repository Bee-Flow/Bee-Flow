'use strict';
/**
 * join: add the columns of another table to each row, matched on one to
 * three key columns. The left side streams; the right side is read into a
 * map (capped), keeping only the columns that will be used.
 */

const { tableError, requireColumn, uniqueKey, iterate, isBlankCell } = require('./values');

function keyMaker(cols, op) {
    return (row) => {
        const parts = [];
        for (const c of cols) {
            const v = row[c.key];
            if (isBlankCell(v)) return null;
            let t = String(v);
            if (op.trim) t = t.trim();
            if (op.caseInsensitive) t = t.toLowerCase();
            parts.push(t);
        }
        return parts.join('\u001f');
    };
}

async function buildIndex(op, right, projectKeys, rightKeyOf, ctx) {
    const index = new Map();
    const cap = ctx.limits.joinMaxRightRows;
    let count = 0;
    for await (const row of iterate(right.rows)) {
        await ctx.tick();
        if (cap > 0 && ++count > cap) {
            throw tableError('table_join_too_large', `The table to join with has more than ${cap} rows. Filter it first, or raise AUTOMATION_TABLE_JOIN_MAX_RIGHT_ROWS.`, { opId: op.id, field: 'with' });
        }
        const key = rightKeyOf(row);
        if (key === null) continue;
        const projected = projectKeys.map((k) => (row[k] === undefined ? null : row[k]));
        const existing = index.get(key);
        if (!existing) index.set(key, [projected]);
        else if (op.onDuplicate === 'all') existing.push(projected);
    }
    return index;
}

async function apply(op, input, ctx) {
    const where = (field) => ({ opId: op.id, field });
    if (!op.on.length || op.on.length > 3) throw tableError('table_op_invalid', 'Link the tables on one to three columns.', where('on'));
    if (op.with === null || op.with === undefined) throw tableError('table_op_invalid', 'Pick the table to join with.', where('with'));
    const right = await ctx.resolveTable(op.with, op.id);
    if (!right || !Array.isArray(right.columns)) throw tableError('table_op_invalid', 'The table to join with could not be found.', where('with'));

    const leftKeys = op.on.map((k, j) => requireColumn(input.columns, k.left, { ...where(`on[${j}].left`), alternatives: k.alternatives }));
    const rightKeys = op.on.map((k, j) => requireColumn(right.columns, k.right, { ...where(`on[${j}].right`), alternatives: k.alternatives }));
    const skip = new Set(rightKeys.map((c) => c.key));
    const picked = op.columns
        ? op.columns.map((name, i) => requireColumn(right.columns, name, where(`columns[${i}]`)))
        : right.columns.filter((c) => !skip.has(c.key));
    const taken = new Set(input.columns.map((c) => c.key));
    const added = picked.map((c) => {
        const key = uniqueKey(`${op.prefix}${c.key}`, taken);
        taken.add(key);
        return { ...c, key, label: key };
    });
    const columns = [...input.columns, ...added];
    const leftKeyOf = keyMaker(leftKeys, op);
    const rightKeyOf = keyMaker(rightKeys, op);
    const pickedKeys = picked.map((c) => c.key);

    let indexPromise = null;
    async function* rows() {
        indexPromise = indexPromise || buildIndex(op, right, pickedKeys, rightKeyOf, ctx);
        const index = await indexPromise;
        let unmatched = 0;
        for await (const row of input.rows()) {
            await ctx.tick();
            const key = leftKeyOf(row);
            const hits = key === null ? undefined : index.get(key);
            if (!hits) {
                unmatched++;
                if (op.how === 'inner') continue;
                const out = { ...row };
                for (const c of added) out[c.key] = null;
                yield out;
                continue;
            }
            for (const values of hits) {
                const out = { ...row };
                added.forEach((c, i) => { out[c.key] = values[i]; });
                yield out;
            }
        }
        ctx.stat.unmatched = unmatched;
        if (unmatched) ctx.warn(`${unmatched} row${unmatched === 1 ? ' has' : 's have'} no match in the other table${op.how === 'inner' ? ' and ' + (unmatched === 1 ? 'was' : 'were') + ' left out' : ''}.`, 'join_unmatched');
    }
    return { columns, rows };
}

module.exports = { apply };
