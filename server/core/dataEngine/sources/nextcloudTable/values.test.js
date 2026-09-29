/**
 * Cell conversion both ways, pinned to the shapes Tables 2.3.0 parses — a
 * value in the wrong shape is not refused by Nextcloud, it is silently blanked,
 * so the WRITE side is the one that has to be exact.
 */
const test = require('node:test');
const assert = require('node:assert');
const { cellToLocal, localToWire } = require('./values');

const OPTS = [{ id: 0, label: 'open' }, { id: 1, label: 'betaald' }];
const sel = { ncType: 'selection', ncSubtype: '', options: OPTS, title: 'Status' };
const multi = { ncType: 'selection', ncSubtype: 'selection-multi', options: OPTS, title: 'Tags' };
const check = { ncType: 'selection', ncSubtype: 'check', title: 'Akkoord' };
const dt = { ncType: 'datetime', ncSubtype: '', title: 'Moment' };
const date = { ncType: 'datetime', ncSubtype: 'date', title: 'Datum' };
const num = { ncType: 'number', ncSubtype: '', title: 'Totaal' };
const txt = { ncType: 'text', ncSubtype: 'line', title: 'Naam' };
const rel = { ncType: 'relation', title: 'Leverancier' };

test('reads: every Nextcloud shape lands as the mirror type', () => {
    assert.equal(cellToLocal('Acme', txt, { type: 'text' }), 'Acme');
    assert.equal(cellToLocal(12.5, num, { type: 'number' }), 12.5);
    assert.equal(cellToLocal('12.5', num, { type: 'number' }), 12.5);
    assert.equal(cellToLocal('abc', num, { type: 'number' }), null);
    assert.equal(cellToLocal('2026-09-12', date, { type: 'date' }), '2026-09-12');
    assert.equal(cellToLocal('2026-09-12 10:30', dt, { type: 'datetime' }), '2026-09-12T10:30:00.000Z');
    assert.equal(cellToLocal('2026-09-12 10:30:15', dt, { type: 'datetime' }), '2026-09-12T10:30:15.000Z');
    assert.equal(cellToLocal('1', sel, { type: 'select' }), 'betaald');
    assert.equal(cellToLocal(1, sel, { type: 'select' }), 'betaald');
    assert.equal(cellToLocal('9', sel, { type: 'select' }), '9');           // unknown id → shown as-is
    assert.deepEqual(cellToLocal('[0,1]', multi, { type: 'multiselect' }), ['open', 'betaald']);
    assert.deepEqual(cellToLocal([1], multi, { type: 'multiselect' }), ['betaald']);
    assert.equal(cellToLocal('true', check, { type: 'bool' }), true);
    assert.equal(cellToLocal('false', check, { type: 'bool' }), false);
    assert.equal(cellToLocal(7, rel, { type: 'relation' }), '7');
    assert.equal(cellToLocal(0, rel, { type: 'relation' }), null);
    assert.equal(cellToLocal(7, rel, { type: 'number' }), 7);
    assert.equal(cellToLocal([{ id: 'alice', type: 0 }], { ncType: 'usergroup' }, { type: 'text' }), '[{"id":"alice","type":0}]');
    assert.equal(cellToLocal(null, txt, { type: 'text' }), null);
    assert.equal(cellToLocal('', num, { type: 'number' }), null);
});

test('writes: the exact shapes Tables keeps', () => {
    assert.equal(localToWire('Acme', txt, { type: 'text' }), 'Acme');
    assert.equal(localToWire('12.5', num, { type: 'number' }), 12.5);
    assert.equal(localToWire('2026-09-12', date, { type: 'date' }), '2026-09-12');
    assert.equal(localToWire('2026-09-12T10:30:00.000Z', date, { type: 'date' }), '2026-09-12');
    assert.equal(localToWire('2026-09-12T10:30:00.000Z', dt, { type: 'datetime' }), '2026-09-12 10:30');
    assert.equal(localToWire('betaald', sel, { type: 'select' }), 1);
    assert.equal(localToWire(1, sel, { type: 'select' }), 1);                 // a numeric id is accepted too
    assert.deepEqual(localToWire(['open', 'betaald'], multi, { type: 'multiselect' }), [0, 1]);
    assert.deepEqual(localToWire('open, betaald', multi, { type: 'multiselect' }), [0, 1]);
    assert.equal(localToWire(true, check, { type: 'bool' }), true);
    assert.equal(localToWire('yes', check, { type: 'bool' }), true);
    assert.equal(localToWire(null, check, { type: 'bool' }), false);
    assert.deepEqual(localToWire(null, multi, { type: 'multiselect' }), []);
    assert.equal(localToWire(null, txt, { type: 'text' }), null);
    assert.equal(localToWire('7', rel, { type: 'relation' }), 7);
    assert.deepEqual(localToWire('[{"id":"alice","type":0}]', { ncType: 'usergroup' }, { type: 'text' }), [{ id: 'alice', type: 0 }]);
});

test('writes: what Nextcloud would blank is refused here as a 422 with the column named', () => {
    for (const [v, e, f] of [
        ['nope', sel, { type: 'select' }],
        [['nope'], multi, { type: 'multiselect' }],
        ['abc', num, { type: 'number' }],
        ['not a date', date, { type: 'date' }],
        ['not a date', dt, { type: 'datetime' }],
        ['x', rel, { type: 'relation' }],
    ]) {
        assert.throws(() => localToWire(v, e, f), (err) => err.status === 422 && err.code === 'nextcloud_rejected' && err.safe === true && new RegExp(e.title).test(err.message));
    }
});
