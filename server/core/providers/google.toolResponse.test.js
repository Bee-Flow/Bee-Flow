/**
 * Gemini's functionResponse.response is a protobuf Struct (a JSON object). A
 * tool result whose text happens to be valid JSON of another kind ("[]", "42",
 * "true", "null") must be wrapped, or the API rejects the whole request.
 *
 * Run: node --test core/providers/google.toolResponse.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');

const GoogleProvider = require('./google');

function responseFor(content) {
    const { contents } = new GoogleProvider().normalizeMessages([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content },
    ]);
    const part = contents[contents.length - 1].parts[0].functionResponse;
    assert.strictEqual(part.name, 'lookup');
    return part.response;
}

test('an object result is passed through as the response', () => {
    assert.deepStrictEqual(responseFor('{"rows":[1,2]}'), { rows: [1, 2] });
});

test('plain text is wrapped', () => {
    assert.deepStrictEqual(responseFor('done'), { result: 'done' });
});

test('JSON that is not an object is wrapped too', () => {
    assert.deepStrictEqual(responseFor('[]'), { result: [] });
    assert.deepStrictEqual(responseFor('[{"id":1}]'), { result: [{ id: 1 }] });
    assert.deepStrictEqual(responseFor('42'), { result: 42 });
    assert.deepStrictEqual(responseFor('true'), { result: true });
    assert.deepStrictEqual(responseFor('null'), { result: null });
    assert.deepStrictEqual(responseFor('"quoted"'), { result: 'quoted' });
});
