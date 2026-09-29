/**
 * Nextcloud Forms tools.
 *
 * The submission mapper is the load-bearing part: the API returns answers
 * keyed by numeric question id, which is unusable in a routine binding. If the
 * join against the form's questions is wrong, `{{trigger.output.answers.X}}`
 * silently resolves to undefined and the routine posts a blank field.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    NEXTCLOUD_FORMS_TOOLS,
    isNextcloudFormsTool,
    mapSubmission,
} = require('./nextcloudFormsTools');

const QUESTIONS = [
    { id: 1, text: 'Department' },
    { id: 2, text: 'How many days?' },
    { id: 3, text: 'Which perks do you want?' },
];

test('the prefix test matches this module and nothing broader', () => {
    assert.equal(isNextcloudFormsTool('nextcloud_forms_get_submissions'), true);
    assert.equal(isNextcloudFormsTool('nextcloud_folder_tree'), false);
    assert.equal(isNextcloudFormsTool(null), false);
});

test('every tool declares a name, description and parameters object', () => {
    for (const t of NEXTCLOUD_FORMS_TOOLS) {
        assert.equal(t.type, 'function');
        assert.match(t.function.name, /^nextcloud_forms_/);
        assert.ok(t.function.description.length > 20, `${t.function.name} needs a real description`);
        assert.equal(t.function.parameters.type, 'object');
    }
});

test('answers are keyed by question text so a routine can bind them', () => {
    const sub = mapSubmission({
        id: 220,
        formId: 51,
        userId: 'bob',
        timestamp: 1700001234,
        answers: [
            { questionId: 1, text: 'Engineering' },
            { questionId: 2, text: '5' },
        ],
    }, QUESTIONS);
    assert.equal(sub.id, 220);
    assert.equal(sub.userId, 'bob');
    assert.equal(sub.submittedAt, new Date(1700001234 * 1000).toISOString());
    assert.deepEqual(sub.answers, { Department: 'Engineering', 'How many days?': '5' });
});

test('a multi-select question collects every selected option', () => {
    // Forms emits one answer row per selected option; collapsing them to the
    // last one would quietly lose the rest.
    const sub = mapSubmission({
        id: 221,
        answers: [
            { questionId: 3, text: 'Bike' },
            { questionId: 3, text: 'Gym' },
            { questionId: 3, text: 'Lunch' },
        ],
    }, QUESTIONS);
    assert.deepEqual(sub.answers['Which perks do you want?'], ['Bike', 'Gym', 'Lunch']);
});

test('the id-keyed form is kept alongside, for forms with duplicate question text', () => {
    const sub = mapSubmission({
        id: 222,
        answers: [{ questionId: 1, text: 'Engineering' }],
    }, QUESTIONS);
    assert.deepEqual(sub.answersByQuestionId, { 1: 'Engineering' });
});

test('an answer to a deleted question does not collide with a real one', () => {
    const sub = mapSubmission({
        id: 223,
        answers: [
            { questionId: 1, text: 'Engineering' },
            { questionId: 99, text: 'orphaned' },
        ],
    }, QUESTIONS);
    assert.deepEqual(sub.answers, { Department: 'Engineering' });
    assert.equal(sub.answersByQuestionId['99'], 'orphaned', 'still recoverable by id');
});

test('an unanswered question is absent rather than null', () => {
    // So Object.keys(answers) means "what they actually filled in".
    const sub = mapSubmission({ id: 224, answers: [{ questionId: 1, text: 'Sales' }] }, QUESTIONS);
    assert.deepEqual(Object.keys(sub.answers), ['Department']);
});

test('a submission with no answers array does not throw', () => {
    const sub = mapSubmission({ id: 225 }, QUESTIONS);
    assert.deepEqual(sub.answers, {});
    assert.equal(sub.submittedAt, null);
});
