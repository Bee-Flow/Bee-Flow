'use strict';
/** shieldTitleContext: the title model gets the conversation's tokens. Run: node --test core/dlp/titleShield.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { shieldTitleContext } = require('./titleShield.mts');

const MAP = { '[person_1]': 'Jan Dekker', '[email_1]': 'jan@voorbeeld.nl' };

test('real values are replaced by their tokens; the title is shown with them restored', async () => {
    const s = await shieldTitleContext('conv-1', 'Mail Jan Dekker at jan@voorbeeld.nl', { tokenMapFor: async () => MAP });
    assert.equal(s.text, 'Mail [person_1] at [email_1]');
    assert.equal(s.restore('Mail to [person_1]'), 'Mail to Jan Dekker');
});

test('no map, no conversation: unchanged', async () => {
    assert.equal((await shieldTitleContext('conv-1', 'hello', { tokenMapFor: async () => ({}) })).text, 'hello');
    assert.equal((await shieldTitleContext(null, 'hello')).text, 'hello');
});

test('a token map that cannot be read throws, so no raw text is sent', async () => {
    await assert.rejects(() => shieldTitleContext('conv-1', 'Jan Dekker', { tokenMapFor: async () => { throw new Error('db down'); } }), /db down/);
});
