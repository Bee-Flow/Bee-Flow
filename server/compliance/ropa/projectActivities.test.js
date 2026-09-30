'use strict';

/**
 * Projects in the processing register: only the ones with a recorded lawful
 * basis or retention, only this organisation's, categories from signals.
 *
 * Run: cd server && node --test compliance/ropa/projectActivities.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { projectActivities, kindLabels } = require('./projectActivities');

function deps({ registrations, rows, signals, throws = {} } = {}) {
    return {
        complianceStore: {
            listSubjectRegistrations: async () => { if (throws.store) throw new Error('down'); return registrations; },
        },
        query: async (_sql, params) => { if (throws.query) throw new Error('down'); return rows.filter(r => params[1].includes(r.id)); },
        signals: { signalsFor: async () => ({ byProject: new Map(Object.entries(signals || {})), unreadable: [] }) },
    };
}

test('a recorded project is an activity with its name, basis, retention and signalled categories', async () => {
    const out = await projectActivities('org1', deps({
        registrations: [
            { subject_id: 'p1', purpose: 'Client casework', lawful_basis: 'contract', retention_days: 730 },
            { subject_id: 'p2', purpose: null, lawful_basis: null, retention_days: null },
            { subject_id: 'p3', lawful_basis: 'consent' },
        ],
        rows: [{ id: 'p1', name: 'Casework' }],
        signals: { p1: { kinds: ['health', 'name'] } },
    }));
    assert.deepStrictEqual(out.map(a => a.activity_id), ['project:p1'], 'p2 records nothing; p3 is not a project of this org');
    const [a] = out;
    assert.strictEqual(a.name, 'Casework');
    assert.strictEqual(a.legal_basis, 'contract');
    assert.match(a.retention, /^730 days/);
    assert.deepStrictEqual(a.data_categories, ['Health data', 'Names']);
    assert.deepStrictEqual(a.source, { kind: 'project', id: 'p1' });
});

test('an unreadable store makes the register shorter, never wrong; unreadable names fall back to ids', async () => {
    assert.deepStrictEqual(await projectActivities('org1', deps({ throws: { store: true } })), []);
    const out = await projectActivities('org1', deps({ registrations: [{ subject_id: 'abcdefghijk', lawful_basis: 'contract' }], rows: [], throws: { query: true } }));
    assert.strictEqual(out[0].name, 'project:abcdefgh');
    assert.deepStrictEqual(await projectActivities('', deps()), []);
    assert.deepStrictEqual(kindLabels(['personal', 'x']), ['Personal data (kind not determined)', 'x']);
});

test('when every registered project was deleted, the register lists none of them', async () => {
    const out = await projectActivities('org1', deps({
        registrations: [
            { subject_id: '1a2b3c4d-gone', lawful_basis: 'contract', retention_days: 365 },
            { subject_id: '5e6f7a8b-gone', lawful_basis: 'consent' },
        ],
        rows: [],
    }));
    assert.deepStrictEqual(out, [], 'a lookup that answered "none of these exist" is not a lookup that failed');
});
