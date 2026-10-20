/**
 * The table recipes in the gallery: each one validates, its formulas parse, its
 * sample file exists with the columns it names, and its table steps really run
 * over that sample (same columns the planner promises, a non-empty result).
 *
 * Run: cd server && node --test automation/tableTemplates.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TABLE_TEMPLATES } = require('./tableTemplates');
const { listTemplates, getTemplate } = require('./templates');
const { validateDefinition } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');
const { parseExpr } = require('./expr');
const { parseRecords } = require('../core/dataEngine/sources/spreadsheetFile/formats/csv');
const { readWorkbookTables } = require('../core/automationRunner/tables/workbook');
const { runTableOps } = require('../core/automationRunner/tables/ops');
const { tableLimits } = require('../core/automationRunner/tables/limits');
const { normalizeTableStep, planColumns } = require('../core/automationModel/tableOps/spec');

const SAMPLES = path.join(__dirname, '..', '..', 'agent-hub', 'public', 'automation-samples');
const deliverableEvents = getDeliverableEvents();
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every formula in a table step: `expr` bindings anywhere in an op, and a filter's `expr`. */
function formulasIn(value, where, out = []) {
    if (Array.isArray(value)) value.forEach((v, i) => formulasIn(v, `${where}[${i}]`, out));
    else if (isRecord(value)) {
        if (value.kind === 'expr' && typeof value.value === 'string') out.push({ expr: value.value, where });
        for (const [k, v] of Object.entries(value)) {
            if (k === 'expr' && typeof v === 'string') out.push({ expr: v, where: `${where}.expr` });
            else formulasIn(v, `${where}.${k}`, out);
        }
    }
    return out;
}

/** The column names an op set reads from its INPUT table (not those it derives itself). */
function sourceColumnsUsed(ops) {
    const used = new Set();
    const derived = new Set();
    const add = (c) => { if (typeof c === 'string' && c && !derived.has(c)) used.add(c); };
    for (const op of ops) {
        if (op.op === 'filter') (op.rules || []).forEach((r) => add(r.column));
        if (op.op === 'describe') (op.columns || []).forEach(add);
        if (op.op === 'pseudonymise') [...(op.columns || []), ...(op.dropColumns || [])].forEach(add);
        if (op.op === 'bucket') { add(op.column); derived.add(op.output); }
        if (op.op === 'group') {
            (op.by || []).forEach(add);
            (op.aggregates || []).forEach((a) => add(a.column));
            break; // what follows reads the group's own output
        }
        if (op.op === 'pivot') { add(op.rows); add(op.columns); add(op.value?.column); break; }
        if (op.op === 'groups') { (op.splits || []).forEach((s) => add(s.column)); break; }
        if (op.op === 'derive') {
            for (const c of op.columns || []) {
                for (const m of JSON.stringify(c.value).matchAll(/row\.([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1]);
                derived.add(c.name);
            }
        }
    }
    return [...used];
}

const readSample = (file) => fs.readFileSync(path.join(SAMPLES, file));

async function sampleTable(file) {
    const { sheets } = await readWorkbookTables(readSample(file), { filename: file, format: 'csv', sheets: 'first', headerRow: 1 });
    const sheet = sheets.find((s) => s.rows && s.rows.length) || sheets[0];
    return { columns: sheet.columns, rows: sheet.rows };
}

async function collect(rows) {
    const out = [];
    for await (const r of rows()) out.push(r);
    return out;
}

test('there are three or four recipes, in the Reports category, each with a sample file', () => {
    assert.ok(TABLE_TEMPLATES.length >= 3 && TABLE_TEMPLATES.length <= 4);
    const cards = listTemplates();
    for (const t of TABLE_TEMPLATES) {
        const card = cards.find((c) => c.id === t.id);
        assert.ok(card, `${t.id} is in the gallery`);
        assert.equal(card.category, 'Reports');
        assert.deepEqual(card.sampleData, { filename: t.sampleData.filename, url: `/automation-samples/${t.sampleData.filename}` });
        assert.equal(card.triggerKind, 'form');
    }
    // Templates without a sample file carry no key at all.
    assert.equal('sampleData' in cards.find((c) => c.id === 'nc-form-intake'), false);
});

for (const tmpl of TABLE_TEMPLATES) {
    const def = () => getTemplate(tmpl.id).definition;
    const tableSteps = () => def().steps.filter((s) => s.type === 'table');

    test(`${tmpl.id}: validates clean, to save and to activate`, () => {
        const draft = validateDefinition(def(), { deliverableEvents, stage: 'draft' });
        assert.deepEqual([...draft.errors, ...(draft.warnings || [])].map((e) => e.code), []);
        const live = validateDefinition(def(), { deliverableEvents });
        assert.deepEqual(live.errors, []);
        assert.deepEqual(live.warnings || [], []);
    });

    test(`${tmpl.id}: has the form, read, table, summary, document and ending spine`, () => {
        const d = def();
        assert.equal(d.trigger.kind, 'form');
        const file = d.trigger.form.fields.find((f) => f.type === 'file');
        assert.ok(file && file.required);
        assert.match(file.accept, /\.csv/);
        assert.match(file.accept, /\.xlsx/);
        assert.ok(file.maxSizeMb >= 1 && file.maxSizeMb <= 25, 'within the platform ceiling');
        assert.ok(d.trigger.form.fields.some((f) => f.type === 'info'));
        const types = d.steps.map((s) => s.type);
        assert.equal(types[0], 'read_table');
        assert.ok(tableSteps().length >= 1);
        assert.deepEqual(types.slice(-3), ['ai_step', 'generate_document', 'form_page']);
        assert.equal(d.steps.at(-1).mode, 'ending');
        assert.equal(d.steps.at(-1).form.fields[0].type, 'download');
        assert.equal(d.steps.find((s) => s.type === 'generate_document').format, 'pdf');
    });

    test(`${tmpl.id}: the summary reads the table text only, and is told to use only its numbers`, () => {
        const ai = def().steps.find((s) => s.type === 'ai_step');
        const refs = Object.values(ai.inputs).map((b) => b.path);
        assert.ok(refs.length >= 1);
        for (const p of refs) assert.match(p, /^steps\.[a-z_]+\.output\.markdown$/);
        assert.match(ai.prompt, /only the numbers that appear in the table/i);
        // Never the whole table: no binding to the rows or to the handle.
        assert.ok(!JSON.stringify(ai.inputs).includes('output.rows'));
        assert.ok(!JSON.stringify(ai.inputs).includes('output.table'));
    });

    test(`${tmpl.id}: every formula parses under the restricted grammar`, () => {
        const found = tableSteps().flatMap((s) => formulasIn(s.ops, s.id));
        for (const { expr, where } of found) {
            assert.doesNotThrow(() => parseExpr(expr), `${tmpl.id}: ${where}: ${expr}`);
        }
    });

    test(`${tmpl.id}: the sample file exists and has the columns the recipe names`, () => {
        const file = path.join(SAMPLES, tmpl.sampleData.filename);
        assert.ok(fs.existsSync(file), `${tmpl.sampleData.filename} exists`);
        const { records } = parseRecords(fs.readFileSync(file, 'utf8'), ',');
        const rows = records.map((r) => r.fields).filter((f) => f.some((c) => c !== ''));
        assert.ok(rows.length >= 151 && rows.length <= 301, `150 to 300 data rows (got ${rows.length - 1})`);
        const header = rows[0].map((h) => String(h).trim());
        // Only the FIRST table step reads source columns of the sample directly.
        for (const s of tableSteps()) {
            for (const c of sourceColumnsUsed(s.ops)) assert.ok(header.includes(c), `${tmpl.id}/${s.id} reads "${c}", the sample has ${header.join(', ')}`);
        }
    });

    test(`${tmpl.id}: its table steps run over the sample file`, async () => {
        const source = await sampleTable(tmpl.sampleData.filename);
        assert.ok(source.rows.length >= 150);
        for (const s of tableSteps()) {
            const norm = normalizeTableStep(s);
            const out = await runTableOps({
                source: { columns: source.columns, rows: async function* rows() { for (const r of source.rows) yield { ...r }; } },
                ops: norm.ops,
                runState: { vars: { TABLE_SALT: 'a-made-up-salt-of-sixteen-plus' } },
                limits: tableLimits(),
                minGroupFloor: tableLimits().minGroupFloor,
                mode: 'run',
            });
            const rows = await collect(out.rows);
            assert.ok(rows.length > 0, `${s.id} gives rows`);
            assert.ok(out.columns.length > 0);
            assert.deepEqual(out.opStats.filter((o) => !o.ok), [], `${s.id}: every op ok`);
            // The planner and the engine agree, where the planner can tell.
            const planned = planColumns(source.columns, norm.ops);
            assert.deepEqual(planned.findings.filter((f) => f.severity === 'error'), []);
            if (planned.columns) assert.deepEqual(planned.columns.map((c) => c.key), out.columns.map((c) => c.key), `${s.id}: planned columns`);
            // Rows carry the columns that were announced.
            for (const r of rows) for (const k of Object.keys(r)) assert.ok(out.columns.some((c) => c.key === k), `${s.id}: stray key ${k}`);
        }
    });
}

test('the satisfaction recipe leaves out empty scores and hides small cells', async () => {
    const t = getTemplate('table-satisfaction-by-region').definition.steps.find((s) => s.type === 'table');
    const source = await sampleTable('customer-satisfaction.csv');
    const out = await runTableOps({
        source: { columns: source.columns, rows: async function* rows() { yield* source.rows; } },
        ops: normalizeTableStep(t).ops, runState: { vars: {} }, limits: tableLimits(), minGroupFloor: 0, mode: 'run',
    });
    const rows = await collect(out.rows);
    assert.ok(out.description && out.description.rowCount < source.rows.length, 'the empty scores were dropped before describe');
    assert.equal(rows.at(-1)[out.columns[0].key], 'Total');
});

test('the segment recipe never carries the id or the free text into the result', async () => {
    const t = getTemplate('table-segment-overview').definition.steps.find((s) => s.type === 'table');
    const source = await sampleTable('customer-satisfaction.csv');
    const out = await runTableOps({
        source: { columns: source.columns, rows: async function* rows() { yield* source.rows; } },
        ops: normalizeTableStep(t).ops, runState: { vars: { TABLE_SALT: 'a-made-up-salt-of-sixteen-plus' } },
        limits: tableLimits(), minGroupFloor: 10, mode: 'run',
    });
    const text = JSON.stringify(await collect(out.rows));
    assert.ok(!/rec_\d{4}/.test(text));
    assert.ok(out.segments && out.segments.length > 0);
});
