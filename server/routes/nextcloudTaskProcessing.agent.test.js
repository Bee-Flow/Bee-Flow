/**
 * The Nextcloud agent task type (`core:contextagent:interaction`).
 *
 * This is the type that makes Bee Flow the engine behind Nextcloud's Assistant:
 * Assistant decides whether to show its agent tab, confirmation dialog and chat
 * history from `array_key_exists(ContextAgentInteraction::ID, getAvailableTaskTypes())`,
 * and that array gains a type as soon as any provider claims it.
 *
 * The assertion that matters most here is the SAFETY BOUND. Nextcloud's agent
 * contract has a confirmation step — a provider returns pending tool calls in
 * `actions`, Nextcloud renders confirm/deny, the next turn carries
 * `confirmation`. Bee Flow's chat runtime has no interrupt hook to populate that
 * with, so write tools must not be reachable from this path at all. If someone
 * removes the filter without building the gate, these fail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { isSideEffect } = require('../automation/sideEffectMap');

test('the agent task type is the one Assistant keys its whole agent UI on', () => {
    const mod = require('./nextcloudTaskProcessing');
    assert.equal(mod.AGENT_TASK_TYPE, 'core:contextagent:interaction');
});

test('the connector registers the agent type, with the shapes Assistant inspects', () => {
    // Registration and execution are in different repos-worth of code; this is
    // what ties them together. A provider registered for a type the SaaS cannot
    // serve takes Assistant down instance-wide.
    process.env.APP_SECRET = process.env.APP_SECRET || 'ci-test-secret';
    process.env.NEXTCLOUD_URL = process.env.NEXTCLOUD_URL || 'http://nextcloud.invalid';
    const tp = require('../../nextcloud-connector/src/taskProcessing');
    const mod = require('./nextcloudTaskProcessing');

    const agent = tp.TASK_TYPES.find(t => t.id === mod.AGENT_TASK_TYPE);
    assert.ok(agent, 'the connector must register the agent task type');

    const def = tp.providerDefinition(agent);
    assert.equal(def.task_type, 'core:contextagent:interaction');
    assert.ok(def.id.startsWith('bee_flow:'), 'provider ids stay namespaced so they cannot collide with context_agent');
    // Assistant reads optionalInputShape['memories'] to decide whether it may
    // send prior context; without the declaration it never does.
    assert.ok(def.optional_input_shape.some(s => s.name === 'memories'));
    assert.ok(def.optional_output_shape.some(s => s.name === 'sources'));
    // The text types must NOT have grown shapes — they are drop-in replacements
    // for whatever provider the admin had before.
    const summary = tp.TASK_TYPES.find(t => t.id === 'core:text2text:summary');
    assert.deepEqual(tp.providerDefinition(summary).optional_input_shape, []);
});

test('every tool the agent may call is classified non-side-effecting', () => {
    // The filter is `!isSideEffect(name)` against the same fail-closed map the
    // MCP surface uses: an unclassified tool counts as destructive.
    const writes = ['nextcloud_delete', 'nextcloud_talk_send_message', 'nextcloud_tables_delete'];
    for (const w of writes) {
        assert.equal(isSideEffect(w), true, `${w} must be classified as side-effecting`);
    }
    const reads = ['nextcloud_list_files', 'nextcloud_talk_list_rooms', 'nextcloud_tables_list'];
    for (const r of reads) {
        assert.equal(isSideEffect(r), false, `${r} should be readable by the agent`);
    }
    // Fail-closed: a tool nobody classified is treated as destructive, so a new
    // write tool cannot reach the agent by being forgotten.
    assert.equal(isSideEffect('some_tool_added_next_year'), true);
});

test('the agent turn refuses to run without a mapped Bee Flow user', async () => {
    // Running as "the organisation" would hand one person another user's data.
    const mod = require('./nextcloudTaskProcessing');
    await assert.rejects(
        () => mod.runAgentTurn({ input: {}, org: { id: 'org-1' }, user: null, ncUid: 'alice' }),
        /No Bee Flow user is linked/,
    );
});
