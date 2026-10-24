// @typecheck
/**
 * Reopening a conversation restores its Privacy Shield tokens for display.
 * An org that encrypts its token maps stores `pii_token_map` as an envelope
 * ({ _bfenc, alg, iv, tag, ct }); that envelope was once handed to the restore
 * as if it were the map, and every "ct", "iv" or "tag" inside a word turned
 * into hex ("produ" + the ciphertext). Pinned here: only `[bracketed]` keys
 * restore, an envelope restores nothing, and the display read takes the map
 * from the registered reader (dlpRunner's, which decrypts it), never the raw column.
 *
 * Run: cd server && node --test stores/agent/tokenDisplay.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { _restoreTokensInMessages, _displayTokenMap, setTokenMapReader } = require('./tokenDisplay');

const hydrated = [];
setTokenMapReader(async (id) => { hydrated.push(id); return { '[person_1]': 'Sem', '[product_2]': 'Webcam HD' }; });

const ENVELOPE = { _bfenc: 1, alg: 'A256GCM', iv: '4fe188977430f0022f8a1155', tag: '08a56048f0ba4f8224e3d5fcc229dc2d', ct: 'deadbeefcafe' };
const reply = { role: 'assistant', content: 'Het product van [person_1] is een pivot-functie met een tag.' };

test('an envelope passed as the map changes no word', () => {
    const [out] = _restoreTokensInMessages([reply], ENVELOPE);
    assert.strictEqual(out.content, reply.content);
});

test('only bracketed keys restore; a stray key is ignored', () => {
    const [out] = _restoreTokensInMessages([reply], { ct: 'HEX', iv: 'HEX', '[person_1]': 'Sem' });
    assert.strictEqual(out.content, 'Het product van Sem is een pivot-functie met een tag.');
});

test('a user message restores from its own map, filtered the same way', () => {
    const [out] = _restoreTokensInMessages([{ role: 'user', content: 'Ik ben [person_1], product?', tokenMap: { '[person_1]': 'Sem', ct: 'HEX' } }], null);
    assert.strictEqual(out.content, 'Ik ben Sem, product?');
});

test('the display map comes decrypted from dlpRunner, never from the raw column', async () => {
    hydrated.length = 0;
    const map = await _displayTokenMap({ id: 'c1', pii_token_map: ENVELOPE });
    assert.deepStrictEqual(hydrated, ['c1']);
    const [out] = _restoreTokensInMessages([{ role: 'assistant', content: 'Een [product_2] voor [person_1].' }], map);
    assert.strictEqual(out.content, 'Een Webcam HD voor Sem.');
    assert.strictEqual(await _displayTokenMap({ id: 'c2', pii_token_map: null }), null);
    assert.deepStrictEqual(hydrated, ['c1'], 'no map stored: nothing to read');
});

