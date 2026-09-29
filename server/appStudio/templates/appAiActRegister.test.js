/**
 * AI system register — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates and that its
 * seed rows conform to their columns. None of that can catch the two failures
 * this template is actually exposed to.
 *
 * ONE — THE VOCABULARIES DRIFTING APART. Risk tiers and Annex III use cases are
 * text keys pointing at config tables rather than `select` options, which is
 * what makes them editable by the compliance officer instead of by a developer
 * (see the module header). The price is that nothing in the schema ties
 * `ai_systems.risk_tier` to a row in `risk_tiers`. A system in a tier no column
 * collects does not error: it lands in a nameless trailing column of the triage
 * board and the register looks broken on the first screen a customer sees. Same
 * for a use case whose `default_tier` names a tier that was never defined —
 * that one is worse, because classifying a system would then WRITE the broken
 * value. And because there are no joins, every denormalised `system_name` /
 * `use_case_name` copy is a fact the database cannot keep honest.
 *
 * TWO — THE STATUTORY DEADLINE. Article 73 gives a serious incident 15 days
 * from AWARENESS, 10 where a person died, 2 for a widespread infringement or a
 * serious and irreversible disruption of critical infrastructure. That
 * arithmetic is a formula string inside an action; nothing in the platform
 * knows it is a legal deadline, so nothing but this file will notice if it is
 * counted from the wrong date or with the wrong offset. So the test COMPILES
 * the formula and runs it, rather than reading it.
 *
 * Run: cd server && node --test appStudio/templates/appAiActRegister.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appAiActRegister');
const { canonicalizeAppDefinition } = require('../canonicalize');

const { seed, dataModel, definition } = template;

const rowsOf = (tableId) => seed[tableId] || [];
const keysOf = (tableId, key) => new Set(rowsOf(tableId).map((r) => r[key]));
const tableOf = (tableId) => dataModel.tables.find((t) => t.id === tableId);
const fieldOf = (tableId, key) => (tableOf(tableId).fields || []).find((f) => f.key === key);

/** Every seeded row that carries a `$id`, by alias — for following a { $ref }. */
const BY_ALIAS = new Map(
    Object.values(seed).flat().filter((r) => typeof r.$id === 'string').map((r) => [r.$id, r]),
);

/** Every node in the definition, flattened. */
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

const CANON = canonicalizeAppDefinition(definition).def;
const NODES = allNodes(CANON);
const nodeById = (id) => NODES.find((n) => n.id === id);
const screenById = (id) => CANON.screens.find((s) => s.id === id);

/** Flatten an action's steps, following condition/loop/switch branches. */
function flatSteps(action) {
    const out = [];
    const walk = (steps) => {
        for (const s of steps || []) {
            out.push(s);
            for (const branch of ['then', 'else', 'steps']) if (Array.isArray(s[branch])) walk(s[branch]);
            for (const c of Array.isArray(s.cases) ? s.cases : []) walk(c.steps);
        }
    };
    if (action.kind === 'sequence') walk(action.steps); else out.push(action);
    return out;
}

// ── The vocabularies agree ──────────────────────────────────────────────────

test('every seeded system is in a tier the vocabulary defines', () => {
    const tiers = keysOf('tbl_tiers01', 'key');
    for (const sys of rowsOf('tbl_aisys01')) {
        assert.ok(tiers.has(sys.risk_tier),
            `"${sys.name}" is in tier "${sys.risk_tier}", which risk_tiers does not define — it would land in a nameless column of the triage board`);
    }
});

/**
 * The dangerous direction. `risk_tier` has a column default, but the seed IS
 * the install: a row that omits the key leans on DDL nobody reading this file
 * can see, and the "Unclassified" counter — the number this whole template
 * exists to show — would silently depend on it.
 */
test('no seeded system leaves its tier to the column default', () => {
    for (const sys of rowsOf('tbl_aisys01')) {
        assert.equal(typeof sys.risk_tier, 'string',
            `"${sys.name}" has no explicit risk_tier in the seed`);
        assert.notEqual(sys.risk_tier, '', `"${sys.name}" has an empty risk_tier`);
    }
});

test('every use case triggers a tier that exists', () => {
    const tiers = keysOf('tbl_tiers01', 'key');
    for (const uc of rowsOf('tbl_usecase1')) {
        assert.ok(tiers.has(uc.default_tier),
            `use case "${uc.name}" triggers tier "${uc.default_tier}", which risk_tiers does not define — classifying a system against it would write a broken value`);
    }
});

/**
 * There are no joins, so the register grid and the triage cards read a
 * DENORMALISED copy of the use case's name. A copy that disagrees with the row
 * it points at is a register that describes a system it is not describing.
 */
test('every system\'s use_case_name matches the use case it points at', () => {
    for (const sys of rowsOf('tbl_aisys01')) {
        if (!sys.use_case_id) {
            assert.equal(sys.use_case_name, undefined,
                `"${sys.name}" carries a use-case name with no use case behind it`);
            continue;
        }
        const uc = BY_ALIAS.get(sys.use_case_id.$ref);
        assert.ok(uc, `"${sys.name}" references a use case alias that is not seeded`);
        assert.equal(sys.use_case_name, uc.name,
            `"${sys.name}" displays use case "${sys.use_case_name}" but points at "${uc.name}"`);
    }
});

/**
 * The seed must not ship a system whose tier contradicts the use case it was
 * classified against. A LATER hand-drag on the triage board legitimately may —
 * the officer overrules the rule and records why under Assessments — but a
 * template that installs already self-contradicting teaches the wrong thing on
 * the first screen.
 */
test('a classified system carries the tier its use case triggers', () => {
    for (const sys of rowsOf('tbl_aisys01')) {
        if (!sys.use_case_id) continue;
        const uc = BY_ALIAS.get(sys.use_case_id.$ref);
        assert.equal(sys.risk_tier, uc.default_tier,
            `"${sys.name}" is "${sys.risk_tier}" but its use case "${uc.name}" triggers "${uc.default_tier}"`);
    }
});

test('every child row names the system it actually hangs off', () => {
    for (const tableId of ['tbl_overs01', 'tbl_incid01', 'tbl_asmnt01']) {
        for (const row of rowsOf(tableId)) {
            const sys = BY_ALIAS.get(row.system_id.$ref);
            assert.ok(sys, `${tableId} row references a system alias that is not seeded`);
            assert.equal(row.system_name, sys.name,
                `a ${tableId} row displays "${row.system_name}" but hangs off "${sys.name}"`);
        }
    }
});

test('the tier tone map on the screens covers every seeded tier', () => {
    const board = nodeById('cmp_trtiers');
    const mapped = new Set(board.props.badgeToneMap.map((m) => m.value));
    for (const key of keysOf('tbl_tiers01', 'key')) {
        assert.ok(mapped.has(key), `tier "${key}" has no colour on the triage tier list`);
    }
    // Same literal list feeds the register's filter dropdown, which is the one
    // place the config-as-data story has a seam (author-time options, not a
    // binding). If it ever loses a tier, that tier becomes unfilterable.
    const bar = nodeById('cmp_regfilt');
    const tierField = bar.props.fields.find((f) => f.name === 'tier');
    const offered = new Set(tierField.options.map((o) => o.value));
    for (const key of keysOf('tbl_tiers01', 'key')) {
        assert.ok(offered.has(key), `tier "${key}" cannot be filtered for on the register`);
    }
});

// ── Unclassified is a tier, not a missing value ─────────────────────────────

test('"unclassified" is a real, first, red tier — not a null', () => {
    const rows = rowsOf('tbl_tiers01');
    const unclassified = rows.find((t) => t.key === 'unclassified');
    assert.ok(unclassified, 'the vocabulary must define an unclassified tier, or an unclassified system is invisible');
    assert.equal(unclassified.color, 'danger', 'an unknown risk is a red state, not a grey one');
    const first = rows.slice().sort((a, b) => a.position - b.position)[0];
    assert.equal(first.key, 'unclassified', 'it has to be the first column of the triage board');
    // And the column default agrees, so a system created outside the app's own
    // form still lands there rather than in a nameless column.
    assert.equal(fieldOf('tbl_aisys01', 'risk_tier').default, 'unclassified');
});

test('registering a system does not classify it', () => {
    const create = flatSteps(definition.actions.act_regcreate).find((s) => s.kind === 'create_record');
    assert.equal(create.tableId, 'tbl_aisys01');
    assert.deepEqual(create.values.risk_tier, { kind: 'static', value: 'unclassified' },
        'the create form must not be able to set a tier — triage is a separate, visible decision');
    assert.equal(create.values.use_case_id, undefined, 'and it must not set a use case either');
    // The form itself offers no tier control, or the action above would be a lie.
    const form = nodeById('cmp_regform');
    const names = form.children.map((c) => c.props && c.props.name).filter(Boolean);
    assert.equal(names.includes('risk_tier'), false);
});

test('the seed ships unclassified systems, so the counter is not zero on install', () => {
    const unclassified = rowsOf('tbl_aisys01').filter((s) => s.risk_tier === 'unclassified');
    assert.ok(unclassified.length >= 2,
        `expected the register to install with real unclassified systems; found ${unclassified.length}`);
    // …and at least one of them is actually running, which is the case that
    // makes the red column mean something rather than decorate a backlog.
    assert.ok(unclassified.some((s) => s.status === 'in_use'),
        'at least one unclassified system must be in use — a planned one is not yet a risk');
});

// ── The triage board reads its configuration, not its props ─────────────────

test('the board groups by the column the tier table supplies as its value', () => {
    const board = nodeById('cmp_trboard');
    assert.equal(board.props.groupByField, 'risk_tier');
    assert.equal(board.props.columnsSource.tableId, 'tbl_tiers01');
    // normalizeAxisRows reads a column's `value` from value|state|key —
    // risk_tiers carries `key`, which is also what a system stores. Rename
    // either side without the other and every card falls into one trailing
    // column.
    assert.ok(fieldOf('tbl_tiers01', 'key'), 'risk_tiers must carry a `key` column');
    assert.ok(fieldOf('tbl_aisys01', board.props.groupByField), 'ai_systems must carry the field the board groups by');
    // Columns in the officer's order, so 'unclassified' at position 0 really is
    // the leftmost column.
    assert.deepEqual(board.props.columnsSource.sort, [{ field: 'position', dir: 'asc' }]);
});

test('the drag writes the tier the column stands for', () => {
    const board = nodeById('cmp_trboard');
    const move = definition.actions[board.onCardMove];
    const update = flatSteps(move).find((s) => s.kind === 'update_record');
    assert.equal(update.tableId, 'tbl_aisys01');
    assert.equal(update.values.risk_tier.expr, 'form.value');
    assert.equal(update.recordId.expr, 'form.item.id');
});

/**
 * The classification rule lives in the use-case row, not in the action. One
 * step writes the relation, the display copy AND the tier — so the officer can
 * correct the rule on Setup instead of asking for a new build.
 */
test('picking a use case classifies the system from the use case itself', () => {
    const list = nodeById('cmp_syscase');
    assert.equal(list.props.source.tableId, 'tbl_usecase1');
    const update = flatSteps(definition.actions[list.onRowClick]).find((s) => s.kind === 'update_record');
    assert.equal(update.tableId, 'tbl_aisys01');
    assert.equal(update.values.risk_tier.expr, 'item.default_tier');
    assert.equal(update.values.use_case_id.expr, 'item.id');
    // The denormalised copy is written in the SAME step as the relation, which
    // is the only way it cannot be forgotten.
    assert.equal(update.values.use_case_name.expr, 'item.name');
});

// ── The statutory deadline (Article 73) ─────────────────────────────────────

/**
 * The offsets the Act actually gives, and the ONLY reason the three "serious"
 * severities are distinguished at all.
 */
const STATUTORY_DAYS = { serious: 15, serious_death: 10, serious_infra: 2 };

/** Run the authored formula through the real engine, on the real scope shape. */
async function evalDeadline(severity, awareOn) {
    const { evaluate } = await import('../../shared/expr/index.mjs');
    const step = flatSteps(definition.actions.act_sysinadd).find((s) => s.kind === 'create_record');
    return evaluate(step.values.report_due_on.expr, { form: { severity, became_aware_on: awareOn } });
}

test('the reporting deadline is computed with the offsets Article 73 gives', async () => {
    const aware = '2026-06-09';
    for (const [severity, days] of Object.entries(STATUTORY_DAYS)) {
        const expected = new Date(Date.UTC(2026, 5, 9) + days * 86400000).toISOString().slice(0, 10);
        assert.equal(await evalDeadline(severity, aware), expected,
            `a "${severity}" incident must be reportable within ${days} days of awareness`);
    }
});

test('a non-serious incident gets no deadline at all', async () => {
    // This is load-bearing: the Incidents screen counts outstanding
    // notifications as "has a due date and no reported date". A due date on a
    // minor incident would inflate a statutory backlog with noise.
    for (const severity of ['minor', 'significant']) {
        assert.equal(await evalDeadline(severity, '2026-06-09'), null);
    }
});

test('the clock starts at awareness, never at occurrence', async () => {
    const step = flatSteps(definition.actions.act_sysinadd).find((s) => s.kind === 'create_record');
    const expr = step.values.report_due_on.expr;
    assert.match(expr, /became_aware_on/);
    assert.equal(/occurred_on/.test(expr), false,
        'Article 73 counts from the day the operator became aware — an incident discovered late is still reportable from the day it was found');
    // Proven, not just read: an incident that happened long ago but was found
    // today is still due 15 days from today.
    assert.equal(await evalDeadline('serious', '2026-08-15'), '2026-08-30');
    // And the field the form asks for is required, or the clock has no start.
    assert.equal(nodeById('cmp_sysin3').props.name, 'became_aware_on');
    assert.equal(nodeById('cmp_sysin3').props.required, true);
});

test('every seeded deadline is exactly what the formula would have produced', async () => {
    for (const inc of rowsOf('tbl_incid01')) {
        const expected = await evalDeadline(inc.severity, inc.became_aware_on);
        assert.equal(inc.report_due_on ?? null, expected,
            `"${inc.title}" (${inc.severity}, aware ${inc.became_aware_on}) is seeded with report_due_on ${inc.report_due_on ?? 'null'}, but the register would compute ${expected}`);
    }
});

test('the seed ships one notification that is genuinely overdue', () => {
    // A register whose first screen says "nothing to do" teaches nothing. The
    // template's own date is 2026-08-15; the seeded state is what a real
    // register looks like when someone finally opens it.
    const overdue = rowsOf('tbl_incid01').filter((i) => i.report_due_on && !i.reported_on && i.report_due_on < '2026-08-15');
    assert.ok(overdue.length >= 1, 'expected at least one incident past its reporting deadline');
    // And an outstanding one still inside its deadline, so the screen shows
    // both states rather than only the alarming one.
    const owed = rowsOf('tbl_incid01').filter((i) => i.report_due_on && !i.reported_on);
    assert.ok(owed.length > overdue.length, 'expected an outstanding notification that is not yet late');
});

test('the outstanding-report counter reads exactly "has a deadline, has no notification"', () => {
    const stat = nodeById('cmp_ins2');
    const fields = stat.props.value.filter.map((f) => `${f.field}:${f.op}`);
    assert.deepEqual(fields, ['report_due_on:isNotNull', 'reported_on:isNull']);
    assert.equal(stat.props.value.tableId, 'tbl_incid01');
});

// ── The logic behind the controls ───────────────────────────────────────────

/**
 * A server step's formula scope has no `screen`, `forms`, `actions`, `records`
 * or `datasets`. A binding naming one resolves in the browser preview and
 * writes NULL in production — the worst kind of wrong, because it passes every
 * check an author can run before shipping.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets)\b/;
    const offences = [];

    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (!SERVER_KINDS.has(step.kind)) continue;
            const exprs = [];
            if (step.recordId && step.recordId.expr) exprs.push(['recordId', step.recordId.expr]);
            if (step.expectedUpdatedAt && step.expectedUpdatedAt.expr) exprs.push(['expectedUpdatedAt', step.expectedUpdatedAt.expr]);
            for (const [key, binding] of Object.entries(step.values || {})) {
                if (binding && binding.expr) exprs.push([`values.${key}`, binding.expr]);
            }
            for (const [where, expr] of exprs) {
                if (FORBIDDEN.test(expr.trim())) offences.push(`${actionId}.${where}: ${expr}`);
            }
        }
    }
    assert.deepEqual(offences, []);
});

test('every mutation refreshes the table it dirtied', () => {
    const MUTATING = new Set(['create_record', 'update_record', 'delete_record']);
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        const dirtied = new Set(steps.filter((s) => MUTATING.has(s.kind)).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${actionId} writes ${tableId} but never refreshes it — the change would not appear until something else refetched`);
        }
    }
});

/**
 * Recording an assessment is the event that moves the system's review dates.
 * If it only wrote the assessment, the register would go on saying "never
 * assessed" about a system assessed this morning — and the overdue-review
 * counter on the front screen would be permanently wrong.
 */
test('recording an assessment moves the system\'s own review dates with it', () => {
    const steps = flatSteps(definition.actions.act_sysasadd);
    const onSystem = steps.find((s) => s.kind === 'update_record' && s.tableId === 'tbl_aisys01');
    assert.ok(onSystem, 'the assessment must write back to the system');
    assert.equal(onSystem.values.last_assessed_on.expr, 'form.performed_on');
    assert.equal(onSystem.values.next_review_due.expr, 'form.next_due_on');
    assert.ok(steps.some((s) => s.kind === 'refresh' && s.tableId === 'tbl_aisys01'));
});

/**
 * A write does not update the variable that was clicked. Anything the app can
 * CHANGE about the open system has to be read back through a live binding, or
 * classifying a system leaves the header showing the old tier until the user
 * navigates away and back — and quietly teaches them not to trust the screen.
 */
test('the open system is read live, so a write to it shows immediately', () => {
    const detail = nodeById('cmp_sysdet');
    assert.equal(detail.props.source.kind, 'record');
    assert.equal(detail.props.source.tableId, 'tbl_aisys01');
    const idFilter = detail.props.source.filter.find((f) => f.field === 'id');
    assert.ok(idFilter, 'the detail must be scoped to one record by id');
    assert.equal(idFilter.value.expr, 'vars.system.id', 'the variable supplies identity only');
    assert.equal(idFilter.required, true, 'with nothing open it must show its empty state, not the first system in the table');
    // The fields the classification writes are on this live view, which is the
    // whole reason it is live.
    const keys = detail.props.fields.map((f) => f.key);
    for (const key of ['risk_tier', 'use_case_name']) assert.ok(keys.includes(key));
});

test('inline editing cannot nudge a statutory date', () => {
    const grid = nodeById('cmp_sysing');
    const editable = grid.props.columns.filter((c) => c.editable).map((c) => c.key);
    for (const key of ['became_aware_on', 'severity', 'report_due_on', 'reported_on']) {
        assert.equal(editable.includes(key), false,
            `"${key}" decides or records a legal deadline and must not be editable from a grid cell`);
    }
    // Inline editing at all requires selectable:'none' — with a selection mode
    // set, onRowSelect fires with the selected rows instead of the edited one.
    assert.equal(grid.props.selectable, 'none');
    // The one date the app DOES write is written server-side from `today`, not
    // from the browser's clock, because it is evidence of meeting a deadline.
    for (const actionId of ['act_inreport', 'act_inrepdlg']) {
        const update = flatSteps(definition.actions[actionId]).find((s) => s.kind === 'update_record');
        assert.match(update.values.reported_on.expr, /\btoday\b/,
            `${actionId} must take the report date from the server's today`);
        assert.equal(/Date|now\b/.test(update.values.reported_on.expr), false,
            `${actionId} must not reach for a clock other than the server's today`);
    }
});

test('recording a notification twice cannot overwrite the first one', async () => {
    // `rowActions` is { label, actionId } and nothing more — no per-row
    // `visible` — so "Record notification" is offered on rows that were already
    // reported. Unguarded it would stamp today over the real notification date
    // and make an incident that MET its deadline look weeks late, so the write
    // has to be idempotent rather than merely discouraged.
    const grid = nodeById('cmp_ingrid');
    assert.ok(grid.props.rowActions.some((a) => a.actionId === 'act_inreport'));
    assert.equal(
        grid.props.rowActions.every((a) => a.visible === undefined), true,
        'if rowActions ever grow a per-row visible, prefer hiding this button over guarding it',
    );

    const { evaluate } = await import('../../shared/expr/index.mjs');
    const update = flatSteps(definition.actions.act_inreport).find((s) => s.kind === 'update_record');

    // Already reported: both writes must be a no-op that preserves the record.
    const reported = { reported_on: '2026-06-18', status: 'mitigated' };
    assert.equal(evaluate(update.values.reported_on.expr, { item: reported, today: '2026-08-15' }), '2026-06-18',
        'a second click must not move the date the notification was actually made');
    assert.equal(evaluate(update.values.status.expr, { item: reported, today: '2026-08-15' }), 'mitigated',
        'a second click must not drag a mitigated incident back to investigating');

    // Not yet reported: it still does the job it exists for.
    const fresh = { reported_on: null, status: 'open' };
    assert.equal(evaluate(update.values.reported_on.expr, { item: fresh, today: '2026-08-15' }), '2026-08-15');
    assert.equal(evaluate(update.values.status.expr, { item: fresh, today: '2026-08-15' }), 'investigating');

    // Every seeded incident that carries a report date survives a stray click.
    for (const inc of rowsOf('tbl_incid01').filter((i) => i.reported_on)) {
        assert.equal(evaluate(update.values.reported_on.expr, { item: inc, today: '2026-08-15' }), inc.reported_on);
    }
});

test('the tier key is not editable, because every system stores it', () => {
    const grid = nodeById('cmp_sutiers');
    const key = grid.props.columns.find((c) => c.key === 'key');
    assert.equal(key.editable, false, 'there are no joins to cascade a key rename through');
    const cases = nodeById('cmp_sucases').props.columns.find((c) => c.key === 'key');
    assert.equal(cases.editable, false);
});

// ── It degrades sensibly with nothing selected ──────────────────────────────

test('the register opens showing everything, not an empty screen', () => {
    const grid = nodeById('cmp_reggrid');
    for (const clause of grid.props.source.filter) {
        assert.notEqual(clause.required, true,
            `the register's "${clause.field}" filter is required, so the first screen would be blank until someone typed`);
    }
    assert.equal(CANON.homeScreenId, 'scr_register');
});

test('the triage board shows every system before anything is picked', () => {
    const board = nodeById('cmp_trboard');
    assert.equal(board.props.source.filter, undefined,
        'the board is the whole register — nothing scopes it away');
    // The tier list beside it is a reader, not a filter: picking a tier reveals
    // its obligations and changes nothing about the board.
    const pick = definition.actions[nodeById('cmp_trtiers').onRowClick];
    assert.deepEqual(flatSteps(pick).map((s) => s.kind), ['set_variable']);
});

test('every screen that needs a selection says so instead of showing nothing', () => {
    const emptyStates = [
        ['cmp_sysdet', /register|triage/i],
        ['cmp_trobl', /pick a tier/i],
        ['cmp_indet', /open an incident/i],
        ['cmp_sysovg', /finding|nobody/i],
    ];
    for (const [id, pattern] of emptyStates) {
        const node = nodeById(id);
        assert.match(node.props.emptyText, pattern, `${id} needs an empty state that tells the reader what to do`);
    }
});

test('the child grids of the open system refuse to show another system\'s rows', () => {
    for (const id of ['cmp_sysovg', 'cmp_sysing', 'cmp_sysasg']) {
        const scope = nodeById(id).props.source.filter.find((f) => f.field === 'system_id');
        assert.ok(scope, `${id} must be scoped to the open system`);
        assert.equal(scope.required, true,
            `${id} would otherwise list every row in the workspace while nothing is open`);
        assert.equal(scope.value.expr, 'vars.system.id');
    }
});

test('the dialog\'s file-the-notification button hides once it has been filed', () => {
    const btn = nodeById('cmp_inbtn');
    assert.equal(btn.visible.kind, 'formula');
    assert.match(btn.visible.expr, /vars\.incident\.reported_on/,
        'offering it twice would overwrite a statutory date with today\'s');
});

// ── Layout, roles, and running without Nextcloud ────────────────────────────

test('every fill section is a single 12-column row', () => {
    // A height:'fill' section stretches its FIRST grid row only, so a second
    // row inside one collapses to nothing.
    for (const screen of CANON.screens) {
        for (const section of screen.sections) {
            if (section.style.height !== 'fill') continue;
            const spans = section.children.map((c) => c.style.span);
            assert.equal(spans.reduce((a, b) => a + b, 0), 12,
                `${screen.id}/${section.id} is a fill section but its children do not make exactly one row`);
        }
    }
});

test('exactly one filter bar exists in the whole app', () => {
    // filter_bar publishes to ONE hardcoded variable, vars.filters. A second bar
    // on another screen would share it, and the two screens would silently
    // inherit each other's filters.
    const bars = NODES.filter((n) => n.type === 'filter_bar');
    assert.equal(bars.length, 1);
    assert.equal(definition.variables.some((v) => v.name === 'filters'), false,
        '`filters` is reserved — declaring it is a validation error');
});

test('every table has a real access matrix, and nobody but the officer deletes a system', () => {
    const roles = new Set(dataModel.roles.map((r) => r.key));
    assert.deepEqual([...roles], ['officer', 'contributor', 'auditor']);
    for (const table of dataModel.tables) {
        assert.equal(table.access.default, 'role',
            `${table.key} falls back to app-wide access — every grant must be a decision`);
        for (const role of roles) {
            assert.ok(table.access.roles[role], `${table.key} says nothing about the ${role} role`);
        }
        // An auditor reads the register and changes nothing about it. That is
        // what makes handing one an account safe.
        assert.deepEqual(table.access.roles.auditor, { read: 'all', create: false, update: false, delete: false });
    }
    // The two records that are evidence rather than working data.
    assert.equal(dataModel.tables.find((t) => t.id === 'tbl_aisys01').access.roles.contributor.delete, false);
    assert.equal(dataModel.tables.find((t) => t.id === 'tbl_incid01').access.roles.contributor.delete, false);
    assert.equal(dataModel.tables.find((t) => t.id === 'tbl_incid01').access.roles.contributor.update, 'own');
    // Opening the app grants nothing until someone is given a role: this
    // register names who is accountable and carries incident narratives.
    assert.equal(dataModel.roleMapping.default, null);
});

test('the seed contains no personal data — accountability is a role, not a person', () => {
    // A compliance register is precisely the document that must not ship
    // pre-filled with something that reads like a real person's file. Every
    // seeded "who" is a job, and every address is a functional one at
    // example.com.
    const people = [
        ...rowsOf('tbl_aisys01').map((s) => [s.business_owner, s.business_owner_email]),
        ...rowsOf('tbl_overs01').map((o) => [o.reviewer, o.reviewer_email]),
        ...rowsOf('tbl_incid01').map((i) => [i.logged_by, null]),
        ...rowsOf('tbl_asmnt01').map((a) => [a.performed_by, null]),
    ];
    for (const [who, email] of people) {
        if (email) assert.match(email, /@example\.com$/, `${email} is not an example.com address`);
        if (!who) continue;
        // A role reads as a job title: two or more words, and never a
        // capitalised first name followed by a capitalised surname.
        assert.equal(/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(who), false,
            `"${who}" reads like a person's name; seed a role instead`);
    }
});

/**
 * The template must be identical embedded in a Nextcloud page and standalone.
 * It may BENEFIT from Nextcloud (an embedded viewer resolves to their NC
 * identity, so currentUser is the signed-in user and an incident is attributed
 * correctly), but it must not REQUIRE it.
 */
test('nothing in the app requires Nextcloud or a connector', () => {
    const kinds = new Set();
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (typeof obj.kind === 'string') kinds.add(obj.kind);
        Object.values(obj).forEach(walk);
    };
    walk(definition);
    assert.equal(kinds.has('connector'), false, 'a connector binding would need an external system configured');
    assert.equal(dataModel.connectors, undefined, 'the data model must not ship a connector');
    for (const node of NODES) {
        assert.notEqual(node.type, 'connector_status');
    }
});

/**
 * The single tolerated warning. It is here because the app genuinely wants a
 * routine — chasing the owners of overdue reviews — and cannot know which one.
 * It must stay the ONLY one, and the UI must say so rather than failing quietly
 * when it is pressed.
 */
test('the one unwired routine is deliberate and admitted in the interface', () => {
    const unset = [];
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (step.kind === 'run_automation') unset.push([actionId, step.automationId]);
        }
    }
    assert.equal(unset.length, 1, 'exactly one run_automation, or the template ships warnings nobody chose');
    assert.deepEqual(unset[0], ['act_regremind', null]);
    const toast = flatSteps(definition.actions.act_regremind).find((s) => s.kind === 'toast');
    assert.match(toast.message, /routine/i, 'the button has to tell the user it needs wiring');
    assert.equal(nodeById('cmp_regrem').onClick, 'act_regremind');
});

test('the register and triage screens are full width — they are embedded in a page', () => {
    for (const id of ['scr_register', 'scr_triage', 'scr_incident']) {
        assert.equal(screenById(id).maxWidth, 'full');
    }
    assert.equal(screenById('scr_system').showInNav, false, 'the detail screen is reached from a row, not from the nav');
});
