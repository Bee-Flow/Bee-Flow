/**
 * Data subject requests — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates, and that its
 * seed rows fit their columns. None of that can catch what this app is actually
 * exposed to, which is not a schema problem at all:
 *
 *  • THE DEADLINE IS ARITHMETIC NOBODY RE-DOES. `due_date` is written once, at
 *    intake, as received + 30 days. A seed row whose due date does not match
 *    that rule teaches the first customer the wrong thing about their own clock
 *    — and an extension whose "requester informed" date falls AFTER the original
 *    month is an extension that was never lawful, which is precisely the mistake
 *    this app exists to make visible.
 *
 *  • THE VOCABULARIES CAN DRIFT. Types, statuses and grounds are text keys into
 *    config tables, which is what makes them editable by the privacy officer
 *    instead of by a developer. Nothing in the schema ties a request's `status`
 *    to a row in `request_statuses`, and a request in a status the stepper does
 *    not know simply shows no progress at all.
 *
 *  • IDENTITY IS THE ONE RULE THAT MUST NOT BE POLITE. Answering the wrong
 *    person is a personal data breach. So it is asserted twice: no seeded
 *    disclosure hangs off an unverified request, and the actions that disclose
 *    put their write INSIDE a condition rather than behind a disabled button.
 *
 *  • THERE ARE NO JOINS, so every child row carries a denormalised copy of its
 *    request's reference. A copy that disagrees with its parent is a search log
 *    that points at the wrong case.
 *
 * Run: cd server && node --test appStudio/templates/appDataSubjectRequests.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appDataSubjectRequests');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { compile } = require('../../automation/expr');

const { seed, dataModel, definition } = template;

const rowsOf = (tableId) => seed[tableId] || [];
const keysOf = (tableId, key) => new Set(rowsOf(tableId).map((r) => r[key]));
const tableOf = (tableId) => dataModel.tables.find((t) => t.id === tableId);

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

/** Flatten an action's steps, including condition/loop/switch branches. */
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

const DAY = 86400000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

/**
 * The seed is written around this date so that "overdue" and "due this week"
 * are visibly true on the register the moment the app is installed. Asserting
 * against a fixed anchor rather than against the real clock keeps the test
 * honest in 2027 — the seed's job is to be readable on the day it was written,
 * and if someone later reworks the dates this is what tells them what the
 * register was supposed to demonstrate.
 */
const ANCHOR = '2026-08-15';

// ── The deadline: the one calculation the whole app rests on ───────────────

test('every request carries both halves of the clock', () => {
    const fields = tableOf('tbl_reqs001').fields;
    for (const key of ['received_date', 'due_date']) {
        const field = fields.find((f) => f.key === key);
        assert.equal(field.type, 'date', `${key} must be a real date column — a filter can only compare a column against today`);
        assert.equal(field.required, true, `${key} is the statutory clock; a request without one cannot be chased`);
    }
    for (const r of rowsOf('tbl_reqs001')) {
        assert.ok(r.received_date && r.due_date, `${r.reference} is missing a date`);
        assert.ok(daysBetween(r.received_date, r.due_date) > 0, `${r.reference} is due before it arrived`);
    }
});

test('the seeded due dates are exactly what intake would have computed', () => {
    // received + 30 days, and 60 more where an extension was taken — the same
    // arithmetic as act_incre and act_csextdo. A hand-typed date that drifts
    // from the rule teaches the first customer the wrong clock.
    for (const r of rowsOf('tbl_reqs001')) {
        const expected = r.extension_taken ? 90 : 30;
        assert.equal(daysBetween(r.received_date, r.due_date), expected,
            `${r.reference}: due_date is ${daysBetween(r.received_date, r.due_date)} days after receipt, expected ${expected}`);
    }
});

test('an extension was notified INSIDE the first month, which is what makes it lawful', () => {
    const extended = rowsOf('tbl_reqs001').filter((r) => r.extension_taken);
    assert.ok(extended.length, 'the seed must show an extension — it is half of the deadline story');
    for (const r of extended) {
        assert.ok(r.extension_reason, `${r.reference} extended with no reason recorded`);
        assert.ok(r.extension_notified_on, `${r.reference} extended without recording when the requester was told`);
        const originalDue = isoDate(Date.parse(r.received_date) + 30 * DAY);
        assert.ok(r.extension_notified_on <= originalDue,
            `${r.reference}: the requester was told on ${r.extension_notified_on}, after the original deadline ${originalDue} — the extension would not be lawful`);
    }
});

test('the register shows overdue and due-soon work on the day it is installed', () => {
    const open = rowsOf('tbl_reqs001').filter((r) => r.status !== 'closed');
    const overdue = open.filter((r) => r.due_date < ANCHOR);
    const dueSoon = open.filter((r) => r.due_date >= ANCHOR && r.due_date <= isoDate(Date.parse(ANCHOR) + 7 * DAY));
    assert.ok(overdue.length >= 2, `expected the seed to ship at least two overdue requests around ${ANCHOR}; found ${overdue.length}`);
    assert.ok(dueSoon.length >= 1, `expected at least one request due within a week of ${ANCHOR}; found ${dueSoon.length}`);
    assert.ok(open.length > overdue.length + dueSoon.length, 'not everything may be urgent, or the urgency means nothing');
});

test('urgency is a stored date compared against today, sorted so the worst is first', () => {
    const urgent = nodeById('cmp_rgurgent');
    const window = urgent.props.source.filter.find((f) => f.field === 'due_date');
    assert.ok(window, 'the urgent list must narrow by the deadline column');
    assert.match(window.value.expr, /today/, 'the only clock a filter formula may read is `today`');
    assert.deepEqual(urgent.props.source.sort, [{ field: 'due_date', dir: 'asc' }]);

    const overdueStat = nodeById('cmp_rgs2');
    const clause = overdueStat.props.value.filter.find((f) => f.field === 'due_date');
    assert.equal(clause.op, 'lt');
    assert.equal(clause.value.expr, 'today');
    assert.equal(overdueStat.props.value.limit, 1, 'an aggregate with no explicit limit is silently capped at 50');

    // The register itself is ordered by the deadline, not by when it was logged.
    assert.deepEqual(nodeById('cmp_rggrid').props.source.sort, [{ field: 'due_date', dir: 'asc' }]);
});

test('the due date stays editable, because the statute says a month and the app writes 30 days', () => {
    const due = nodeById('cmp_rggrid').props.columns.find((c) => c.key === 'due_date');
    assert.equal(due.editable, true);
    const save = definition.actions.act_rgsave;
    const update = flatSteps(save).find((s) => s.kind === 'update_record');
    assert.equal(update.values.due_date.expr, 'form.due_date');
    assert.ok(update.expectedUpdatedAt, 'moving a statutory deadline must not silently overwrite someone else’s edit');
});

// ── The vocabularies agree ─────────────────────────────────────────────────

test('every seeded request uses a type and a status the config tables define', () => {
    const types = keysOf('tbl_types01', 'key');
    const statuses = keysOf('tbl_stat001', 'key');
    for (const r of rowsOf('tbl_reqs001')) {
        assert.ok(types.has(r.request_type), `${r.reference} invokes "${r.request_type}", which request_types does not define`);
        assert.ok(statuses.has(r.status), `${r.reference} is in status "${r.status}", which request_statuses does not define`);
    }
});

test('every recorded ground exists in the exemption grounds table', () => {
    const grounds = keysOf('tbl_grnd001', 'key');
    for (const r of rowsOf('tbl_reqs001')) {
        if (!r.refusal_ground) continue;
        assert.ok(grounds.has(r.refusal_ground), `${r.reference} was refused on "${r.refusal_ground}", which exemption_grounds does not define`);
    }
    for (const e of rowsOf('tbl_exem001')) {
        assert.ok(grounds.has(e.ground), `a withholding cites "${e.ground}", which exemption_grounds does not define`);
    }
});

/**
 * The seam the module header warns about: `input_select.options`,
 * `filter_bar.options` and `stepper.steps` are author-time lists, not bindings.
 * They cannot follow the config tables automatically — so they are asserted to
 * agree here, which is the only place that can notice.
 */
test('the authored dropdowns and the config tables cover the same vocabulary', () => {
    const pairs = [
        ['tbl_types01', nodeById('cmp_inf2').props.options, 'request types'],
        ['tbl_grnd001', nodeById('cmp_exf1').props.options, 'exemption grounds'],
        ['tbl_grnd001', nodeById('cmp_reff1').props.options, 'refusal grounds'],
    ];
    for (const [tableId, options, label] of pairs) {
        const authored = new Set(options.map((o) => o.value));
        for (const key of keysOf(tableId, 'key')) {
            assert.ok(authored.has(key), `${label}: "${key}" exists in the table but not in the dropdown`);
        }
        for (const value of authored) {
            assert.ok(keysOf(tableId, 'key').has(value), `${label}: the dropdown offers "${value}", which the table does not define`);
        }
    }
});

test('the stepper knows every status a request can be in', () => {
    const steps = new Set(nodeById('cmp_csstep').props.steps.map((s) => s.value));
    for (const key of keysOf('tbl_stat001', 'key')) {
        assert.ok(steps.has(key), `status "${key}" has no stage on the case file's stepper — the request would show no progress at all`);
    }
    assert.equal(nodeById('cmp_csstep').props.value.expr, 'vars.request.status');

    // …and the register's status pills colour the same set.
    const tones = new Set(nodeById('cmp_rgurgent').props.badgeToneMap.map((t) => t.value));
    for (const key of keysOf('tbl_stat001', 'key')) {
        assert.ok(tones.has(key), `status "${key}" has no colour on the urgent list`);
    }
});

test('the status filter and the stepper are ordered the same way a case moves', () => {
    const filterBar = nodeById('cmp_rgfilt');
    const statusField = filterBar.props.fields.find((f) => f.name === 'status');
    const filterOrder = statusField.options.map((o) => o.value);
    const stepOrder = nodeById('cmp_csstep').props.steps.map((s) => s.value);
    assert.deepEqual(filterOrder, stepOrder, 'two orderings of the same lifecycle read as two different lifecycles');
    const seeded = rowsOf('tbl_stat001').slice().sort((a, b) => a.position - b.position).map((s) => s.key);
    assert.deepEqual(seeded, stepOrder, 'the config table’s own order must match too');
});

// ── No joins: the denormalised copies must agree ──────────────────────────

test('every evidence row carries the reference of the request it actually belongs to', () => {
    const byAlias = new Map(rowsOf('tbl_reqs001').filter((r) => r.$id).map((r) => [r.$id, r]));
    for (const tableId of ['tbl_ident01', 'tbl_srch001', 'tbl_disc001', 'tbl_exem001']) {
        for (const row of rowsOf(tableId)) {
            const parent = byAlias.get(row.request_id.$ref);
            assert.ok(parent, `${tableId} row references alias "${row.request_id.$ref}", which is not seeded`);
            assert.equal(row.request_reference, parent.reference,
                `${tableId} row says it belongs to ${row.request_reference} but hangs off ${parent.reference}`);
        }
    }
});

test('the org-wide search log reads the display copy, not the relation it cannot follow', () => {
    const grid = nodeById('cmp_evgrid');
    const col = grid.props.columns.find((c) => c.key === 'request_reference');
    assert.ok(col, 'the search log must be able to say which request each search was for');
    const field = tableOf('tbl_srch001').fields.find((f) => f.key === 'request_reference');
    assert.equal(field.type, 'text', 'a relation here could not be displayed or filtered without a join');
    // …and every action that writes an evidence row fills it in.
    for (const id of ['act_idadd', 'act_sradd', 'act_srkb', 'act_dsadd', 'act_exadd', 'act_csrefdo']) {
        const creates = flatSteps(definition.actions[id]).filter((s) => s.kind === 'create_record' && s.tableId !== 'tbl_reqs001');
        for (const step of creates) {
            assert.equal(step.values.request_reference.expr, 'vars.request.reference',
                `${id} writes an evidence row without the denormalised reference`);
        }
    }
});

// ── Identity: the rule that must not be polite ────────────────────────────

test('nothing was disclosed to a requester who was never verified', () => {
    const byAlias = new Map(rowsOf('tbl_reqs001').filter((r) => r.$id).map((r) => [r.$id, r]));
    for (const d of rowsOf('tbl_disc001')) {
        const request = byAlias.get(d.request_id.$ref);
        assert.equal(request.identity_verified, true,
            `${request.reference} has a disclosure on ${d.sent_on} but was never verified — that is a personal data breach, not a demo`);
    }
});

test('the verified flag and the identity checks tell the same story', () => {
    const byAlias = new Map(rowsOf('tbl_reqs001').filter((r) => r.$id).map((r) => [r.$id, r]));
    const verifiedAliases = new Set(
        rowsOf('tbl_ident01').filter((c) => c.outcome === 'verified').map((c) => c.request_id.$ref),
    );
    for (const [alias, request] of byAlias) {
        const flagged = request.identity_verified === true;
        assert.equal(flagged, verifiedAliases.has(alias),
            `${request.reference}: identity_verified is ${flagged} but a verified check ${verifiedAliases.has(alias) ? 'exists' : 'does not exist'}`);
        if (flagged) assert.ok(request.verified_on, `${request.reference} is verified with no date`);
    }
    // The register's unverified counter reads the roll-up column, because a
    // count over a related table is a join it cannot do.
    const stat = nodeById('cmp_rgs4').props.value;
    assert.equal(stat.tableId, 'tbl_reqs001');
    assert.ok(stat.filter.some((f) => f.field === 'identity_verified' && f.value === false));
});

test('an unverified requester genuinely exists in the seed, so the warning is not theoretical', () => {
    const open = rowsOf('tbl_reqs001').filter((r) => r.status !== 'closed');
    assert.ok(open.some((r) => !r.identity_verified), 'the seed must show a request that cannot be answered yet');
    // …and the check that failed says why, because a refusal under Art. 12(6)
    // stands or falls on that sentence.
    for (const c of rowsOf('tbl_ident01')) {
        if (c.outcome === 'verified') continue;
        assert.ok(c.notes && c.notes.length > 20, 'an inconclusive identity check must record what is still missing');
    }
});

test('disclosing and closing as fulfilled are guarded by a condition, not by a disabled button', () => {
    for (const id of ['act_dsadd', 'act_csdone']) {
        const action = definition.actions[id];
        const guard = action.steps.find((s) => s.kind === 'condition');
        assert.ok(guard, `${id} must refuse to write, not merely look unavailable`);
        assert.equal(guard.expr, 'vars.verified');
        const writes = (guard.then || []).filter((s) => ['create_record', 'update_record'].includes(s.kind));
        assert.ok(writes.length, `${id} must do its writing inside the guarded branch`);
        const elseWrites = (guard.else || []).filter((s) => ['create_record', 'update_record'].includes(s.kind));
        assert.deepEqual(elseWrites, [], `${id} must write nothing when identity is unverified`);
        assert.ok((guard.else || []).some((s) => s.kind === 'toast'), `${id} must say WHY it refused`);
    }
});

test('recording an identity check keeps the session guard, the column and both grids in step', () => {
    const steps = flatSteps(definition.actions.act_idadd);
    assert.ok(steps.some((s) => s.kind === 'create_record' && s.tableId === 'tbl_ident01'));
    const rollups = steps.filter((s) => s.kind === 'update_record' && s.tableId === 'tbl_reqs001');
    assert.equal(rollups.length, 2, 'both branches must roll the flag up — a failed check must UNSET a stale verification');
    assert.deepEqual(rollups.map((s) => s.values.identity_verified.value), [true, false]);
    const sets = steps.filter((s) => s.kind === 'set_variable' && s.name === 'verified');
    assert.deepEqual(sets.map((s) => s.value.value), [true, false],
        'the session mirror must move with the column, or the red warning keeps lying after the check');
    const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
    assert.deepEqual([...refreshed].sort(), ['tbl_ident01', 'tbl_reqs001']);
});

test('opening a request seeds the session guard from the row it opened', () => {
    const pick = definition.actions.act_rgpick;
    const sets = pick.steps.filter((s) => s.kind === 'set_variable');
    assert.deepEqual(sets.map((s) => s.name), ['request', 'verified']);
    assert.equal(sets[1].value.expr, 'item.identity_verified');
    // One action for the list click and the grid row action alike — both hand
    // the clicked row over as `item`.
    assert.equal(nodeById('cmp_rgurgent').onRowClick, 'act_rgpick');
    assert.ok(nodeById('cmp_rggrid').props.rowActions.some((a) => a.actionId === 'act_rgpick'));
});

// ── A refusal is a first-class outcome ─────────────────────────────────────

test('every refused request carries its ground, its words and a matching withholding', () => {
    const refused = rowsOf('tbl_reqs001').filter((r) => r.outcome === 'refused');
    assert.ok(refused.length, 'a template that never shows a refusal teaches that refusing is not allowed');
    const withheldRefs = new Set(rowsOf('tbl_exem001').map((e) => e.request_reference));
    for (const r of refused) {
        assert.ok(r.refusal_ground, `${r.reference} was refused with no ground recorded`);
        assert.ok(r.refusal_explanation && r.refusal_explanation.length > 40,
            `${r.reference} was refused without recording what the requester was told`);
        assert.equal(r.status, 'closed');
        assert.ok(r.closed_on, `${r.reference} was refused but never closed off`);
        assert.ok(withheldRefs.has(r.reference), `${r.reference} was refused but nothing is filed under what we withheld`);
    }
});

test('refusing writes the request and files the reasoning in the evidence trail', () => {
    const steps = flatSteps(definition.actions.act_csrefdo);
    const update = steps.find((s) => s.kind === 'update_record' && s.tableId === 'tbl_reqs001');
    assert.equal(update.values.outcome.value, 'refused');
    assert.equal(update.values.refusal_ground.expr, 'form.ground');
    assert.equal(update.values.refusal_explanation.expr, 'form.explanation');
    const create = steps.find((s) => s.kind === 'create_record' && s.tableId === 'tbl_exem001');
    assert.ok(create, 'a refusal must also land where every other withholding lands');
    assert.equal(create.values.ground.expr, 'form.ground');
    // Both writes are reachable from a form that demands the reasoning.
    const form = nodeById('cmp_refform');
    assert.equal(form.onSubmit, 'act_csrefdo');
    const explanation = NODES.find((n) => n.props && n.props.name === 'explanation');
    assert.equal(explanation.props.required, true, 'a refusal without words is not an answer');
});

test('a withholding can be recorded without refusing the whole request', () => {
    // Redaction is the normal case: fulfilled, minus somebody else's data.
    const partial = rowsOf('tbl_exem001').filter((e) => {
        const request = rowsOf('tbl_reqs001').find((r) => r.reference === e.request_reference);
        return request && request.outcome !== 'refused';
    });
    assert.ok(partial.length, 'the seed must show a withholding on a request that was NOT refused');
    const form = nodeById('cmp_exform');
    assert.equal(form.onSubmit, 'act_exadd');
    assert.ok(NODES.some((n) => n.id === 'cmp_exf1' && n.props.required === true), 'the ground is not optional');
});

// ── The knowledge-base search degrades honestly ───────────────────────────

test('the knowledge base search ships unwired, and says so instead of pretending', () => {
    const steps = flatSteps(definition.actions.act_srkb);
    const kb = steps.find((s) => s.kind === 'kb_query');
    assert.ok(kb, 'the search step is the point of the Searches tab');
    assert.deepEqual(kb.knowledgeBaseIds, [],
        'a fresh install has no knowledge bases; shipping an id would point at somebody else’s');
    assert.equal(kb.resultVar, 'kbhits');
    assert.equal(kb.query.expr, 'vars.request.identifiers');

    // Guarded: with nothing to search FOR, the step would fail with "the search
    // query is empty". Say what is missing instead.
    const guard = definition.actions.act_srkb.steps.find((s) => s.kind === 'condition');
    assert.match(guard.expr, /identifiers/);
    assert.ok((guard.then || []).every((s) => s.kind === 'toast'), 'the empty case must write nothing');

    // And the UI explains what wiring it up buys you.
    const note = nodeById('cmp_srnote');
    assert.match(note.props.text, /knowledge base/i);
    assert.match(note.props.text, /App Studio/, 'say WHERE to wire it, not just that it is unwired');
});

test('what the search returned is written into the log, attributed and flagged', () => {
    const create = flatSteps(definition.actions.act_srkb).find((s) => s.kind === 'create_record');
    assert.equal(create.tableId, 'tbl_srch001');
    assert.equal(create.values.is_automated.value, true, 'a reader must be able to tell machine diligence from human diligence');
    assert.match(create.values.hits_found.expr, /vars\.kbhits\.count/);
    assert.match(create.values.findings.expr, /vars\.kbhits\.results/, 'log WHAT came back, not only how many');
    assert.equal(create.values.searched_by.expr, 'currentUser.name');
    assert.ok(flatSteps(definition.actions.act_srkb).some((s) => s.kind === 'refresh' && s.tableId === 'tbl_srch001'));
});

test('the app is complete with the search step unused', () => {
    // Nothing else reads kbhits, so an unwired kb_query cannot break a screen…
    const readsKbhits = JSON.stringify(definition).match(/vars\.kbhits/g) || [];
    const inSearchAction = JSON.stringify(definition.actions.act_srkb).match(/vars\.kbhits/g) || [];
    assert.equal(readsKbhits.length, inSearchAction.length, 'only the search action may depend on the search result');
    // …and every search can be logged by hand, with the same columns.
    const manual = flatSteps(definition.actions.act_sradd).find((s) => s.kind === 'create_record');
    assert.equal(manual.tableId, 'tbl_srch001');
    assert.equal(manual.values.is_automated.value, false);
    assert.ok(rowsOf('tbl_srch001').some((r) => !r.is_automated), 'the seed must show hand-logged searches');
    assert.ok(rowsOf('tbl_srch001').some((r) => r.is_automated), 'and one the search step would have written');
});

test('a nil result is recorded as a finding, because that is the evidence people forget', () => {
    const nil = rowsOf('tbl_srch001').filter((r) => r.hits_found === 0);
    assert.ok(nil.length, 'the seed must show a search that found nothing');
    for (const row of nil) {
        assert.ok(row.findings && row.findings.length > 10, `"${row.system_name}" found nothing and said nothing about it`);
    }
});

// ── The rules the platform enforces silently, and the ones it does not ────

/**
 * A binding filter runs in TWO places — the fetch layer and the read-side cache
 * key — and they build their scope differently. A filter formula reading
 * form.*, item.*, records.* or now makes the two diverge, and the component
 * loads forever with nothing on screen and nothing in the console.
 */
test('no binding filter reads a scope the fetch layer and the cache key disagree about', () => {
    const ALLOWED = new Set(['currentUser', 'vars', 'forms', 'screen', 'today']);
    const offences = [];
    const visit = (value, path) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { value.forEach((v, i) => visit(v, `${path}[${i}]`)); return; }
        if (Array.isArray(value.filter)) {
            for (const entry of value.filter) {
                const expr = entry && entry.value && entry.value.expr;
                if (typeof expr !== 'string') continue;
                for (const root of compile(expr).refs) {
                    if (!ALLOWED.has(root)) offences.push(`${path}.filter ${entry.field}: ${expr} (reads ${root})`);
                }
            }
        }
        for (const [k, v] of Object.entries(value)) visit(v, `${path}.${k}`);
    };
    visit(definition.screens, 'screens');
    assert.deepEqual(offences, []);
});

/**
 * A server step's formula scope is a strict subset of the browser's: no
 * `screen`, `forms`, `actions`, `records` or `datasets`. A binding naming one
 * resolves in preview and writes NULL in production — the worst kind of wrong,
 * because it passes every check an author can run before shipping.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record', 'kb_query']);
    const FORBIDDEN = /^(screen|forms|actions|records|datasets)\b/;
    const offences = [];
    for (const [actionId, action] of Object.entries(definition.actions)) {
        for (const step of flatSteps(action)) {
            if (!SERVER_KINDS.has(step.kind)) continue;
            const exprs = [];
            for (const key of ['recordId', 'expectedUpdatedAt', 'query']) {
                if (step[key] && step[key].expr) exprs.push([key, step[key].expr]);
            }
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
    const MUTATES = new Set(['create_record', 'update_record', 'delete_record']);
    for (const [actionId, action] of Object.entries(definition.actions)) {
        if (action.kind !== 'sequence') continue;
        const steps = flatSteps(action);
        const dirtied = new Set(steps.filter((s) => MUTATES.has(s.kind)).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${actionId} writes ${tableId} but never refreshes it — the change would not appear until something else refetched`);
        }
    }
});

// ── What the app looks like with nothing selected ─────────────────────────

test('the case file shows nothing at all until a request is opened', () => {
    // required:true means "show nothing until this resolves". Without it, a
    // handler opening the case file cold would see every identity check and
    // every disclosure in the organisation.
    const scoped = ['cmp_idgrid', 'cmp_srgrid', 'cmp_dsgrid', 'cmp_exgrid'];
    for (const id of scoped) {
        const clause = nodeById(id).props.source.filter.find((f) => f.field === 'request_id');
        assert.ok(clause, `${id} must be scoped to the open request`);
        assert.equal(clause.required, true, `${id} would list every row in the workspace with no request selected`);
        assert.match(clause.value.expr, /vars\.request\.id/);
    }
    const detail = nodeById('cmp_csdet').props.source;
    assert.equal(detail.kind, 'record', 'the header record must refetch after a write, not show the snapshot it was picked from');
    assert.equal(detail.filter[0].required, true);
});

/**
 * An aggregate binding resolves to the ROWS ARRAY, not to a number: the counter
 * `count(*) as n` comes back as `[{ n: 7 }]`. A `stat` renders that through
 * displayValue, which summarises a one-element array of objects as "1 item" —
 * so a tile without `pick` reads "Overdue: 1 item" no matter what the data says,
 * on every screen, forever. `pick: { row, column }` is the read-side lens that
 * narrows it, and its column has to name the aggregate's own alias.
 */
test('every scalar tile picks one value out of the rows its aggregate returns', () => {
    const offences = [];
    for (const node of NODES) {
        if (node.type !== 'stat') continue;
        const src = node.props && node.props.value;
        if (!src || src.kind !== 'aggregate') continue;
        const aliases = (src.aggregates || []).map((a) => a.as);
        if (!src.pick) { offences.push(`${node.id}: no pick — would render "1 item"`); continue; }
        if (!aliases.includes(src.pick.column)) {
            offences.push(`${node.id}: pick.column "${src.pick.column}" is not one of ${aliases.join(', ')}`);
        }
    }
    assert.deepEqual(offences, []);
    // And the tiles exist at all, so this never passes by finding nothing.
    assert.equal(NODES.filter((n) => n.type === 'stat').length, 11);
});

test('the register, by contrast, shows everything until you narrow it', () => {
    const grid = nodeById('cmp_rggrid');
    for (const clause of grid.props.source.filter) {
        assert.notEqual(clause.required, true,
            `the register's "${clause.field}" clause is required — on first open the screen would be empty instead of full`);
        assert.ok(clause.value.expr.startsWith('vars.filters.'), 'every optional clause is fed by the filter bar');
    }
    // One filter_bar per screen: `vars.filters` is a single hardcoded variable.
    const bars = NODES.filter((n) => n.type === 'filter_bar');
    assert.equal(bars.length, 1);
    assert.equal(definition.variables.some((v) => v.name === 'filters'), false, '`filters` is reserved — declaring it is an error');
});

test('the home screen is the clock, and every screen a handler needs is in the nav', () => {
    assert.equal(definition.homeScreenId, 'scr_register');
    const nav = CANON.screens.filter((s) => s.showInNav).map((s) => s.id);
    assert.deepEqual(nav, ['scr_register', 'scr_intake', 'scr_evidence', 'scr_report', 'scr_setup']);
    // The case file is reached BY opening a request, never from a cold nav
    // click that would land on an empty screen.
    assert.equal(screenById('scr_case').showInNav, false);
});

test('the fill sections are a single 12-column row, or they would not stretch', () => {
    for (const [screenId, sectionId] of [['scr_register', 'sec_rgmain'], ['scr_evidence', 'sec_evmain'], ['scr_report', 'sec_rpmain']]) {
        const section = screenById(screenId).sections.find((s) => s.id === sectionId);
        assert.equal(section.style.height, 'fill');
        const spans = section.children.map((c) => c.style.span);
        assert.equal(spans.reduce((a, b) => a + b, 0), 12, `${sectionId} must hold exactly one row — a fill section stretches its first row only`);
    }
});

// ── Access, and running anywhere ──────────────────────────────────────────

test('opening the app grants nothing, and nobody deletes the register', () => {
    assert.equal(dataModel.roleMapping.default, null,
        'this register holds other people’s personal data — a viewer with no role must see nothing');
    const requests = tableOf('tbl_reqs001');
    assert.equal(requests.access.default, 'role');
    for (const [role, grant] of Object.entries(requests.access.roles)) {
        assert.equal(grant.delete, false, `${role} may delete requests — a register you can erase is not evidence`);
    }
    for (const tableId of ['tbl_ident01', 'tbl_srch001', 'tbl_disc001', 'tbl_exem001']) {
        for (const [role, grant] of Object.entries(tableOf(tableId).access.roles)) {
            assert.equal(grant.delete, false, `${role} may delete from ${tableId}`);
            assert.equal(grant.update, 'own', `${role} may rewrite someone else's entry in ${tableId}`);
        }
    }
    // Vocabulary is the privacy officer's to change; a handler works within it.
    assert.equal(tableOf('tbl_grnd001').access.roles.handler.create, false);
    assert.equal(tableOf('tbl_grnd001').access.roles.dpo.create, true);
});

test('nothing in the app requires Nextcloud to be connected', () => {
    const kinds = new Set();
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (typeof obj.kind === 'string') kinds.add(obj.kind);
        Object.values(obj).forEach(walk);
    };
    walk(definition);
    assert.equal(kinds.has('connector'), false, 'a connector binding would need an external system configured');
    assert.equal(dataModel.connectors, undefined);
    assert.equal(kinds.has('run_automation'), false, 'an automation dependency would install unwired');
    assert.equal(kinds.has('send_email'), false, 'no mailbox is configured on a fresh install');
});

test('every person in the seed is plainly fictional', () => {
    // This app would otherwise hold real requesters. Demo data that could be
    // mistaken for a real personal record is the one thing it must never ship.
    for (const r of rowsOf('tbl_reqs001')) {
        assert.match(r.requester_email, /@example\.com$/, `${r.reference}: ${r.requester_email} is not an example.com address`);
        assert.ok(r.identifiers.length === 0 || /example\.com|\d/.test(r.identifiers));
    }
    const emails = JSON.stringify(seed).match(/[\w.+-]+@[\w.-]+/g) || [];
    for (const email of emails) {
        assert.match(email, /@example\.com$/, `${email} is not an example.com address`);
    }
});
