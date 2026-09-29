/**
 * BI reports — the checks the generic suite cannot make.
 *
 * This template's whole mechanism is DESCRIPTORS AS DATA: a chart's
 * groupBy/aggregates are formulas that build a JSON descriptor from a slot
 * variable (dashboard) or the designer form (live preview), resolved
 * client-side by resolveBindingShape before the fetch. Nothing in the schema
 * ties those formulas to the fact table's real columns, to the aliases the
 * one literal sort may name, or to the scope roots that resolve IDENTICALLY
 * on the fetch side and the read side — and each of those, wrong, is a chart
 * that silently never loads. So: assert the joins the pipeline cannot.
 *
 * The template is not registered yet (templates.js is owned by another wave),
 * so this file imports the module DIRECTLY and replays the registry suite's
 * pipeline checks (canonicalize → validate, data model, seed conformance)
 * before its own.
 *
 * Run: cd server && node --test appStudio/templates/appBiReports.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appBiReports');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const {
    canonicalizeDataModel, validateDataModel, SYSTEM_COLUMNS, AGG_FNS, DATE_BUCKETS, FILTER_OPS,
} = require('../dataModel');
const { LIMITS, COMPONENT_SPECS } = require('../componentSpecs');
const { _orderTablesByDependency, MAX_SEED_ROWS_PER_TABLE } = require('../templateInstall');

const { definition, dataModel, seed } = template;

const T = {
    dimCategories: 'tbl_bidimc1',
    dimEntities: 'tbl_bidime1',
    facts: 'tbl_bifact1',
    staging: 'tbl_bistg01',
    loads: 'tbl_biload1',
    reports: 'tbl_birep01',
};

const canonicalModel = canonicalizeDataModel(dataModel).model;
const tableById = new Map(canonicalModel.tables.map((t) => [t.id, t]));
const fieldKeysOf = (tableId) => new Set((tableById.get(tableId)?.fields || []).map((f) => f.key));
const FACT_FIELDS = fieldKeysOf(T.facts);
const STAGING_FIELDS = fieldKeysOf(T.staging);

const rowsOf = (tableId) => seed[tableId] || [];

/** Every node in the canonical definition, flattened. */
function allNodes(def) {
    const out = [];
    const walk = (children) => {
        for (const child of children || []) {
            out.push(child);
            if (Array.isArray(child.children)) walk(child.children);
        }
    };
    for (const screen of def.screens || []) {
        for (const section of screen.sections || []) walk(section.children);
    }
    return out;
}

const CANON = canonicalizeAppDefinition(definition);
const NODES = allNodes(CANON.def);
const nodeById = (id) => NODES.find((n) => n.id === id);

/** Every step in an action, including condition/loop/switch branches. */
function flatSteps(action) {
    const out = [];
    const walk = (steps) => {
        for (const s of steps || []) {
            out.push(s);
            for (const branch of ['then', 'else', 'steps', 'default']) if (Array.isArray(s[branch])) walk(s[branch]);
            for (const c of s.cases || []) walk(c.steps);
        }
    };
    walk(action.kind === 'sequence' ? action.steps : [action]);
    return out;
}

/** Every { kind:'formula', expr } in a value tree, with its path. */
function collectFormulas(value, path = '', out = []) {
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value)) {
        value.forEach((v, i) => collectFormulas(v, `${path}[${i}]`, out));
        return out;
    }
    if (value.kind === 'formula' && typeof value.expr === 'string') out.push({ path, expr: value.expr });
    for (const [k, v] of Object.entries(value)) collectFormulas(v, path ? `${path}.${k}` : k, out);
    return out;
}

/** Every data binding (records/record/aggregate) in the definition. */
function collectDataBindings() {
    const out = [];
    const visit = (value, path) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}[${i}]`)); return; }
        if (['record', 'records', 'aggregate'].includes(value.kind) && typeof value.tableId === 'string') {
            out.push({ path, binding: value });
        }
        for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
    };
    visit(definition, 'definition');
    return out;
}

// ── The registry suite's pipeline, replayed (registration comes later) ──────

test('canonicalize needs no structural repairs', () => {
    const structural = CANON.repairs.filter((r) => !/defaulted|default/i.test(r.code));
    assert.deepEqual(structural.map((r) => `${r.code} @ ${r.path}: ${r.message}`), []);
});

test('canonicalize + validate: zero errors, zero unexpected warnings', () => {
    const result = validateAppDefinition(CANON.def, { dataModel: canonicalModel, datasets: [] });
    assert.deepEqual(result.errors.map((e) => `${e.code} @ ${e.path}`), [], 'validation errors');
    const ALLOWED = new Set(['action.automation_unset']);
    assert.deepEqual(
        result.warnings.filter((w) => !ALLOWED.has(w.code)).map((w) => `${w.code} @ ${w.path}: ${w.message}`),
        [],
        'unexpected warnings',
    );
    assert.equal(result.ok, true);
});

test('the data model passes validateDataModel with zero errors', () => {
    const { errors } = validateDataModel(canonicalModel);
    assert.deepEqual(errors, []);
});

test('seed rows conform to their tables (types, options, parent-first refs, install ceiling)', () => {
    const aliasesSeen = new Set();
    for (const table of _orderTablesByDependency(canonicalModel)) {
        const rows = rowsOf(table.id);
        assert.ok(rows.length <= MAX_SEED_ROWS_PER_TABLE, `${table.key}: ${rows.length} rows exceeds the install ceiling`);
        const fieldByKey = new Map((table.fields || []).map((f) => [f.key, f]));
        for (const row of rows) {
            for (const [key, value] of Object.entries(row)) {
                if (key === '$id') {
                    assert.equal(typeof value, 'string');
                    assert.ok(!aliasesSeen.has(value), `duplicate $id ${value}`);
                    continue;
                }
                assert.ok(!SYSTEM_COLUMNS.includes(key), `${table.key}: seed writes system column ${key}`);
                const field = fieldByKey.get(key);
                assert.ok(field, `${table.key}: seed key "${key}" is not a field`);
                if (value === null || value === undefined) continue;
                if (field.type === 'relation') {
                    assert.ok(value && typeof value === 'object' && typeof value.$ref === 'string',
                        `${table.key}.${key}: relation seed must be { $ref }`);
                    assert.ok(aliasesSeen.has(value.$ref), `${table.key}.${key}: $ref "${value.$ref}" points at no earlier row`);
                } else if (field.type === 'number') {
                    assert.equal(typeof value, 'number', `${table.key}.${key}: wants a number`);
                    if (field.subtype === 'integer') assert.ok(Number.isInteger(value), `${table.key}.${key}: integer field`);
                } else if (field.type === 'bool') {
                    assert.equal(typeof value, 'boolean', `${table.key}.${key}: wants a boolean`);
                } else if (field.type === 'select') {
                    const opts = (field.options || []).map((o) => o.value);
                    assert.ok(opts.includes(value), `${table.key}.${key}: "${value}" is not a select option`);
                } else {
                    assert.equal(typeof value, 'string', `${table.key}.${key}: ${field.type} field wants a string`);
                }
            }
            if (typeof row.$id === 'string') aliasesSeen.add(row.$id);
        }
    }
    for (const tableId of Object.keys(seed)) {
        assert.ok(tableById.has(tableId), `seed references unknown table ${tableId}`);
    }
});

// ── Every reference resolves against the data model ─────────────────────────

test('every data binding names a real table, and every literal field a real column', () => {
    for (const { path, binding } of collectDataBindings()) {
        assert.ok(tableById.has(binding.tableId), `${path}: unknown table ${binding.tableId}`);
        const fields = fieldKeysOf(binding.tableId);
        const okField = (f) => fields.has(f) || SYSTEM_COLUMNS.includes(f);
        for (const entry of Array.isArray(binding.filter) ? binding.filter : []) {
            assert.ok(okField(entry.field), `${path}: filter field "${entry.field}" not on ${binding.tableId}`);
            assert.ok(FILTER_OPS.includes(entry.op), `${path}: unknown filter op "${entry.op}"`);
        }
        // A literal aggregate sort may name a produced alias — but ONLY when
        // the validator can see literal groupBy/aggregates. With a formula
        // descriptor the sort must name a REAL column (the whole reason the
        // fact table carries `label`) — so this check is deliberately strict.
        const aliases = new Set();
        if (Array.isArray(binding.groupBy)) for (const g of binding.groupBy) aliases.add(g.as || g.field);
        if (Array.isArray(binding.aggregates)) for (const a of binding.aggregates) aliases.add(a.as || `${a.fn}_all`);
        for (const entry of Array.isArray(binding.sort) ? binding.sort : []) {
            assert.ok(okField(entry.field) || aliases.has(entry.field),
                `${path}: sort field "${entry.field}" is neither a column of ${binding.tableId} nor a declared alias`);
        }
        if (Array.isArray(binding.groupBy)) {
            for (const g of binding.groupBy) {
                assert.ok(okField(g.field), `${path}: groupBy field "${g.field}" not on ${binding.tableId}`);
                if (g.bucket) assert.ok(DATE_BUCKETS.includes(g.bucket), `${path}: unknown bucket "${g.bucket}"`);
            }
        }
        if (Array.isArray(binding.aggregates)) {
            for (const a of binding.aggregates) {
                assert.ok(AGG_FNS.includes(a.fn), `${path}: unknown fn "${a.fn}"`);
                if (a.field && a.field !== '*') assert.ok(okField(a.field), `${path}: aggregate field "${a.field}" not on ${binding.tableId}`);
            }
        }
    }
});

test('every formula in the whole definition compiles, and only names in-scope roots', async () => {
    const { compile } = await import('../../shared/expr/engine.mjs');
    const ROOTS = new Set(['actions', 'form', 'forms', 'screen', 'vars', 'item', 'index', 'value', 'currentUser', 'records', 'datasets', 'connectors', 'now', 'today']);
    for (const { path, expr } of collectFormulas(definition)) {
        let refs;
        assert.doesNotThrow(() => { refs = compile(expr).refs; }, `${path}: "${expr}" does not parse`);
        for (const r of refs) assert.ok(ROOTS.has(r), `${path}: unknown root "${r}" in "${expr}"`);
    }
});

// ── The slot descriptors — the heart, and the part with no schema net ───────

const SLOT_CHART_IDS = [1, 2, 3, 4, 5, 6].map((n) => `cmp_bisch${n}`);

test('each dashboard slot is its own chart component — never a repeater of charts', () => {
    // Data bindings are collected and fetched at SCREEN scope; a binding
    // inside a repeater whose formula reads item.* never fetches per row.
    assert.equal(NODES.filter((n) => n.type === 'repeater').length, 0, 'no repeater anywhere in this template');
    for (const id of SLOT_CHART_IDS) {
        const chart = nodeById(id);
        assert.ok(chart, `${id} exists`);
        assert.equal(chart.type, 'chart');
    }
});

/**
 * FETCH/READ SYMMETRY. The fetch layer resolves descriptor formulas against a
 * scope built WITHOUT dataState (AppRunPage/Canvas both say so out loud), the
 * read layer against one WITH it. A shape formula reading records.* therefore
 * computes two different cache keys and the chart never loads. Every dynamic
 * descriptor here must read ONLY roots present on both sides: vars/forms
 * (plus currentUser/screen/today, unused). This is the platform finding the
 * whole slot design rests on — if it fails, someone reached for records.*.
 */
test('slot descriptors read vars.slotN only — never records/forms/item/now', async () => {
    const { compile } = await import('../../shared/expr/engine.mjs');
    for (const [i, id] of SLOT_CHART_IDS.entries()) {
        const n = i + 1;
        const source = nodeById(id).props.source;
        assert.equal(source.kind, 'aggregate');
        assert.equal(source.tableId, T.facts);
        const exprs = collectFormulas(source).map((f) => f.expr);
        assert.ok(exprs.length >= 3, `slot ${n}: groupBy, aggregates and the gate filter are formulas`);
        for (const expr of exprs) {
            const refs = compile(expr).refs;
            assert.deepEqual(refs, ['vars'], `slot ${n}: "${expr}" must read vars and nothing else`);
            assert.match(expr, new RegExp(`vars\\.slot${n}\\.`), `slot ${n}: reads its own slot variable`);
        }
    }
});

test('slot and preview descriptors build server-legal JSON: real columns, allowed fns, the label/value aliases', () => {
    const sources = [...SLOT_CHART_IDS.map((id) => nodeById(id).props.source), nodeById('cmp_bigchart').props.source];
    for (const source of sources) {
        for (const key of ['groupBy', 'aggregates']) {
            const expr = source[key].expr;
            // Complete JSON literals (the month / count branches) must parse
            // and reference only what compileAggregate will accept.
            for (const m of expr.matchAll(/parseJson\('(\[[^']*\])'\)/g)) {
                const parsed = JSON.parse(m[1]);
                assert.ok(Array.isArray(parsed) && parsed.length === 1);
                const entry = parsed[0];
                if (entry.fn) {
                    assert.ok(AGG_FNS.includes(entry.fn), `unknown fn ${entry.fn}`);
                    assert.ok(entry.field === '*' || FACT_FIELDS.has(entry.field), `fn field ${entry.field} not on facts`);
                    assert.equal(entry.as, 'value', 'measure alias is pinned — the series key is a literal prop');
                } else {
                    assert.ok(FACT_FIELDS.has(entry.field), `group field ${entry.field} not on facts`);
                    if (entry.bucket) assert.ok(DATE_BUCKETS.includes(entry.bucket), `unknown bucket ${entry.bucket}`);
                    assert.equal(entry.as, 'label', 'group alias is pinned — xKey is a literal prop');
                }
            }
            // The concat-built branches pin the same aliases.
            if (key === 'groupBy') assert.match(expr, /"as":"label"/);
            else assert.match(expr, /"as":"value"/);
        }
        // The gate: a REQUIRED filter formula, so an unassigned slot resolves
        // the whole binding to null and nothing is fetched (an empty aggregate
        // would be rejected server-side).
        const gate = (source.filter || []).find((f) => f.required === true);
        assert.ok(gate, 'a required gate filter exists');
        assert.equal(gate.field, 'record_date');
        assert.equal(gate.op, 'gte');
        assert.equal(gate.value.kind, 'formula');
        assert.match(gate.value.expr, /: null$/, 'no group_field resolves the gate to null — no fetch');
    }
});

/**
 * Aggregate sort/limit MUST be literals (validate.js special-cases only
 * groupBy/aggregates as formulas), and a literal sort next to a FORMULA
 * groupBy is checked against the table's REAL columns — the validator sees no
 * aliases. `label` is therefore both the pinned group alias AND a real fact
 * column. If someone renames or drops fact_records.label, every report chart
 * stops validating — this is the tripwire.
 */
test('report descriptors sort by the label alias, which is also a real fact column', () => {
    assert.ok(FACT_FIELDS.has('label'), 'fact_records carries the `label` column the literal sort validates against');
    for (const source of [...SLOT_CHART_IDS.map((id) => nodeById(id).props.source), nodeById('cmp_bigchart').props.source]) {
        assert.deepEqual(source.sort, [{ field: 'label', dir: 'asc' }], 'literal sort, by the group alias');
        assert.equal(typeof source.limit, 'number', 'literal limit — a formula limit fails validation');
        assert.equal(source.pick, undefined, 'a chart consumes the rows array; pick would collapse it to one cell');
    }
});

test('the live preview reads forms.designer only, and the designer form supplies every key it reads', async () => {
    const { compile } = await import('../../shared/expr/engine.mjs');
    const source = nodeById('cmp_bigchart').props.source;
    const keysRead = new Set();
    for (const { expr } of collectFormulas(source)) {
        assert.deepEqual(compile(expr).refs, ['forms'], `"${expr}" must read forms and nothing else`);
        for (const m of expr.matchAll(/forms\.designer\.([A-Za-z_][\w]*)/g)) keysRead.add(m[1]);
    }
    const form = nodeById('cmp_bigform');
    const inputNames = new Set(allNodes({ screens: [{ sections: [{ children: [form] }] }] })
        .filter((n) => COMPONENT_SPECS[n.type]?.isInput)
        .map((n) => n.props.name));
    for (const key of keysRead) {
        assert.ok(inputNames.has(key), `preview reads forms.designer.${key} but the form has no input named "${key}"`);
    }
    // And the save action's server step reads the same vocabulary.
    const create = flatSteps(definition.actions.act_birepsave).find((s) => s.kind === 'create_record');
    for (const binding of Object.values(create.values)) {
        for (const m of (binding.expr || '').matchAll(/form\.([A-Za-z_][\w]*)/g)) {
            assert.ok(inputNames.has(m[1]), `act_birepsave reads form.${m[1]} which the designer form does not collect`);
        }
    }
});

test('the designer options catalog matches what the server will accept', () => {
    const reports = tableById.get(T.reports);
    const optionValues = (fieldKey) => reports.fields.find((f) => f.key === fieldKey).options.map((o) => o.value);
    for (const v of optionValues('group_field')) {
        assert.ok(v === 'month' || FACT_FIELDS.has(v), `group_field option "${v}" is neither 'month' nor a fact column`);
    }
    for (const v of optionValues('measure_field')) assert.ok(FACT_FIELDS.has(v), `measure_field option "${v}" not on facts`);
    for (const v of optionValues('measure_fn')) assert.ok(AGG_FNS.includes(v), `measure_fn option "${v}" not an allowed fn`);
    const chartEnum = COMPONENT_SPECS.chart.props.chartType.values;
    for (const v of optionValues('chart_type')) assert.ok(chartEnum.includes(v), `chart_type option "${v}" not a chart type`);
});

/**
 * The missing-pick bug class: an aggregate binding resolves to the ROWS
 * ARRAY. Wherever a SCALAR is expected (a stat tile: no groupBy), `pick` must
 * narrow it to one of the descriptor's own aliases — without it the tile
 * renders the array. Grouped (or formula-shaped) descriptors feed charts and
 * must NOT carry pick.
 */
test('every scalar aggregate carries a pick naming one of its own aliases; grouped ones carry none', () => {
    const offences = [];
    for (const { path, binding } of collectDataBindings()) {
        if (binding.kind !== 'aggregate') continue;
        const dynamic = binding.groupBy && !Array.isArray(binding.groupBy);
        const grouped = dynamic || (Array.isArray(binding.groupBy) && binding.groupBy.length > 0);
        if (grouped) {
            if (binding.pick) offences.push(`${path}: grouped aggregate carries a pick (would collapse the chart to one cell)`);
            continue;
        }
        const aliases = (binding.aggregates || []).map((a) => a.as).filter(Boolean);
        if (!binding.pick) offences.push(`${path}: scalar aggregate has no pick (would render the rows array)`);
        else if (!aliases.includes(binding.pick.column)) {
            offences.push(`${path}: pick.column "${binding.pick.column}" not one of [${aliases.join(', ')}]`);
        }
    }
    assert.deepEqual(offences, []);
});

// ── Slots: variables, defaults, and the routing actions ─────────────────────

test('slot variables 1-3 default to the seeded slot reports, 4-6 start empty', () => {
    const vars = new Map(definition.variables.map((v) => [v.name, v]));
    for (let n = 1; n <= 6; n++) {
        const v = vars.get(`slot${n}`);
        assert.ok(v, `slot${n} is declared`);
        assert.equal(v.type, 'record');
    }
    for (let n = 1; n <= 3; n++) {
        const seeded = rowsOf(T.reports).find((r) => r.slot === n);
        assert.ok(seeded, `a seeded report occupies slot ${n} — the dashboard must be alive on first open`);
        const dflt = vars.get(`slot${n}`).default;
        for (const key of ['name', 'chart_type', 'group_field', 'measure_fn', 'measure_field', 'slot']) {
            assert.equal(dflt[key], seeded[key], `slot${n} default.${key} must mirror the seeded report`);
        }
        assert.equal(dflt.since ?? null, seeded.since ?? null, `slot${n} default.since mirrors the seed`);
    }
    for (let n = 4; n <= 6; n++) {
        assert.deepEqual(vars.get(`slot${n}`).default, {}, `slot${n} starts empty (its hint shows)`);
    }
});

test('dashboard slots above 3 show their hint and never fetch until assigned', () => {
    for (let n = 1; n <= 6; n++) {
        const chart = nodeById(`cmp_bisch${n}`);
        assert.deepEqual(chart.visible, { kind: 'formula', expr: `vars.slot${n}.group_field` });
        const hint = nodeById(`cmp_bishint${n}`);
        assert.ok(hint, `slot ${n} has a hint`);
        assert.equal(hint.visible.kind, 'formula');
        assert.match(hint.visible.expr, new RegExp(`^!vars\\.slot${n}\\.group_field$`));
    }
});

test('the sync loop reads the byte-identical binding the dashboard library fetched', () => {
    // A loop resolves its source from the SAME client data cache the screen's
    // components filled — a binding differing by one byte is a different
    // cache key and resolves to nothing (zero iterations, silently).
    const loop = definition.actions.act_bidsync.steps.find((s) => s.kind === 'loop');
    assert.ok(loop, 'act_bidsync loops');
    const library = nodeById('cmp_bidlib');
    assert.deepEqual(loop.source, library.props.source, 'loop source ≡ dashboard library source');
    assert.equal(library.props.source.tableId, T.reports);
    const grid = nodeById('cmp_biggrid');
    assert.deepEqual(grid.props.source, library.props.source, 'the designer grid shares the same query');
    assert.ok(Number.isInteger(loop.maxIterations) && loop.maxIterations <= LIMITS.MAX_ACTION_LOOP_ITERATIONS);
});

test('the slot routing covers slots 1-6 with flat conditions (expressions cannot say "the row where slot == N")', () => {
    for (const [actionId, rootExpr] of [['act_bidsync', 'item'], ['act_bidapply', 'item'], ['act_birepsave', 'form']]) {
        const steps = flatSteps(definition.actions[actionId]);
        for (let n = 1; n <= 6; n++) {
            const cond = steps.find((s) => s.kind === 'condition' && s.expr === `${rootExpr}.slot == ${n}`);
            assert.ok(cond, `${actionId}: a condition for slot ${n}`);
            const set = cond.then.find((s) => s.kind === 'set_variable' && s.name === `slot${n}`);
            assert.ok(set, `${actionId}: slot ${n} condition sets vars.slot${n}`);
            assert.deepEqual(set.value, { kind: 'formula', expr: rootExpr });
        }
    }
    // Saving writes the slot as a NUMBER even though the select submits text.
    const create = flatSteps(definition.actions.act_birepsave).find((s) => s.kind === 'create_record');
    assert.equal(create.values.slot.expr, 'number(form.slot)');
    assert.equal(create.tableId, T.reports);
});

// ── The warehouse load ──────────────────────────────────────────────────────

test('the load snapshots pending rows, logs a run, maps staging onto facts, and closes the run', () => {
    const steps = flatSteps(definition.actions.act_biload);

    // Snapshot FIRST, from the byte-identical binding the staging grid reads.
    const snap = definition.actions.act_biload.steps[0];
    assert.equal(snap.kind, 'set_variable');
    assert.equal(snap.name, 'staged');
    assert.deepEqual(snap.value, nodeById('cmp_bilstg').props.source, 'snapshot source ≡ staging grid source');

    // The run row, created before the loop and closed after it.
    const run = steps.find((s) => s.kind === 'create_record' && s.tableId === T.loads);
    assert.ok(run, 'a load_runs row is created');
    assert.equal(run.resultVar, 'run', 'its id must be readable as vars.run.id inside the loop');
    assert.equal(run.values.rows_loaded.expr, 'len(vars.staged)');
    const close = steps.find((s) => s.kind === 'update_record' && s.tableId === T.loads);
    assert.ok(close, 'the run is closed');
    assert.equal(close.recordId.expr, 'vars.run.id');

    // The loop: over the snapshot, capped at exactly the binding's limit so
    // the recorded count is the moved count.
    const loop = steps.find((s) => s.kind === 'loop');
    assert.equal(loop.source.expr, 'vars.staged');
    assert.equal(loop.maxIterations, snap.value.limit, 'loop cap ≡ staging binding limit');
    assert.ok(loop.maxIterations <= LIMITS.MAX_ACTION_LOOP_ITERATIONS);

    // Field mapping: every fact column written exists; every item.* read
    // exists on staging; provenance rides along.
    const createFact = loop.steps.find((s) => s.kind === 'create_record');
    assert.equal(createFact.tableId, T.facts);
    for (const [column, binding] of Object.entries(createFact.values)) {
        assert.ok(FACT_FIELDS.has(column), `load writes unknown fact column "${column}"`);
        for (const m of (binding.expr || '').matchAll(/item\.([A-Za-z_][\w]*)/g)) {
            assert.ok(STAGING_FIELDS.has(m[1]) || m[1] === 'id', `load reads item.${m[1]} which staging does not carry`);
        }
    }
    assert.equal(createFact.values.load_run_id.expr, 'vars.run.id', 'every loaded fact names its run');

    // The moved row is marked, not deleted — re-running cannot double-load.
    const mark = loop.steps.find((s) => s.kind === 'update_record');
    assert.equal(mark.tableId, T.staging);
    assert.deepEqual(mark.values.status, { kind: 'static', value: 'loaded' });
});

test('the staging landing zone is select-typed pending/loaded, never a boolean', () => {
    // A boolean filter value round-trips differently per SQL dialect; the
    // pending filter must be a text eq that both engines compare identically.
    const status = tableById.get(T.staging).fields.find((f) => f.key === 'status');
    assert.equal(status.type, 'select');
    assert.deepEqual(status.options.map((o) => o.value).sort(), ['loaded', 'pending']);
    const grid = nodeById('cmp_bilstg');
    const filter = grid.props.source.filter.find((f) => f.field === 'status');
    assert.deepEqual(filter, { field: 'status', op: 'eq', value: 'pending' });
});

// ── Star-schema integrity in the seeds ──────────────────────────────────────

test('every fact row: denormalised keys agree with their relations, and label (the sort anchor) is set', () => {
    const dimKey = new Map();
    for (const row of [...rowsOf(T.dimCategories), ...rowsOf(T.dimEntities)]) dimKey.set(row.$id, row.key);
    for (const fact of rowsOf(T.facts)) {
        assert.ok(typeof fact.label === 'string' && fact.label.length > 0, 'every fact carries a label');
        assert.equal(fact.category_key, dimKey.get(fact.category_id.$ref),
            `"${fact.label}": category_key disagrees with its relation — it would group under one name and link to another`);
        assert.equal(fact.entity_key, dimKey.get(fact.entity_id.$ref),
            `"${fact.label}": entity_key disagrees with its relation`);
    }
});

test('load_runs row counts are honest: rows_loaded equals the facts that reference the run', () => {
    const counts = new Map();
    for (const fact of rowsOf(T.facts)) {
        const ref = fact.load_run_id.$ref;
        counts.set(ref, (counts.get(ref) || 0) + 1);
    }
    for (const run of rowsOf(T.loads)) {
        assert.equal(run.rows_loaded, counts.get(run.$id) || 0,
            `run "${run.$id}" claims ${run.rows_loaded} rows but ${counts.get(run.$id) || 0} facts reference it`);
    }
});

test('seeded reports are renderable and the dashboard slots are unique', () => {
    const reports = rowsOf(T.reports);
    assert.ok(reports.length >= 4, 'a populated library');
    const chartEnum = COMPONENT_SPECS.chart.props.chartType.values;
    const slots = [];
    for (const r of reports) {
        assert.ok(r.group_field === 'month' || FACT_FIELDS.has(r.group_field), `${r.name}: group_field "${r.group_field}"`);
        assert.ok(AGG_FNS.includes(r.measure_fn), `${r.name}: measure_fn`);
        assert.ok(FACT_FIELDS.has(r.measure_field), `${r.name}: measure_field`);
        assert.ok(chartEnum.includes(r.chart_type), `${r.name}: chart_type`);
        assert.ok(Number.isInteger(r.slot) && r.slot >= 0 && r.slot <= 6, `${r.name}: slot ${r.slot}`);
        if (r.slot > 0) slots.push(r.slot);
    }
    assert.equal(new Set(slots).size, slots.length, 'no two seeded reports claim the same slot');
    assert.ok(reports.some((r) => r.slot === 0), 'one library-only report, so the designer grid shows both states');
    assert.ok(reports.some((r) => r.group_field === 'month'), 'one time-bucketed report exercises the month branch');
});

test('staged demo rows use dimension keys the warehouse already knows', () => {
    const catKeys = new Set(rowsOf(T.dimCategories).map((r) => r.key));
    const entKeys = new Set(rowsOf(T.dimEntities).map((r) => r.key));
    let pending = 0;
    for (const row of rowsOf(T.staging)) {
        assert.ok(catKeys.has(row.category_key), `staged "${row.label}": unknown category_key`);
        assert.ok(entKeys.has(row.entity_key), `staged "${row.label}": unknown entity_key`);
        if (row.status === 'pending') pending += 1;
    }
    assert.ok(pending >= 3, 'enough pending rows that "Load staged rows" visibly does something');
});

// ── The logic behind the controls ───────────────────────────────────────────

test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets|connectors)\b/;
    const offences = [];
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (!SERVER_KINDS.has(step.kind)) continue;
            for (const { path, expr } of collectFormulas(step, actionId)) {
                if (FORBIDDEN.test(expr.trim())) offences.push(`${path}: ${expr}`);
            }
        }
    }
    assert.deepEqual(offences, []);
});

test('every mutation refreshes the table it dirtied', () => {
    const MUTATES = { create_record: true, update_record: true, delete_record: true };
    for (const [actionId, action] of Object.entries(definition.actions)) {
        if (action.kind !== 'sequence') continue;
        const steps = flatSteps(action);
        const dirtied = new Set(steps.filter((s) => MUTATES[s.kind]).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId), `${actionId} writes ${tableId} but never refreshes it`);
        }
    }
});

test('every destructive action asks first', () => {
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        if (!steps.some((s) => s.kind === 'delete_record')) continue;
        assert.ok(steps.some((s) => s.kind === 'confirm'), `${actionId} deletes without confirming`);
    }
});

test('every action is wired to something, and every wire points at a real action', () => {
    const referenced = new Set();
    for (const n of NODES) {
        for (const ev of ['onClick', 'onSubmit', 'onRowClick', 'onRowSelect', 'onCardMove', 'onChange']) {
            if (typeof n[ev] === 'string') referenced.add(n[ev]);
        }
        for (const ra of n.props?.rowActions || []) if (ra.actionId) referenced.add(ra.actionId);
        for (const ia of n.props?.itemActions || []) if (ia.actionId) referenced.add(ia.actionId);
    }
    const declared = new Set(Object.keys(definition.actions));
    for (const id of referenced) assert.ok(declared.has(id), `something is wired to unknown action "${id}"`);
    for (const id of declared) assert.ok(referenced.has(id), `action "${id}" is wired to nothing`);
});

test('inline fact edits are compare-and-set, with the strict empty-string ternary on numbers', () => {
    const update = flatSteps(definition.actions.act_bifactsave).find((s) => s.kind === 'update_record');
    assert.deepEqual(update.expectedUpdatedAt, { kind: 'formula', expr: 'form.updated_at' },
        'two analysts in the same grid must not overwrite each other silently');
    // 0 == '' is true in the engine, so a loose ternary would turn a real 0
    // into NULL — the strictness is the point.
    for (const key of ['amount', 'quantity']) {
        assert.equal(update.values[key].expr, `form.${key} === '' ? null : form.${key}`);
    }
    const grid = nodeById('cmp_biwfacts');
    assert.equal(grid.props.selectable, 'none', 'selection would overload the cell-commit event');
    assert.equal(grid.onRowSelect, 'act_bifactsave');
});

// ── Connectors: degrade gracefully, never dangle ────────────────────────────

test('no connector binding ships — the staging table plus an instructive empty state carry that story', () => {
    // A template cannot know the ids of connectors the OWNER will create; a
    // dangling { kind:'connector' } placeholder would fail publish validation
    // and render a dead box. The landing-zone pattern degrades gracefully.
    const kinds = new Set();
    const walk = (v) => {
        if (!v || typeof v !== 'object') return;
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (typeof v.kind === 'string') kinds.add(v.kind);
        Object.values(v).forEach(walk);
    };
    walk(definition);
    assert.equal(kinds.has('connector'), false, 'no connector binding anywhere');
    assert.equal(dataModel.connectors, undefined, 'the data model ships no connector');
    assert.equal(NODES.some((n) => n.type === 'connector_status'), false, 'no status card pointing at nothing');

    const callout = nodeById('cmp_bilhow');
    assert.ok(callout, 'the Load screen explains the wiring');
    for (const needle of ['Data panel', 'Staging rows', 'record_date', 'category_key', 'pending']) {
        assert.ok(callout.props.text.includes(needle), `the connector how-to names ${needle}`);
    }
});

// ── Budget ──────────────────────────────────────────────────────────────────

test('the template stays inside the definition budget', () => {
    const def = CANON.def;
    let nodes = 0;
    let maxDepth = 0;
    const walk = (children, depth) => {
        for (const c of children || []) {
            nodes += 1;
            maxDepth = Math.max(maxDepth, depth);
            walk(c.children, depth + 1);
        }
    };
    for (const screen of def.screens) {
        for (const section of screen.sections || []) { nodes += 1; walk(section.children, 2); }
    }
    assert.ok(def.screens.length <= LIMITS.MAX_SCREENS, 'screens');
    assert.ok(nodes <= LIMITS.MAX_TOTAL_NODES, `nodes ${nodes} <= ${LIMITS.MAX_TOTAL_NODES}`);
    assert.ok(Object.keys(def.actions || {}).length <= LIMITS.MAX_ACTIONS, 'actions');
    assert.ok(maxDepth <= LIMITS.MAX_DEPTH, `depth ${maxDepth} <= ${LIMITS.MAX_DEPTH}`);
    assert.ok(definition.variables.length <= LIMITS.MAX_VARIABLES, 'variables');
    assert.ok(Buffer.byteLength(JSON.stringify(definition), 'utf8') < LIMITS.MAX_DEFINITION_BYTES, 'definition bytes');
});

test('template metadata is complete for later registration', () => {
    assert.equal(template.id, 'app-bi-reports');
    for (const key of ['title', 'description', 'category', 'icon']) {
        assert.ok(typeof template[key] === 'string' && template[key].length > 0, `missing ${key}`);
    }
    assert.ok(Array.isArray(template.tags) && template.tags.length > 0);
    assert.equal(definition.schemaVersion, 2);
    assert.equal(definition.homeScreenId, 'scr_bidash');
    // Roles agree by value across the two shapes.
    assert.deepEqual(
        dataModel.roles.map((r) => r.key).sort(),
        definition.roles.map((r) => r.id).sort(),
    );
});
