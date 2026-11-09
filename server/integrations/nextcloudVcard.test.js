const { test } = require('node:test');
const assert = require('node:assert');

const { buildVCard, parseVCard } = require('./nextcloudVcard');

test('a backslash followed by "n" survives the vCard round trip (it is not a line break)', () => {
    const notes = 'see C:\\new\\table, then\nnext line; done';
    const back = parseVCard(buildVCard({ uid: 'u1', fullName: 'Ann, B; C', firstName: 'Ann', lastName: 'O\\neil', notes }));
    assert.strictEqual(back.notes, notes);
    assert.strictEqual(back.fullName, 'Ann, B; C');
    assert.strictEqual(back.lastName, 'O\\neil');
});

test('escaped separators and line breaks still decode', () => {
    const back = parseVCard('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A\\, B\r\nN:Last\\;x;First;;;\r\nNOTE:one\\Ntwo\\nthree\r\nEND:VCARD\r\n');
    assert.strictEqual(back.fullName, 'A, B');
    assert.strictEqual(back.lastName, 'Last;x');
    assert.strictEqual(back.firstName, 'First');
    assert.strictEqual(back.notes, 'one\ntwo\nthree');
});
