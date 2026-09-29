/**
 * The stage chain's rulebook — pure, so the whole matrix is enumerable.
 *
 * What must hold:
 *   • the three legacy shapes desugar into exactly what they meant before,
 *     so a routine authored last release behaves identically this release;
 *   • legacy rows keep the keys 'panel'/'final' — the literals the votes
 *     table already carries, which is what makes the migration free;
 *   • conditions decide membership ONCE and are recorded, never silently
 *     dropped;
 *   • the caps hold, and a chain nobody can decide is refused outright.
 *
 * Run: node --test automation/approvalStages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    MAX_APPROVAL_STAGES, MAX_TOTAL_SEATS,
    desugarApprovalStages, activeStages, stageByKey,
    firstStageKey, nextStageKey, stagePosition, collectParticipants,
} = require('./approvalStages');

// ── Desugaring the legacy shapes ─────────────────────────────────────────

test('a lone assignee has NO chain — the single-approver row shape is preserved', () => {
    assert.strictEqual(desugarApprovalStages({ assignee: { userId: 'u1' } }), null);
    assert.strictEqual(desugarApprovalStages({}), null);
    assert.strictEqual(desugarApprovalStages(null), null);
});

test('a panel becomes one stage keyed "panel" — the literal the votes table carries', () => {
    const stages = desugarApprovalStages({
        approvers: [{ userId: 'a' }, { groupId: 'g1' }], rule: 'quorum', quorum: 2,
    });
    assert.strictEqual(stages.length, 1);
    assert.strictEqual(stages[0].key, 'panel');
    assert.strictEqual(stages[0].rule, 'quorum');
    assert.strictEqual(stages[0].quorum, 2);
    assert.deepStrictEqual(stages[0].approvers, [{ userId: 'a' }, { groupId: 'g1' }]);
});

test('panel + final becomes two stages keyed panel/final', () => {
    const stages = desugarApprovalStages({
        approvers: [{ userId: 'a' }], rule: 'all', finalApprover: { userId: 'cfo' },
    });
    assert.deepStrictEqual(stages.map(s => s.key), ['panel', 'final']);
    assert.strictEqual(stages[1].rule, 'first', 'a single final approver decides alone');
    assert.deepStrictEqual(stages[1].approvers, [{ userId: 'cfo' }]);
});

test('assignee + final replaces the one-seat-panel hack, and the lone seat decides alone', () => {
    const stages = desugarApprovalStages({
        assignee: { userId: 'lead' }, finalApprover: { groupId: 'g_cfo' },
    });
    assert.deepStrictEqual(stages.map(s => s.key), ['panel', 'final']);
    assert.deepStrictEqual(stages[0].approvers, [{ userId: 'lead' }]);
    assert.strictEqual(stages[0].rule, 'first', "a promoted assignee must not become an 'all' of one");
    assert.deepStrictEqual(stages[1].approvers, [{ groupId: 'g_cfo' }]);
});

// ── Authored stages ──────────────────────────────────────────────────────

test('authored stages keep their order, get positional keys, and name themselves', () => {
    const stages = desugarApprovalStages({ stages: [
        { name: 'Cost-centre check', description: 'Team lead checks the budget line.', approvers: [{ userId: 'lead' }] },
        { approvers: [{ groupId: 'g_fin' }], rule: 'first' },
    ] });
    assert.deepStrictEqual(stages.map(s => s.key), ['s1', 's2']);
    assert.strictEqual(stages[0].name, 'Cost-centre check');
    assert.strictEqual(stages[0].description, 'Team lead checks the budget line.');
    assert.strictEqual(stages[0].rule, 'all', 'the default rule is the strictest reading');
    assert.strictEqual(stages[1].name, 'Stage 2', 'an unnamed stage still reads as something');
    assert.strictEqual(stages[1].description, null);
});

test('an author-supplied key is honoured — re-saving must not orphan votes already cast', () => {
    const stages = desugarApprovalStages({ stages: [
        { key: 'panel', name: 'Team', approvers: [{ userId: 'a' }] },
        { key: 'final', name: 'CFO', approvers: [{ userId: 'cfo' }] },
    ] });
    assert.deepStrictEqual(stages.map(s => s.key), ['panel', 'final']);
});

test('duplicate keys are made unique rather than colliding', () => {
    const stages = desugarApprovalStages({ stages: [
        { key: 'dup', approvers: [{ userId: 'a' }] },
        { key: 'dup', approvers: [{ userId: 'b' }] },
    ] });
    assert.strictEqual(new Set(stages.map(s => s.key)).size, 2);
});

test('names and descriptions interpolate, then cap', () => {
    const stages = desugarApprovalStages(
        { stages: [{ name: 'Sign-off for {{supplier}}', description: 'x'.repeat(400), approvers: [{ userId: 'a' }] }] },
        { interpolate: (s) => s.replace('{{supplier}}', 'Jansen BV') },
    );
    assert.strictEqual(stages[0].name, 'Sign-off for Jansen BV');
    assert.strictEqual(stages[0].description.length, 200);
});

test('a stage with no usable seat is dropped; seats dedupe within a stage', () => {
    const stages = desugarApprovalStages({ stages: [
        { name: 'Ghosts', approvers: [{}, 'nope', { userId: '' }] },
        { name: 'Real', approvers: [{ userId: 'a' }, { userId: 'a' }, { groupId: 'g' }] },
    ] });
    assert.strictEqual(stages.length, 1);
    assert.strictEqual(stages[0].name, 'Real');
    assert.deepStrictEqual(stages[0].approvers, [{ userId: 'a' }, { groupId: 'g' }]);
});

// ── Conditions ───────────────────────────────────────────────────────────

test('a false condition marks the stage skipped — kept for the audit, not dropped', () => {
    const stages = desugarApprovalStages(
        { stages: [
            { name: 'Always', approvers: [{ userId: 'a' }] },
            { name: 'Big amounts only', when: 'amount > 25000', approvers: [{ userId: 'cfo' }] },
        ] },
        { evaluateWhen: (expr) => expr === 'amount > 25000' ? false : true },
    );
    assert.strictEqual(stages.length, 2, 'the skipped stage is still recorded');
    assert.strictEqual(stages[1].skipped, true);
    assert.deepStrictEqual(activeStages(stages).map(s => s.name), ['Always']);
});

test('a condition that throws keeps the stage — never silently drop an approver', () => {
    const stages = desugarApprovalStages(
        { stages: [{ name: 'Finance', when: 'broken(', approvers: [{ userId: 'a' }] }] },
        { evaluateWhen: () => { throw new Error('parse error'); } },
    );
    assert.strictEqual(stages[0].skipped, undefined);
});

test('a chain whose every stage is skipped is no chain at all', () => {
    const stages = desugarApprovalStages(
        { stages: [{ name: 'Never', when: 'false', approvers: [{ userId: 'a' }] }] },
        { evaluateWhen: () => false },
    );
    assert.strictEqual(stages, null, 'an approval nobody can decide must not be created');
});

// ── Caps ─────────────────────────────────────────────────────────────────

test('the chain caps at five stages and at the whole-chain seat budget', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, approvers: [{ userId: `u${i}` }] }));
    assert.strictEqual(desugarApprovalStages({ stages: many }).length, MAX_APPROVAL_STAGES);

    // Four stages of ten seats each would be 40 — the budget stops at 30, and
    // it stops on a stage BOUNDARY (half a panel would change its rule).
    const fat = Array.from({ length: 4 }, (_, s) => ({
        name: `S${s}`, approvers: Array.from({ length: 10 }, (_, i) => ({ userId: `u${s}_${i}` })),
    }));
    const capped = desugarApprovalStages({ stages: fat });
    const seats = capped.reduce((n, s) => n + s.approvers.length, 0);
    assert.ok(seats <= MAX_TOTAL_SEATS, `${seats} seats exceeds the budget`);
    assert.ok(capped.every(s => s.approvers.length === 10), 'no stage was truncated mid-panel');
});

test('quorum clamps to the seat count', () => {
    const stages = desugarApprovalStages({ stages: [
        { approvers: [{ userId: 'a' }, { userId: 'b' }], rule: 'quorum', quorum: 9 },
    ] });
    assert.strictEqual(stages[0].quorum, 2);
    const noQuorum = desugarApprovalStages({ stages: [{ approvers: [{ userId: 'a' }], rule: 'first', quorum: 5 }] });
    assert.strictEqual(noQuorum[0].quorum, null, 'quorum is meaningless off the quorum rule');
});

// ── Navigation ───────────────────────────────────────────────────────────

test('navigation walks the ACTIVE chain, skipping skipped stages entirely', () => {
    const stages = [
        { key: 's1', approvers: [{ userId: 'a' }] },
        { key: 's2', approvers: [{ userId: 'b' }], skipped: true },
        { key: 's3', approvers: [{ userId: 'c' }] },
    ];
    assert.strictEqual(firstStageKey(stages), 's1');
    assert.strictEqual(nextStageKey(stages, 's1'), 's3', 'the skipped stage is stepped over');
    assert.strictEqual(nextStageKey(stages, 's3'), null, 'the last stage has no next');
    assert.strictEqual(nextStageKey(stages, 'nope'), null);
    assert.deepStrictEqual(stagePosition(stages, 's3'), { index: 2, total: 2 });
    assert.strictEqual(stageByKey(stages, 's2').key, 's2');
});

test('the participant index is every distinct seat across the active chain', () => {
    const stages = [
        { key: 's1', approvers: [{ userId: 'a' }, { groupId: 'g' }] },
        { key: 's2', approvers: [{ userId: 'a' }, { userId: 'b' }] },
        { key: 's3', approvers: [{ userId: 'zz' }], skipped: true },
    ];
    assert.deepStrictEqual(collectParticipants(stages), [{ userId: 'a' }, { groupId: 'g' }, { userId: 'b' }]);
});
