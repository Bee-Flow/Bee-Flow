/**
 * Special categories (GDPR Art. 9) in the monitoring views: which labels count,
 * and what a row that carries a person keeps.
 *
 * Run: cd server && node --test core/privacy/specialCategories.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    isSpecialCategory, hasSpecialCategory, withoutSpecialCategories, withholdSpecialCategories, dropSpecialCategoryRows,
} = require('./specialCategories');

test('the health categories count in every spelling a producer has used', () => {
    for (const c of ['MedicalCondition', 'Medical Condition', 'medication', 'HealthInsuranceNumber', 'Health Insurance Number']) {
        assert.strictEqual(isSpecialCategory(c), true, c);
    }
    for (const c of ['Person', 'Email', 'scan_timeout', '', null, undefined]) {
        assert.strictEqual(isSpecialCategory(c), false, String(c));
    }
});

test('a list loses only its special categories; a list without one comes back as it was', () => {
    assert.strictEqual(hasSpecialCategory('Person, MedicalCondition'), true);
    assert.strictEqual(withoutSpecialCategories('Person, MedicalCondition,Email'), 'Person,Email');
    assert.strictEqual(withoutSpecialCategories('Medication'), null);
    assert.strictEqual(withoutSpecialCategories('Person Name, Person Name'), 'Person Name, Person Name');
    assert.strictEqual(withoutSpecialCategories(null), null);
});

test('rows with a person: health labels go, an all-health row is withheld, the input is not changed', () => {
    const rows = [
        { id: 3, c: 'Person, MedicalCondition' },
        { id: 2, c: 'Medication' },
        { id: 1, c: null },
    ];
    const out = withholdSpecialCategories(rows, 'c');
    assert.deepStrictEqual(out, [{ id: 3, c: 'Person' }, { id: 1, c: null }]);
    assert.strictEqual(rows[0].c, 'Person, MedicalCondition');
    assert.deepStrictEqual(withholdSpecialCategories(null, 'c'), []);
});

test('a category breakdown drops the special-category rows', () => {
    assert.deepStrictEqual(
        dropSpecialCategoryRows([{ category: 'MedicalCondition' }, { category: 'Email' }]),
        [{ category: 'Email' }],
    );
    assert.deepStrictEqual(dropSpecialCategoryRows([{ key: 'Medication' }, { key: 'Person' }], 'key'), [{ key: 'Person' }]);
});
