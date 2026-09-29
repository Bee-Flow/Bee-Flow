'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: { parseTerms, sanitizeFileName, aiMarks } } = require('./redactStep');

const app = { id: 'app1', userId: 'u1', organizationId: 'o1' };
const runs = [
    { ref: 'p1-3', page: 1, id: 3, text: 'JDO', position: 'bottom-right' },
    { ref: 'p1-4', page: 1, id: 4, text: '45°', position: 'middle-left' },
    { ref: 'p1-5', page: 1, id: 5, text: '14-07-2026', position: 'bottom-right' },
    { ref: 'p1-6', page: 1, id: 6, text: 'Contact: Jan de Vries', position: 'middle-left' },
];
const fakeRuntime = (remove, calls = []) => ({
    resolveOwnerModel: async (a, tier) => { calls.push(tier); return { modelId: 'm' }; },
    runStructured: async (a, m, opts) => { calls.push(opts); return { structured: { remove } }; },
});

test('terms come from a comma, semicolon or newline list and drop fragments', () => {
    assert.deepEqual(parseTerms('Acme Metal; acme-metal.com\nAM, x'), ['Acme Metal', 'acme-metal.com']);
    assert.deepEqual(parseTerms(['Acme BV', '', null]), ['Acme BV']);
    assert.deepEqual(parseTerms(undefined), []);
});

test('file names lose path and header characters and the .pdf they get back', () => {
    assert.equal(sanitizeFileName('../E0123 "x".pdf', 'f'), '..E0123 x');
    assert.equal(sanitizeFileName('', 'document-clean'), 'document-clean');
});

test('the AI pass asks the fast tier and maps refs back to page objects', async () => {
    const calls = [];
    const { marks, warning } = await aiMarks(app, runs, ['Acme'], fakeRuntime([
        { ref: 'p1-3', category: 'person' },
        { ref: 'p1-6', category: 'person' },
        { ref: 'p9-99', category: 'person' }, // not a run: ignored
    ], calls));
    assert.equal(warning, undefined);
    assert.equal(calls[0], 'fast');
    assert.match(calls[1].user, /also known as: Acme/);
    assert.deepEqual(marks, [{ page: 1, id: 3, category: 'person' }, { page: 1, id: 6, category: 'person' }]);
});

test('the AI can never take a dimension or a date off the page', async () => {
    const { marks } = await aiMarks(app, runs, [], fakeRuntime([
        { ref: 'p1-4', category: 'company' },
        { ref: 'p1-5', category: 'person' },
    ]));
    assert.deepEqual(marks, []);
});

test('no model or a failing model degrades to the rules, with a warning', async () => {
    const noModel = { resolveOwnerModel: async () => { throw Object.assign(new Error('none'), { status: 400 }); } };
    assert.match((await aiMarks(app, runs, [], noModel)).warning, /no AI model/);
    const broken = { resolveOwnerModel: async () => ({}), runStructured: async () => { throw new Error('timeout'); } };
    assert.match((await aiMarks(app, runs, [], broken)).warning, /only the built-in rules/);
});
