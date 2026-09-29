/**
 * Invoice approvals — the checks templates.test.js cannot make.
 *
 * The generic suite proves this template canonicalizes, validates and that its
 * seed rows conform to their columns. None of that can catch what an APPROVAL
 * LADDER is actually exposed to, which is not a crash — it is an invoice that
 * quietly reaches the wrong desk, or nobody's:
 *
 *  • a rung whose condition drifted away from the band that chooses the chain,
 *  • a branch of the switch that marks an invoice "in approval" without asking
 *    anybody,
 *  • a real user id committed into a shipped template's approver seat,
 *  • an on_decided hook writing a column that no longer exists, so the
 *    decision lands and the invoice never moves,
 *  • a written-down policy that no longer describes the enforced one,
 *  • a denormalised supplier name that no longer matches the row it came from.
 *
 * Every one of those passes validation and reads fine on screen.
 *
 * The routing is exercised with the REAL expression engine over the REAL
 * expressions lifted out of the definition — a test that re-implements the
 * rule it is checking only proves the author typed it twice.
 *
 * Run: cd server && node --test --test-force-exit appStudio/templates/appInvoiceApprovals.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const template = require('./appInvoiceApprovals');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { canonicalizeDataModel } = require('../dataModel');
const { tryEvaluate } = require('../../shared/expr/engine.mjs');
const {
    MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE, MAX_TOTAL_SEATS,
    MAX_STAGE_NAME_LEN, MAX_STAGE_DESCRIPTION_LEN, STAGE_RULES,
    desugarApprovalStages, activeStages,
} = require('../../automation/approvalStages');

const { seed, dataModel, definition } = template;

// ── little helpers ──────────────────────────────────────────────────────────

const rowsOf = (tableId) => seed[tableId] || [];
const tableOf = (tableId) => dataModel.tables.find((t) => t.id === tableId);
const fieldOf = (tableId, key) => (tableOf(tableId).fields || []).find((f) => f.key === key);
const optionsOf = (tableId, key) => (fieldOf(tableId, key).options || []).map((o) => o.value);

/** Alias → row, for the $ref graph. */
const byAlias = new Map(
    Object.values(seed).flat().filter((r) => typeof r.$id === 'string').map((r) => [r.$id, r]),
);

/** Every node in the canonical definition, flattened, with its screen. */
function allNodes(def) {
    const out = [];
    const walk = (children, screen) => {
        for (const child of children || []) {
            out.push({ node: child, screen });
            if (Array.isArray(child.children)) walk(child.children, screen);
        }
    };
    for (const screen of def.screens || []) {
        for (const section of screen.sections || []) walk(section.children, screen);
    }
    return out;
}

const CANON = canonicalizeAppDefinition(definition).def;
const MODEL = canonicalizeDataModel(dataModel).model;
const NODES = allNodes(CANON);
const nodeById = (id) => (NODES.find((n) => n.node.id === id) || {}).node;

/** Flatten one action's steps, including condition/loop/switch branches. */
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

const ALL_STEPS = Object.entries(definition.actions)
    .flatMap(([id, action]) => flatSteps(action).map((step) => ({ id, step })));

/** Every request_approval step in the app, with the action it belongs to. */
const APPROVAL_STEPS = ALL_STEPS.filter(({ step }) => step.kind === 'request_approval');

/** Every stage of every chain. */
const ALL_STAGES = APPROVAL_STEPS.flatMap(({ id, step }) =>
    (step.stages || []).map((stage) => ({ id, stage })));

const evaluate = (expr, scope) => {
    const { value, error } = tryEvaluate(expr, scope);
    assert.equal(error, null, `"${expr}" failed to evaluate: ${error}`);
    return value;
};

/** The scope a request_approval step really sees: form + vars, nothing else. */
const submitScope = (form) => ({
    form,
    forms: { send: form },
    vars: { invoice: { id: 'rec_test', invoice_no: 'X-1', document: null } },
    screen: {}, actions: {}, records: {}, datasets: {}, connectors: {},
    item: undefined, index: undefined, value: undefined,
    now: '2026-08-23T09:00:00Z', today: '2026-08-23',
    currentUser: { id: 'u1', name: 'Tester', email: 't@example.com', roleKey: 'ap', isOwner: false, roles: ['ap'] },
});

const money = (amount, over = {}) => ({
    amount_total: amount, currency: 'EUR', invoice_no: 'X-1', supplier_name: 'A supplier',
    cost_center: 'cc_ops', supplier_check: 'standard', director_rule: 'auto', submit_note: '',
    ...over,
});

/** The submit action, and the two routing steps inside it. */
const SUBMIT = definition.actions.act_iasubmit;
const SUPPLIER_CONDITION = flatSteps(SUBMIT).find((s) => s.kind === 'condition');
const BAND_SWITCH = (SUPPLIER_CONDITION.else || []).find((s) => s.kind === 'switch');

/** Which chain a given form lands on, decided by the REAL switch expression. */
function chainFor(form) {
    const key = evaluate(BAND_SWITCH.expr, submitScope(form));
    const branch = (BAND_SWITCH.cases.find((c) => c.value === key) || { steps: BAND_SWITCH.default });
    const step = branch.steps.find((s) => s.kind === 'request_approval');
    assert.ok(step, `switch case "${key}" requests no approval`);
    return { key, step };
}

/** The rungs that would actually be asked, run through the shared rulebook. */
function rungsFor(form) {
    const { step } = chainFor(form);
    const scope = submitScope(form);
    const chain = desugarApprovalStages(
        { stages: step.stages },
        { evaluateWhen: (expr) => !!tryEvaluate(expr, scope).value },
    );
    return activeStages(chain).map((s) => s.name);
}

// ══ THE APPROVER SEATS ══════════════════════════════════════════════════════

test('every approver seat is an unmistakable placeholder, never a real id', () => {
    // A template has no idea who the installer's team leads are, and a seat
    // that LOOKED like a real user id would be silently wrong on every
    // install. `replace-me-` cannot collide with a real group and reads as an
    // instruction wherever it surfaces.
    assert.ok(ALL_STAGES.length > 0, 'the template has stage chains at all');
    for (const { id, stage } of ALL_STAGES) {
        assert.ok(stage.approvers.length > 0, `${id}: stage "${stage.key}" names nobody`);
        for (const seat of stage.approvers) {
            assert.equal(seat.userId, undefined,
                `${id}/${stage.key}: names a USER seat — a rung that names a person stops working the day that person leaves, and a template cannot know the person anyway`);
            assert.equal(typeof seat.groupId, 'string');
            assert.ok(seat.groupId.startsWith('replace-me-'),
                `${id}/${stage.key}: seat "${seat.groupId}" is not a placeholder — a real group id must never be committed into the shipped gallery`);
        }
    }
});

test('the app tells the installer that the seats are placeholders', () => {
    // Two places, because someone who lands on the dashboard should not have
    // to find the Setup screen to learn that every rung currently falls back
    // to the owner.
    for (const id of ['cmp_iahsetup', 'cmp_iaplsetup']) {
        const callout = nodeById(id);
        assert.ok(callout, `${id} exists`);
        assert.match(callout.props.text, /replace-me/,
            `${id} must name the placeholder convention`);
        assert.match(callout.props.text, /owner/i,
            `${id} must say what happens until the seats are filled in`);
    }
    // And every seat the chains use is listed on the policy screen, so the
    // setup task is a checklist rather than a hunt through the action editor.
    const md = nodeById('cmp_iaplmd').props.content;
    const seats = new Set(ALL_STAGES.flatMap(({ stage }) => stage.approvers.map((a) => a.groupId)));
    for (const seat of seats) {
        assert.ok(md.includes(seat), `the policy screen does not list the seat "${seat}"`);
    }
});

test('the seats the policy table names are exactly the seats the chains use', () => {
    const used = new Set(ALL_STAGES.flatMap(({ stage }) => stage.approvers.map((a) => a.groupId)));
    const listed = new Set(
        rowsOf('tbl_iapol')
            .flatMap((r) => String(r.seats_label || '').split(','))
            .map((s) => s.trim())
            .filter((s) => s.startsWith('replace-me-')),
    );
    assert.deepEqual([...listed].sort(), [...used].sort(),
        'the written-down policy names a different set of groups than the ladder actually asks');
});

// ══ STAGES SUPERSEDE THE SHAPES THEY REPLACE ════════════════════════════════

test('no chain also sets an assignee, a panel, a final approver or an escalation', () => {
    // validate.js reports this as action.approval_stages_conflict, and the
    // reason it is an ERROR rather than a merge is worth restating: the
    // alternative is a configured approver nobody ever asks, and nobody
    // discovers that until the invoice is already paid.
    const forbidden = [
        'assigneeUserId', 'assigneeGroupId', 'approverUserIds', 'approverGroupIds',
        'finalApproverUserId', 'finalApproverGroupId', 'escalateToUserId', 'escalateToGroupId',
    ];
    for (const { id, step } of APPROVAL_STEPS) {
        for (const f of forbidden) {
            assert.equal(step[f], undefined, `${id}: request_approval sets both stages and ${f}`);
        }
    }
});

test('every chain stays inside the shared rulebook’s caps', () => {
    for (const { id, step } of APPROVAL_STEPS) {
        const stages = step.stages;
        assert.ok(stages.length <= MAX_APPROVAL_STAGES, `${id}: ${stages.length} stages (max ${MAX_APPROVAL_STAGES})`);
        const keys = new Set();
        let total = 0;
        for (const st of stages) {
            assert.ok(!keys.has(st.key), `${id}: two stages share the key "${st.key}" — votes are filed under it`);
            keys.add(st.key);
            assert.ok(st.approvers.length <= MAX_SEATS_PER_STAGE, `${id}/${st.key}: too many seats`);
            total += st.approvers.length;
            assert.ok(st.name.length <= MAX_STAGE_NAME_LEN, `${id}/${st.key}: name too long`);
            assert.ok(!st.description || st.description.length <= MAX_STAGE_DESCRIPTION_LEN, `${id}/${st.key}: description too long`);
            assert.ok(STAGE_RULES.includes(st.rule), `${id}/${st.key}: rule "${st.rule}" is not legal`);
            if (st.rule === 'quorum') {
                assert.ok(Number.isInteger(st.quorum) && st.quorum >= 1 && st.quorum <= st.approvers.length,
                    `${id}/${st.key}: a quorum of ${st.quorum} out of ${st.approvers.length} seats can never be reached`);
            }
        }
        assert.ok(total <= MAX_TOTAL_SEATS, `${id}: ${total} seats across the chain (max ${MAX_TOTAL_SEATS})`);
    }
});

test('every stage says what it is for — an approver reads the description, not the key', () => {
    for (const { id, stage } of ALL_STAGES) {
        assert.ok(stage.name && stage.name.trim(), `${id}/${stage.key}: unnamed stage`);
        assert.ok(stage.description && stage.description.trim(),
            `${id}/${stage.key}: no description — the person being asked has nothing telling them what they are checking`);
    }
});

// ══ BOTH KINDS OF ROUTING ARE PRESENT ═══════════════════════════════════════

test('flow-level routing: a condition on the supplier and a switch on the amount', () => {
    assert.ok(SUPPLIER_CONDITION, 'act_iasubmit branches on the supplier');
    assert.match(SUPPLIER_CONDITION.expr, /supplier_check/,
        'the flow-level condition must read the supplier lever');
    assert.ok(BAND_SWITCH, 'act_iasubmit switches on the amount band');
    assert.match(BAND_SWITCH.expr, /amount_total/,
        'the flow-level switch must read the amount');

    // Three genuinely different ladders, not three copies of one.
    assert.ok(BAND_SWITCH.cases.length >= 3, 'at least three bands');
    const shapes = BAND_SWITCH.cases.map((c) => {
        const step = c.steps.find((s) => s.kind === 'request_approval');
        return (step.stages || []).map((s) => `${s.key}:${s.rule}`).join('|');
    });
    assert.equal(new Set(shapes).size, shapes.length,
        'two bands produce the identical chain — then they are not different ladders and the switch is decoration');
});

test('per-stage routing: `when` conditions on rungs inside more than one chain', () => {
    const withWhen = APPROVAL_STEPS.filter(({ step }) => (step.stages || []).some((s) => s.when));
    assert.ok(withWhen.length >= 2,
        'at least two chains must carry a conditional rung, or the mechanism is shown once by accident');
    // The owner's own sentence has to be findable as ONE line.
    const director = ALL_STAGES.find(({ stage }) => stage.key === 'director' && stage.when);
    assert.ok(director, 'the director rung must be conditional');
    assert.match(director.stage.when, /amount_total/);
    assert.match(director.stage.when, /director_rule/,
        '"over €5,000 OR this supplier always needs the director" is one condition, not two branches');
});

test('every `when` reads only what a request_approval step can actually see', () => {
    // A request_approval runs SERVER-side, where buildServerScope pins
    // `records`, `actions` and `forms` to empty. A condition reading one of
    // them is not a syntax error — it silently evaluates to false, and a rung
    // vanishes with nobody the wiser.
    for (const { id, stage } of ALL_STAGES) {
        if (!stage.when) continue;
        for (const root of ['records.', 'actions.', 'forms.', 'datasets.', 'connectors.', 'item.', 'screen.']) {
            assert.ok(!stage.when.includes(root),
                `${id}/${stage.key}: \`when\` reads ${root} — server-side that resolves to nothing and the rung would silently disappear`);
        }
        assert.ok(/\bform\./.test(stage.when) || /\bvars\./.test(stage.when),
            `${id}/${stage.key}: \`when\` reads neither form nor vars — it can only be constant`);
        evaluate(stage.when, submitScope(money(1)));
    }
});

// ══ THE ROUTING ACTUALLY ROUTES ═════════════════════════════════════════════

test('the band decides which ladder, and the supplier can promote a small invoice onto a longer one', () => {
    const cases = [
        [money(1), 'fast'],
        [money(999.99), 'fast'],
        [money(1000), 'standard'],
        [money(24999.99), 'standard'],
        [money(25000), 'board'],
        [money(150000), 'board'],
        // A one-rung ladder has nowhere to put Finance or the director, so a
        // watch-list supplier or an "always director" flag has to be answered
        // at the FLOW level rather than by a stage condition.
        [money(400, { supplier_check: 'watch' }), 'standard'],
        [money(400, { director_rule: 'always' }), 'standard'],
        // A missing amount must still land somewhere — a switch that matched
        // nothing would mark the invoice "in approval" with nobody asked.
        [money(null), 'fast'],
    ];
    for (const [form, expected] of cases) {
        assert.equal(chainFor(form).key, expected,
            `€${form.amount_total} (${form.supplier_check}/${form.director_rule}) should take the "${expected}" ladder`);
    }
});

test('the rungs that get asked match the policy, condition by condition', () => {
    const asked = (form) => rungsFor(form);

    // Under €1,000, standard supplier: one rung. Anything more is ceremony.
    assert.deepEqual(asked(money(412.61)), ['Team lead']);

    // The everyday ladder. Finance from €2,500; the director from €5,000.
    assert.deepEqual(asked(money(1200)), ['Team lead', 'Budget holder']);
    assert.deepEqual(asked(money(2500)), ['Team lead', 'Budget holder', 'Finance']);
    assert.deepEqual(asked(money(4999.99)), ['Team lead', 'Budget holder', 'Finance']);
    assert.deepEqual(asked(money(5000)), ['Team lead', 'Budget holder', 'Finance', 'Director']);

    // The supplier levers, at their own thresholds.
    assert.deepEqual(asked(money(1200, { supplier_check: 'watch' })),
        ['Team lead', 'Budget holder', 'Finance'], 'a watch-list supplier pulls Finance in below €2,500');
    assert.deepEqual(asked(money(1200, { director_rule: 'always' })),
        ['Team lead', 'Budget holder', 'Director'], 'the supplier flag pulls the director in below €5,000');

    // The long ladder: quorum, both directors, and the board only at the top.
    assert.deepEqual(asked(money(34364)),
        ['Team lead', 'Budget holder', 'Finance — two of three', 'Both directors']);
    assert.deepEqual(asked(money(116160)),
        ['Team lead', 'Budget holder', 'Finance — two of three', 'Both directors', 'Board']);
});

test('a skipped rung is kept, not deleted — the record must answer “why did this never reach Finance?”', () => {
    const form = money(1200);
    const { step } = chainFor(form);
    const scope = submitScope(form);
    const chain = desugarApprovalStages({ stages: step.stages },
        { evaluateWhen: (expr) => !!tryEvaluate(expr, scope).value });
    assert.equal(chain.length, step.stages.length, 'every authored rung survives into the chain');
    assert.ok(chain.some((s) => s.skipped), 'the rungs whose condition was not met are marked skipped');
});

test('no branch can mark an invoice “in approval” without asking anybody', () => {
    // The fail-safe. A switch case (or a default) that requests nothing while
    // the steps after it set status 'in_approval' is the one failure this app
    // must not have — the invoice would sit there looking like it was with
    // somebody, forever.
    const branches = [
        ...BAND_SWITCH.cases.map((c) => [`case ${c.value}`, c.steps]),
        ['default', BAND_SWITCH.default],
    ];
    for (const [label, steps] of branches) {
        assert.ok(Array.isArray(steps) && steps.length, `the switch has no ${label} — an unmatched value would ask nobody`);
        const requests = steps.filter((s) => s.kind === 'request_approval');
        assert.equal(requests.length, 1, `${label} must request exactly one approval (got ${requests.length})`);
    }
    // …and the else-branch does set the status, which is what makes the above
    // a real invariant rather than a shape assertion.
    const setsInApproval = (SUPPLIER_CONDITION.else || []).some((s) => s.kind === 'update_record'
        && s.values && s.values.status && s.values.status.value === 'in_approval');
    assert.ok(setsInApproval, 'the non-blocked branch marks the invoice as being on the ladder');
});

test('a blocked supplier is parked and nobody is asked', () => {
    // There is no stage shape that means "ask nobody", which is exactly why
    // this decision is made at the flow level, before a chain exists.
    assert.ok(evaluate(SUPPLIER_CONDITION.expr, submitScope(money(2000, { supplier_check: 'blocked' }))));
    assert.ok(!evaluate(SUPPLIER_CONDITION.expr, submitScope(money(2000))));

    const parked = SUPPLIER_CONDITION.then;
    assert.equal(parked.filter((s) => s.kind === 'request_approval').length, 0,
        'the blocked branch must not ask anybody');
    const status = parked.find((s) => s.kind === 'update_record').values.status;
    assert.deepEqual(status, { kind: 'static', value: 'on_hold' });
    const trail = parked.find((s) => s.kind === 'create_record' && s.tableId === 'tbl_iaevt');
    assert.ok(trail, 'and the trail records why, or "nothing happened" is indistinguishable from a bug');
    assert.deepEqual(trail.values.kind, { kind: 'static', value: 'hold' });
});

// ══ THE NUMBERS AGREE EVERYWHERE THEY APPEAR ════════════════════════════════

/** Every numeric literal a routing expression mentions. */
const numbersIn = (expr) => (String(expr).match(/\d+(?:\.\d+)?/g) || []).map(Number);

test('every threshold the routing uses also appears in the preview the sender reads', () => {
    const routing = new Set([
        ...numbersIn(BAND_SWITCH.expr),
        ...ALL_STAGES.filter(({ stage }) => stage.when).flatMap(({ stage }) => numbersIn(stage.when)),
    ]);
    assert.ok(routing.size >= 4, 'the routing should turn on several thresholds');
    const preview = nodeById('cmp_iadladder').props.contentFrom.expr;
    for (const n of routing) {
        assert.ok(numbersIn(preview).includes(n),
            `the "who will be asked" preview never mentions €${n}, so it can tell the sender the wrong ladder`);
    }
});

test('the computed band column uses the same thresholds as the switch', () => {
    const expr = fieldOf('tbl_iainv', 'band').computed.expr;
    for (const n of numbersIn(BAND_SWITCH.expr)) {
        assert.ok(numbersIn(expr).includes(n), `the band column does not know about €${n}`);
    }
});

test('the written-down policy still describes the ladder that runs', () => {
    const policy = rowsOf('tbl_iapol');
    const bands = new Set(numbersIn(BAND_SWITCH.expr));
    // The band boundaries are the table's own min/max.
    const edges = new Set(policy.flatMap((r) => [r.min_amount, r.max_amount]).filter((n) => typeof n === 'number'));
    for (const n of bands) {
        assert.ok(edges.has(n), `no policy row has €${n} as a boundary, but the switch changes ladder there`);
    }
    // The conditional rungs' thresholds are in the prose.
    const prose = policy.map((r) => `${r.rule_note} ${r.stages_label}`).join(' ');
    const stageNumbers = new Set(ALL_STAGES.filter(({ stage }) => stage.when).flatMap(({ stage }) => numbersIn(stage.when)));
    for (const n of stageNumbers) {
        assert.ok(prose.includes(String(n)),
            `the policy prose never mentions €${n}, but a rung switches on there`);
    }
    // A rung that is sometimes skipped must be marked as such where it is read.
    assert.match(prose, /\*/, 'the policy must flag which rungs are conditional');
});

test('the route recorded on every seeded invoice is the route the real expression picks', () => {
    // The label written onto the record has to agree with the switch, or the
    // grid tells a story the ladder did not follow.
    const routeExpr = SUBMIT.steps
        .find((s) => s.kind === 'update_record').values.approval_route.expr;
    for (const inv of rowsOf('tbl_iainv')) {
        if (!inv.approval_route) continue;
        if (inv.supplier_risk === 'blocked') {
            assert.match(inv.approval_route, /Blocked/,
                `${inv.invoice_no}: a blocked supplier's invoice records the parked route`);
            continue;
        }
        const expected = evaluate(routeExpr, submitScope(money(inv.amount_total, {
            supplier_check: inv.supplier_risk,
            director_rule: inv.director_rule,
        })));
        assert.equal(inv.approval_route, expected,
            `${inv.invoice_no}: recorded route "${inv.approval_route}", but the ladder would pick "${expected}"`);
    }
});

// ══ THE RECORD LEARNS THE DECISION ══════════════════════════════════════════

test('every chain carries an on_decided hook that answers all four outcomes', () => {
    for (const { id, step } of APPROVAL_STEPS) {
        const hook = step.onDecided;
        assert.ok(hook, `${id}: no on_decided hook — the decision would land and the invoice never move`);
        assert.equal(hook.tableId, 'tbl_iainv');
        assert.equal(hook.recordId.expr, 'vars.invoice.id');
        for (const outcome of ['approved', 'rejected', 'expired', 'cancelled']) {
            assert.ok(hook.set[outcome] && Object.keys(hook.set[outcome]).length,
                `${id}: on_decided says nothing about "${outcome}" — the invoice would keep saying it is in approval`);
        }
        // Neither "nobody answered" nor "it was withdrawn" is a decision, so
        // neither may invent one.
        for (const outcome of ['expired', 'cancelled']) {
            assert.equal(hook.set[outcome].status, 'needs_review',
                `${id}: "${outcome}" must not be recorded as approved or rejected`);
        }
    }
});

test('the on_decided hook only writes columns the invoices table has', () => {
    const columns = new Set((tableOf('tbl_iainv').fields || []).map((f) => f.key));
    const statuses = new Set(optionsOf('tbl_iainv', 'status'));
    for (const { id, step } of APPROVAL_STEPS) {
        for (const [outcome, map] of Object.entries(step.onDecided.set)) {
            for (const [col, value] of Object.entries(map)) {
                assert.ok(columns.has(col), `${id}/${outcome}: writes "${col}", which is not a column on invoices`);
                if (col === 'status') {
                    assert.ok(statuses.has(value), `${id}/${outcome}: sets status "${value}", which is not an option`);
                }
                const f = fieldOf('tbl_iainv', col);
                if (f.type === 'computed') assert.fail(`${id}/${outcome}: writes the computed column "${col}"`);
            }
        }
    }
});

test('every {{answers.…}} the hook reads is a question the approver was actually asked', () => {
    for (const { id, step } of APPROVAL_STEPS) {
        const asked = new Set((step.fields || []).map((q) => q.name));
        assert.ok(asked.size > 0, `${id}: no approver questions`);
        const json = JSON.stringify(step.onDecided);
        for (const m of json.matchAll(/\{\{\s*answers\.([a-zA-Z0-9_]+)\s*\}\}/g)) {
            assert.ok(asked.has(m[1]),
                `${id}: the hook reads answers.${m[1]}, which no question produces — the column would always be empty`);
        }
    }
});

test('the approval carries the invoice PDF, and reads it from somewhere a server step can see', () => {
    for (const { id, step } of APPROVAL_STEPS) {
        assert.ok(step.attachments, `${id}: the approver would decide without the document`);
        // A server step resolves only static / field / formula bindings — a
        // record binding here silently resolves to null.
        assert.equal(step.attachments.kind, 'formula',
            `${id}: attachments must be a formula; a {kind:"${step.attachments.kind}"} binding resolves to nothing server-side`);
    }
});

test('every context key the app sets is one the trail or the hook actually uses', () => {
    for (const { id, step } of APPROVAL_STEPS) {
        assert.ok(step.context.invoice_id, `${id}: no invoice_id in the context`);
        assert.ok(step.context.invoice_no, `${id}: no invoice_no in the context`);
    }
    // act_iadecided is the other half: it writes the trail row from the
    // component event, and it can only reach the invoice through the context.
    const trail = flatSteps(definition.actions.act_iadecided)
        .find((s) => s.kind === 'create_record' && s.tableId === 'tbl_iaevt');
    assert.equal(trail.values.invoice.expr, 'form.context.invoice_id');
    assert.equal(trail.values.invoice_no.expr, 'form.context.invoice_no');
});

// ══ THE DEMO DATA IS TRUE ═══════════════════════════════════════════════════

const near = (a, b, tol = 0.011) => Math.abs(a - b) <= tol;

test('net plus VAT equals the gross total on every seeded invoice', () => {
    for (const inv of rowsOf('tbl_iainv')) {
        if (typeof inv.amount_excl_vat !== 'number' || typeof inv.vat_amount !== 'number') continue;
        assert.ok(near(inv.amount_excl_vat + inv.vat_amount, inv.amount_total),
            `${inv.invoice_no}: ${inv.amount_excl_vat} + ${inv.vat_amount} ≠ ${inv.amount_total} — a demo whose sums do not add up teaches people to ignore the sums`);
    }
});

test('the seeded lines add up to their invoice’s net, and each line to its own total', () => {
    const netByAlias = new Map(rowsOf('tbl_iainv').map((i) => [i.$id, i.amount_excl_vat]));
    const sums = new Map();
    for (const line of rowsOf('tbl_ialine')) {
        const alias = line.invoice.$ref;
        sums.set(alias, (sums.get(alias) || 0) + line.line_total);
        if (typeof line.quantity === 'number' && typeof line.unit_price === 'number') {
            assert.ok(near(line.quantity * line.unit_price, line.line_total, 0.02),
                `${line.invoice_no} line ${line.line_no}: ${line.quantity} × ${line.unit_price} ≠ ${line.line_total}`);
        }
    }
    for (const [alias, total] of sums) {
        assert.ok(near(total, netByAlias.get(alias)),
            `${alias}: the lines add up to ${total} but the invoice's net is ${netByAlias.get(alias)}`);
    }
});

test('every denormalised copy still matches the row it was copied from', () => {
    // There are no joins in a records binding, which is why these copies
    // exist — and why nothing corrects them if they drift.
    for (const inv of rowsOf('tbl_iainv')) {
        const supplier = byAlias.get(inv.supplier.$ref);
        assert.ok(supplier, `${inv.invoice_no}: supplier points at an unseeded alias`);
        assert.equal(inv.supplier_name, supplier.name,
            `${inv.invoice_no}: says "${inv.supplier_name}" but its supplier is "${supplier.name}"`);
        assert.equal(inv.supplier_risk, supplier.risk,
            `${inv.invoice_no}: carries supplier check "${inv.supplier_risk}", the supplier master says "${supplier.risk}" — the ladder reads the copy`);
        assert.equal(inv.director_rule, supplier.always_director ? 'always' : 'auto',
            `${inv.invoice_no}: director rule disagrees with the supplier's flag`);
    }
    for (const tableId of ['tbl_ialine', 'tbl_iaevt']) {
        for (const row of rowsOf(tableId)) {
            const parent = byAlias.get(row.invoice.$ref);
            assert.ok(parent, `${tableId}: invoice points at an unseeded alias`);
            assert.equal(row.invoice_no, parent.invoice_no,
                `${tableId}: row says "${row.invoice_no}" but its invoice is "${parent.invoice_no}" — there is no join to correct it with`);
        }
    }
});

test('a decided invoice carries who decided it; an undecided one does not pretend to', () => {
    for (const inv of rowsOf('tbl_iainv')) {
        if (['approved', 'scheduled', 'paid'].includes(inv.status)) {
            assert.ok(inv.decided_by_name, `${inv.invoice_no} is ${inv.status} but names nobody who approved it`);
            assert.ok(inv.decided_at, `${inv.invoice_no} is ${inv.status} but has no decision date`);
        }
        if (inv.status === 'rejected') {
            assert.ok(inv.rejection_reason, `${inv.invoice_no} is rejected with no reason — the supplier has to be told something`);
        }
        if (['draft', 'needs_review'].includes(inv.status)) {
            assert.ok(!inv.decided_by_name, `${inv.invoice_no} is ${inv.status} yet claims a decision`);
        }
        if (inv.status === 'paid') {
            assert.ok(inv.payment_date && inv.payment_reference,
                `${inv.invoice_no} is paid but the payment is not recorded`);
        }
    }
});

test('the cost-centre dropdown and the cost-centre table define the same codes', () => {
    // The one seam in the config-as-data story, called out on the Setup
    // screen: a select needs its options at build time, the budget holder
    // lives in a table. They must at least AGREE on install.
    const table = new Set(rowsOf('tbl_iacc').map((r) => r.key));
    assert.deepEqual(optionsOf('tbl_iainv', 'cost_center').sort(), [...table].sort());
    assert.deepEqual(optionsOf('tbl_ialine', 'cost_center').sort(), [...table].sort());
    for (const inv of rowsOf('tbl_iainv')) {
        if (inv.cost_center) assert.ok(table.has(inv.cost_center), `${inv.invoice_no}: unknown cost centre`);
    }
    for (const line of rowsOf('tbl_ialine')) {
        if (line.cost_center) assert.ok(table.has(line.cost_center), `${line.invoice_no}: line has an unknown cost centre`);
    }
});

test('the demo data is fiction, and says so where it matters most', () => {
    // A template that ships a plausible-looking IBAN is a template somebody
    // eventually pays money into.
    const json = JSON.stringify(seed);
    assert.ok(!/\b[A-Z]{2}\d{2}[A-Z0-9]{10,}\b/.test(json),
        'the seed contains something shaped like an IBAN');
    for (const s of rowsOf('tbl_iasup')) {
        assert.match(s.contact_email, /@[a-z.]+\.example$/,
            `${s.name}: contact address must be on a reserved .example domain`);
    }
});

// ══ TONES, ROLES AND WIRING ═════════════════════════════════════════════════

test('every badge tone map covers every value it can be handed', () => {
    const statuses = new Set(optionsOf('tbl_iainv', 'status'));
    const gridsShowingStatus = NODES
        .map((n) => n.node)
        .filter((n) => (n.props && Array.isArray(n.props.columns))
            && n.props.columns.some((c) => c.key === 'status' && Array.isArray(c.toneMap)));
    assert.ok(gridsShowingStatus.length >= 3, 'several screens show the status pill');
    for (const grid of gridsShowingStatus) {
        const mapped = new Set(grid.props.columns.find((c) => c.key === 'status').toneMap.map((m) => m.value));
        for (const v of statuses) {
            assert.ok(mapped.has(v), `${grid.id}: status "${v}" has no tone — it would render as a grey pill and stop carrying its warning`);
        }
    }
    const kinds = new Set(optionsOf('tbl_iaevt', 'kind'));
    const trailMapped = new Set(nodeById('cmp_iaaugrid').props.columns.find((c) => c.key === 'kind').toneMap.map((m) => m.value));
    for (const v of kinds) assert.ok(trailMapped.has(v), `the trail has no tone for "${v}"`);
    const risks = new Set(optionsOf('tbl_iasup', 'risk'));
    const riskMapped = new Set(nodeById('cmp_iasugrid').props.columns.find((c) => c.key === 'risk').toneMap.map((m) => m.value));
    for (const v of risks) assert.ok(riskMapped.has(v), `the supplier grid has no tone for risk "${v}"`);
});

test('every status the app can write exists, and every status it can reach is shown somewhere', () => {
    const statuses = new Set(optionsOf('tbl_iainv', 'status'));

    // What the app writes, from both writers: the actions and the hooks.
    const written = new Set();
    for (const { step } of ALL_STEPS) {
        if (step.tableId !== 'tbl_iainv') continue;
        const v = (step.values || {}).status;
        if (v && v.kind === 'static' && typeof v.value === 'string') written.add(v.value);
    }
    for (const { step } of APPROVAL_STEPS) {
        for (const map of Object.values(step.onDecided.set)) if (map.status) written.add(map.status);
    }
    for (const v of written) {
        assert.ok(statuses.has(v), `the app writes status "${v}", which the column does not offer`);
    }

    // Every status a row can END UP in has to be reachable by a writer or be
    // the arrival state — a status nothing can produce is a dead option in a
    // dropdown, and a status nothing shows is a row that goes invisible.
    const arrival = fieldOf('tbl_iainv', 'status').default;
    for (const v of statuses) {
        assert.ok(written.has(v) || v === arrival,
            `nothing in the app can ever set status "${v}" — either wire it or drop the option`);
    }

    // The stepper is the "where is it" answer on the invoice screen. It shows
    // the happy path; the exceptional states (rejected, on hold) are pills,
    // not rungs, which is why they are deliberately absent from it.
    const stepper = new Set(nodeById('cmp_iadstep').props.steps.map((s) => s.value));
    for (const v of ['draft', 'needs_review', 'in_approval', 'approved', 'scheduled', 'paid']) {
        assert.ok(stepper.has(v), `the stepper skips "${v}", so the invoice screen cannot say where the invoice is`);
    }
    for (const v of stepper) assert.ok(statuses.has(v), `the stepper shows "${v}", which is not a status`);
});

test('the audit trail is append-only for everybody, the controller included', () => {
    const access = tableOf('tbl_iaevt').access;
    assert.equal(access.default, 'role');
    const roles = Object.keys(access.roles);
    assert.ok(roles.length >= 3, 'every role is named explicitly');
    for (const [role, m] of Object.entries(access.roles)) {
        assert.equal(m.update, false, `${role} can edit the trail — the point of a trail is that the people it records cannot`);
        assert.equal(m.delete, false, `${role} can delete from the trail`);
        assert.equal(m.create, true, `${role} does things the trail has to record, so it must be able to append`);
    }
});

test('an approver can read an invoice and change nothing about it', () => {
    // An approver who could edit the amount could approve a different invoice
    // from the one they were shown.
    for (const tableId of ['tbl_iainv', 'tbl_ialine']) {
        const m = tableOf(tableId).access.roles.approver;
        assert.equal(m.read, 'all', `${tableId}: an approver must be able to read what they are deciding on`);
        assert.equal(m.create, false, `${tableId}: an approver may not create rows`);
        assert.equal(m.update, false, `${tableId}: an approver may not edit what they are approving`);
        assert.equal(m.delete, false, `${tableId}: an approver may not delete rows`);
    }
    // Accounts payable books invoices but never decides them and never pays.
    assert.equal(tableOf('tbl_iasup').access.roles.ap.update, false,
        'AP editing the supplier master would be AP editing the approval policy');
});

test('every table names all three roles explicitly — no table is left on the friendly default', () => {
    const roles = MODEL.roles.map((r) => r.key).sort();
    assert.deepEqual(roles, ['ap', 'approver', 'finance']);
    for (const table of MODEL.tables) {
        assert.equal(table.access.default, 'role', `${table.key}: still on a non-role access default`);
        assert.deepEqual(Object.keys(table.access.roles).sort(), roles,
            `${table.key}: does not name every role`);
    }
    // Opening the app is a publication gate, not a grant of access to every
    // invoice the company has to pay.
    assert.equal(MODEL.roleMapping.default, null);
});

test('every component that lists invoices opens the invoice', () => {
    // The bug this guards: a grid that lists invoices and does nothing when
    // you click a row is a dead end people have to be taught around.
    const listing = NODES
        .map((n) => n.node)
        .filter((n) => ['data_grid', 'list'].includes(n.type)
            && n.props && n.props.source && n.props.source.kind === 'records'
            && n.props.source.tableId === 'tbl_iainv');
    assert.ok(listing.length >= 4, 'invoices are listed on several screens');
    assert.deepEqual(
        listing.filter((n) => n.onRowClick !== 'act_iaopen').map((n) => n.id),
        [],
        'every component listing invoices must open the invoice',
    );
});

test('opening an invoice publishes it BEFORE navigating', () => {
    // Otherwise the detail screen renders the previous invoice for a frame —
    // and, worse, the approval attachment would read the previous document.
    const steps = definition.actions.act_iaopen.steps;
    assert.equal(steps[steps.length - 1].kind, 'navigate');
    assert.ok(steps.slice(0, -1).every((s) => s.kind === 'set_variable'), 'navigate is last');
    assert.equal(steps[0].name, 'invoice');
});

test('every screen shown in the menu sits in exactly one nav group, and the detail screen is reachable', () => {
    const inNav = definition.screens.filter((s) => s.showInNav).map((s) => s.id);
    const grouped = definition.nav.groups.flatMap((g) => g.screens);
    assert.deepEqual([...grouped].sort(), [...inNav].sort(),
        'a screen in the menu but in no group (or the other way round) is a screen nobody finds');
    assert.equal(new Set(grouped).size, grouped.length, 'a screen may render in one nav place');

    const hidden = definition.screens.filter((s) => !s.showInNav).map((s) => s.id);
    const navigatedTo = new Set(ALL_STEPS
        .filter(({ step }) => step.kind === 'navigate')
        .map(({ step }) => step.screenId));
    for (const id of hidden) {
        assert.ok(navigatedTo.has(id), `screen "${id}" is not in the menu and nothing navigates to it`);
    }
});

test('the trail records every kind of thing the app can do to an invoice', () => {
    const written = new Set(ALL_STEPS
        .filter(({ step }) => step.kind === 'create_record' && step.tableId === 'tbl_iaevt')
        .map(({ step }) => step.values.kind && step.values.kind.value)
        .filter(Boolean));
    for (const kind of ['uploaded', 'extracted', 'edited', 'submitted', 'decided', 'hold', 'paid']) {
        assert.ok(written.has(kind), `nothing ever writes a "${kind}" trail row`);
    }
    const declared = new Set(optionsOf('tbl_iaevt', 'kind'));
    for (const kind of written) assert.ok(declared.has(kind), `the app writes trail kind "${kind}", which is not an option`);
});

test('inline grid edits are single-column writes guarded by a compare-and-set token', () => {
    // Two people editing DIFFERENT cells of one row must not clobber each
    // other (that is the single-column write) and two people editing the SAME
    // cell must not either (that is the token).
    for (const actionId of ['act_ialineedit', 'act_iasupedit', 'act_iapoledit']) {
        const sw = flatSteps(definition.actions[actionId]).find((s) => s.kind === 'switch');
        assert.ok(sw, `${actionId}: an inline commit is a switch over form.__edited`);
        assert.equal(sw.expr, 'form.__edited');
        for (const c of sw.cases) {
            const write = c.steps.find((s) => s.kind === 'update_record');
            assert.ok(write, `${actionId}/${c.value}: no write`);
            assert.deepEqual(Object.keys(write.values), [c.value],
                `${actionId}/${c.value}: writes more than the edited column`);
            assert.ok(write.expectedUpdatedAt, `${actionId}/${c.value}: no compare-and-set token`);
        }
    }
});

test('the AI reads the invoice, and the vocabulary it cannot be trusted with is enforced in the app', () => {
    const steps = flatSteps(definition.actions.act_iaread).filter((s) => s.kind === 'ai_extract');
    assert.equal(steps.length, 2, 'the header and the lines are read separately');
    const [head, lines] = steps;
    const headFields = head.schema.map((f) => f.name);
    for (const f of ['supplier_name', 'invoice_no', 'invoice_date', 'due_date', 'amount_excl_vat', 'vat_amount', 'amount_total']) {
        assert.ok(headFields.includes(f), `the header extraction never asks for ${f}`);
    }
    const lineFields = lines.schema.map((f) => f.name);
    for (const f of ['description', 'quantity', 'unit_price', 'line_total']) {
        assert.ok(lineFields.includes(f), `the line extraction never asks for ${f}`);
    }
    assert.ok(lines.writeTo && lines.writeTo.tableId === 'tbl_ialine', 'the lines are written as rows');
    assert.ok(lines.promptContext, 'the line pass must see the header, or a line that does not fit the total goes unnoticed');

    // aiSchema has no enum support, so a select column's vocabulary has to be
    // enforced where the row is written rather than hoped for in the prompt.
    const create = flatSteps(definition.actions.act_iaread).find((s) => s.kind === 'create_record' && s.tableId === 'tbl_iainv');
    const currencies = optionsOf('tbl_iainv', 'currency');
    for (const c of currencies) {
        assert.ok(create.values.currency.expr.includes(`'${c}'`),
            `the currency guard never mentions "${c}", so that option can never be written`);
    }
    for (const bogus of ['dollars', '', 'euro', null]) {
        const value = evaluate(create.values.currency.expr, {
            vars: { head: { rows: [{ currency: bogus }] } },
        });
        assert.ok(currencies.includes(value), `an AI answer of ${JSON.stringify(bogus)} produced "${value}"`);
    }
});
