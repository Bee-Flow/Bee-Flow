const test = require('node:test');
const assert = require('node:assert/strict');
const { partialAnswer } = require('./coworkConversationStream');

test('streams the answer across JSON escape boundaries and withholds internal routing', () => {
    const prefix = '{"action":"answer","answer":"';
    assert.equal(partialAnswer(prefix + 'Line\\'), 'Line');
    assert.equal(partialAnswer(prefix + 'Line\\n\\u00'), 'Line\n');
    assert.equal(partialAnswer(prefix + 'Line\\n\\u00e9","instruction":"hidden"}'), 'Line\né');
    assert.equal(partialAnswer('{"action":"read_result","answer":"intermediate"}'), '');
});
