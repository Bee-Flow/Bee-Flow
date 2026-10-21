'use strict';
/**
 * sample: the first rows, or a random but repeatable pick. The generator is
 * seeded from sha256(seed), so a preview and a run of the same input agree.
 */

const crypto = require('node:crypto');
const { tableError } = require('./values');

/** mulberry32 over the first 32 bits of sha256(seed). */
function createPrng(seed) {
    let a = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0);
    return function next() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function apply(op, input, ctx) {
    const hasN = op.n !== null;
    const hasP = op.percent !== null;
    if (hasN === hasP) throw tableError('table_op_invalid', 'Give either a number of rows or a percentage to sample, not both and not neither.', { opId: op.id, field: hasN ? 'percent' : 'n' });

    async function* rows() {
        if (op.mode === 'first') {
            let limit = op.n;
            if (hasP) {
                let total = 0;
                for await (const r of input.rows()) { void r; total++; await ctx.tick(); }
                limit = Math.ceil((total * op.percent) / 100);
            }
            if (limit <= 0) return;
            let seen = 0;
            for await (const row of input.rows()) {
                await ctx.tick();
                yield row;
                if (++seen >= limit) return;
            }
            return;
        }
        const rand = createPrng(op.seed);
        if (hasP) {
            const share = op.percent / 100;
            for await (const row of input.rows()) {
                await ctx.tick();
                if (rand() < share) yield row;
            }
            return;
        }
        // Reservoir (algorithm R); the picked rows come out in their original order.
        const reservoir = [];
        let i = 0;
        for await (const row of input.rows()) {
            await ctx.tick();
            if (reservoir.length < op.n) reservoir.push({ i, row });
            else {
                const j = Math.floor(rand() * (i + 1));
                if (j < op.n) reservoir[j] = { i, row };
            }
            i++;
        }
        reservoir.sort((a, b) => a.i - b.i);
        for (const item of reservoir) yield item.row;
    }
    return { columns: input.columns, rows };
}

module.exports = { apply, createPrng };
