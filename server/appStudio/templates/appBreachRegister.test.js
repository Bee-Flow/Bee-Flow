/**
 * Data breach register — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates, and that its
 * seed rows fit their columns. None of that can catch what this app is actually
 * exposed to, which is arithmetic and judgement:
 *
 *   • A DEADLINE THAT IS WRONG BY A FEW HOURS looks exactly like one that is
 *     right. Every column the register sorts, filters and reports on is written
 *     by an authored formula, so the formulas are run here through the REAL
 *     expression engine and the seed is checked against what they produce.
 *   • A GUARD READING A STALE SNAPSHOT is invisible in review. `vars.breach` is
 *     taken when the row is clicked; anything an action can rewrite is a lie the
 *     moment somebody uses the screen. The set of rewritable fields is derived
 *     from the actions themselves, so this test cannot go out of date.
 *   • A JUDGEMENT WITH NO REASONING is the exact failure the register exists to
 *     prevent — a breach recorded as not notifiable, or notified late, with
 *     nothing on file saying why.
 *
 * Run: cd server && node --test appStudio/templates/appBreachRegister.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appBreachRegister');
const { canonicalizeAppDefinition } = require('../canonicalize');

const { seed, dataModel, definition } = template;

const rowsOf = (tableId) => seed[tableId] || [];
const tableOf = (tableId) => dataModel.tables.find((t) => t.id === tableId);
const fieldOf = (tableId, key) => (tableOf(tableId).fields || []).find((f) => f.key === key);

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

/** Every step of an action, including the ones inside condition branches. */
function flatSteps(action) {
    const out = [];
    const walk = (steps) => {
        for (const s of steps || []) {
            out.push(s);
            for (const branch of ['then', 'else', 'steps']) if (Array.isArray(s[branch])) walk(s[branch]);
        }
    };
    walk(action.kind === 'sequence' ? action.steps : [action]);
    return out;
}

const allSteps = () => Object.entries(definition.actions)
    .flatMap(([actionId, action]) => flatSteps(action).map((step) => ({ actionId, step })));

/** The create/update step an action performs on one table. */
function writeStep(actionId, tableId, kind) {
    return flatSteps(definition.actions[actionId]).find((s) => s.kind === kind && s.tableId === tableId);
}

const evalExpr = async (expr, scope) => {
    const { evaluate } = await import('../../shared/expr/index.mjs');
    return evaluate(expr, scope);
};

// ── THE 72-HOUR CLOCK ───────────────────────────────────────────────────────

const intake = () => writeStep('act_report', 'tbl_brchs01', 'create_record');

test('the deadline is awareness plus exactly 72 hours', async () => {
    const expr = intake().values.notify_due_at.expr;
    const cases = [
        ['2026-08-12T09:05:00.000Z', '2026-08-15T09:05:00.000Z'],
        // Across a month boundary, and at an hour where a naive "+3 days" on a
        // date string would silently drop the time of day.
        ['2026-07-30T23:40:00.000Z', '2026-08-02T23:40:00.000Z'],
        ['2026-12-30T00:00:00.000Z', '2027-01-02T00:00:00.000Z'],
    ];
    for (const [aware, expected] of cases) {
        assert.equal(await evalExpr(expr, { form: { became_aware_at: aware } }), expected,
            `72 hours after ${aware} is ${expected}`);
    }
});

/**
 * The distinction people get wrong, and the reason this app exists. An incident
 * that happened months ago but was discovered this morning is due 72 hours from
 * this morning — so the formula must not so much as mention the occurrence date.
 */
test('the clock starts at awareness, never at occurrence', async () => {
    const values = intake().values;
    for (const key of ['notify_due_at', 'notify_due_date']) {
        assert.match(values[key].expr, /became_aware_at/);
        assert.equal(/occurred_at/.test(values[key].expr), false,
            `${key} must not be computed from when the incident happened`);
    }
    // Proven, not just read: something that happened in March, found today.
    assert.equal(
        await evalExpr(values.notify_due_at.expr, { form: { became_aware_at: '2026-08-15T07:30:00.000Z' } }),
        '2026-08-18T07:30:00.000Z',
    );
    // And the field the intake asks for is required, or the clock has no start.
    const awareInput = nodeById('cmp_rpf3');
    assert.equal(awareInput.props.name, 'became_aware_at');
    assert.equal(awareInput.props.required, true);
    assert.equal(awareInput.props.withTime, true, 'a date without a time cannot start a 72-hour clock');
});

/**
 * `notify_due_date` is the deadline's CALENDAR DAY, and the queue flags a breach
 * from the start of that day. That is deliberately early — a filter may only
 * compare against `today`, and being flagged sixteen hours before the deadline
 * is a nuisance where being flagged after it is a fine.
 */
test('the date copy is the deadline day, so the queue errs early and never late', async () => {
    const values = intake().values;
    const aware = '2026-08-12T23:30:00.000Z';
    const dueAt = await evalExpr(values.notify_due_at.expr, { form: { became_aware_at: aware } });
    const dueDate = await evalExpr(values.notify_due_date.expr, { form: { became_aware_at: aware } });
    assert.equal(dueAt, '2026-08-15T23:30:00.000Z');
    assert.equal(dueDate, '2026-08-15', 'the date copy must be the day the deadline falls on');
    assert.ok(dueAt.startsWith(dueDate), 'the two columns must describe the same instant');
});

test('every seeded deadline is exactly what the intake formula would have produced', async () => {
    const values = intake().values;
    for (const b of rowsOf('tbl_brchs01')) {
        assert.equal(b.notify_due_at, await evalExpr(values.notify_due_at.expr, { form: b }),
            `${b.reference}: notify_due_at disagrees with the formula the app writes`);
        assert.equal(b.notify_due_date, await evalExpr(values.notify_due_date.expr, { form: b }),
            `${b.reference}: notify_due_date disagrees with the formula the app writes`);
    }
});

/**
 * The deadline is a stored column and not a computed field. A computed field
 * would have to be stored:true to be evaluated at all, and a stored computed is
 * emitted as raw author SQL into GENERATED ALWAYS AS (…) STORED — which
 * computedDialect only translates for two idioms, neither of them date
 * arithmetic. Asserting the shape keeps a future edit from "simplifying" the
 * intake into DDL that breaks on Postgres and can never be added to a live table.
 */
test('the deadline columns are plain stored columns, not computed fields', () => {
    for (const key of ['notify_due_at', 'notify_due_date', 'authority_hours']) {
        const field = fieldOf('tbl_brchs01', key);
        assert.ok(field, `breaches must carry ${key}`);
        assert.notEqual(field.type, 'computed', `${key} must not be a computed field — see the module header`);
    }
    assert.equal(fieldOf('tbl_brchs01', 'notify_due_at').type, 'datetime');
    assert.equal(fieldOf('tbl_brchs01', 'notify_due_date').type, 'date', 'a filter can only compare a date against `today`');
});

test('the queue compares the date copy against today and orders by the exact instant', () => {
    const grid = nodeById('cmp_ckgrid');
    const urgent = grid.props.source.filter.find((f) => f.field === 'notify_due_date');
    assert.equal(urgent.op, 'lte');
    assert.match(urgent.value.expr, /today/);
    assert.notEqual(urgent.required, true, 'with the toggle off the clause must drop out, not empty the register');
    assert.deepEqual(grid.props.source.sort, [{ field: 'notify_due_at', dir: 'asc' }],
        'the most urgent breach must be the top row');
    // And what the eye reads is the column the filter uses — showing the
    // timestamp beside a filter on the date would be two different truths.
    assert.ok(grid.props.columns.some((c) => c.key === 'notify_due_date'));
});

// ── THE PROOF, AFTERWARDS ───────────────────────────────────────────────────

test('the hours-to-notify are computed from two stored timestamps, never from the clock', async () => {
    const step = writeStep('act_authnote', 'tbl_brchs01', 'update_record');
    const expr = step.values.authority_hours.expr;
    assert.match(expr, /form\.notified_at/, 'the notification time comes from the form');
    assert.match(expr, /vars\.breach\.became_aware_at/, 'the start of the clock comes from the record');
    assert.equal(/\bnow\b/.test(expr), false,
        'reading `now` would make the evidence depend on when the button was pressed rather than on the register');
    assert.equal(await evalExpr(expr, {
        form: { notified_at: '2026-08-06T09:15:00.000Z' },
        vars: { breach: { became_aware_at: '2026-08-05T11:20:00.000Z' } },
    }), 21);
});

test('every seeded notification records exactly the hours the app would have computed', async () => {
    const expr = writeStep('act_authnote', 'tbl_brchs01', 'update_record').values.authority_hours.expr;
    for (const b of rowsOf('tbl_brchs01')) {
        if (!b.authority_notified_at) {
            assert.equal(b.authority_hours, undefined,
                `${b.reference} records hours-to-notify without a notification`);
            continue;
        }
        const expected = await evalExpr(expr, {
            form: { notified_at: b.authority_notified_at },
            vars: { breach: { became_aware_at: b.became_aware_at } },
        });
        assert.equal(b.authority_hours, expected, `${b.reference}: authority_hours should be ${expected}`);
    }
});

/**
 * Article 33(1): a notification later than 72 hours must be accompanied by the
 * reasons for the delay. A late breach with an empty reason column is precisely
 * the finding an authority writes down, so the seed may not teach it.
 */
test('every notification later than 72 hours carries its reason for the delay', () => {
    const late = rowsOf('tbl_brchs01').filter((b) => typeof b.authority_hours === 'number' && b.authority_hours > 72);
    assert.ok(late.length >= 1, 'the seed must show what a late notification looks like — it is the case that teaches');
    for (const b of late) {
        assert.ok(b.authority_late_reason && b.authority_late_reason.trim().length > 20,
            `${b.reference} was notified after ${b.authority_hours} hours with no reason for the delay on file`);
    }
    // The other direction: an on-time notification should not be carrying an
    // excuse, which would read as an admission that was never needed.
    for (const b of rowsOf('tbl_brchs01')) {
        if (typeof b.authority_hours === 'number' && b.authority_hours <= 72) {
            assert.equal(b.authority_late_reason, undefined,
                `${b.reference} was notified in time but records a reason for a delay`);
        }
    }
    // The register offers somewhere to put it.
    assert.ok(nodeById('cmp_auf3').props.name === 'late_reason');
});

test('the late counter reads exactly "notified after the 72 hours were up"', () => {
    const stat = nodeById('cmp_ckst3');
    assert.deepEqual(stat.props.value.filter, [{ field: 'authority_hours', op: 'gt', value: 72 }]);
    assert.equal(stat.props.value.tableId, 'tbl_brchs01');
});

test('the "due now" counter reads "owes a notification, and the day has come"', () => {
    const stat = nodeById('cmp_ckst2');
    const shape = stat.props.value.filter.map((f) => `${f.field}:${f.op}`);
    assert.deepEqual(shape, ['authority_required:eq', 'authority_notified_at:isNull', 'notify_due_date:lte']);
    // The safe direction: a breach nobody has assessed yet still counts, because
    // authority_required defaults to true.
    assert.equal(fieldOf('tbl_brchs01', 'authority_required').default, true,
        'Article 33(1) presumes the obligation until someone writes down why it does not apply');
});

// ── THE VOCABULARIES AGREE ──────────────────────────────────────────────────

test('every seeded breach sits in a severity tier the vocabulary defines', () => {
    const tiers = new Set(rowsOf('tbl_sevs001').map((s) => s.key));
    for (const b of rowsOf('tbl_brchs01')) {
        assert.ok(tiers.has(b.severity),
            `${b.reference} is at severity "${b.severity}", which severity_levels does not define`);
    }
});

test('the assessment dropdown and the severity table describe the same tiers', () => {
    const tiers = new Set(rowsOf('tbl_sevs001').map((s) => s.key));
    const offered = new Set(nodeById('cmp_asf1').props.options.map((o) => o.value));
    assert.deepEqual([...offered].sort(), [...tiers].sort(),
        'the dropdown is author-time and the table is data — a tier in one and not the other is the seam becoming a bug');
    // And the register colours every tier it can display.
    const toned = new Set(nodeById('cmp_asguide').props.badgeToneMap.map((m) => m.value));
    for (const key of tiers) assert.ok(toned.has(key), `tier "${key}" has no colour anywhere`);
});

/**
 * A breach with no risk tier is a hole in the register, so "not assessed yet" is
 * a tier rather than a blank: the column is required with a default, the default
 * names a real row of the vocabulary, and the intake writes it explicitly rather
 * than relying on the column default alone.
 */
test('a breach can never sit in the register with no risk tier at all', () => {
    const field = fieldOf('tbl_brchs01', 'severity');
    assert.equal(field.required, true);
    assert.ok(field.default, 'a required severity with no default would refuse the insert instead of defaulting');
    const tiers = new Set(rowsOf('tbl_sevs001').map((s) => s.key));
    assert.ok(tiers.has(field.default), `the default tier "${field.default}" must exist in severity_levels`);
    assert.deepEqual(intake().values.severity, { kind: 'static', value: field.default });
    for (const b of rowsOf('tbl_brchs01')) {
        assert.ok(b.severity, `${b.reference} has no severity`);
    }
});

test('the breach references are unique, so the log can name one without ambiguity', () => {
    const refs = rowsOf('tbl_brchs01').map((b) => b.reference);
    assert.equal(new Set(refs).size, refs.length, 'two breaches share a reference');
    assert.equal(fieldOf('tbl_brchs01', 'reference').unique, true);
});

/**
 * There are no joins, so every child row carries a denormalised copy of its
 * parent's reference. A copy that disagrees with the parent makes a log entry
 * point at a breach that is not the one it belongs to.
 */
test('every child row names the reference of the breach it belongs to', () => {
    const refByAlias = new Map(rowsOf('tbl_brchs01').filter((b) => b.$id).map((b) => [b.$id, b.reference]));
    for (const tableId of ['tbl_bacts01', 'tbl_bsys001']) {
        for (const row of rowsOf(tableId)) {
            const alias = row.breach_id.$ref;
            assert.ok(refByAlias.has(alias), `${tableId} row points at unseeded breach "${alias}"`);
            assert.equal(row.breach_reference, refByAlias.get(alias),
                `${tableId} row is labelled "${row.breach_reference}" but hangs off ${refByAlias.get(alias)}`);
        }
    }
});

test('every seeded log entry uses an action type the vocabulary declares', () => {
    const declared = new Set(fieldOf('tbl_bacts01', 'action_type').options.map((o) => o.value));
    for (const row of rowsOf('tbl_bacts01')) {
        assert.ok(declared.has(row.action_type), `log entry uses unknown action type "${row.action_type}"`);
    }
});

// ── RECORDED, NOT NOTIFIABLE — A FIRST-CLASS OUTCOME ────────────────────────

/**
 * The judgement the register exists to evidence. A breach that was correctly not
 * notified is a compliant ending under Article 33(5), so it has to be an outcome
 * the app can reach, count and explain — not a case left at "pending" forever.
 */
test('"nobody needs to be told" is a complete outcome, reached by one explicit choice', () => {
    const update = writeStep('act_assess', 'tbl_brchs01', 'update_record');
    assert.equal(update.values.outcome.expr, "form.notify_decision == 'nobody' ? 'recorded_only' : 'pending'");
    assert.equal(update.values.authority_required.expr, "form.notify_decision != 'nobody'");
    assert.equal(update.values.subjects_required.expr, "form.notify_decision == 'authority_and_subjects'");

    // The choice is one required field, and its three values are the three the
    // Regulation actually distinguishes.
    const decision = nodeById('cmp_asf2');
    assert.equal(decision.props.required, true);
    assert.deepEqual(decision.props.options.map((o) => o.value).sort(),
        ['authority_and_subjects', 'authority_only', 'nobody']);

    // And it is a declared outcome, with a counter on the home screen.
    const outcomes = fieldOf('tbl_brchs01', 'outcome').options.map((o) => o.value);
    assert.ok(outcomes.includes('recorded_only'));
    assert.deepEqual(nodeById('cmp_ckst4').props.value.filter,
        [{ field: 'outcome', op: 'eq', value: 'recorded_only' }]);
});

test('nothing can be recorded as not notifiable without writing down why', () => {
    // The dedicated route asks for the ground as a required field…
    assert.equal(nodeById('cmp_nnf1').props.required, true);
    const update = writeStep('act_notnotify', 'tbl_brchs01', 'update_record');
    assert.equal(update.values.risk_summary.expr, 'form.justification');
    assert.deepEqual(update.values.outcome, { kind: 'static', value: 'recorded_only' });
    assert.deepEqual(update.values.authority_required, { kind: 'static', value: false });
    // …and so does the assessment that can reach the same outcome.
    assert.equal(nodeById('cmp_asf3').props.name, 'risk_summary');
    assert.equal(nodeById('cmp_asf3').props.required, true);
    // The seed shows one, with real reasoning attached.
    const recorded = rowsOf('tbl_brchs01').filter((b) => b.outcome === 'recorded_only');
    assert.ok(recorded.length >= 1, 'the seed must contain a breach that was correctly not notified');
    for (const b of recorded) {
        assert.ok(b.risk_summary && b.risk_summary.trim().length > 40,
            `${b.reference} is recorded as not notifiable with no reasoning`);
        assert.equal(b.authority_notified_at, undefined, `${b.reference} is "not notifiable" yet records a notification`);
    }
});

/** Article 34(3): skipping the people affected needs one of three grounds, recorded. */
test('the people affected can only be skipped on a recorded Article 34(3) ground', () => {
    const grounds = new Set(fieldOf('tbl_brchs01', 'subjects_exempt_ground').options.map((o) => o.value));
    assert.deepEqual([...grounds].sort(), ['disproportionate', 'encryption', 'measures']);
    const update = writeStep('act_subjexmpt', 'tbl_brchs01', 'update_record');
    assert.deepEqual(update.values.subjects_required, { kind: 'static', value: false });
    assert.equal(update.values.subjects_exempt_ground.expr, 'form.ground');
    assert.equal(update.values.subjects_exempt_reason.expr, 'form.reason');
    assert.equal(nodeById('cmp_sef2').props.required, true, 'the ground alone is a label; the reasoning is the record');

    for (const b of rowsOf('tbl_brchs01')) {
        if (!b.subjects_exempt_ground) continue;
        assert.ok(grounds.has(b.subjects_exempt_ground), `${b.reference} uses unknown exemption "${b.subjects_exempt_ground}"`);
        assert.ok(b.subjects_exempt_reason && b.subjects_exempt_reason.trim().length > 40,
            `${b.reference} claims an Article 34(3) exemption with no reasoning`);
    }
});

// ── THE ACTION LOG IS THE EVIDENCE ──────────────────────────────────────────

/**
 * The timeline is only evidence if it is complete, and it is only complete if
 * writing it is not a separate thing to remember. Every action that changes the
 * register must write a log line in the same sequence.
 */
test('every action that changes the register also writes the action log', () => {
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        const touchesRegister = steps.some(
            (s) => (s.kind === 'create_record' || s.kind === 'update_record') && s.tableId === 'tbl_brchs01',
        );
        if (!touchesRegister) continue;
        assert.ok(steps.some((s) => s.kind === 'create_record' && s.tableId === 'tbl_bacts01'),
            `${actionId} changes the register without leaving a line in the action log`);
    }
});

test('every log line the app writes says who wrote it, on the server', () => {
    for (const { actionId, step } of allSteps()) {
        if (step.kind !== 'create_record' || step.tableId !== 'tbl_bacts01') continue;
        assert.equal(step.values.actor_name.expr, 'currentUser.name',
            `${actionId} writes a log line with no author`);
        assert.ok(step.values.happened_at, `${actionId} writes a log line with no timestamp`);
    }
});

/**
 * Nothing deletes from the register or its log. A record that can be removed is
 * not evidence, and a gap in the references is the first thing an auditor asks
 * about. Only the supporting systems list — working notes about infrastructure —
 * may be corrected by deletion, and that asks first.
 */
test('the register and its log cannot be deleted from; the systems list can, with a confirmation', () => {
    const deleted = new Set(allSteps().filter(({ step }) => step.kind === 'delete_record').map(({ step }) => step.tableId));
    assert.equal(deleted.has('tbl_brchs01'), false, 'nothing may delete a breach');
    assert.equal(deleted.has('tbl_bacts01'), false, 'nothing may delete an action-log entry');
    assert.ok(deleted.has('tbl_bsys001'), 'a system added in error must be removable');

    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        if (!steps.some((s) => s.kind === 'delete_record')) continue;
        assert.ok(steps.some((s) => s.kind === 'confirm'), `${actionId} deletes without confirming`);
    }

    // The access matrix has to agree with the actions — a role granted delete on
    // the register would make the guarantee a UI convention rather than a rule.
    for (const tableId of ['tbl_brchs01', 'tbl_bacts01']) {
        for (const [role, grants] of Object.entries(tableOf(tableId).access.roles)) {
            assert.ok(grants.delete === false || grants.delete === 'none',
                `role "${role}" may delete from ${tableId}`);
        }
    }
});

// ── SNAPSHOTS, GUARDS AND STALENESS ─────────────────────────────────────────

/** Every column an action can rewrite — derived, so this cannot go out of date. */
const MUTABLE_BREACH_FIELDS = new Set(
    allSteps()
        .filter(({ step }) => step.kind === 'update_record' && step.tableId === 'tbl_brchs01')
        .flatMap(({ step }) => Object.keys(step.values || {})),
);

/**
 * `vars.breach` is the row as it was when it was clicked. Reading a field an
 * action can rewrite means reading a value that may already be wrong — and the
 * failure is silent, because the snapshot is a perfectly valid object. So the
 * whole app may only read fields of it that nothing here ever writes.
 */
test('nothing reads a field of the open-breach snapshot that an action can rewrite', () => {
    const offences = [];
    const READ_RE = /\bvars\s*\.\s*breach\s*\.\s*([A-Za-z_][\w]*)/g;
    const visit = (obj, path) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((o, i) => visit(o, `${path}[${i}]`)); return; }
        if (typeof obj.expr === 'string') {
            for (const m of obj.expr.matchAll(READ_RE)) {
                if (MUTABLE_BREACH_FIELDS.has(m[1])) offences.push(`${path}: vars.breach.${m[1]}`);
            }
        }
        for (const [k, v] of Object.entries(obj)) visit(v, `${path}.${k}`);
    };
    visit(definition.screens, 'screens');
    visit(definition.actions, 'actions');
    assert.deepEqual(offences, [],
        'read these from a live record binding instead — the snapshot is only trustworthy for fields nothing writes');
});

test('every guard tests only whether a breach is open at all', () => {
    for (const { actionId, step } of allSteps()) {
        if (step.kind !== 'condition') continue;
        assert.equal(step.expr, 'vars.breach.id', `${actionId} guards on something that can change underneath it`);
        assert.ok(Array.isArray(step.else) && step.else.some((s) => s.kind === 'toast'),
            `${actionId} refuses silently when nothing is open`);
    }
});

/**
 * The complement of the rule above: anything on screen that DOES show a field an
 * action rewrites has to be re-read from the database, or it keeps showing the
 * old value immediately after the very action the screen exists to perform.
 */
test('the stage stepper reads the live row, not the snapshot', () => {
    const stepper = nodeById('cmp_brstep');
    assert.equal(stepper.props.value.kind, 'record');
    assert.equal(stepper.props.value.tableId, 'tbl_brchs01');
    assert.equal(stepper.props.value.pick.column, 'stage');
    assert.ok(MUTABLE_BREACH_FIELDS.has('stage'),
        'if stage ever stopped being written by an action this test would be guarding nothing');
    // Same for the file itself.
    assert.equal(nodeById('cmp_brdet').props.source.kind, 'record');
    assert.equal(nodeById('cmp_brdet').props.source.tableId, 'tbl_brchs01');
});

/**
 * The countdown is the one place `now` is legal: it is a display formula, not a
 * filter, so it can never make a fetch and its cache key disagree. It must stay
 * out of every records/aggregate filter.
 */
test('`now` appears in the countdown and in no binding filter anywhere', () => {
    const clock = nodeById('cmp_brclock');
    assert.match(clock.props.contentFrom.expr, /\bnow\b/);
    assert.match(clock.props.contentFrom.expr, /notify_due_at/);

    const offences = [];
    const visit = (obj, path) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((o, i) => visit(o, `${path}[${i}]`)); return; }
        if (Array.isArray(obj.filter) && typeof obj.kind === 'string') {
            obj.filter.forEach((f, i) => {
                const expr = f && f.value && f.value.expr;
                if (typeof expr !== 'string') return;
                const roots = expr.match(/\b(now|form|item|records|datasets)\b/g);
                if (roots) offences.push(`${path}.filter[${i}]: ${expr}`);
            });
        }
        for (const [k, v] of Object.entries(obj)) visit(v, `${path}.${k}`);
    };
    visit(definition.screens, 'screens');
    assert.deepEqual(offences, [],
        'a filter formula may only read currentUser / vars / forms / screen / today');
});

// ── IT WORKS WITH NOTHING SELECTED ──────────────────────────────────────────

test('the breach file shows nothing rather than everything when nothing is open', () => {
    // Every child query is scoped to the open breach and REQUIRED, so with no
    // breach the whole clause set is dropped and the component shows nothing —
    // never every processor in the organisation.
    for (const id of ['cmp_brdet', 'cmp_sygrid', 'cmp_lgline']) {
        const source = nodeById(id).props.source;
        const scope = source.filter.find((f) => f.field === 'breach_id' || f.field === 'id');
        assert.ok(scope, `${id} must be scoped to the open breach`);
        assert.equal(scope.required, true, `${id} would show unrelated rows with nothing open`);
        assert.ok(nodeById(id).props.emptyText, `${id} must say what to do when it is empty`);
    }
    // And the screen says so in words rather than leaving four blank panels.
    const empty = nodeById('cmp_brnone');
    assert.equal(empty.type, 'callout');
    assert.equal(empty.visible.expr, '!vars.breach.id');
    assert.equal(nodeById('cmp_brclock').visible.expr, 'vars.breach.id');
});

test('the register itself shows everything open when no filter is set', () => {
    const source = nodeById('cmp_ckgrid').props.source;
    const fixed = source.filter.filter((f) => f.required === true);
    assert.deepEqual(fixed, [], 'a required filter here would leave the home screen blank on first open');
    const always = source.filter.find((f) => f.field === 'stage' && f.op === 'neq');
    assert.equal(always.value, 'closed', 'the home screen is the OPEN register');
    for (const f of source.filter) {
        if (f === always) continue;
        assert.equal(f.required, false, `${f.field} must drop out when the filter bar is empty`);
    }
});

test('every scalar aggregate carries a pick naming one of its own aliases', () => {
    const offences = [];
    const visit = (obj, path) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach((o, i) => visit(o, `${path}[${i}]`)); return; }
        if (obj.kind === 'aggregate' && !Array.isArray(obj.groupBy)) {
            const aliases = (obj.aggregates || []).map((a) => a.as).filter(Boolean);
            if (!obj.pick) offences.push(`${path}: no pick (would render the rows array)`);
            else if (!aliases.includes(obj.pick.column)) {
                offences.push(`${path}: pick.column "${obj.pick.column}" is not one of [${aliases.join(', ')}]`);
            }
        }
        if (obj.kind === 'aggregate' && !obj.limit) offences.push(`${path}: no limit (silently capped at 50)`);
        for (const [k, v] of Object.entries(obj)) visit(v, `${path}.${k}`);
    };
    visit(definition.screens, 'screens');
    assert.deepEqual(offences, []);
});

// ── THE SERVER/CLIENT SCOPE SPLIT ───────────────────────────────────────────

/**
 * A server step's formula scope has no `screen`, `forms`, `actions`, `records`
 * or `datasets`. A binding naming one resolves in the browser preview and writes
 * NULL in production — the worst kind of wrong, because it passes every check an
 * author can run before shipping.
 */
test('no server step reads a scope root the server does not populate', () => {
    const SERVER_KINDS = new Set(['create_record', 'update_record', 'delete_record']);
    const FORBIDDEN = /\b(screen|forms|actions|records|datasets)\s*\./;
    const offences = [];
    for (const { actionId, step } of allSteps()) {
        if (!SERVER_KINDS.has(step.kind)) continue;
        const exprs = [];
        if (step.recordId && step.recordId.expr) exprs.push(['recordId', step.recordId.expr]);
        for (const [key, binding] of Object.entries(step.values || {})) {
            if (binding && binding.expr) exprs.push([`values.${key}`, binding.expr]);
        }
        for (const [where, expr] of exprs) {
            if (FORBIDDEN.test(expr)) offences.push(`${actionId}.${where}: ${expr}`);
        }
    }
    assert.deepEqual(offences, []);
});

test('every mutation refreshes the table it dirtied', () => {
    const MUTATES = new Set(['create_record', 'update_record', 'delete_record']);
    for (const [actionId, action] of Object.entries(definition.actions)) {
        const steps = flatSteps(action);
        const dirtied = new Set(steps.filter((s) => MUTATES.has(s.kind)).map((s) => s.tableId));
        if (!dirtied.size) continue;
        const refreshed = new Set(steps.filter((s) => s.kind === 'refresh').map((s) => s.tableId));
        for (const tableId of dirtied) {
            assert.ok(refreshed.has(tableId),
                `${actionId} writes ${tableId} but never refreshes it — the change would not appear`);
        }
    }
});

test('the intake hangs the first log entry off the row it just created', () => {
    const steps = flatSteps(definition.actions.act_report);
    const create = steps.find((s) => s.kind === 'create_record' && s.tableId === 'tbl_brchs01');
    assert.equal(create.resultVar, 'newbreach',
        'without naming the result, the new id is only the last step result and the next server step overwrites it');
    const log = steps.find((s) => s.kind === 'create_record' && s.tableId === 'tbl_bacts01');
    assert.equal(log.values.breach_id.expr, 'vars.newbreach.id');
    assert.ok(steps.indexOf(create) < steps.indexOf(log), 'the row has to exist before anything points at it');
    // Declared, so a typo in the name is a warning rather than a silent null.
    assert.ok(definition.variables.some((v) => v.name === 'newbreach'));
});

// ── LAYOUT AND PORTABILITY ──────────────────────────────────────────────────

test('every fill section is a single 12-column row', () => {
    for (const screen of CANON.screens) {
        for (const section of screen.sections) {
            if (section.style?.height !== 'fill') continue;
            const spans = section.children.map((c) => c.style.span);
            assert.equal(spans.reduce((a, b) => a + b, 0), 12,
                `${screen.id}/${section.id} must hold one row — a fill section stretches its first row only`);
        }
    }
});

test('the home screen is the clock, and it is full width for a Nextcloud page', () => {
    assert.equal(CANON.homeScreenId, 'scr_clock');
    const home = CANON.screens.find((s) => s.id === 'scr_clock');
    assert.equal(home.maxWidth, 'full');
    assert.equal(home.showInNav, true);
    // The breach file is reached by opening a breach, never from the nav — with
    // nothing selected a nav entry would land on an empty screen.
    assert.equal(CANON.screens.find((s) => s.id === 'scr_breach').showInNav, false);
});

test('`filters` is used but never declared — it belongs to the filter bar', () => {
    assert.equal(definition.variables.some((v) => v.name === 'filters'), false);
    const bars = NODES.filter((n) => n.type === 'filter_bar');
    // One per screen, never two: they all publish into the same variable.
    const byScreen = new Map();
    for (const screen of CANON.screens) {
        const count = allNodes({ screens: [screen] }).filter((n) => n.type === 'filter_bar').length;
        if (count) byScreen.set(screen.id, count);
    }
    for (const [screenId, count] of byScreen) {
        assert.equal(count, 1, `${screenId} has ${count} filter bars, which would fight over vars.filters`);
    }
    assert.ok(bars.length >= 1);
});

/**
 * The template must be identical inside a Nextcloud page and standalone. It may
 * BENEFIT from Nextcloud — an embedded viewer's currentUser is their NC identity,
 * so the register records the real name — but it must not REQUIRE it.
 */
test('nothing in the app requires Nextcloud, a connector or a routine', () => {
    const kinds = new Set();
    const walk = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (typeof obj.kind === 'string') kinds.add(obj.kind);
        Object.values(obj).forEach(walk);
    };
    walk(definition);
    assert.equal(kinds.has('connector'), false, 'a connector binding needs an external system configured');
    assert.equal(kinds.has('run_automation'), false, 'a routine would install unwired and could not succeed');
    assert.equal(dataModel.connectors, undefined);
    assert.equal(kinds.has('send_email'), false, 'sending a notification needs a mailbox connector');
});

// ── THE SEED TEACHES THE APP ────────────────────────────────────────────────

test('the seed shows a register in every state the app can be in', () => {
    const rows = rowsOf('tbl_brchs01');
    const has = (fn, what) => assert.ok(rows.some(fn), `the seed must contain ${what}`);

    has((b) => b.severity === 'unassessed' && b.stage === 'reported', 'a breach nobody has assessed yet');
    has((b) => b.stage !== 'closed' && !b.authority_notified_at && b.notify_due_date <= '2026-08-15',
        'a breach whose 72 hours are up and which has not been notified — the app is pointless if the first screen is empty');
    has((b) => typeof b.authority_hours === 'number' && b.authority_hours <= 72, 'a notification made in time');
    has((b) => typeof b.authority_hours === 'number' && b.authority_hours > 72, 'a notification made late');
    has((b) => b.outcome === 'recorded_only', 'a breach correctly not notified');
    has((b) => b.outcome === 'not_a_breach', 'something reported that turned out not to be a breach at all');
    has((b) => b.outcome === 'notified_all', 'a breach where the people affected were told');
    has((b) => b.subjects_exempt_ground, 'a high-risk breach where an Article 34(3) exemption applied');
    has((b) => b.special_categories === true, 'a breach involving special-category data');
    // Every kind of breach the vocabulary names, so the type column is not one value.
    const types = new Set(rows.map((b) => b.breach_type));
    assert.ok(types.size >= 2, 'the seed should show more than one kind of breach');
});

test('the closed register can show why each case ended the way it did', () => {
    for (const b of rowsOf('tbl_brchs01')) {
        if (b.stage !== 'closed') continue;
        assert.notEqual(b.outcome, 'pending', `${b.reference} is closed with no outcome recorded`);
        assert.ok(b.closed_on, `${b.reference} is closed with no closing date`);
        assert.ok(b.risk_summary, `${b.reference} is closed with no risk assessment on file`);
    }
    // Closing preserves the outcome rather than flattening it — a case recorded
    // as not notifiable must still say so after it is closed.
    const close = writeStep('act_close', 'tbl_brchs01', 'update_record');
    assert.equal('outcome' in close.values, false,
        'closing must not overwrite the outcome the assessment reached');
    assert.deepEqual(close.values.stage, { kind: 'static', value: 'closed' });
});

test('every breach with a processor involved records when they told us', () => {
    // Article 33(2): the controller's own 72 hours start when the processor
    // reports. If that timestamp is missing, the deadline on the record cannot
    // be justified to anyone.
    for (const row of rowsOf('tbl_bsys001')) {
        if (row.party_role === 'own_system') continue;
        assert.ok(row.told_us_at, `"${row.name}" is a ${row.party_role} with no record of when they told us`);
    }
    const processorBreach = rowsOf('tbl_bsys001').find((r) => r.party_role === 'processor');
    const parent = rowsOf('tbl_brchs01').find((b) => b.reference === processorBreach.breach_reference);
    assert.equal(parent.became_aware_at, processorBreach.told_us_at,
        'when a processor reports it, the moment they told us IS the moment we became aware');
});
