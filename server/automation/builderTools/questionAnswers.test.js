const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswersText } = require('./questionAnswers');

// The literal text agent-hub's answersToText produces (chat/questionAnswers.ts).
const QA = 'Q: Which inbox?\nA: Finance\n\nQ: Retries?\nA: 3';

test('parseAnswersText reads exactly the card\'s Q/A text', () => {
    assert.deepEqual(parseAnswersText(QA), [{ prompt: 'Which inbox?', answer: 'Finance' }, { prompt: 'Retries?', answer: '3' }]);
});

test('parseAnswersText returns null for anything else a user may type', () => {
    for (const text of ['Q: only a question', 'Hello Q: x\nA: y', 'Q: a\nA: b\n\nand more', '', null, undefined, 42]) assert.equal(parseAnswersText(text), null, String(text));
});
