const test = require('node:test');
const assert = require('node:assert');
const { scorePairs } = require('./cpuCrossEncoder');

test('scorePairs encodes (query, document) as a PAIR and returns the raw logit per document', async () => {
    const seen = {};
    const ranker = {
        tokenizer: (text, opts) => { seen.text = text; seen.opts = opts; return { input_ids: 'x' }; },
        model: async (inputs) => {
            seen.inputs = inputs;
            return { logits: { tolist: () => [[-2.5], [3.1]] } };
        },
    };
    const logits = await scorePairs(ranker, 'reset password', ['unrelated', 'how to reset a password']);
    assert.deepStrictEqual(seen.text, ['reset password', 'reset password']);
    assert.deepStrictEqual(seen.opts.text_pair, ['unrelated', 'how to reset a password']);
    assert.deepStrictEqual(seen.inputs, { input_ids: 'x' });
    // Raw logits, not a softmax over one label (which is 1.0 for everything).
    assert.deepStrictEqual(logits, [-2.5, 3.1]);
});
