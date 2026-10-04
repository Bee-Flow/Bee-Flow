const test = require('node:test');
const assert = require('node:assert');

const { TRIGGER_SOURCES } = require('./events');
const { validateTriggerSource } = require('../../automation/triggerSources/validate');
const { runPollDiff, makePassCtx } = require('../../automation/triggerSources/pollDiff');

/**
 * Tuya is the proof case for declaration-driven triggers: a bundled MCP server
 * with no push channel, whose "device status changed" event is produced purely
 * by the generic poll_diff runtime. No account or credentials needed — the tool
 * call is stubbed, exactly like tuya.test.js does for the signing helpers.
 */

const [tuya] = TRIGGER_SOURCES;
const statusEvent = tuya.events.find(e => e.id === 'device.status.changed');

// A device as list_devices({ include_status: true }) returns it.
const device = (over = {}) => ({
    id: 'bf12ab34cd56ef7890',
    name: 'Woonkamer lamp',
    category: 'dj',
    product_name: 'Smart Bulb',
    online: true,
    is_lock: false,
    status: [{ code: 'switch_led', value: false }, { code: 'bright_value_v2', value: 540 }],
    ...over,
});

function poll(devices, lastCursor = null) {
    const saved = [];
    const passCtx = makePassCtx({
        toolBudget: 10,
        executeTool: async () => ({ result: JSON.stringify({ devices }) }),
        resolveEntitlements: async () => ({ effective: { integration: new Set(['mcp:tuya']) } }),
    });
    const store = { updateSubscription: async (id, patch) => saved.push(patch) };
    return runPollDiff({ id: 'sub-1', userId: 'u1', lastCursor }, statusEvent, passCtx, { automationStore: store })
        .then(out => ({ ...out, cursor: saved[0]?.lastCursor }));
}

const aged = (cursor) => JSON.stringify({ ...JSON.parse(cursor), t: 0 });

test('the Tuya manifest is a valid trigger-source declaration', () => {
    const errors = validateTriggerSource(tuya).filter(i => i.severity === 'error');
    assert.deepStrictEqual(errors, [], errors.map(e => `${e.code}@${e.path}`).join(', '));
});

test('every declared output field has a sample the picker can show', () => {
    for (const ev of tuya.events) {
        for (const field of ev.fields) {
            assert.ok(field in ev.sample, `${ev.id}.${field}`);
        }
    }
});

test('both events poll the same tool with the same arguments, so they share one call', () => {
    const [a, b] = tuya.events.map(e => e.source);
    assert.strictEqual(a.tool, b.tool);
    assert.deepStrictEqual(a.args, b.args);
    assert.strictEqual(a.tool, 'mcp_tuya_list_devices');
});

test('switching a lamp produces exactly one event naming the data point that moved', async () => {
    const first = await poll([device()]);
    assert.deepStrictEqual(first.events, [], 'activating the automation fires nothing');

    const second = await poll([device({ status: [{ code: 'switch_led', value: true }, { code: 'bright_value_v2', value: 540 }] })], aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    const ev = second.events[0];
    assert.strictEqual(ev.deviceId, 'bf12ab34cd56ef7890');
    assert.strictEqual(ev.deviceName, 'Woonkamer lamp');
    assert.deepStrictEqual(ev.changedKeys, ['status.switch_led']);
    assert.strictEqual(ev.previous['status.switch_led'], false);
    assert.strictEqual(ev.current['status.switch_led'], true);
});

test('a device merely reporting the same state again is not a change', async () => {
    const first = await poll([device()]);
    const second = await poll([device()], aged(first.cursor));
    assert.deepStrictEqual(second.events, []);
});

test('going offline is a change on its own', async () => {
    const first = await poll([device()]);
    const second = await poll([device({ online: false })], aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    assert.deepStrictEqual(second.events[0].changedKeys, ['online']);
    assert.strictEqual(second.events[0].online, false);
});

test('adding a device to the account does not fire a status change', async () => {
    const first = await poll([device()]);
    const second = await poll([device(), device({ id: 'new-device', name: 'Keuken' })], aged(first.cursor));
    assert.deepStrictEqual(second.events, [], 'emitOnAppear is off for a status trigger');
});

test('a lock is observable but the payload never implies it is operable', async () => {
    const lock = device({ id: 'lock-1', name: 'Voordeur', is_lock: true, status: [{ code: 'lock_motor_state', value: false }] });
    const first = await poll([lock]);
    const second = await poll([device({ ...lock, status: [{ code: 'lock_motor_state', value: true }] })], aged(first.cursor));
    assert.strictEqual(second.events.length, 1);
    // isLock travels so an automation can filter locks out; commanding one still
    // goes through the MCP server's own TUYA_ALLOW_LOCKS gate.
    assert.strictEqual(second.events[0].isLock, true);
});
