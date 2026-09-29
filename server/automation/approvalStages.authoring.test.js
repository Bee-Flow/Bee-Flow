/**
 * The authoring layer for stage chains: what an author writes in the builder
 * (or an AI writes through builderTools), what the validator refuses, and what
 * the engine hands the lifecycle when the run pauses.
 *
 * The three are tested together on purpose — a chain that validates green but
 * desugars to something else, or renders without its conditions applied, is
 * exactly the class of bug that only shows up once a real invoice is waiting
 * on the wrong person.
 */

const test = require('node:test');
const assert = require('node:assert');

const validate = require('./validate');
const { renderApprovalExtras } = require('../core/automationRunner/engine');
const { MAX_APPROVAL_STAGES, MAX_TOTAL_SEATS } = require('./approvalStages');

// ── helpers ─────────────────────────────────────────────────────────────
const stage = (over = {}) => ({ name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'all', ...over });

function issuesFor(approval, extra = {}) {
    const res = validate.validateDefinition({
        trigger: { id: 'trg', kind: 'manual', label: 'Manual' },
        steps: [{ id: 'appr_1', type: 'approval', prompt: 'Pay this invoice?', approval, ...extra }],
        edges: [{ from: 'trg', to: 'appr_1' }],
    });
    return [...(res.errors || []), ...(res.warnings || [])];
}
const codes = (list) => list.map(i => i.code);

// ── validation ──────────────────────────────────────────────────────────

test('a well-formed chain validates clean', () => {
    const issues = issuesFor({
        stages: [
            stage({ name: 'Team lead', description: 'Confirm the invoice is for work we ordered.' }),
            stage({ name: 'Finance', approvers: [{ groupId: 'g-fin' }], rule: 'first' }),
            stage({ name: 'Director', approvers: [{ userId: 'u2' }, { userId: 'u3' }], rule: 'quorum', quorum: 2, when: '1 > 0' }),
        ],
    });
    assert.deepEqual(issues.filter(i => i.code.startsWith('approval.')), []);
});

test('the chain is capped at five stages and thirty seats', () => {
    const six = Array.from({ length: MAX_APPROVAL_STAGES + 1 }, (_, i) => stage({ name: `S${i}` }));
    assert.ok(codes(issuesFor({ stages: six })).includes('approval.stages_invalid'));

    // Four stages of ten seats each is 40 — over the whole-chain budget.
    const fat = Array.from({ length: 4 }, (_, s) => stage({
        approvers: Array.from({ length: 10 }, (_, i) => ({ userId: `u${s}_${i}` })),
    }));
    const issues = issuesFor({ stages: fat });
    assert.ok(codes(issues).includes('approval.stages_invalid'));
    assert.ok(issues.some(i => i.message.includes(String(MAX_TOTAL_SEATS))));
});

test('a stage with nobody in it is refused — it could never be decided', () => {
    assert.ok(codes(issuesFor({ stages: [stage({ approvers: [] })] })).includes('approval.stages_invalid'));
    assert.ok(codes(issuesFor({ stages: [stage({ approvers: [{ userId: 'u1', groupId: 'g1' }] })] }))
        .includes('approval.stages_invalid'));
});

test('names, descriptions and rules are bounded and checked', () => {
    assert.ok(codes(issuesFor({ stages: [stage({ name: 'x'.repeat(61) })] })).includes('approval.stage_name_invalid'));
    assert.ok(codes(issuesFor({ stages: [stage({ description: 'x'.repeat(201) })] })).includes('approval.stage_description_invalid'));
    assert.ok(codes(issuesFor({ stages: [stage({ rule: 'majority' })] })).includes('approval.stage_rule_invalid'));
    // A quorum larger than the stage's own seats can never be reached.
    assert.ok(codes(issuesFor({ stages: [stage({ rule: 'quorum', quorum: 3 })] })).includes('approval.stage_rule_invalid'));
});

test('two stages may not share a key — votes are filed under it', () => {
    const issues = issuesFor({ stages: [stage({ key: 'k' }), stage({ key: 'k' })] });
    assert.ok(codes(issues).includes('approval.stages_invalid'));
});

test('stages refuse to coexist with the shapes they replace', () => {
    for (const legacy of [
        { assignee: { userId: 'u9' } },
        { approvers: [{ userId: 'u9' }] },
        { finalApprover: { userId: 'u9' } },
        { escalateTo: { userId: 'u9' } },
    ]) {
        const issues = issuesFor({ stages: [stage()], ...legacy });
        assert.ok(codes(issues).includes('approval.stages_conflict'),
            `${Object.keys(legacy)[0]} alongside stages must be refused, not silently ignored`);
    }
});

// ── the builder normalizer ──────────────────────────────────────────────
//
// This is the door an AI author comes through. A model reaching for a chain
// routinely invents keys, so the normalizer REBUILDS rather than merges: what
// the engine reads is exactly what the editor would have written.

const { applyToolCall, emptyDefinition } = require('./builderTools');

async function addApproval(args) {
    const dw = { userId: 'u_test', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const res = await applyToolCall('builder_add_approval', args, dw);
    assert.ok(!res.error, `builder_add_approval errored: ${res.error}`);
    return dw.def.steps.find(s => s.type === 'approval').approval;
}

test('the normalizer rebuilds a chain to exactly what the editor writes', async () => {
    const cfg = await addApproval({
        prompt: 'Pay this invoice?',
        stages: [
            { name: '  Team lead  ', description: 'Ordered?', approvers: [{ userId: 'u1' }, { userId: 'u1' }], rule: 'nonsense', cc: 'invented' },
            { name: 'x'.repeat(80), approvers: [{ groupId: 'g1' }], rule: 'quorum', quorum: 9, when: ' amount > 5000 ' },
        ],
    });
    assert.equal(cfg.stages.length, 2);
    assert.deepEqual(cfg.stages[0].approvers, [{ userId: 'u1' }], 'a repeated seat is one seat');
    assert.equal(cfg.stages[0].name, 'Team lead');
    assert.equal(cfg.stages[0].rule, 'all', 'an invented rule falls back to the default, never persists');
    assert.ok(!('cc' in cfg.stages[0]), 'an invented key the engine never reads must not be persisted');
    assert.equal(cfg.stages[1].name.length, 60);
    assert.equal(cfg.stages[1].quorum, 1, 'a quorum larger than the stage is clamped to what it can reach');
    assert.equal(cfg.stages[1].when, 'amount > 5000');
    assert.deepEqual(cfg.stages.map(s => s.key), ['s1', 's2']);
});

test('an authored key survives a re-save — votes are filed under it', async () => {
    const cfg = await addApproval({
        prompt: 'q',
        stages: [{ key: 'finance', name: 'Finance', approvers: [{ userId: 'u1' }] }],
    });
    assert.equal(cfg.stages[0].key, 'finance');
});

test('a chain drops the legacy approver fields rather than keeping both', async () => {
    const cfg = await addApproval({
        prompt: 'q',
        stages: [{ name: 'Finance', approvers: [{ userId: 'u1' }] }],
        assignee: { userId: 'u9' },
        approvers: [{ userId: 'u8' }],
        rule: 'first',
        finalApprover: { userId: 'u7' },
        escalateTo: { userId: 'u6' },
        escalateAfterHours: 4,
    });
    assert.ok(cfg.stages);
    for (const dead of ['assignee', 'approvers', 'rule', 'quorum', 'finalApprover', 'escalateTo', 'escalateAfterHours']) {
        assert.ok(!(dead in cfg), `${dead} must not survive alongside a chain — it would look configured and never be asked`);
    }
});

test('a stage nobody sits in is dropped by the normalizer, not persisted empty', async () => {
    const cfg = await addApproval({
        prompt: 'q',
        stages: [{ name: 'Ghost', approvers: [] }, { name: 'Real', approvers: [{ userId: 'u1' }] }],
    });
    assert.equal(cfg.stages.length, 1);
    assert.equal(cfg.stages[0].name, 'Real');
});

// ── the engine's render ─────────────────────────────────────────────────

const runState = { steps: { inv: { output: { supplier: 'Acme BV', amount: 9000 } } }, secrets: { k: 'sh' } };

test('renderApprovalExtras interpolates stage text and decides conditions once', () => {
    const extras = renderApprovalExtras({
        approval: {
            stages: [
                stage({ name: 'Finance — {{steps.inv.output.supplier}}', description: 'Amount {{steps.inv.output.amount}}' }),
                stage({ name: 'Director', approvers: [{ userId: 'u2' }], when: 'steps.inv.output.amount > 5000' }),
                stage({ name: 'Board', approvers: [{ userId: 'u3' }], when: 'steps.inv.output.amount > 100000' }),
            ],
        },
    }, runState);

    assert.equal(extras.stages.length, 3);
    assert.equal(extras.stages[0].name, 'Finance — Acme BV');
    assert.equal(extras.stages[0].description, 'Amount 9000');
    // 9,000 clears the director's threshold but not the board's.
    assert.ok(!extras.stages[1].skipped);
    assert.equal(extras.stages[2].skipped, true, 'a stage whose condition is not met is KEPT and marked skipped');
});

test('secrets never reach a stage name', () => {
    const extras = renderApprovalExtras({
        approval: { stages: [stage({ name: 'Leak {{secrets.k}}' })] },
    }, runState);
    assert.ok(!extras.stages[0].name.includes('sh'));
});

test('the legacy shapes desugar into the same chain the panel release filed votes under', () => {
    const panel = renderApprovalExtras({
        approval: { approvers: [{ userId: 'u1' }, { userId: 'u2' }], rule: 'quorum', quorum: 2 },
    }, runState);
    assert.deepEqual(panel.stages.map(s => s.key), ['panel']);
    assert.equal(panel.stages[0].rule, 'quorum');
    assert.equal(panel.stages[0].quorum, 2);

    const withFinal = renderApprovalExtras({
        approval: { approvers: [{ userId: 'u1' }], finalApprover: { userId: 'u9' } },
    }, runState);
    assert.deepEqual(withFinal.stages.map(s => s.key), ['panel', 'final']);

    // A single approver plus a final sign-off — the case the panel release
    // expressed as a one-seat panel — is now two honest stages.
    const oneThenFinal = renderApprovalExtras({
        approval: { assignee: { userId: 'u1' }, finalApprover: { userId: 'u9' } },
    }, runState);
    assert.deepEqual(oneThenFinal.stages.map(s => s.key), ['panel', 'final']);
    assert.equal(oneThenFinal.stages[0].rule, 'first', 'a lone approver promoted to a stage still decides alone');

    // A lone assignee keeps the pre-stages row shape exactly.
    const alone = renderApprovalExtras({ approval: { assignee: { userId: 'u1' } } }, runState);
    assert.equal(alone.stages, null);
    assert.deepEqual(alone.assignee, { userId: 'u1' });
});

test('a chain whose every stage is skipped is no chain at all', () => {
    const extras = renderApprovalExtras({
        approval: { stages: [stage({ when: '1 > 2' }), stage({ approvers: [{ userId: 'u2' }], when: '1 > 3' })] },
    }, runState);
    assert.equal(extras.stages, null,
        'nobody would ever be asked — the caller must fall back to its owner path rather than create an undecidable row');
});
