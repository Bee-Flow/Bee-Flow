/**
 * The Privacy Shield token map is the reverse dictionary: [email_1] -> the real
 * address. It is exactly the PII that was stripped from the message, and it was
 * stored in plaintext JSONB on the same row as the conversation.
 *
 * The trap this file guards: pii_token_map is JSONB and the hydration path
 * branches on `typeof stored === 'object'`. If the encrypted form were a bare
 * string it would fall through that check with no error and no log, and every
 * placeholder in the stored conversation would become permanently unresolvable.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { encryptField, decryptField, isEnvelope } = require('../../../stores/lib/fieldEnvelope');

const KEY = crypto.createHash('sha256').update('token-map-test-key').digest();
const CONV = 'conv-abc';
const AAD = `bfpii:v1:${CONV}`;

const TOKEN_MAP = {
    '[email_1]': 'jan.dekker@voorbeeld.nl',
    '[person_1]': 'Jan Dekker',
    '[phone_1]': '+31 6 12345678',
    '[iban_1]': 'NL91ABNA0417164300',
};

/**
 * Mirrors _writeMapToDb exactly: build the JSON payload, optionally wrap it in
 * an object envelope, stringify, and hand it to a `$1::jsonb` parameter — which
 * node-postgres reads back as a parsed object.
 */
function storeAsJsonb(mapObj, { encrypt }) {
    let payload = JSON.stringify(mapObj);
    if (encrypt) {
        payload = JSON.stringify(encryptField(payload, { key: KEY, aad: AAD, encrypt: true, asObject: true }));
    }
    return JSON.parse(payload);   // the ::jsonb round-trip
}

/** Mirrors the hydration branch in _hydrateFromDb. */
function hydrate(stored, key) {
    if (isEnvelope(stored)) {
        const plain = decryptField(stored, { key, aad: AAD });
        return JSON.parse(plain);
    }
    return stored;
}

test('the encrypted map is still a JSON object, not a bare string', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: true });
    assert.strictEqual(
        typeof stored, 'object',
        'hydration branches on typeof === "object"; a string here silently drops every token'
    );
    assert.ok(!Array.isArray(stored));
});

test('real PII is not readable in the stored value', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: true });
    const raw = JSON.stringify(stored);
    for (const secret of ['jan.dekker@voorbeeld.nl', 'Jan Dekker', 'NL91ABNA0417164300', '12345678']) {
        assert.ok(!raw.includes(secret), `"${secret}" must not survive in the stored map`);
    }
});

test('encrypted map round-trips to the exact original', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: true });
    assert.deepStrictEqual(hydrate(stored, KEY), TOKEN_MAP);
});

test('a plaintext map written before encryption was enabled still hydrates', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: false });
    assert.ok(!isEnvelope(stored));
    assert.deepStrictEqual(hydrate(stored, KEY), TOKEN_MAP);
});

test('an encrypted map still hydrates after encryption is switched off', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: true });
    // Policy now says off, but the value is an envelope, so the read still opens it.
    assert.deepStrictEqual(hydrate(stored, KEY), TOKEN_MAP);
});

test('a wrong key throws rather than silently yielding no tokens', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: true });
    const wrong = crypto.createHash('sha256').update('not-the-key').digest();
    assert.throws(
        () => hydrate(stored, wrong),
        /decrypt/i,
        'silently returning nothing would look like "no tokens to restore" instead of a failure'
    );
});

test('an empty map round-trips', () => {
    const stored = storeAsJsonb({}, { encrypt: true });
    assert.deepStrictEqual(hydrate(stored, KEY), {});
});

test('tokens are bound to their conversation', () => {
    const stored = storeAsJsonb(TOKEN_MAP, { encrypt: true });
    assert.throws(
        () => JSON.parse(decryptField(stored, { key: KEY, aad: 'bfpii:v1:conv-other' })),
        /decrypt/i,
        'a token map must not be replayable into another conversation'
    );
});
