/**
 * Every starter template must survive the real pipeline: canonicalize →
 * validate with zero errors. Data-backed templates additionally carry a
 * dataModel (validated with validateDataModel), seed rows (each row's keys +
 * types must conform to its table) and optional dataset descriptors.
 *
 * The only warnings allowed are the deliberate 'action.automation_unset' ones
 * (routine templates ship automationId: null so they install without routine
 * dependencies).
 *
 * Run: cd server && node --test appStudio/templates.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TEMPLATES, listTemplates, getTemplate } = require('./templates');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { canonicalizeDataModel, validateDataModel, SYSTEM_COLUMNS } = require('./dataModel');
const { LIMITS, DATA_MUTATING_STEP_KINDS } = require('./componentSpecs');

// The canonical model a data-backed template installs (templateInstall runs
// canonicalizeDataModel before saveDataModel) — validation cross-checks the
// definition against exactly this shape.
function canonicalModelFor(t) {
    return t.dataModel ? canonicalizeDataModel(t.dataModel).model : undefined;
}

// Dataset ids the template declares (definition dataset bindings resolve here).
function datasetIdsFor(t) {
    return Array.isArray(t.datasets) ? t.datasets.map((d) => d.id) : [];
}

test('template ids are unique and metadata is complete', () => {
    const ids = new Set();
    for (const t of TEMPLATES) {
        assert.ok(t.id && !ids.has(t.id), `duplicate/missing template id: ${t.id}`);
        ids.add(t.id);
        for (const key of ['title', 'description', 'category', 'icon']) {
            assert.ok(typeof t[key] === 'string' && t[key].length > 0, `${t.id}: missing ${key}`);
        }
        assert.ok(Array.isArray(t.tags) && t.tags.length > 0, `${t.id}: missing tags`);
        assert.ok(t.definition && [1, 2].includes(t.definition.schemaVersion), `${t.id}: bad definition`);
    }
});

for (const t of TEMPLATES) {
    test(`template ${t.id} passes canonicalize + validate with zero errors`, () => {
        const { def } = canonicalizeAppDefinition(t.definition);
        // Data-backed templates pass their own model + dataset ids so the
        // record/records/dataset cross-checks resolve instead of firing
        // binding.unknown_* errors. Definition-only templates pass neither
        // (opts.dataModel undefined → the checks are skipped entirely).
        const opts = t.dataModel
            ? { dataModel: canonicalModelFor(t), datasets: datasetIdsFor(t) }
            : {};
        const result = validateAppDefinition(def, opts);
        assert.deepEqual(
            result.errors.map((e) => `${e.code} @ ${e.path}`),
            [],
            `${t.id} has validation errors`,
        );
        const ALLOWED_WARNINGS = new Set(['action.automation_unset']);
        const unexpected = result.warnings.filter((w) => !ALLOWED_WARNINGS.has(w.code));
        assert.deepEqual(
            unexpected.map((w) => `${w.code} @ ${w.path}`),
            [],
            `${t.id} has unexpected warnings`,
        );
        assert.equal(result.ok, true);
    });

    test(`template ${t.id} definition is already canonical (no structural repairs)`, () => {
        const { repairs } = canonicalizeAppDefinition(t.definition);
        // Default-filling is fine (canonicalize pads absent optional props);
        // anything else means the template drifted from the contract.
        const structural = repairs.filter((r) => !/defaulted|default/i.test(r.code));
        assert.deepEqual(
            structural.map((r) => `${r.code} @ ${r.path}`),
            [],
            `${t.id} needed structural repairs`,
        );
    });
}

// ── Data model + seed conformance (data-backed templates) ───────────────────

const DATA_TEMPLATES = TEMPLATES.filter((t) => t.dataModel);

test('there are data-backed templates to exercise the catalog', () => {
    assert.ok(DATA_TEMPLATES.length >= 5, `expected ≥5 data-backed templates, got ${DATA_TEMPLATES.length}`);
});

// A tiny seed validator: every row key is a real field key (or the `$id`
// alias), and every value conforms to its field type.
function assertSeedRowConforms(t, table, row, aliasesSeen) {
    const fieldByKey = new Map((table.fields || []).map((f) => [f.key, f]));
    for (const [key, value] of Object.entries(row)) {
        if (key === '$id') {
            assert.equal(typeof value, 'string', `${t.id}/${table.key}: $id alias must be a string`);
            assert.ok(!aliasesSeen.has(value), `${t.id}/${table.key}: duplicate $id alias ${value}`);
            continue;
        }
        assert.ok(!SYSTEM_COLUMNS.includes(key), `${t.id}/${table.key}: seed writes system column ${key}`);
        const field = fieldByKey.get(key);
        assert.ok(field, `${t.id}/${table.key}: seed key "${key}" is not a field`);
        if (value === null || value === undefined) continue;

        if (field.type === 'relation') {
            assert.ok(value && typeof value === 'object' && typeof value.$ref === 'string',
                `${t.id}/${table.key}.${key}: relation seed must be { $ref } (got ${JSON.stringify(value)})`);
            assert.ok(aliasesSeen.has(value.$ref),
                `${t.id}/${table.key}.${key}: relation $ref "${value.$ref}" points at no earlier row`);
        } else if (field.type === 'number') {
            assert.equal(typeof value, 'number', `${t.id}/${table.key}.${key}: number field wants a number`);
            if (field.subtype === 'integer') assert.ok(Number.isInteger(value), `${t.id}/${table.key}.${key}: integer field`);
        } else if (field.type === 'bool') {
            assert.equal(typeof value, 'boolean', `${t.id}/${table.key}.${key}: bool field wants a boolean`);
        } else if (field.type === 'select') {
            const opts = (field.options || []).map((o) => o.value);
            assert.ok(opts.includes(value), `${t.id}/${table.key}.${key}: "${value}" is not a select option`);
        } else if (field.type === 'multiselect') {
            assert.ok(Array.isArray(value), `${t.id}/${table.key}.${key}: multiselect wants an array`);
            const opts = (field.options || []).map((o) => o.value);
            for (const v of value) assert.ok(opts.includes(v), `${t.id}/${table.key}.${key}: "${v}" is not an option`);
        } else {
            // text / richtext / date / datetime / file — string-ish.
            assert.equal(typeof value, 'string', `${t.id}/${table.key}.${key}: ${field.type} field wants a string`);
        }
    }
}

for (const t of DATA_TEMPLATES) {
    test(`template ${t.id} dataModel passes validateDataModel with zero errors`, () => {
        const model = canonicalModelFor(t);
        const { errors } = validateDataModel(model);
        assert.deepEqual(errors, [], `${t.id} dataModel errors: ${errors.join('; ')}`);
    });

    test(`template ${t.id} seed rows conform to their tables (install ceiling, parent-first refs)`, () => {
        const model = canonicalModelFor(t);
        const tableById = new Map(model.tables.map((tbl) => [tbl.id, tbl]));
        const seed = t.seed || {};
        // Aliases accumulate across tables in dependency order — a relation ref
        // may only point at a row seeded in an EARLIER (parent) table.
        const { _orderTablesByDependency, MAX_SEED_ROWS_PER_TABLE } = require('./templateInstall');
        const aliasesSeen = new Set();
        for (const table of _orderTablesByDependency(model)) {
            const rows = Array.isArray(seed[table.id]) ? seed[table.id] : [];
            // The INSTALLER's ceiling, not a copy of it: installTemplate
            // slice()s at this number, so any row past it silently vanishes.
            assert.ok(rows.length <= MAX_SEED_ROWS_PER_TABLE, `${t.id}/${table.key}: ${rows.length} seed rows exceeds the install ceiling (${MAX_SEED_ROWS_PER_TABLE})`);
            for (const row of rows) {
                assertSeedRowConforms(t, table, row, aliasesSeen);
                if (typeof row.$id === 'string') aliasesSeen.add(row.$id);
            }
        }
        // Every seed key must reference a real table id in the model.
        for (const tableId of Object.keys(seed)) {
            assert.ok(tableById.has(tableId), `${t.id}: seed references unknown table id ${tableId}`);
        }
    });
}

test('listTemplates strips heavy fields; getTemplate returns them', () => {
    const listed = listTemplates();
    assert.equal(listed.length, TEMPLATES.length);
    for (const item of listed) {
        assert.equal(item.definition, undefined);
        assert.equal(item.dataModel, undefined);
        assert.equal(item.seed, undefined);
        assert.equal(item.datasets, undefined);
    }
    const one = getTemplate(TEMPLATES[0].id);
    assert.ok(one && one.definition);
    assert.equal(getTemplate('nope'), null);
    // A data-backed template still exposes its data side through getTemplate.
    const crm = getTemplate('app-crm-pipeline');
    assert.ok(crm && crm.dataModel && crm.seed, 'getTemplate returns the data side');
});

// ── The support desk is the wave's acceptance test ──────────────────────────

test('app-support-desk exercises every capability the mailbox wave added', () => {
    // If a future edit quietly strips these, the template stops proving that a
    // support desk is authorable and becomes just another CRUD demo.
    const t = getTemplate('app-support-desk');
    assert.ok(t, 'template is registered');
    const json = JSON.stringify(t);

    // Mail: a mailbox connector writing into a table, and a reply going out.
    const mailbox = (t.dataModel.connectors || []).find((c) => c.kind === 'mailbox');
    assert.ok(mailbox, 'a mailbox connector');
    // Conversations dedupe on thread_key; the individual messages hang under
    // them as a child keyed on the provider's message id.
    assert.strictEqual(mailbox.groupIntoThreads, true, 'tickets appear by themselves');
    assert.strictEqual(mailbox.sync.keyField, 'thread_key', 'dedupe key');
    assert.strictEqual(mailbox.sync.children[0].keyField, 'provider_message_id', 'child dedupe key');
    assert.ok(Number.isInteger(mailbox.sync.retentionDays), 'retention is set');
    assert.ok(mailbox.query, 'scoped so installing it does not ingest a whole personal inbox');
    assert.ok(json.includes('"kind":"send_email"') || json.includes('send_email'), 'a send_email step');

    // Layout: a full-height section and panes.
    assert.ok(json.includes('"height":"fill"'), 'a full-height section/pane');
    assert.ok(json.includes('"type":"pane"'), 'panes');

    // The conversation view and the composer that fills itself.
    assert.ok(json.includes('"type":"message_thread"'), 'a message thread');
    assert.ok(json.includes('sideMap'), 'per-row sides');
    assert.ok(json.includes('valueFrom'), 'a composer an AI draft can fill');
    assert.ok(json.includes('promptContext'), 'the AI draft sees the ticket');

    // Numbers.
    assert.ok(json.includes('"kind":"aggregate"'), 'aggregate bindings');
    assert.ok(json.includes('"fn":"p50"'), 'a percentile');
    assert.ok(json.includes('"bucket":"hour"'), 'the hour histogram');

    // Live.
    const inbox = t.definition.screens.find((s) => s.id === 'scr_sdinbox');
    assert.ok(inbox.refreshInterval > 0, 'the inbox refreshes itself');
});

test('app-support-desk: clicking a ticket anywhere opens the conversation', () => {
    // The bug this guards: every ticket row already fired act_sdpick, but that
    // action only set variables. On My queue and Customer — screens that render
    // none of those variables — a click therefore did nothing at all.
    const def = getTemplate('app-support-desk').definition;
    const pick = def.actions.act_sdpick;
    const last = pick.steps[pick.steps.length - 1];
    assert.equal(last.kind, 'navigate', 'act_sdpick ends by going somewhere');
    assert.equal(last.screenId, 'scr_sdinbox', 'and that somewhere is the conversation view');
    // The variables must be published BEFORE the jump, or the inbox renders the
    // previous ticket for a frame.
    assert.ok(pick.steps.slice(0, -1).every((s) => s.kind === 'set_variable'), 'navigate is last');

    // Every place a TICKET is listed must be wired to it — a grid that lists
    // tickets and does nothing on click is the thing being fixed here. Anything
    // listing something else (attachments) is expected to have its own action,
    // but it must never be left dead.
    const wired = [];
    const walk = (nodes) => {
        for (const n of nodes || []) {
            wired.push({ id: n.id, type: n.type, action: n.onRowClick || null, source: n.props?.source || null });
            walk(n.children);
        }
    };
    for (const screen of def.screens) for (const section of screen.sections || []) walk(section.children);

    // Row-clickable components reading ticket ROWS (an aggregate over the same
    // table is a count, not a row list — clicking a tally opens nothing).
    const ticketRows = wired.filter((n) => ['list', 'data_grid'].includes(n.type)
        && n.source?.kind === 'records' && n.source.tableId === 'tbl_sdthr');
    assert.deepEqual(
        ticketRows.filter((n) => n.action !== 'act_sdpick').map((n) => n.id),
        [],
        'every component listing tickets opens the conversation',
    );
    assert.equal(ticketRows.length, 3, 'inbox list, my-queue grid and customer grid');

    // The attachment list opens the attachment, not the ticket.
    const att = wired.find((n) => n.id === 'cmp_sdattl');
    assert.equal(att.action, 'act_sdpickatt');
});

test('app-support-desk proves the document capability end to end', () => {
    const t = getTemplate('app-support-desk');
    const json = JSON.stringify(t);

    // Attachments arrive as their own grain, under the MESSAGE.
    const mailbox = t.dataModel.connectors.find((c) => c.kind === 'mailbox');
    assert.strictEqual(mailbox.includeAttachmentMeta, true);
    const attChild = mailbox.sync.children.find((c) => c.tableId === 'tbl_sdatt');
    assert.ok(attChild, 'the attachments child');
    assert.strictEqual(attChild.level, 2);
    assert.strictEqual(attChild.parentLevel, 1, 'an attachment belongs to its message, not to the ticket');

    // A file column to hold it, and a viewer to show it.
    const atts = t.dataModel.tables.find((x) => x.id === 'tbl_sdatt');
    assert.ok(atts.fields.some((f) => f.key === 'file' && f.type === 'file'));
    assert.ok(json.includes('"type":"file_preview"'), 'the inline viewer');

    // …and the extraction, with provenance. Rows that name no ticket cannot be
    // shown in context and cannot be found by a retention purge.
    const extract = t.definition.actions.act_sdextract.steps.find((s) => s.kind === 'ai_extract');
    assert.ok(extract, 'an ai_extract step');
    assert.strictEqual(extract.writeTo.tableId, 'tbl_sdinv');
    assert.ok(extract.writeTo.constants.thread_key, 'each row names its conversation');
    assert.ok(extract.writeTo.constants.source_file, 'and the document it came from');

    // A tier the tier map is actually keyed by — 'tier:smart' silently demoted
    // every AI step in this template to the standard model.
    assert.ok(!json.includes('tier:smart'), 'no tier:-prefixed model tier anywhere');
});

// ── Offerte-intake: the quote-intake template's own invariants ──────────────

test('app-quote-intake: mailbox invariants match the support-desk spine', () => {
    const t = getTemplate('app-quote-intake');
    assert.ok(t, 'template is registered');

    const mailbox = (t.dataModel.connectors || []).find((c) => c.kind === 'mailbox');
    assert.ok(mailbox, 'a mailbox connector');
    assert.strictEqual(mailbox.groupIntoThreads, true, 'aanvragen appear by themselves');
    assert.strictEqual(mailbox.sync.keyField, 'thread_key', 'dedupe key');
    assert.ok(Number.isInteger(mailbox.sync.retentionDays), 'retention is set');
    assert.ok(mailbox.query, 'scoped so installing never ingests a personal inbox');
    assert.strictEqual(mailbox.includeAttachmentMeta, true, 'drawings arrive as pending descriptors');

    const msgChild = mailbox.sync.children.find((c) => c.tableId === 'tbl_qimsg');
    assert.ok(msgChild && msgChild.keyField === 'provider_message_id' && msgChild.retentionCascade === true);
    const attChild = mailbox.sync.children.find((c) => c.tableId === 'tbl_qiatt');
    assert.ok(attChild, 'the attachments child');
    assert.strictEqual(attChild.level, 2);
    assert.strictEqual(attChild.parentLevel, 1, 'an attachment belongs to its message, not the aanvraag');
    assert.strictEqual(attChild.retentionCascade, true);
});

test('app-quote-intake: the grid commit covers every editable column, single-column writes', () => {
    // The bug this guards: an editable data_grid whose onRowSelect is missing
    // (the support desk's saved-replies grid) silently drops every cell edit.
    // And a commit that writes the WHOLE row would let two verkopers clobber
    // each other's cells — each case must write exactly its own column.
    const def = getTemplate('app-quote-intake').definition;

    const grids = [];
    const walk = (nodes) => {
        for (const n of nodes || []) {
            if (n.type === 'data_grid') grids.push(n);
            walk(n.children);
        }
    };
    for (const screen of def.screens) for (const section of screen.sections || []) walk(section.children);

    const commitActionByGrid = {
        cmp_qigrid: 'act_qigridcommit',
        cmp_qimatg: 'act_qimatcommit',
        cmp_qicolg: 'act_qicolcommit',
        cmp_qiopg: 'act_qiopcommit',
    };

    for (const grid of grids) {
        // Derived from the grid itself, not a hardcoded snapshot — a number
        // column added later is covered automatically.
        const numberColumns = new Set((grid.props.columns || [])
            .filter((c) => c.format === 'number' && c.editable === true)
            .map((c) => c.key));
        const editable = (grid.props.columns || []).filter((c) => c.editable === true).map((c) => c.key);
        if (editable.length === 0) {
            assert.ok(!grid.onRowSelect, `${grid.id}: no editable columns, so no commit event`);
            continue;
        }
        const actionId = commitActionByGrid[grid.id];
        assert.ok(actionId, `${grid.id}: an editable grid this test does not know about`);
        assert.equal(grid.onRowSelect, actionId, `${grid.id}: cell edits must be wired to ${actionId}`);
        // selectable:'none' is what makes onRowSelect a pure cell-edit event —
        // with selection on, the same slot also fires with {selected} payloads.
        assert.equal(grid.props.selectable, 'none', `${grid.id}: selection would overload the commit event`);

        const action = def.actions[actionId];
        const sw = action.steps.find((s) => s.kind === 'switch');
        assert.ok(sw && sw.expr === 'form.__edited', `${actionId}: a switch on form.__edited`);
        const caseValues = sw.cases.map((c) => c.value);
        assert.deepEqual([...caseValues].sort(), [...editable].sort(),
            `${actionId}: exactly one case per editable column`);
        for (const c of sw.cases) {
            assert.equal(c.steps.length, 1, `${actionId}[${c.value}]: one step per case`);
            const upd = c.steps[0];
            assert.equal(upd.kind, 'update_record');
            assert.deepEqual(Object.keys(upd.values), [c.value],
                `${actionId}[${c.value}]: writes exactly its own column`);
            // Compare-and-set on the row the person actually edited: without
            // it, two people in the same grid overwrite each other silently.
            assert.deepEqual(upd.expectedUpdatedAt, { kind: 'formula', expr: 'form.updated_at' },
                `${actionId}[${c.value}]: carries the row's CAS token`);
            const expr = upd.values[c.value].expr;
            if (numberColumns.has(c.value)) {
                // '' must become NULL, and STRICTLY: 0 == '' is true, so a loose
                // ternary would turn a real 0 into NULL. Pinned as the EXACT
                // expression — a substring check let an inverted ternary
                // (destroying every edit) pass.
                assert.equal(expr, `form.${c.value} === '' ? null : form.${c.value}`,
                    `${actionId}[${c.value}]: number column needs the strict empty-string ternary`);
            }
        }
        // The commit must end by refreshing the table, or the CSV block (which
        // reads the shared records cache) keeps showing the pre-edit rows.
        const last = action.steps[action.steps.length - 1];
        assert.equal(last.kind, 'refresh', `${actionId}: ends with a refresh`);
        // Provenance stays read-only.
        if (grid.id === 'cmp_qigrid') {
            const bron = grid.props.columns.find((c) => c.key === 'bron_bestand');
            assert.ok(bron && bron.editable !== true, 'bron_bestand is not editable');
            assert.ok(!caseValues.includes('bron_bestand'), 'and has no commit case');
        }
    }
    assert.ok(grids.some((g) => g.id === 'cmp_qigrid'), 'the projectlines grid exists');
});

test('app-quote-intake: the CSV column chain is pinned end to end', () => {
    // The portal's import format is DATA now: a seeded Portal-format table
    // whose rows feed the generate_file columns binding. Three things must
    // agree — the seed (24 columns, exact portal order, each pulling from a
    // real projectregels field XOR printing a constant), the generate_file
    // step that renders them, and the projectregels table itself (the old
    // computed-CSV columns must stay gone). This test is the tripwire.
    const t = getTemplate('app-quote-intake');

    // The quoting portal's header line, in exact order.
    const PORTAL_ORDER = [
        'cadfile', 'Material', 'Thickness', 'Quantity', 'Orientation',
        'CuttingStrategyDesc', 'Finishing', 'Operation', 'CertificateRequested',
        'CheckboxCustom1', 'CheckboxCustom2', 'CheckboxCustom3', 'CheckboxCustom4', 'CheckboxCustom5',
        'DropDownCustom1', 'DropDownCustom2', 'DropDownCustom3', 'DropDownCustom4', 'DropDownCustom5',
        'CountCustom1', 'CountCustom2', 'CountCustom3', 'CountCustom4', 'CountCustom5',
    ];

    const lines = t.dataModel.tables.find((x) => x.id === 'tbl_qiline');
    const lineKeys = new Set(lines.fields.map((f) => f.key));

    // The seeded portal format: all 24 names, in portal order, both by array
    // position and by the `order` column generate_file actually sorts on.
    const seed = t.seed.tbl_qicol;
    assert.deepEqual(seed.map((r) => r.name), PORTAL_ORDER, 'the 24 portal columns in exact order');
    assert.deepEqual(seed.map((r) => r.order), PORTAL_ORDER.map((_, i) => i + 1),
        'the order column matches the array order 1..24');
    for (const row of seed) {
        assert.strictEqual(row.active, true, `${row.name}: seeded active`);
        const hasFrom = typeof row.from === 'string' && row.from.length > 0;
        const hasValue = row.value !== null && row.value !== undefined;
        // XOR: a row either copies a field or prints a constant — carrying
        // both would silently hide the constant (from wins at render time).
        assert.notStrictEqual(hasFrom, hasValue, `${row.name}: exactly one of from/value`);
        if (hasFrom) {
            assert.ok(lineKeys.has(row.from), `${row.name}: from "${row.from}" is a real projectregels field`);
        }
    }
    // The portal reads geometry from the CAD file — the cadfile column is the link.
    assert.strictEqual(seed[0].from, 'cad_bestand', 'cadfile prints the CAD filename');

    // The generate_file step renders exactly this table over the thread's rows.
    const findStep = (steps, kind) => {
        for (const s of steps || []) {
            if (s.kind === kind) return s;
            const hit = findStep(s.steps, kind) || findStep(s.then, kind) || findStep(s.else, kind)
                || (s.cases || []).map((c) => findStep(c.steps, kind)).find(Boolean);
            if (hit) return hit;
        }
        return null;
    };
    const gen = findStep(t.definition.actions.act_qimakecsv.steps, 'generate_file');
    assert.ok(gen, 'act_qimakecsv carries a generate_file step');
    assert.strictEqual(gen.rows.kind, 'records');
    assert.strictEqual(gen.rows.tableId, 'tbl_qiline', 'rows come from the project lines');
    assert.strictEqual(gen.columns.kind, 'records');
    assert.strictEqual(gen.columns.tableId, 'tbl_qicol', 'columns come from the Portal-format table');
    assert.strictEqual(gen.delimiter, ';', 'the portal reads semicolons');
    // BOTH attachTo halves: an unlinked ledger row is downloadable by the app
    // owner only — the validator errors on half, this pins the whole. The
    // field-exists half is asserted here because the validator's own check is
    // broken (see the ALLOWED_WARNINGS note above).
    assert.ok(gen.attachToRecordId, 'the file is attached to the request');
    assert.strictEqual(gen.attachToFieldKey, 'csv_file', 'on its csv_file column');
    const thr = t.dataModel.tables.find((x) => x.id === 'tbl_qithr');
    const csvField = thr.fields.find((f) => f.key === 'csv_file');
    assert.ok(csvField && csvField.type === 'file', 'csv_file is a real file column on the request');

    // The old computed-CSV machinery must stay gone: the 24-column format
    // cannot fit the 500-char computed cap, and the profile is data now.
    for (const goneKey of ['csv_regel', 'area_m2', 'total_area_m2', 'lengte_mm', 'breedte_mm']) {
        assert.ok(!lineKeys.has(goneKey), `${goneKey} is gone from projectregels`);
    }
});

test('app-quote-intake: intake, operations and retention hold their contracts', () => {
    const t = getTemplate('app-quote-intake');

    // Every seeded operation counts into a real op_count_* column — the
    // CountCustom mapping would otherwise print empty cells forever.
    const lines = t.dataModel.tables.find((x) => x.id === 'tbl_qiline');
    const lineKeys = new Set(lines.fields.map((f) => f.key));
    for (const op of t.seed.tbl_qiop) {
        assert.match(op.doel_kolom, /^op_count_[1-5]$/, `${op.naam}: doel_kolom is an op-count column`);
        assert.ok(lineKeys.has(op.doel_kolom), `${op.naam}: "${op.doel_kolom}" exists on projectregels`);
    }

    // Button 1: the file_intake step upserts on base_name (without it every
    // re-run duplicates the grid) and stamps conversation + retention date.
    const findStep = (steps, kind) => {
        for (const s of steps || []) {
            if (s.kind === kind) return s;
            const hit = findStep(s.steps, kind) || findStep(s.then, kind) || findStep(s.else, kind)
                || (s.cases || []).map((c) => findStep(c.steps, kind)).find(Boolean);
            if (hit) return hit;
        }
        return null;
    };
    const intake = findStep(t.definition.actions.act_qiintake.steps, 'file_intake');
    assert.ok(intake, 'act_qiintake carries a file_intake step');
    assert.strictEqual(intake.connectorId, 'conn_qimail');
    assert.strictEqual(intake.writeTo.tableId, 'tbl_qiline');
    assert.ok(Object.values(intake.writeTo.mapping).includes('base_name'),
        'some column maps base_name — the upsert key');
    assert.strictEqual(intake.writeTo.mapping.basisnaam, 'base_name', 'and it is basisnaam');
    assert.ok(intake.writeTo.constants.thread_key, 'rows name their conversation');
    assert.ok(intake.writeTo.constants.toegevoegd_op, 'and carry the retention stamp');

    // The connector governs the lifetime of the tables it never writes: the
    // dependents declaration is what pulls projectregels, activiteit and
    // eindcontrole into the retention purge (the old KNOWN GAP, closed).
    const mailbox = t.dataModel.connectors.find((c) => c.kind === 'mailbox');
    const deps = mailbox.sync.dependents;
    assert.deepEqual(
        deps.map((d) => d.tableId).sort(),
        ['tbl_qiact', 'tbl_qicheck', 'tbl_qiline'].sort(),
        'all three thread_key-linked tables are declared',
    );
    for (const dep of deps) {
        const table = t.dataModel.tables.find((x) => x.id === dep.tableId);
        const field = table.fields.find((f) => f.key === dep.retentionField);
        assert.ok(field, `${table.key}: retentionField "${dep.retentionField}" exists`);
        assert.strictEqual(field.type, 'datetime', `${table.key}: retentionField is a datetime column`);
    }
});

test('app-quote-intake: reply, classification and roles hold their contracts', () => {
    const t = getTemplate('app-quote-intake');
    const def = t.definition;

    // send_email ships ONLY the six allowed fields — `to`/`subject`/`cc`
    // detach the reply and fork the thread on the next sync.
    const send = def.actions.act_qisend.steps.find((s) => s.kind === 'send_email');
    assert.ok(send, 'a send_email step');
    assert.deepEqual(
        Object.keys(send).sort(),
        ['body', 'bodyFormat', 'connectorId', 'kind', 'recordOutbound', 'replyToThreadKey', 'resultVar'].sort(),
        'send_email carries exactly the reply-threading fields',
    );

    // Server-side steps may not read actions.* — the executor pins the server
    // scope's `actions` to {}, so such a formula silently resolves to null.
    // (Structured AI results travel via vars.<resultVar>.*.) Derived from the
    // spec, not hardcoded: a ninth server kind must not escape this scan.
    const SERVER_STEPS = new Set(DATA_MUTATING_STEP_KINDS);
    const offenders = [];
    const walkSteps = (steps, actionId) => {
        for (const s of steps || []) {
            if (SERVER_STEPS.has(s.kind)) {
                const scan = (v) => {
                    if (!v) return;
                    if (typeof v === 'object') {
                        if (v.kind === 'formula' && typeof v.expr === 'string' && /\bactions\./.test(v.expr)) {
                            offenders.push(`${actionId}: ${v.expr}`);
                        }
                        for (const inner of Object.values(v)) scan(inner);
                    }
                };
                scan(s);
            }
            walkSteps(s.steps, actionId);
            walkSteps(s.then, actionId);
            walkSteps(s.else, actionId);
            walkSteps(s.default, actionId);
            for (const c of s.cases || []) walkSteps(c.steps, actionId);
        }
    };
    for (const [actionId, action] of Object.entries(def.actions)) walkSteps(action.steps, actionId);
    assert.deepEqual(offenders, [], 'no server step reads actions.*');

    // The classify handoff goes through vars.<resultVar>.
    const classify = def.actions.act_qiclassify.steps;
    const gen = classify.find((s) => s.kind === 'ai_generate');
    assert.equal(gen.output, 'structured');
    const upd = classify.find((s) => s.kind === 'update_record');
    assert.ok(Object.values(upd.values).some((v) => v.expr && v.expr.startsWith(`vars.${gen.resultVar}.`)),
        'the update reads the structured result via vars');

    // Re-classification must not knock an answered aanvraag back into the open
    // queue: the status write promotes only from 'nieuw'.
    assert.ok(upd.values.status.kind === 'formula' && upd.values.status.expr.includes("'nieuw'"),
        'the classify status write is conditional on the current status');

    // AI prompt context reads newest-first: LIMIT and the 8k serialization cap
    // both truncate the tail, so 'asc' would drop the newest customer mail.
    for (const actionId of ['act_qiclassify', 'act_qidraft']) {
        const step = def.actions[actionId].steps.find((s) => s.kind === 'ai_generate');
        assert.deepEqual(step.promptContext.sort, [{ field: 'received_at', dir: 'desc' }],
            `${actionId}: promptContext keeps the newest messages`);
    }

    // Clearing the status pill must publish NULL — '' survives filter
    // resolution and empties the inbox (`status = ''` matches nothing).
    const filterStep = def.actions.act_qifilter.steps[0];
    assert.ok(filterStep.value.expr.includes('? null :'),
        'the pill clear branch yields null, not the empty string');

    // Roles agree by value across the two shapes; nobody gets in by default;
    // every table opts into explicit grants; the audit trail is append-only.
    const dmKeys = t.dataModel.roles.map((r) => r.key).sort();
    const defIds = def.roles.map((r) => r.id).sort();
    assert.deepEqual(dmKeys, defIds, 'dataModel roles ≡ definition roles');
    assert.strictEqual(t.dataModel.roleMapping.default, null, 'no role by default — publication is not mail access');
    for (const table of t.dataModel.tables) {
        assert.equal(table.access.default, 'role', `${table.key}: every grant is a decision`);
    }
    const audit = t.dataModel.tables.find((x) => x.id === 'tbl_qiact');
    for (const [role, grant] of Object.entries(audit.access.roles)) {
        assert.strictEqual(grant.update, false, `${role} cannot edit the audit trail`);
        assert.strictEqual(grant.delete, false, `${role} cannot delete the audit trail`);
    }

    // No tier:-prefixed model tier anywhere (it misses the tier map and
    // silently demotes to the standard model).
    assert.ok(!JSON.stringify(t).includes('"modelTier":"tier:'), 'bare tier names only');
});

test('app-quote-intake: the navigation actually organises the app', () => {
    // The template ships nav.style 'mega', which renders group PANELS. Two
    // things make that work rather than look broken, and both are easy to lose
    // in an edit: every nav screen sits in exactly one group, and every one of
    // them has the description the panel shows under its name.
    const t = getTemplate('app-quote-intake');
    const { def } = canonicalizeAppDefinition(t.definition);

    assert.equal(def.nav.style, 'mega');
    const grouped = def.nav.groups.flatMap((g) => g.screens);
    assert.equal(new Set(grouped).size, grouped.length, 'no screen appears in two groups');

    const navScreens = def.screens.filter((s) => s.showInNav !== false);
    for (const screen of navScreens) {
        assert.ok(grouped.includes(screen.id), `${screen.name} is in no nav group — it would sit outside the menu`);
        assert.ok(screen.description && screen.description.length > 10,
            `${screen.name} has no menu description, so the mega panel shows a bare name`);
    }
    // The home screen must be reachable as itself, not only through a group.
    assert.ok(navScreens.some((s) => s.id === def.homeScreenId), 'the home screen is a nav screen');
});

test('app-quote-intake: the status vocabulary agrees across all four surfaces', () => {
    // status is written by the select, dragged on the board, drawn by the
    // stepper and coloured by the pills. Four places, one vocabulary — a value
    // added to the column and forgotten in the stepper renders as a stage that
    // can never be current.
    const t = getTemplate('app-quote-intake');
    const { def } = canonicalizeAppDefinition(t.definition);

    const table = t.dataModel.tables.find((x) => x.id === 'tbl_qithr');
    const statusValues = table.fields.find((f) => f.key === 'status').options.map((o) => o.value);

    const nodes = [];
    const walk = (list) => { for (const n of list || []) { nodes.push(n); walk(n.children); } };
    for (const screen of def.screens) for (const section of screen.sections || []) walk(section.children);

    const steppers = nodes.filter((n) => n.type === 'stepper');
    assert.ok(steppers.length >= 1, 'the workspace draws the pipeline');
    for (const s of steppers) {
        assert.deepEqual(s.props.steps.map((x) => x.value), statusValues, 'stepper stages ≡ the status column');
    }
    const board = nodes.find((n) => n.type === 'kanban');
    assert.equal(board.props.groupByField, 'status');
    assert.deepEqual(board.props.columns.map((c) => c.value), statusValues, 'board columns ≡ the status column');
    // Dragging a card is a status change like any other — it must leave the
    // same audit trail the dropdown does, or the board becomes a back door.
    const move = def.actions[board.onCardMove].steps;
    assert.ok(move.some((s) => s.kind === 'update_record' && s.values.status), 'the drag writes the status');
    assert.ok(move.some((s) => s.kind === 'create_record' && s.tableId === 'tbl_qiact'), 'and records it');

    const pills = nodes.find((n) => n.type === 'badge_list');
    assert.deepEqual(pills.props.colorMap.map((c) => c.value), statusValues, 'pill vocabulary ≡ the status column');
});

test('app-quote-intake: the app can see its own mailbox', () => {
    // The complaint this answers: an empty app and a disconnected mailbox
    // looked identical from the inside. The connection card must exist, name
    // the real connector, and sit on a screen the sales role can actually open.
    const t = getTemplate('app-quote-intake');
    const { def } = canonicalizeAppDefinition(t.definition);
    const connectorIds = new Set(t.dataModel.connectors.map((c) => c.id));

    let card = null;
    let owningScreen = null;
    for (const screen of def.screens) {
        const walk = (list) => {
            for (const n of list || []) {
                if (n.type === 'connector_status') { card = n; owningScreen = screen; }
                walk(n.children);
            }
        };
        for (const section of screen.sections || []) walk(section.children);
    }
    assert.ok(card, 'a connection card exists');
    assert.ok(connectorIds.has(card.props.connectorId), 'and points at a connector that exists');
    assert.ok(!owningScreen.visibleToRoles || owningScreen.visibleToRoles.includes('verkoper'),
        'sales can reach it — they are the ones staring at an empty inbox');
});

test('app-quote-intake stays inside the definition budget', () => {
    const t = getTemplate('app-quote-intake');
    const def = t.definition;
    const bytes = Buffer.byteLength(JSON.stringify(def), 'utf8');
    assert.ok(bytes < LIMITS.MAX_DEFINITION_BYTES, `definition ${bytes} bytes exceeds the cap`);
    assert.ok(Object.keys(def.actions).length <= LIMITS.MAX_ACTIONS, 'inside the action cap');
    assert.ok(def.screens.length <= LIMITS.MAX_SCREENS, 'inside the screen cap');
});

test('app-support-desk stays inside the definition budget', () => {
    const t = getTemplate('app-support-desk');
    const def = t.definition;

    let nodes = 0;
    let maxDepth = 0;
    // Depth is a property of a NODE, not of the walk — recording it on entry
    // counted every leaf one level too deep and made this stricter than
    // validate.js, which is the thing that actually gates a save.
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
    // The split layout spends one of the five nesting levels; going over is the
    // most likely way a future edit breaks this template.
    assert.ok(maxDepth <= LIMITS.MAX_DEPTH, `depth ${maxDepth} <= ${LIMITS.MAX_DEPTH}`);
    assert.ok(JSON.stringify(def).length < 512 * 1024, 'definition size');
});
