/**
 * Row identity: a plain key is used verbatim, anything else is hashed, row
 * numbers become `r<n>`, blank rows and duplicates never get an id.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const identity = require('./identity');

test('a plain key is the id itself; case matters; whitespace is normalised', () => {
    assert.equal(identity.rowIdFromKey('F-2026-001'), 'F-2026-001');
    assert.equal(identity.rowIdFromKey('  F-2026-001 '), 'F-2026-001');
    assert.equal(identity.rowIdFromKey('abc'), 'abc');
    assert.equal(identity.rowIdFromKey('ABC'), 'ABC');
    assert.notEqual(identity.rowIdFromKey('abc'), identity.rowIdFromKey('ABC'));
    assert.equal(identity.rowIdFromKey('a.b:c_d-e'), 'a.b:c_d-e');
    assert.equal(identity.rowIdFromKey(42), '42');
    assert.equal(identity.rowIdFromKey(1.5), '1.5');
    assert.equal(identity.rowIdFromKey(true), 'true');
    assert.equal(identity.rowIdFromKey(new Date(Date.UTC(2026, 0, 15))), '2026-01-15');
});

test('a key outside the verbatim charset becomes k_ + sha256[0:32], deterministically', () => {
    const expected = (s) => `k_${crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32)}`;
    assert.equal(identity.rowIdFromKey('Jan de Vries'), expected('Jan de Vries'));
    assert.equal(identity.rowIdFromKey('Jan   de\tVries'), expected('Jan de Vries'));      // collapsed whitespace
    assert.equal(identity.rowIdFromKey('F/2026/001'), expected('F/2026/001'));
    assert.equal(identity.rowIdFromKey('-starts-with-dash'), expected('-starts-with-dash'));
    assert.equal(identity.rowIdFromKey('Zürich'), expected('Zürich'));
    assert.equal(identity.rowIdFromKey('x'.repeat(61)), expected('x'.repeat(61)));
    assert.equal(identity.rowIdFromKey('x'.repeat(60)), 'x'.repeat(60));
    assert.match(identity.rowIdFromKey('Jan de Vries'), /^k_[0-9a-f]{32}$/);
    assert.ok(identity.rowIdFromKey('Jan de Vries').length <= 64);
});

test('a blank key gives no id', () => {
    assert.equal(identity.rowIdFromKey(''), null);
    assert.equal(identity.rowIdFromKey('   '), null);
    assert.equal(identity.rowIdFromKey(null), null);
    assert.equal(identity.rowIdFromKey(undefined), null);
    assert.equal(identity.rowIdFromKey(NaN), null);
});

test('row-number ids are r<n> and read back', () => {
    assert.equal(identity.rowIdFromNumber(2), 'r2');
    assert.equal(identity.rowIdFromNumber(10001), 'r10001');
    assert.equal(identity.rowNumberOf('r12'), 12);
    assert.equal(identity.rowNumberOf('12'), null);
    assert.equal(identity.rowNumberOf('k_abc'), null);
    assert.throws(() => identity.rowIdFromNumber(0));
    assert.throws(() => identity.rowIdFromNumber('x'));
});

test('identityOf falls back to row mode for anything but a key column', () => {
    assert.deepEqual(identity.identityOf({ identity: { mode: 'key', keyFieldId: 'fld_ss1234567890txt' } }), { mode: 'key', keyFieldId: 'fld_ss1234567890txt' });
    assert.deepEqual(identity.identityOf({ identity: { mode: 'key' } }), { mode: 'row' });
    assert.deepEqual(identity.identityOf({ identity: { mode: 'row' } }), { mode: 'row' });
    assert.deepEqual(identity.identityOf({}), { mode: 'row' });
    assert.deepEqual(identity.identityOf(null), { mode: 'row' });
});

test('assignRowIds in key mode: first wins, duplicates and missing keys are counted, blank rows skipped', () => {
    const rows = [
        ['F-1', 'a'],
        ['F-2', 'b'],
        ['', 'no key'],
        ['F-1', 'dup'],
        [null, null],
        [' F-3 ', 'c'],
    ];
    const r = identity.assignRowIds(rows, [2, 3, 4, 5, 6, 7], { mode: 'key', keyCol: 0 });
    assert.deepEqual(r.ids, ['F-1', 'F-2', null, null, null, 'F-3']);
    assert.equal(r.missing, 1);
    assert.equal(r.duplicate, 1);
    assert.equal(r.blank, 1);
});

test('assignRowIds in row mode numbers by sheet row and never mints an id for a blank row', () => {
    const rows = [['a'], [null], ['b']];
    const r = identity.assignRowIds(rows, [2, 3, 7], { mode: 'row' });
    assert.deepEqual(r.ids, ['r2', null, 'r7']);
    assert.equal(r.blank, 1);
    assert.equal(r.missing, 0);
});

test('checkKeyColumn reports whether a column can be the key and names the first duplicate', () => {
    assert.deepEqual(identity.checkKeyColumn([['a'], ['b'], ['c']], 0), { unique: true, missing: 0, duplicate: 0, firstDuplicate: null });
    assert.deepEqual(identity.checkKeyColumn([['a'], ['b'], ['a '], [null]], 0), { unique: false, missing: 0, duplicate: 1, firstDuplicate: 'a' });
    assert.deepEqual(identity.checkKeyColumn([['a', 1], ['', 2]], 0), { unique: false, missing: 1, duplicate: 0, firstDuplicate: null });
});

test('a NUMBER key is one id for every spelling of one number — the read side ("7,5" from a csv) and the write side (7.5) agree', () => {
    assert.equal(identity.rowIdFromKey('7,5', 'number'), '7.5');
    assert.equal(identity.rowIdFromKey(7.5, 'number'), '7.5');
    assert.equal(identity.rowIdFromKey('7.50', 'number'), '7.5');
    assert.equal(identity.rowIdFromKey('7.5', 'number'), '7.5');
    assert.equal(identity.rowIdFromKey('1.000', 'number'), '1000');
    assert.equal(identity.rowIdFromKey('1,000', 'number'), '1000');
    assert.equal(identity.rowIdFromKey(' 42 ', 'number'), '42');
    assert.equal(identity.rowIdFromKey('€ 12,50', 'number'), '12.5');
    assert.equal(identity.rowIdFromKey('-3', 'number'), identity.rowIdFromKey(-3, 'number'));
    // not a number in a number key column: the key is missing (the row is skipped), never a text id
    assert.equal(identity.rowIdFromKey('abc', 'number'), null);
    assert.equal(identity.rowIdFromKey('0123', 'number'), null);
    assert.equal(identity.rowIdFromKey(true, 'number'), null);
    assert.equal(identity.rowIdFromKey('', 'number'), null);
    // a text key is the text, as before — '7,5' and '7.5' are two rows there
    assert.notEqual(identity.rowIdFromKey('7,5'), identity.rowIdFromKey('7.5'));
    assert.equal(identity.rowIdFromKey('7,5', 'text'), identity.rowIdFromKey('7,5'));
    const ids = identity.assignRowIds([['7,5', 'a'], ['7.50', 'b'], ['1.000', 'c'], ['abc', 'd']], [2, 3, 4, 5], { mode: 'key', keyCol: 0, keyType: 'number' });
    assert.deepEqual(ids, { ids: ['7.5', null, '1000', null], missing: 1, duplicate: 1, blank: 0 });
    const check = identity.checkKeyColumn([['7,5'], ['7.50'], ['8']], 0, 'number');
    assert.deepEqual(check, { unique: false, missing: 0, duplicate: 1, firstDuplicate: '7.5' });
    assert.equal(identity.checkKeyColumn([['7,5'], ['7.50'], ['8']], 0).unique, true, 'as text they differ');
});
