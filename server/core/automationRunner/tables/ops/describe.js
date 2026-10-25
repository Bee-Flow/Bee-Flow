// @typecheck noImplicitAny
'use strict';
/**
 * describe: what each column holds, so a later step (or a person, or a
 * model) can pick sensible splits without seeing the rows. The rows pass
 * through unchanged. Columns that look like personal data or identifiers
 * never show sample values.
 */

const { parseIsoUtc } = require('../../../dataEngine/sources/spreadsheetFile/cells');
const { requireColumn, toNumber, foldText, isBlankCell } = require('./values');

const DISTINCT_CAP = 10000;
const CELL_BUDGET = 5_000_000;
const SEPARATORS = [';', '|', ','];
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(?:\+|0)[\d\s().-]{7,20}$/;
const SAMPLE_CHARS = 80;
const SHARE = 0.95;

/** @typedef {import('./index').TableOp & ReturnType<typeof import('../../../automationModel/tableOps/normalize').byOp.describe>} DescribeOp */
/** @typedef {{ value: string, count: number }} Counted */
/** @typedef {ReturnType<typeof newAcc>} Acc */
/**
 * @typedef {{ key: string, label: string, kind: string, storageType: string, filled: number, empty: number, distinct: number,
 *   distinctCapped: boolean, options?: Counted[], separator?: string, min?: number|string|null, max?: number|string|null,
 *   mean?: number|null, usableAsSplit?: boolean, looksPersonal?: boolean, sampleValues?: string[] }} ColumnDescription
 */

/**
 * @param {string[]} candidates
 * @param {number} cap
 */
function newAcc(candidates, cap) {
    return {
        filled: 0, empty: 0, cap, capped: false, allUnique: true,
        distinct: /** @type {Map<string, Counted>} */ (new Map()), numeric: 0, allInt: true, min: Infinity, max: -Infinity, sum: 0,
        dates: 0, dateMin: /** @type {string|null} */ (null), dateMax: /** @type {string|null} */ (null), personal: 0, samples: /** @type {string[]} */ ([]),
        sep: Object.fromEntries(candidates.map((c) => [c, { cells: 0, items: /** @type {Map<string, Counted>} */ (new Map()), overflow: false }])),
    };
}

/**
 * @param {Acc} acc
 * @param {unknown} cell
 * @param {number} sampleLimit
 * @param {number} itemCap
 */
function feed(acc, cell, sampleLimit, itemCap) {
    if (isBlankCell(cell)) { acc.empty++; return; }
    acc.filled++;
    const text = String(cell).trim();
    const key = foldText(text);
    const hit = acc.distinct.get(key);
    if (hit) { hit.count++; acc.allUnique = false; } else if (acc.distinct.size < acc.cap) {
        acc.distinct.set(key, { value: text, count: 1 });
        if (acc.samples.length < sampleLimit) acc.samples.push(text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS - 1)}…` : text);
    } else acc.capped = true;

    const x = toNumber(cell);
    if (x !== null) {
        acc.numeric++;
        acc.sum += x;
        if (x < acc.min) acc.min = x;
        if (x > acc.max) acc.max = x;
        if (!Number.isInteger(x)) acc.allInt = false;
    } else if (typeof cell === 'string' && ISO_RE.test(text) && parseIsoUtc(text)) {
        acc.dates++;
        if (acc.dateMin === null || text < acc.dateMin) acc.dateMin = text;
        if (acc.dateMax === null || text > acc.dateMax) acc.dateMax = text;
    }
    if (typeof cell === 'string' && (EMAIL_RE.test(text) || (PHONE_RE.test(text) && text.replace(/\D/g, '').length >= 8))) acc.personal++;
    for (const [sep, s] of Object.entries(acc.sep)) {
        const has = text.includes(sep);
        if (has) s.cells++;
        if (s.overflow) continue;
        for (const item of new Set(has ? text.split(sep).map((p) => p.trim()).filter(Boolean) : [text])) {
            const k = foldText(item);
            const e = s.items.get(k);
            if (e) e.count++; else if (s.items.size < itemCap) s.items.set(k, { value: item, count: 1 }); else { s.overflow = true; break; }
        }
    }
}

const byCount = (/** @type {{ count: number; }} */ a, /** @type {{ count: number; }} */ b) => b.count - a.count;

/**
 * @param {Acc} acc
 * @param {DescribeOp} op
 */
function classify(acc, op) {
    const f = acc.filled;
    if (f === 0) return { kind: 'empty' };
    if (acc.numeric / f >= SHARE) {
        const scale = acc.allInt && !acc.capped && acc.distinct.size <= 11 && acc.min >= 0 && acc.max <= 10;
        return { kind: scale ? 'scale' : 'numeric' };
    }
    if (acc.dates / f >= SHARE) return { kind: 'date' };
    const best = Object.entries(acc.sep).filter(([, s]) => !s.overflow && s.cells / f >= 0.2 && s.items.size <= op.maxOptions)
        .sort((a, b) => b[1].cells - a[1].cells)[0];
    if (best) return { kind: 'multi', separator: best[0] };
    if (!acc.capped && acc.distinct.size <= op.maxOptions && acc.distinct.size / f <= 0.5) return { kind: 'single' };
    if (acc.allUnique && f >= 20) return { kind: 'identifier' };
    return { kind: 'free_text' };
}

/**
 * @param {Acc} acc
 * @param {import('./index').TableColumn} col
 * @param {DescribeOp} op
 */
function finish(acc, col, op) {
    const { kind, separator } = classify(acc, op);
    /** @type {ColumnDescription} */
    const out = { key: col.key, label: col.label ?? col.key, kind, storageType: col.type || 'mixed', filled: acc.filled, empty: acc.empty, distinct: acc.distinct.size, distinctCapped: acc.capped };
    let optionCount = 0;
    if (kind === 'single') {
        out.options = [...acc.distinct.values()].sort(byCount).slice(0, op.maxOptions).map((o) => ({ value: o.value, count: o.count }));
        optionCount = acc.distinct.size;
    } else if (kind === 'scale') {
        out.options = [...acc.distinct.values()].sort((a, b) => toNumber(a.value) - toNumber(b.value)).map((o) => ({ value: o.value, count: o.count }));
        optionCount = acc.distinct.size;
    } else if (kind === 'multi') {
        const items = [...acc.sep[separator].items.values()];
        out.distinct = items.length;
        out.separator = separator;
        out.options = items.sort(byCount).slice(0, op.maxOptions).map((o) => ({ value: o.value, count: o.count }));
        optionCount = items.length;
    }
    if (kind === 'numeric' || kind === 'scale') { out.min = acc.min; out.max = acc.max; out.mean = acc.numeric ? acc.sum / acc.numeric : null; }
    if (kind === 'date') { out.min = acc.dateMin; out.max = acc.dateMax; }
    out.usableAsSplit = ['single', 'multi', 'scale'].includes(kind) && optionCount >= 2 && optionCount <= op.maxOptions;
    out.looksPersonal = kind === 'identifier' || (acc.filled > 0 && acc.personal / acc.filled >= 0.2);
    out.sampleValues = out.looksPersonal || kind === 'identifier' || kind === 'empty' ? [] : acc.samples.slice(0, op.sampleValues);
    return out;
}

/**
 * @param {DescribeOp} op
 * @param {import('./index').OpInput} input
 * @param {import('./index').OpCtx} ctx
 */
async function apply(op, input, ctx) {
    const cols = op.columns
        ? op.columns.map((name, i) => requireColumn(input.columns, name, { opId: op.id, field: `columns[${i}]` }))
        : input.columns;
    const candidates = op.separator ? [op.separator] : SEPARATORS;
    const cap = Math.max(100, Math.min(DISTINCT_CAP, Math.floor(CELL_BUDGET / Math.max(1, cols.length))));
    const itemCap = Math.min(op.maxOptions + 1, cap);
    const accs = cols.map(() => newAcc(candidates, cap));
    let rowCount = 0;
    for await (const row of input.rows()) {
        await ctx.tick();
        rowCount++;
        for (let i = 0; i < cols.length; i++) feed(accs[i], row[cols[i].key], op.sampleValues, itemCap);
    }
    const description = { rowCount, provenance: input.provenance || null, columns: cols.map((c, i) => finish(accs[i], c, op)) };
    return { columns: input.columns, rows: input.rows, description };
}

module.exports = { apply };
