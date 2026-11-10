/**
 * validateDataModel and read-time computed fields: an expression the read
 * guard refuses still saves (it always did) and gets a warning saying it reads
 * empty; an accepted one, or a stored one, adds nothing.
 *
 * Run: cd server && node --test appStudio/dataModel/modelValidate.readTime.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateDataModel } = require('./modelValidate');

const modelWith = (computed) => ({
    modelVersion: 1,
    tables: [{
        id: 'tbl_aaaa01',
        key: 'lines',
        fields: [
            { id: 'fld_aaaa01', key: 'qty', type: 'number' },
            { id: 'fld_aaaa02', key: 'calc', type: 'computed', computed },
        ],
    }],
});

test('an accepted read-time expression and a stored one add no finding', () => {
    assert.deepEqual(validateDataModel(modelWith({ expr: 'qty * 2' })), { errors: [], warnings: [] });
    assert.deepEqual(validateDataModel(modelWith({ expr: 'iif(qty > 1, 1, 0)', stored: true })), { errors: [], warnings: [] });
});

test('a refused read-time expression is a warning, never an error', () => {
    const out = validateDataModel(modelWith({ expr: 'iif(qty > 1, 1, 0)' }));
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.warnings, ['tables[0].fields[1] (read-time computed) reads empty: function iif() is not available on both database engines']);
    assert.match(validateDataModel(modelWith({ expr: 'missing + 1' })).warnings[0], /"missing" is not a column of this table/);
});

test('an expression the save guard refuses stays an error, without a second finding', () => {
    const out = validateDataModel(modelWith({ expr: 'qty; DROP TABLE lines' }));
    assert.equal(out.errors.length, 1);
    assert.deepEqual(out.warnings, []);
});
