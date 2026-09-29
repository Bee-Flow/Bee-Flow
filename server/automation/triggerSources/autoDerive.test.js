const test = require('node:test');
const assert = require('node:assert');

const { deriveProviders, deriveEventDef, isWatchable, capabilityForTool } = require('./autoDerive');
const { validateTriggerSource } = require('./validate');
const { runPollDiff, makePassCtx } = require('./pollDiff');

/**
 * Auto-derived sources: enabling an integration is enough to get a trigger, with
 * no declaration file. The risk this carries is offering something that can
 * never work — a write tool, a tool we cannot call blind, or a server whose id
 * we cannot read back — so most of these tests are about what is REFUSED.
 */

const tool = (name, required) => ({
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {}, ...(required ? { required } : {}) } },
});

test('a newly enabled MCP server becomes its own trigger provider', () => {
    const providers = deriveProviders([
        tool('mcp_fireflies_fireflies_get_transcripts'),
        tool('mcp_slack_list_channels'),
    ]);
    assert.deepStrictEqual(providers.map(p => p.id), ['fireflies', 'slack']);
    assert.strictEqual(providers[0].events.length, 1);
    assert.match(providers[0].events[0].id, /^auto\.mcp_fireflies_fireflies_get_transcripts\.changed$/);
});

test('servers are kept apart instead of collapsing into one "mcp" provider', () => {
    // resolveIntegration answers 'mcp' for any server without its own prefix
    // entry; taking that at face value would merge every server together.
    const providers = deriveProviders([tool('mcp_a_list_things'), tool('mcp_b_list_things')]);
    assert.deepStrictEqual(providers.map(p => p.id).sort(), ['a', 'b']);
});

test('anything that could write is refused', () => {
    for (const name of [
        'mcp_x_send_messages', 'mcp_x_delete_items', 'mcp_x_create_records',
        'mcp_x_update_rows', 'mcp_x_switch_devices', 'mcp_x_trigger_scenes',
    ]) {
        assert.strictEqual(isWatchable(tool(name)), false, name);
    }
});

test('a tool we cannot call blind, or that returns one record, is refused', () => {
    assert.strictEqual(isWatchable(tool('mcp_x_list_items', ['folder'])), false, 'required argument');
    assert.strictEqual(isWatchable(tool('mcp_x_get_transcript')), false, 'singular — nothing to diff');
    assert.strictEqual(isWatchable(tool('mcp_x_ping')), false, 'no read verb, no collection');
});

test('first-party tools defer to the curated side-effect map, not to their name', () => {
    // sideEffectMap is authoritative here and lists no MCP tools, which is why
    // MCP needs the name heuristic and first-party tools must not use it.
    assert.strictEqual(isWatchable(tool('gmail_send')), false);
    assert.strictEqual(isWatchable(tool('sheets_list')), true);
});

test('an integration that ships a real declaration is never guessed at', () => {
    // Tuya declares its own events; auto-derivation must not offer a second,
    // vaguer version of the same thing.
    const providers = deriveProviders([tool('mcp_tuya_list_devices'), tool('mcp_tuya_list_scenes')]);
    assert.deepStrictEqual(providers, []);
});

test('a server id that cannot be read back is skipped rather than guessed', () => {
    // Tool names are sanitised, so `my-server` and `my_server` both arrive as
    // mcp_my_server_… — deriving `mcp:my` would list a trigger that then fails
    // its capability check forever.
    const providers = deriveProviders([tool('mcp_myserver_list_things')], { mcpServerIds: new Set(['my-server']) });
    assert.deepStrictEqual(providers, []);
});

test('the capability is derived from the tool name so the poller can re-check it', () => {
    assert.strictEqual(capabilityForTool('mcp_fireflies_list_things'), 'mcp:fireflies');
    assert.strictEqual(capabilityForTool('sheets_list', 'google-sheets'), 'google-sheets');
});

test('a derived event rebuilds itself from its id alone — no user, no catalog', () => {
    const id = 'auto.mcp_fireflies_fireflies_get_transcripts.changed';
    const ev = deriveEventDef(id);
    assert.strictEqual(ev.source.tool, 'mcp_fireflies_fireflies_get_transcripts');
    assert.strictEqual(ev.source.requiresIntegration, 'mcp:fireflies');
    assert.strictEqual(ev.source.auto, true);
    assert.strictEqual(deriveEventDef('gmail.mail.new'), null);
});

test('derived declarations satisfy the same validator as hand-written ones', () => {
    for (const provider of deriveProviders([tool('mcp_fireflies_fireflies_get_transcripts')])) {
        const errors = validateTriggerSource(provider).filter(i => i.severity === 'error');
        assert.deepStrictEqual(errors, [], errors.map(e => `${e.code}@${e.path}`).join(', '));
    }
});

test('derived events poll rarely — we know nothing about the API behind them', () => {
    const ev = deriveEventDef('auto.mcp_x_list_things.changed');
    assert.ok(ev.source.minIntervalMs >= 900_000, 'at least 15 minutes');
    assert.ok(ev.source.maxItemsPerTick <= 10);
});

// ── the runtime half: inferring a shape nobody declared ──────────────────

function poll(results, lastCursor = null) {
    const saved = [];
    const ev = deriveEventDef('auto.mcp_fireflies_fireflies_get_transcripts.changed');
    const passCtx = makePassCtx({
        toolBudget: 10,
        executeTool: async () => results,
        resolveEntitlements: async () => ({ effective: { integration: new Set(['mcp:fireflies']) } }),
    });
    const store = { updateSubscription: async (id, patch) => saved.push(patch) };
    return runPollDiff({ id: 's1', userId: 'u1', lastCursor }, ev, passCtx, { automationStore: store })
        .then(out => ({ ...out, cursor: saved[saved.length - 1]?.lastCursor }));
}

const aged = (cursor) => JSON.stringify({ ...JSON.parse(cursor), t: 0 });

test('the list, the identity and the changing fields are inferred from the response', async () => {
    const first = await poll({ transcripts: [{ id: 't1', title: 'Standup', duration: 15 }] });
    assert.deepStrictEqual(first.events, [], 'first poll anchors');

    const second = await poll({ transcripts: [{ id: 't1', title: 'Standup (edited)', duration: 15 }] }, aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    assert.deepStrictEqual(second.events[0].changedKeys, ['title']);
    // The shape was never declared, so the whole item travels and the author
    // binds into it after one test run.
    assert.deepStrictEqual(second.events[0].item, { id: 't1', title: 'Standup (edited)', duration: 15 });
    assert.strictEqual(second.events[0].itemId, 't1');
});

test('a new item fires, because "something new appeared" is the usual want', async () => {
    const first = await poll({ transcripts: [{ id: 't1', title: 'A' }] });
    const second = await poll({ transcripts: [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }] }, aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    assert.strictEqual(second.events[0].itemId, 't2');
});

test('a bare array response works too', async () => {
    const first = await poll([{ id: 'a', v: 1 }]);
    const second = await poll([{ id: 'a', v: 2 }], aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    assert.deepStrictEqual(second.events[0].changedKeys, ['v']);
});

test('a response with nothing list-shaped fails loudly instead of never firing', async () => {
    await assert.rejects(() => poll({ ok: true, count: 0 }), /nothing list-shaped/);
});

test('a revoked MCP server stops the polling', async () => {
    const ev = deriveEventDef('auto.mcp_fireflies_fireflies_get_transcripts.changed');
    const passCtx = makePassCtx({
        toolBudget: 10,
        executeTool: async () => ({ transcripts: [] }),
        resolveEntitlements: async () => ({ effective: { integration: new Set() } }),
    });
    const out = await runPollDiff({ id: 's1', userId: 'u1', lastCursor: null }, ev, passCtx, {
        automationStore: { updateSubscription: async () => {} },
    });
    assert.strictEqual(out.skipped, 'no_capability');
});
