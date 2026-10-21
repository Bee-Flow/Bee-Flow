/**
 * The forced-tool test double: a JSON object reply is parsed into `structured`,
 * prose (or any other JSON shape) leaves it null and the text in `content`.
 *
 * Run: node --test testUtils/forcedToolViaChat.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { forcedToolViaChat } = require('./forcedToolViaChat');

const toolDef = { name: 'answer' };

function run(content) {
    const chat = async () => ({ content, usage: { tokens: 3 }, stopReason: 'end_turn' });
    return forcedToolViaChat(chat)('m', [], toolDef, {});
}

test('a JSON object reply becomes the structured answer', async () => {
    const out = await run('{"a":1}');
    assert.deepStrictEqual(out.structured, { a: 1 });
    assert.strictEqual(out.content, '{"a":1}');
});

test('prose, a fenced reply and non-object JSON leave structured null', async () => {
    for (const text of ['just words', '```json\n{"a":1}\n```', '[1,2]', '3']) {
        const out = await run(text);
        assert.strictEqual(out.structured, null, text);
        assert.strictEqual(out.content, text);
    }
});

test('rateLimit is not forwarded and the tool is forced', async () => {
    let seen;
    const chat = async (_k, _u, _m, _msgs, options) => { seen = options; return { content: null }; };
    const out = await forcedToolViaChat(chat)('m', [], toolDef, { rateLimit: { x: 1 }, temperature: 0 });
    assert.strictEqual(seen.rateLimit, undefined);
    assert.strictEqual(seen.temperature, 0);
    assert.deepStrictEqual(seen.forcedTool, toolDef);
    assert.deepStrictEqual(out, { structured: null, content: null, usage: undefined, stopReason: null });
});
