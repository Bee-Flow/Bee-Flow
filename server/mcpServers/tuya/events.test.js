// @typecheck
const test = require('node:test');
const assert = require('node:assert');

const { TRIGGER_SOURCES } = require('./events');

/**
 * Tuya is the proof case for declaration-driven triggers: a bundled MCP server
 * with no push channel, whose "device status changed" event is produced purely
 * by the generic poll_diff runtime. No account or credentials needed — the tool
 * call is stubbed, exactly like tuya.test.js does for the signing helpers.
 */

const [tuya] = TRIGGER_SOURCES;

// The declaration against the automation module's trigger-source machinery (validate, the
// poll_diff runtime) is checked in events.automation.test.js.

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
