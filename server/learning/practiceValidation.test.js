/**
 * Unit tests — AI practice item validation/clamps (v2).
 *
 * practiceValidation.js is pure (no stores, no network, no LLM), so these
 * tests pin the acceptance/rejection matrix directly: choice counts, the
 * exactly-one-correct rule, length clamps, minted ids, lessonId pinning, and
 * the public (answer-stripped) projection.
 *
 * Run: node --test server/learning/practiceValidation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { PRACTICE_TOOL, validatePracticeItems, publicPracticeItem, MAX_ITEMS } = require('./practiceValidation');
const { PRACTICE_LESSON_IDS } = require('./practiceTopics');
const { LESSON_IDS } = require('./courseCatalog');

const ALLOWED = ['prompt-basics', 'cowork-basics'];

const goodItem = (over = {}) => ({
    lessonId: 'prompt-basics',
    question: 'Which prompt is strongest?',
    choices: [
        { label: 'The vague one', correct: false },
        { label: 'The specific one', correct: true },
        { label: 'The loudest one', correct: false },
    ],
    explanation: 'Specific prompts name audience, task and format.',
    ...over,
});

test('a well-formed item is normalized with minted a/b/c ids', () => {
    const items = validatePracticeItems({ items: [goodItem()] }, ALLOWED);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].choices.map((c) => c.id), ['a', 'b', 'c']);
    assert.equal(items[0].choices.filter((c) => c.correct).length, 1);
    assert.equal(items[0].lessonId, 'prompt-basics');
});

test('rejection matrix: no correct, two corrects, too few choices, empty strings', () => {
    const noCorrect = goodItem({ choices: goodItem().choices.map((c) => ({ ...c, correct: false })) });
    const twoCorrect = goodItem({ choices: goodItem().choices.map((c) => ({ ...c, correct: true })) });
    const twoChoices = goodItem({ choices: goodItem().choices.slice(0, 2) });
    const emptyQ = goodItem({ question: '   ' });
    const noExplanation = goodItem({ explanation: null });
    assert.equal(validatePracticeItems({ items: [noCorrect] }, ALLOWED), null);
    assert.equal(validatePracticeItems({ items: [twoCorrect] }, ALLOWED), null);
    assert.equal(validatePracticeItems({ items: [twoChoices] }, ALLOWED), null);
    assert.equal(validatePracticeItems({ items: [emptyQ] }, ALLOWED), null);
    assert.equal(validatePracticeItems({ items: [noExplanation] }, ALLOWED), null);
    // A bad item is dropped, not repaired — but good siblings survive.
    const mixed = validatePracticeItems({ items: [noCorrect, goodItem()] }, ALLOWED);
    assert.equal(mixed.length, 1);
});

test('length clamps: oversized question/label/explanation are truncated, not rejected', () => {
    const items = validatePracticeItems({
        items: [goodItem({
            question: 'q'.repeat(500),
            explanation: 'e'.repeat(900),
            choices: [
                { label: 'l'.repeat(400), correct: true },
                { label: 'b', correct: false },
                { label: 'c', correct: false },
            ],
        })],
    }, ALLOWED);
    assert.equal(items[0].question.length, 300);
    assert.equal(items[0].explanation.length, 400);
    assert.equal(items[0].choices[0].label.length, 200);
});

test('unknown lessonId pins to the first requested lesson; item cap holds', () => {
    const many = Array.from({ length: 9 }, () => goodItem({ lessonId: 'not-a-lesson' }));
    const items = validatePracticeItems({ items: many }, ALLOWED);
    assert.equal(items.length, MAX_ITEMS);
    assert.ok(items.every((i) => i.lessonId === 'prompt-basics'));
});

test('a 4-choice item mints a–d; a 5th choice is dropped by the slice', () => {
    const items = validatePracticeItems({
        items: [goodItem({
            choices: [
                { label: 'one', correct: false },
                { label: 'two', correct: true },
                { label: 'three', correct: false },
                { label: 'four', correct: false },
                { label: 'five', correct: false },
            ],
        })],
    }, ALLOWED);
    assert.deepEqual(items[0].choices.map((c) => c.id), ['a', 'b', 'c', 'd']);
});

test('garbage input yields null, never throws', () => {
    for (const input of [null, undefined, {}, { items: 'x' }, { items: [] }, { items: [null, 42] }]) {
        assert.equal(validatePracticeItems(input, ALLOWED), null);
    }
});

test('publicPracticeItem strips the answer key and the explanation', () => {
    const [item] = validatePracticeItems({ items: [goodItem()] }, ALLOWED);
    const pub = publicPracticeItem(item, 'p1');
    assert.equal(pub.id, 'p1');
    assert.ok(pub.choices.every((c) => !('correct' in c)));
    assert.ok(!('explanation' in pub));
});

test('the forced-tool schema stays a single-tool, strict-object contract', () => {
    assert.equal(PRACTICE_TOOL.type, 'function');
    assert.equal(PRACTICE_TOOL.function.parameters.additionalProperties, false);
    assert.deepEqual(PRACTICE_TOOL.function.parameters.required, ['items']);
});

test('every practice topic maps to a real catalog lesson', () => {
    const known = new Set(LESSON_IDS);
    for (const id of PRACTICE_LESSON_IDS) {
        assert.ok(known.has(id), `practice topic '${id}' is not in LESSON_IDS`);
    }
});
