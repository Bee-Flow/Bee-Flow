/**
 * What the INSTALLER supplies, and what a request body may not smuggle in.
 *
 * Two rules carry this module, and both are here as assertions rather than as
 * sentences in a header:
 *
 *   1. A RESOLUTION FILLS A HOLE. It never overwrites a step that already names
 *      a connection, a table or an approver. Without this, a hand-edited
 *      manifest plus a crafted resolutions body could re-point a write that
 *      step 1 of the wizard showed as wired up.
 *   2. UNKNOWN NARROWS. `out` is built from a fixed key set, so a body naming a
 *      fourth kind of edit contributes nothing instead of arriving unexamined
 *      at a store.
 *
 * Pure — nothing here touches a database.
 *
 * Run: cd server && node --test --test-force-exit projects/packaging/resolutions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    normalizeResolutions, normalizeSeat, applyStepResolutions, SEAT_FIELDS,
} = require('./resolutions');
const { AUTOMATION_SEAT_FIELDS } = require('./scrub');

// ═══ normalizeResolutions ════════════════════════════════════════════════

test('a body with nothing in it resolves to three empty lists, never to undefined', () => {
    // Every caller loops over these; an absent key would be a TypeError on the
    // install path rather than "you supplied nothing".
    for (const input of [undefined, null, {}, 'nonsense', [], 42]) {
        assert.deepStrictEqual(normalizeResolutions(input), { tables: [], connections: [], approvers: [] });
    }
});

test('A RESOLUTIONS BODY CANNOT SMUGGLE IN A FOURTH KIND OF EDIT', () => {
    // The narrow direction, asserted on the shape rather than on a deny-list:
    // the day somebody adds `grants` or `slugs` to the wizard, it starts absent
    // here rather than arriving unexamined.
    const out = normalizeResolutions({
        tables: [{ key: 'invoices', datatableId: 'tbl_1' }],
        grants: [{ tool: 'gmail_send' }],
        slugs: [{ ref: 'web_1', slug: 'anything' }],
        bridgeGrants: { ai: { publicEnabled: true } },
        __proto__extra: 'LEAK-CANARY',
    });
    assert.deepStrictEqual(Object.keys(out).sort(), ['approvers', 'connections', 'tables']);
    assert.ok(!JSON.stringify(out).includes('gmail_send'));
    assert.ok(!JSON.stringify(out).includes('LEAK-CANARY'));
});

test('a table row needs a key AND either an id or an explicit create', () => {
    const out = normalizeResolutions({
        tables: [
            { key: 'invoices', datatableId: 'tbl_1' },
            { key: 'contacts', create: true },
            { key: 'nothing' },                            // neither → dropped
            { key: 'coerced', create: 'true' },            // truthy, not `true`
            { datatableId: 'tbl_orphan' },                 // no key → nothing to bind by
            { key: '   ', datatableId: 'tbl_blank' },
        ],
    });
    assert.deepStrictEqual(out.tables, [
        { key: 'invoices', datatableId: 'tbl_1' },
        { key: 'contacts', create: true },
    ]);
});

test('two rows for one key is a contradiction, and the second is dropped', () => {
    // rebindDatatables refuses to choose between two tables with the same key;
    // this refuses to choose between two answers about one key, for the same
    // reason — there is no honest way to pick.
    const out = normalizeResolutions({
        tables: [
            { key: 'invoices', datatableId: 'tbl_first' },
            { key: 'invoices', datatableId: 'tbl_second' },
            { key: 'invoices', create: true },
        ],
    });
    assert.deepStrictEqual(out.tables, [{ key: 'invoices', datatableId: 'tbl_first' }]);
});

test('a connection row without all three of ref, step and connection is dropped', () => {
    const out = normalizeResolutions({
        connections: [
            { ref: 'aut_1', stepId: 's1', connectionId: 'conn_1' },
            { ref: 'aut_1', stepId: 's2', layerKey: 'enrich', connectionId: 'conn_2' },
            { ref: 'aut_1', stepId: 's3' },                       // no credential
            { stepId: 's4', connectionId: 'conn_4' },             // no routine
            { ref: 'aut_1', connectionId: 'conn_5' },             // no step
        ],
    });
    assert.deepStrictEqual(out.connections, [
        { ref: 'aut_1', stepId: 's1', layerKey: null, connectionId: 'conn_1' },
        { ref: 'aut_1', stepId: 's2', layerKey: 'enrich', connectionId: 'conn_2' },
    ]);
});

test('a seat is one person or one group, rebuilt key by key', () => {
    // Rebuilt rather than passed through: a seat carrying extra fields lands in
    // a definition that automation/validate then refuses, and the install would
    // have written something nobody can save.
    assert.deepStrictEqual(normalizeSeat({ userId: 'u1', role: 'admin', extra: 1 }), { userId: 'u1' });
    assert.deepStrictEqual(normalizeSeat({ groupId: 'g1' }), { groupId: 'g1' });
    // A person wins when both are named — one seat, one holder.
    assert.deepStrictEqual(normalizeSeat({ userId: 'u1', groupId: 'g1' }), { userId: 'u1' });
    for (const bad of [null, undefined, {}, 'u1', { userId: '' }, { userId: 42 }, []]) {
        assert.strictEqual(normalizeSeat(bad), null);
    }
});

test('the seat field list stays in step with what the scrub empties', () => {
    // scrub.js decides which seats leave; this module decides which come back.
    // Two lists that drift produce a seat nobody can refill.
    assert.deepStrictEqual([...SEAT_FIELDS].sort(), [...AUTOMATION_SEAT_FIELDS].sort());
});

// ═══ applyStepResolutions ════════════════════════════════════════════════

const httpStep = (id, over = {}) => ({ id, type: 'http_request', url: 'https://x', auth: null, ...over });
const approvalStep = (id, over = {}) => ({ id, type: 'approval', approval: {}, ...over });

const def = (steps, layers = null) => ({
    schemaVersion: 2,
    trigger: { id: 't', type: 'trigger', kind: 'manual' },
    steps,
    ...(layers ? { layers } : {}),
});

test('a connection lands on the step that lost one', () => {
    const definition = def([httpStep('s1')]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_1' }],
    }));
    assert.deepStrictEqual(definition.steps[0].auth, { connectionId: 'conn_1' });
    assert.deepStrictEqual(out.applied, [{ kind: 'connection', ref: 'aut_1', stepId: 's1', layerKey: null }]);
    assert.deepStrictEqual(out.ignored, []);
});

test('A RESOLUTION NEVER RE-POINTS A STEP THAT IS ALREADY WIRED', () => {
    // The rule the whole module rests on. A hand-made file can name its own
    // credential; a resolutions body must not be able to swap it for another.
    const definition = def([httpStep('s1', { auth: { connectionId: 'conn_theirs' } })]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' }],
    }));
    assert.deepStrictEqual(definition.steps[0].auth, { connectionId: 'conn_theirs' });
    assert.deepStrictEqual(out.applied, []);
    assert.strictEqual(out.ignored[0].why, 'already_connected');
});

test('and it never seats an approver over one the file already named', () => {
    for (const field of SEAT_FIELDS) {
        const seated = field === 'approvers' ? [{ userId: 'u_theirs' }] : { userId: 'u_theirs' };
        const definition = def([approvalStep('s1', { approval: { [field]: seated } })]);
        const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
            approvers: [{ ref: 'aut_1', stepId: 's1', seat: { userId: 'u_mine' } }],
        }));
        assert.strictEqual(definition.steps[0].approval.assignee, field === 'assignee' ? seated : undefined,
            `${field}: no seat may be added beside one that is already filled`);
        assert.strictEqual(out.ignored[0].why, 'already_seated');
    }
});

test('an empty panel is a decision the file made, so no assignee is added beside it', () => {
    // `approvers: []` is the one seat value scrub.js leaves standing (it skips
    // empty arrays), and it means the author configured a PANEL. Dropping an
    // `assignee` next to it would earn the step a second validator error on top
    // of the one an empty panel already has: automation/validate/stepRules.js
    // refuses "assignee together with approvers". So it is refused and named,
    // and whoever installs opens the step.
    const definition = def([approvalStep('s1', { approval: { approvers: [] } })]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        approvers: [{ ref: 'aut_1', stepId: 's1', seat: { groupId: 'g1' } }],
    }));
    assert.strictEqual(definition.steps[0].approval.assignee, undefined);
    assert.strictEqual(out.ignored[0].why, 'already_seated');
});

test('a step whose seats the scrub emptied IS filled — that is the whole point', () => {
    // scrub.js deletes the seat fields outright, so `approval: {}` is what a
    // captured approval step looks like on arrival.
    const definition = def([approvalStep('s1', { approval: { details: 'Sign off?' } })]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        approvers: [{ ref: 'aut_1', stepId: 's1', seat: { groupId: 'g1' } }],
    }));
    assert.deepStrictEqual(definition.steps[0].approval.assignee, { groupId: 'g1' });
    assert.strictEqual(definition.steps[0].approval.details, 'Sign off?', 'the rest of the step is untouched');
    assert.deepStrictEqual(out.applied, [{ kind: 'approver', ref: 'aut_1', stepId: 's1', layerKey: null }]);
});

test('a resolution reaches a step inside a flowlet, and only the right one', () => {
    const definition = def([httpStep('s1')], { enrich: { steps: [httpStep('s1')] } });
    applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_1', stepId: 's1', layerKey: 'enrich', connectionId: 'conn_layer' }],
    }));
    // Same step id in two graphs is legal — the layer key is what tells them
    // apart, so the root step must be untouched.
    assert.strictEqual(definition.steps[0].auth, null);
    assert.deepStrictEqual(definition.layers.enrich.steps[0].auth, { connectionId: 'conn_layer' });
});

test('a resolution for another routine is not applied to this one', () => {
    const definition = def([httpStep('s1')]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_2', stepId: 's1', connectionId: 'conn_1' }],
    }));
    assert.strictEqual(definition.steps[0].auth, null);
    assert.deepStrictEqual(out.applied, []);
    assert.deepStrictEqual(out.ignored, []);
});

test('a resolution for a step that is not there is NAMED, never silently dropped', () => {
    // The wizard read this address off the manifest. If it does not exist, the
    // two disagree about what is in the file, and that is worth a sentence.
    const definition = def([httpStep('s1')]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_1', stepId: 's_gone', connectionId: 'conn_1' }],
        approvers: [{ ref: 'aut_1', stepId: 's_also_gone', seat: { userId: 'u1' } }],
    }));
    assert.deepStrictEqual(out.applied, []);
    assert.deepStrictEqual(out.ignored.map(x => [x.kind, x.stepId, x.why]).sort(), [
        ['approver', 's_also_gone', 'no_such_step'],
        ['connection', 's_gone', 'no_such_step'],
    ]);
});

test('a connection aimed at a step that is not an http_request is refused, not forced on', () => {
    const definition = def([approvalStep('s1')]);
    const out = applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_1' }],
    }));
    assert.strictEqual(definition.steps[0].auth, undefined);
    assert.strictEqual(out.ignored[0].why, 'not_an_http_step');
});

test('a trigger is never a resolution target, even when it shares an id', () => {
    // walkAllSteps visits triggers too. A trigger that happened to be called
    // "s1" must not collect the credential meant for the step called "s1".
    const definition = def([httpStep('s1')]);
    definition.trigger.id = 's1';
    applyStepResolutions(definition, 'aut_1', normalizeResolutions({
        connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_1' }],
    }));
    assert.strictEqual(definition.trigger.auth, undefined);
    assert.deepStrictEqual(definition.steps[0].auth, { connectionId: 'conn_1' });
});

test('a definition that is not one survives being handed resolutions', () => {
    for (const junk of [null, undefined, 'text', 42, []]) {
        assert.deepStrictEqual(
            applyStepResolutions(junk, 'aut_1', normalizeResolutions({
                connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'c' }],
            })),
            { applied: [], ignored: [] },
        );
    }
});
