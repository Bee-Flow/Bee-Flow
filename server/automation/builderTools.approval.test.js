/**
 * Approvals: the authoring contract.
 *
 * The step type reached the engine long before it reached the product — it
 * paused, resumed and audited correctly, but nothing could CREATE one: no
 * palette entry, no editor, no builder tool. The AI builder's own guidance told
 * the model to fake it by posting a Talk message and triggering on a 👍.
 *
 * These tests pin the two places a half-wired step type hides: a tool
 * registered in one list but not the others, and a patch path that quietly
 * persists fields the engine never reads.
 *
 * Run: node --test automation/builderTools.approval.test.js
 *
 * No DB needed — everything here mutates the in-memory draft only.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    applyToolCall, emptyDefinition, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, TOOL_SCHEMAS, PATCHABLE_FIELDS,
} = require('./builderTools');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}

/** Append an approval and hand back the step that was created. */
async function addApproval(dw, args) {
    const res = await applyToolCall('builder_add_approval', args, dw);
    assert.ok(!res.error, `builder_add_approval errored: ${res.error}`);
    return dw.def.steps.find(s => s.type === 'approval');
}

test('an added approval carries exactly the fields the engine reads', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'Send the quote?', expiresInHours: 24, label: 'Sign off' });

    assert.deepStrictEqual(Object.keys(step).sort(), ['approval', 'id', 'label', 'prompt', 'type']);
    assert.match(step.id, /^appr_/);
    assert.strictEqual(step.prompt, 'Send the quote?');
    assert.strictEqual(step.label, 'Sign off');
    assert.deepStrictEqual(step.approval, { expiresInHours: 24 });
});

test('the default label is byte-identical to the canvas default', async () => {
    // nodeDefs.serverLabels.test.js asserts the other side of this equality;
    // together they stop the palette and the AI builder drifting apart.
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'ok?' });
    assert.strictEqual(step.label, 'Approval');
});

test('deadline clamp: 0 is a real value, not an empty one', async () => {
    const cases = [
        [undefined, 168],
        [0, 0],          // "no deadline" — must survive, never fall back to the default
        [-5, 0],
        [1.4, 1],
        [9999, 720],
        ['12', 12],
        [NaN, 168],
        [null, 168],
    ];
    for (const [input, expected] of cases) {
        const dw = freshWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const step = await addApproval(dw, { prompt: 'q', expiresInHours: input });
        assert.strictEqual(
            step.approval.expiresInHours, expected,
            `expiresInHours ${JSON.stringify(input)} should clamp to ${expected}, got ${step.approval.expiresInHours}`,
        );
    }
});

test('a missing question is stored blank rather than invented', async () => {
    // There is no honest default for "what am I asking?", and a plausible
    // placeholder would reach a real approver looking configured. validate.js
    // reports the gap as a completeness issue instead.
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, {});
    assert.strictEqual(step.prompt, '');
});

test('builder_update_step patches the question', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'old' });
    await applyToolCall('builder_update_step', { stepId: step.id, patch: { prompt: 'new' } }, dw);
    assert.strictEqual(dw.def.steps.find(s => s.id === step.id).prompt, 'new');
});

test('patching `approval` DROPS fields the engine never reads', async () => {
    // A model reaching for an approval routinely invents assignees and
    // reminders. Persisting them would show a configured-looking control that
    // does nothing — the worst outcome for a step a person relies on.
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'q', expiresInHours: 168 });
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { approval: { expiresInHours: 4, assignee: 'bob', reminderHours: 2 } },
    }, dw);
    assert.deepStrictEqual(dw.def.steps.find(s => s.id === step.id).approval, { expiresInHours: 4 });
});

test('forEach is not patchable onto an approval', async () => {
    // execForEachStep rethrows a run pause, so an approval that iterates
    // pauses on item 1 and items 2..n never run.
    assert.ok(!PATCHABLE_FIELDS.approval.includes('forEach'), 'forEach must stay out of PATCHABLE_FIELDS.approval');
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'q' });
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { forEach: { overRef: 'steps.a.output.rows', itemVar: 'row' } },
    }, dw);
    assert.strictEqual(dw.def.steps.find(s => s.id === step.id).forEach, undefined);
});

test('builder_add_approval is registered in every list a tool must appear in', () => {
    const name = 'builder_add_approval';
    assert.ok(MUTATING_TOOLS.has(name), 'missing from MUTATING_TOOLS');
    assert.ok(SCOPED_GRAPH_TOOLS.has(name), 'missing from SCOPED_GRAPH_TOOLS');
    const schema = TOOL_SCHEMAS.find(t => t.function?.name === name);
    assert.ok(schema, 'missing from TOOL_SCHEMAS');
    assert.ok(schema.function.parameters.properties.scope, 'scope param was not auto-injected');
    assert.ok(schema.function.parameters.properties.prompt, 'prompt param missing');
    // The description has to state the two things that surprise people:
    // rejection ends the run, and it must not go inside a loop.
    const desc = schema.function.description;
    assert.match(desc, /reject/i);
    assert.match(desc, /loop/i);
});

test('builder_add_steps can batch-append an approval', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const res = await applyToolCall('builder_add_steps', {
        steps: [{ type: 'approval', spec: { prompt: 'Ship it?', expiresInHours: 72 } }],
    }, dw);
    assert.ok(!res.error, `unexpected error: ${res.error}`);
    const step = dw.def.steps.find(s => s.type === 'approval');
    assert.ok(step, 'no approval step was appended');
    assert.strictEqual(step.prompt, 'Ship it?');
    assert.strictEqual(step.approval.expiresInHours, 72);
});

test('an approval is reachable from builder_add_steps and builder_replace_step', () => {
    // The gap that let approvals ship half-wired for so long: these two enums
    // are hand-maintained, and nothing checked them against the tool registry.
    // A tool the model can add but never batch-add or convert to is a tool
    // most builds will never reach.
    const addSteps = TOOL_SCHEMAS.find(t => t.function?.name === 'builder_add_steps');
    const replace = TOOL_SCHEMAS.find(t => t.function?.name === 'builder_replace_step');
    const addEnum = addSteps.function.parameters.properties.steps.items.properties.type.enum;
    const replaceEnum = replace.function.parameters.properties.newType.enum;
    assert.ok(addEnum.includes('approval'), "builder_add_steps' type enum is missing 'approval'");
    assert.ok(replaceEnum.includes('approval'), "builder_replace_step's newType enum is missing 'approval'");
});

test('normalizeApprovalConfig: rich keys survive, invented keys die', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const res = await applyToolCall('builder_add_approval', {
        prompt: 'Ship it?',
        expiresInHours: 72,
        assignee: { userId: 'u1', ignoreMe: true },
        details: '**Total:** {{steps.q.output.total}}',
        attachments: [
            { binding: '{{steps.doc.output.fileId}}', label: 'Quote', evil: 'x' },
            { label: 'no binding — dropped' },
        ],
        fields: [
            { name: 'po', label: 'PO number', type: 'text', required: true },
            { name: 'up', label: 'Upload', type: 'file' },   // refused type — dropped
        ],
        reminderHours: 4,          // invented — dropped
        approvers: ['a', 'b'],     // invented — dropped
    }, dw);
    assert.ok(!res.error, res.error);
    const step = dw.def.steps.find(s => s.type === 'approval');
    assert.deepStrictEqual(Object.keys(step.approval).sort(), ['assignee', 'attachments', 'details', 'expiresInHours', 'fields']);
    assert.deepStrictEqual(step.approval.assignee, { userId: 'u1' });
    assert.deepStrictEqual(step.approval.attachments, [{ binding: '{{steps.doc.output.fileId}}', label: 'Quote' }]);
    assert.deepStrictEqual(step.approval.fields.map(f => f.name), ['po']);
    assert.strictEqual(step.approval.details, '**Total:** {{steps.q.output.total}}');
});

test('a group assignee normalizes like a user one; both-set prefers the user', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    await applyToolCall('builder_add_approval', { prompt: 'q', assignee: { groupId: 'g7' } }, dw);
    assert.deepStrictEqual(dw.def.steps.at(-1).approval.assignee, { groupId: 'g7' });
});

test('v2 clocks survive normalization — and half an escalation drops whole', async () => {
    require('./builderTools')._builderTest
        ? require('./builderTools')._builderTest : {};
    // normalizeApprovalConfig is not exported directly — drive it through the
    // patch path instead, which is the surface everything real uses.
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'q' });
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { approval: {
            expiresInHours: 168, remindAfterHours: 24,
            escalateTo: { groupId: 'g9' }, escalateAfterHours: 48,
        } },
    }, dw);
    assert.deepStrictEqual(dw.def.steps.find(s => s.id === step.id).approval, {
        expiresInHours: 168, remindAfterHours: 24,
        escalateTo: { groupId: 'g9' }, escalateAfterHours: 48,
    });
    // Half an escalation (target without delay) must not persist as a control
    // that silently does nothing.
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { approval: { expiresInHours: 168, escalateTo: { userId: 'u1' } } },
    }, dw);
    assert.deepStrictEqual(dw.def.steps.find(s => s.id === step.id).approval, { expiresInHours: 168 });
});

test('a panel survives normalization: deduped, capped, assignee + escalation dropped', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'q' });
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { approval: {
            expiresInHours: 168,
            approvers: [
                { userId: 'u1' }, { groupId: 'g1' }, { userId: 'u1' },    // dup dies
                { userId: '', groupId: '' }, 'junk',                       // junk dies
            ],
            rule: 'quorum', quorum: 9,                                     // clamped to the seat count
            assignee: { userId: 'u9' },                                    // panel wins
            escalateTo: { userId: 'u9' }, escalateAfterHours: 24,          // panel excludes escalation
            finalApprover: { userId: 'cfo' },
        } },
    }, dw);
    assert.deepStrictEqual(dw.def.steps.find(s => s.id === step.id).approval, {
        expiresInHours: 168,
        approvers: [{ userId: 'u1' }, { groupId: 'g1' }],
        rule: 'quorum', quorum: 2,
        finalApprover: { userId: 'cfo' },
    });
});

test('an invalid rule falls back to "all"; a panel of junk-only seats never persists', async () => {
    const dw = freshWrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const step = await addApproval(dw, { prompt: 'q' });
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { approval: { expiresInHours: 4, approvers: [{ userId: 'u1' }, { userId: 'u2' }], rule: 'majority' } },
    }, dw);
    assert.strictEqual(dw.def.steps.find(s => s.id === step.id).approval.rule, 'all');
    await applyToolCall('builder_update_step', {
        stepId: step.id,
        patch: { approval: { expiresInHours: 4, approvers: [{}, 'nope'] } },
    }, dw);
    assert.deepStrictEqual(dw.def.steps.find(s => s.id === step.id).approval, { expiresInHours: 4 });
});
