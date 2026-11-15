// @typecheck
/**
 * Nextcloud Forms tools.
 *
 * The submission mapper is the load-bearing part: the API returns answers
 * keyed by numeric question id, which is unusable in an automation binding. If the
 * join against the form's questions is wrong, `{{trigger.output.answers.X}}`
 * silently resolves to undefined and the automation posts a blank field.
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

test('answers are keyed by question text so an automation can bind them', () => {
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

test('a file question keeps the fileId and name of every uploaded file (G-03)', () => {
    // Forms stores one answer row per uploaded file: `text` is the file name,
    // `fileId` the Nextcloud file id (Forms' Answer::read()).
    const questions = [...QUESTIONS, { id: 4, text: 'Receipts', type: 'file' }];
    const sub = mapSubmission({
        id: 226,
        answers: [
            { id: 900, submissionId: 226, questionId: 1, fileId: null, text: 'Sales' },
            { id: 901, submissionId: 226, questionId: 4, fileId: 5521, text: 'receipt-taxi.pdf' },
            { id: 902, submissionId: 226, questionId: 4, fileId: 5522, text: 'receipt-hotel.jpg' },
        ],
    }, questions);
    assert.deepEqual(sub.files, {
        Receipts: [{ fileId: 5521, name: 'receipt-taxi.pdf' }, { fileId: 5522, name: 'receipt-hotel.jpg' }],
    });
    assert.deepEqual(sub.filesByQuestionId, {
        4: [{ fileId: 5521, name: 'receipt-taxi.pdf' }, { fileId: 5522, name: 'receipt-hotel.jpg' }],
    });
    // `answers` is unchanged: existing automations keep binding the names.
    assert.deepEqual(sub.answers, { Department: 'Sales', Receipts: ['receipt-taxi.pdf', 'receipt-hotel.jpg'] });
});

test('one uploaded file is still a list, and a form without file questions has empty file maps', () => {
    const questions = [...QUESTIONS, { id: 4, text: 'Receipts', type: 'file' }];
    const one = mapSubmission({ id: 227, answers: [{ questionId: 4, fileId: 77, text: 'a.pdf' }] }, questions);
    assert.deepEqual(one.files, { Receipts: [{ fileId: 77, name: 'a.pdf' }] });
    const none = mapSubmission({ id: 228, answers: [{ questionId: 1, text: 'Sales' }] }, QUESTIONS);
    assert.deepEqual(none.files, {});
    assert.deepEqual(none.filesByQuestionId, {});
});
