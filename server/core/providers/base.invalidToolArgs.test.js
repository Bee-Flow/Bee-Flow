/**
 * A tool call whose arguments never became valid JSON is announced, not just logged.
 *
 * The adapter still refuses to hand such a call up as `tool_use` — echoing a
 * half-written call back to the provider next round is the 400 / spin loop the
 * note in flushToolCalls describes. But dropping it silently left the caller
 * with a round that had no tool call and no text, which is indistinguishable
 * from the model going quiet: the builders' own "your arguments were not valid
 * JSON, resend just that call" handler could never fire, and the user got "the
 * model stopped twice without saying anything" for a mistake the model could
 * have repaired in one round.
 *
 * Run: cd server && node --test --test-force-exit core/providers/base.invalidToolArgs.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const BaseProvider = require('./base');

/** Drive a canned SSE transcript through the real parser (same shape as base.test.js). */
async function eventsFor(frames) {
    const provider = new BaseProvider('generic');
    const sse = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
    const body = (async function* () { yield new TextEncoder().encode(sse); })();
    global.fetch = async () => ({ ok: true, body });
    const events = [];
    await provider.stream('k', 'http://x', 'm', [{ role: 'user', content: 'q' }], {},
        (type, data) => events.push({ type, data }));
    return events;
}

const toolDelta = (args) => ({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'builder_add_steps', arguments: args } } ] } }],
});

test('broken arguments are reported as tool_use_invalid with the tool name', async () => {
    const events = await eventsFor([toolDelta('{"steps":[{"tempId":"a"'), { choices: [{ finish_reason: 'length' }] }]);
    const invalid = events.filter((e) => e.type === 'tool_use_invalid');
    assert.strictEqual(invalid.length, 1);
    assert.strictEqual(invalid[0].data.name, 'builder_add_steps');
    assert.ok(invalid[0].data.error, 'the parse error is carried so a log line can name it');
});

test('a broken call is still never handed up as a runnable tool_use', async () => {
    const events = await eventsFor([toolDelta('{"steps":[{"tempId":"a"'), { choices: [{ finish_reason: 'length' }] }]);
    assert.strictEqual(events.filter((e) => e.type === 'tool_use').length, 0);
});

test('a valid call is unaffected — no invalid event, one tool_use', async () => {
    const events = await eventsFor([toolDelta('{"steps":[]}'), { choices: [{ finish_reason: 'tool_calls' }] }]);
    assert.strictEqual(events.filter((e) => e.type === 'tool_use_invalid').length, 0);
    const uses = events.filter((e) => e.type === 'tool_use');
    assert.strictEqual(uses.length, 1);
    assert.deepStrictEqual(uses[0].data.input, { steps: [] });
});

test('empty arguments stay valid — a paramless tool is not a broken call', async () => {
    const events = await eventsFor([toolDelta(''), { choices: [{ finish_reason: 'tool_calls' }] }]);
    assert.strictEqual(events.filter((e) => e.type === 'tool_use_invalid').length, 0);
    assert.strictEqual(events.filter((e) => e.type === 'tool_use').length, 1);
});

test('a nameless call is still dropped without an invalid event', async () => {
    // Nothing to ask the model to resend: there is no tool to name.
    const events = await eventsFor([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { arguments: '{"a":1}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls' }] },
    ]);
    assert.strictEqual(events.filter((e) => e.type === 'tool_use').length, 0);
    assert.strictEqual(events.filter((e) => e.type === 'tool_use_invalid').length, 0);
});
