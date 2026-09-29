/**
 * FORM ANSWERS — the dashboard's numbers, and the generic aggregate.
 *
 * Every figure comes out of queryCompiler.compileAggregate /
 * compileRecordList under the CALLER's access filter — the same predicate
 * their row list runs under — so a reader never counts a row they could not
 * open. The router only delegates: it never spells SELECT (routes/
 * datatables.test.js pins that), and neither does this module.
 *
 * ── THE SHAPE, ONE CALL ─────────────────────────────────────────────
 * The Form page draws the whole dashboard from one answer: totals, a
 * timeline, one breakdown per question in form order (retired last), the
 * recent responses. That is a handful of queries — totals, timeline, then
 * per question by type — batched where the compiler allows (16 aggregates a
 * query), never cached: a submission that landed a second ago must count.
 *
 * Multiselect does not exist on forms, numbers get no histogram (the
 * compiler cannot bucket numbers), and text questions show their most recent
 * answers rather than a chart — a sentence is not a bar.
 */

'use strict';

const queryCompiler = require('../../core/dataEngine/queryCompiler');
const datatableDbStore = require('../../stores/datatableDbStore');
const dataModel = require('../../core/dataEngine/dataModel/vocabulary');
const { orderedColumns } = require('./derive');
const { MAX_AGGREGATES, CompileError } = queryCompiler;

const PG = { dialect: 'pg' };
const DAY_MS = 86400000;
const RECENT = 10;
const TEXT_PREVIEW = 200;
const AGG_BATCH = Number(MAX_AGGREGATES) || 16;

// ── the range ───────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `from`/`to` are calendar days (YYYY-MM-DD, inclusive), default the last
 * 30 days. The bucket follows the span: days up to two months, weeks up to
 * a year, months beyond.
 */
function resolveRange({ from = null, to = null } = {}, now = new Date()) {
    const end = DATE_RE.test(to || '') ? new Date(`${to}T00:00:00.000Z`) : startOfUtcDay(now);
    const start = DATE_RE.test(from || '') ? new Date(`${from}T00:00:00.000Z`) : new Date(end.getTime() - 29 * DAY_MS);
    if (!(start.getTime() <= end.getTime())) {
        const e = new Error('The period ends before it starts'); e.status = 400; e.code = 'bad_range'; throw e;
    }
    const days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
    const bucket = days <= 62 ? 'day' : (days <= 366 ? 'week' : 'month');
    return {
        from: isoDay(start), to: isoDay(end), bucket,
        fromIso: start.toISOString(),
        toIso: new Date(end.getTime() + DAY_MS - 1).toISOString(),
    };
}

function startOfUtcDay(d) { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); }
function isoDay(d) { return d.toISOString().slice(0, 10); }

function rangeFilters(range) {
    return [{ field: 'created_at', op: 'between', value: [range.fromIso, range.toIso] }];
}

// ── the questions ───────────────────────────────────────────────────────

/** The form's questions in form order, retired last, as the dashboard lists them. */
function questionColumns(source, meta) {
    const byKey = new Map((meta.fields || []).map(f => [f.key, f]));
    return orderedColumns(source?.columnMap).filter(c => byKey.has(c.key));
}

// ── the summary ─────────────────────────────────────────────────────────

/**
 * @param {object} args
 * @param {object} args.table       the datatables row (rowToDatatable shape)
 * @param {object} args.meta        the table descriptor WITH `access` (metaFor)
 * @param {object} args.filter      the caller's compiled access filter
 * @param {string} args.scopeKey
 * @param {{from?, to?}} args.range
 * @param {(ids: string[]) => Promise<Array<{id, username, displayName}>>} [args.lookupUsers]
 * @param {Date} [args.now]
 */
async function answersSummary({ table, meta, filter, scopeKey, range: rawRange = {}, lookupUsers = null, now = new Date() }) {
    const range = resolveRange(rawRange, now);
    // the engine answers `{ rows }`
    const q = async (sql, params) => (await datatableDbStore.query(scopeKey, scopeKey, sql, params))?.rows || [];
    const agg = async (opts) => {
        const { sql, params } = queryCompiler.compileAggregate(meta, { ...opts, ...PG }, filter);
        return q(sql, params);
    };
    const questions = questionColumns(table.source, meta);

    // ── totals: four counts and the last submission ────────────────────
    const [allRows] = await agg({ aggregates: [{ fn: 'count', field: '*', as: 'n' }, { fn: 'max', field: 'created_at', as: 'last_at' }] });
    const [inRangeRow] = await agg({ filters: rangeFilters(range), aggregates: [{ fn: 'count', field: '*', as: 'n' }, { fn: 'count', field: 'completed_at', as: 'completed' }] });
    const sevenDays = { fromIso: new Date(now.getTime() - 7 * DAY_MS).toISOString(), toIso: now.toISOString() };
    const today = { fromIso: startOfUtcDay(now).toISOString(), toIso: now.toISOString() };
    const [lastSevenRow] = await agg({ filters: rangeFilters(sevenDays), aggregates: [{ fn: 'count', field: '*', as: 'n' }] });
    const [todayRow] = await agg({ filters: rangeFilters(today), aggregates: [{ fn: 'count', field: '*', as: 'n' }] });
    const inRange = num(inRangeRow?.n);
    const completed = num(inRangeRow?.completed);
    const totals = {
        all: num(allRows?.n),
        inRange,
        last7d: num(lastSevenRow?.n),
        today: num(todayRow?.n),
        completed,
        open: Math.max(0, inRange - completed),
        lastAt: allRows?.last_at ? new Date(allRows.last_at).toISOString() : null,
    };

    // ── timeline ───────────────────────────────────────────────────────
    const timelineRows = await agg({
        filters: rangeFilters(range),
        groupBy: [{ field: 'created_at', bucket: range.bucket, as: 'bucket' }],
        aggregates: [{ fn: 'count', field: '*', as: 'n' }],
        sort: [{ field: 'bucket', dir: 'asc' }],
        limit: 1000,
    });
    const timeline = timelineRows.map(r => ({ bucket: String(r.bucket), n: num(r.n) }));

    // ── answered / skipped, batched ────────────────────────────────────
    const answered = new Map();
    for (let i = 0; i < questions.length; i += AGG_BATCH) {
        const batch = questions.slice(i, i + AGG_BATCH);
        const [row] = await agg({
            filters: rangeFilters(range),
            aggregates: batch.map((c, j) => ({ fn: 'count', field: c.key, as: `a${j}` })),
        });
        batch.forEach((c, j) => answered.set(c.key, num(row?.[`a${j}`])));
    }

    // ── one breakdown per question ─────────────────────────────────────
    const out = [];
    const numberBatch = [];
    for (const c of questions) {
        const base = {
            fieldId: c.fieldId, key: c.key, label: c.name, formType: c.formType, columnType: c.columnType,
            pageStepId: c.pageStepId || null, retired: !!c.retired,
            answered: answered.get(c.key) || 0,
            skipped: Math.max(0, inRange - (answered.get(c.key) || 0)),
            breakdown: null,
        };
        out.push(base);
        if (c.columnType === 'select') {
            const rows = await agg({
                filters: [...rangeFilters(range), { field: c.key, op: 'isNotNull' }],
                groupBy: [{ field: c.key, as: 'v' }],
                aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                sort: [{ field: 'n', dir: 'desc' }],
                limit: dataModel.DATA_LIMITS.MAX_SELECT_OPTIONS,
            });
            const total = rows.reduce((s, r) => s + num(r.n), 0) || 1;
            base.breakdown = { kind: 'choice', values: rows.map(r => ({ value: String(r.v), n: num(r.n), pct: Math.round((num(r.n) / total) * 1000) / 10 })) };
        } else if (c.columnType === 'bool') {
            const rows = await agg({
                filters: rangeFilters(range),
                groupBy: [{ field: c.key, as: 'v' }],
                aggregates: [{ fn: 'count', field: '*', as: 'n' }],
            });
            const yes = rows.filter(r => r.v === true || r.v === 'true' || r.v === 1).reduce((s, r) => s + num(r.n), 0);
            const no = rows.filter(r => r.v === false || r.v === 'false' || r.v === 0).reduce((s, r) => s + num(r.n), 0);
            base.breakdown = { kind: 'yesno', yes, no };
        } else if (c.columnType === 'number') {
            numberBatch.push(base);
        } else if (c.columnType === 'date') {
            const rows = await agg({
                filters: [...rangeFilters(range), { field: c.key, op: 'isNotNull' }],
                groupBy: [{ field: c.key, bucket: 'month', as: 'bucket' }],
                aggregates: [{ fn: 'count', field: '*', as: 'n' }],
                sort: [{ field: 'bucket', dir: 'asc' }],
                limit: 240,
            });
            base.breakdown = { kind: 'date', buckets: rows.map(r => ({ bucket: String(r.bucket), n: num(r.n) })) };
        } else if (c.columnType === 'file') {
            base.breakdown = { kind: 'file', count: base.answered };
        } else {
            const { sql, params } = queryCompiler.compileRecordList(meta, {
                filters: [...rangeFilters(range), { field: c.key, op: 'isNotNull' }],
                sort: [{ field: 'created_at', dir: 'desc' }],
                limit: RECENT,
                ...PG,
            }, filter);
            const rows = (await q(sql, params)).slice(0, RECENT);
            base.breakdown = {
                kind: 'text',
                recent: rows.map(r => ({ rowId: r.id, value: String(r[c.key] ?? '').slice(0, TEXT_PREVIEW), at: isoOf(r.created_at) })),
            };
        }
    }
    // numbers: four aggregates each, batched under the compiler's cap
    const perQuery = Math.max(1, Math.floor(AGG_BATCH / 4));
    for (let i = 0; i < numberBatch.length; i += perQuery) {
        const batch = numberBatch.slice(i, i + perQuery);
        const [row] = await agg({
            filters: rangeFilters(range),
            aggregates: batch.flatMap((b, j) => [
                { fn: 'avg', field: b.key, as: `avg${j}` }, { fn: 'min', field: b.key, as: `min${j}` },
                { fn: 'max', field: b.key, as: `max${j}` }, { fn: 'p50', field: b.key, as: `p50${j}` },
            ]),
        });
        batch.forEach((b, j) => {
            b.breakdown = { kind: 'number', avg: fnum(row?.[`avg${j}`]), min: fnum(row?.[`min${j}`]), max: fnum(row?.[`max${j}`]), p50: fnum(row?.[`p50${j}`]) };
        });
    }

    // ── recent responses ───────────────────────────────────────────────
    const { sql: rsql, params: rparams } = queryCompiler.compileRecordList(meta, {
        filters: rangeFilters(range), sort: [{ field: 'created_at', dir: 'desc' }], limit: RECENT, ...PG,
    }, filter);
    const recentRows = (await q(rsql, rparams)).slice(0, RECENT);
    const names = new Map();
    if (typeof lookupUsers === 'function') {
        const ids = [...new Set(recentRows.map(r => r.created_by).filter(Boolean))];
        if (ids.length) {
            for (const u of (await lookupUsers(ids)) || []) names.set(u.id, u.displayName || u.username || null);
        }
    }
    const previewKeys = questions.filter(c => !c.retired).slice(0, 3).map(c => c.key);
    const recent = recentRows.map(r => ({
        rowId: r.id,
        submittedAt: isoOf(r.created_at),
        completedAt: r.completed_at ? isoOf(r.completed_at) : null,
        runId: r.run_id || null,
        by: r.created_by ? { id: r.created_by, name: names.get(r.created_by) || null } : null,
        preview: Object.fromEntries(previewKeys.map(k => [k, previewValue(r[k])])),
    }));

    return {
        table: { id: table.id, name: table.name, rowCount: table.rowCount ?? null, retentionDays: table.retentionDays ?? null },
        range: { from: range.from, to: range.to, bucket: range.bucket },
        totals,
        timeline,
        questions: out,
        recent,
    };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function fnum(v) { if (v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function isoOf(v) { try { return v ? new Date(v).toISOString() : null; } catch { return null; } }
function previewValue(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
    return String(v).slice(0, 80);
}

// ── the generic aggregate ───────────────────────────────────────────────

const MAX_GROUP_BY = 8;

/**
 * A caller's aggregate descriptor, checked against the table's own columns
 * and the compiler's vocabulary — the aggregate twin of the rows route's
 * readFilters. `readFilters` is the route's (it owns `bad()`); this returns
 * the descriptor or throws a 400-shaped error.
 */
function readAggregateDescriptor(meta, body, { readFilters }) {
    const src = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const keys = new Set(dataModel.SYSTEM_COLUMNS);
    for (const f of (meta.fields || [])) if (f && f.key) keys.add(f.key);
    const fail = (message, code) => { const e = new Error(message); e.status = 400; e.code = code; throw e; };

    const groupBy = Array.isArray(src.groupBy) ? src.groupBy : [];
    const aggregates = Array.isArray(src.aggregates) ? src.aggregates : [];
    if (!groupBy.length && !aggregates.length) fail('Send at least one groupBy or aggregate', 'bad_descriptor');
    if (groupBy.length > MAX_GROUP_BY) fail(`At most ${MAX_GROUP_BY} groupBy fields`, 'too_many_groups');
    if (aggregates.length > AGG_BATCH) fail(`At most ${AGG_BATCH} aggregates`, 'too_many_aggregates');
    for (const g of groupBy) {
        if (!g || typeof g !== 'object' || !keys.has(g.field)) fail(`"${g && g.field}" is not a column of this table`, 'unknown_filter_field');
        if (g.bucket !== undefined && !dataModel.DATE_BUCKETS.includes(g.bucket)) fail(`"${g.bucket}" is not a date bucket`, 'unknown_bucket');
    }
    for (const a of aggregates) {
        if (!a || typeof a !== 'object' || !dataModel.AGG_FNS.includes(a.fn)) fail(`"${a && a.fn}" is not an aggregate`, 'unknown_agg_fn');
        if (a.field !== undefined && a.field !== '*' && !keys.has(a.field)) fail(`"${a.field}" is not a column of this table`, 'unknown_filter_field');
    }
    const filters = readFilters(meta, src.filters);
    const match = src.match === 'any' ? 'any' : 'all';
    const sort = Array.isArray(src.sort) ? src.sort.slice(0, 1).map(s => ({ field: String(s?.field || ''), dir: s?.dir === 'asc' ? 'asc' : 'desc' })) : [];
    const limit = Number.isFinite(Number(src.limit)) ? Number(src.limit) : undefined;
    return { filters, match, groupBy: groupBy.map(g => ({ field: g.field, ...(g.bucket ? { bucket: g.bucket } : {}), ...(g.as ? { as: String(g.as) } : {}) })),
        aggregates: aggregates.map(a => ({ fn: a.fn, field: a.field === undefined ? '*' : a.field, ...(a.as ? { as: String(a.as) } : {}) })), sort, limit };
}

/** Run one aggregate descriptor under the caller's filter. */
async function runAggregate({ meta, filter, scopeKey, descriptor }) {
    let compiled;
    try {
        compiled = queryCompiler.compileAggregate(meta, { ...descriptor, ...PG }, filter);
    } catch (e) {
        if (e instanceof CompileError) { const err = new Error(e.message); err.status = 400; err.code = 'bad_descriptor'; throw err; }
        throw e;
    }
    const out = await datatableDbStore.query(scopeKey, scopeKey, compiled.sql, compiled.params);
    return { rows: (out && out.rows) || [] };
}

module.exports = { answersSummary, resolveRange, questionColumns, readAggregateDescriptor, runAggregate };
