const { test } = require('node:test');
const assert = require('node:assert');

const { chunkText } = require('./chunking');

const sentence = (word, n) => Array.from({ length: n }, (_, i) => `${word} sentence number ${i} talks about ${word}.`).join(' ');

test('a flushed chunk keeps the heading it sits under, not the next section\'s', () => {
    // ~340 tokens under "## Alpha", then a section that opens "## Beta" and overflows the buffer.
    const alphaBody = sentence('alpha', 29);
    const betaBody = sentence('beta', 12);
    const text = `# Handbook\n\n## Alpha\n\n${alphaBody.slice(0, 600)}\n\n${alphaBody.slice(600)}\n\n${alphaBody}\n\n## Beta\n${betaBody}`;
    const chunks = chunkText(text);
    const alphaOnly = chunks.filter(c => /alpha sentence/.test(c.text) && !/beta sentence/.test(c.text));
    assert.ok(alphaOnly.length >= 2, 'the alpha body spans several chunks');
    for (const c of alphaOnly) {
        assert.ok(!c.text.includes('## Beta'), `an alpha-only chunk must not be labelled "## Beta":\n${c.text.slice(0, 120)}`);
    }
    const continuation = alphaOnly[alphaOnly.length - 1];
    assert.ok(continuation.text.startsWith('# Handbook\n## Alpha'), continuation.text.slice(0, 60));
});

test('a placeholder-shaped string in the document itself does not crash the chunker', () => {
    const body = sentence('gamma', 6);
    const alone = chunkText(`${body}\n\n__ATOMIC_BLOCK_7__\n\n${body}`);
    assert.ok(alone.some(c => c.text.includes('__ATOMIC_BLOCK_7__')));
    const inline = chunkText(`${body} see __ATOMIC_BLOCK_3__ for details. ${body}`);
    assert.ok(inline.some(c => c.text.includes('__ATOMIC_BLOCK_3__')));
});
