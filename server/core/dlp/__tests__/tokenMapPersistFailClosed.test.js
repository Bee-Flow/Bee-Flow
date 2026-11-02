'use strict';
/**
 * A token map whose organisation encrypts the piiTokenMap surface is never
 * written in clear: when the key cannot be resolved (escrow down, policy
 * lookup failing) or encryption throws, the write is skipped and retried on
 * the next one; a failed owner lookup is not cached.
 *
 * Run: cd server && node --test core/dlp/__tests__/tokenMapPersistFailClosed.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const { makeSwaps } = require('../../../testUtils/swaps');
const { swap, restore } = makeSwaps();
test.after(restore);

const writes = [];
let ownerLookupFails = false;
let ownerLookups = 0;
const db = require('../../../db');
swap(db, 'getOne', async (sql) => {
    if (/pii_token_map FROM/.test(sql)) return null;
    if (/SELECT user_id FROM agent_conversations/.test(sql)) {
        ownerLookups++;
        if (ownerLookupFails) throw new Error('connection reset');
        return { user_id: 'u1' };
    }
    return null;
});
swap(db, 'run', async (sql, params) => { writes.push({ sql, payload: params[0] }); return { rowCount: 1 }; });
swap(require('../../../stores/userStore'), 'getUser', async () => ({ id: 'u1', organizationId: 'o1' }));
swap(require('../../../stores/guardrailEventStore'), 'logGuardrailEvent', async () => {});

const policy = require('../../../stores/encryptionPolicy');
policy.resolvePolicy = async () => ({ enabled: true });
policy.shouldEncrypt = () => true;
const messageCrypto = require('../../../stores/agent/messageCrypto');
let cryptoAnswer = async () => ({ backgroundKey: crypto.randomBytes(32) });
messageCrypto.resolveCrypto = (opts) => cryptoAnswer(opts);

const maps = require('../dlpTokenMaps');
const SECRET = 'jan.dekker@voorbeeld.nl';

test('no key for an encrypting organisation: the map is not written, and not in clear', async () => {
    let purpose = null;
    cryptoAnswer = async (opts) => { purpose = opts.purpose; return { backgroundKey: null }; };
    maps._mergeIntoTokenMap('conv-1', { '[email_1]': SECRET });
    await maps._writeMapToDb('conv-1');
    assert.equal(purpose, 'write', 'the key is resolved for a write, which refuses instead of degrading');
    assert.deepEqual(writes, []);
});

test('the escrow failing (resolveCrypto throws) skips the write', async () => {
    cryptoAnswer = async () => { throw Object.assign(new Error('escrow unavailable'), { code: 'ENCRYPTION_KEY_UNAVAILABLE' }); };
    maps._mergeIntoTokenMap('conv-2', { '[email_1]': SECRET });
    await maps._writeMapToDb('conv-2');
    assert.deepEqual(writes, []);
});

test('with the key back, the next write stores the sealed map', async () => {
    cryptoAnswer = async () => ({ backgroundKey: crypto.randomBytes(32) });
    await maps._writeMapToDb('conv-2');
    assert.equal(writes.length, 1);
    assert.ok(!String(writes[0].payload).includes(SECRET), 'sealed');
    writes.length = 0;
});

test('a failed owner lookup is not cached', async () => {
    ownerLookupFails = true;
    await assert.rejects(() => maps._resolveOwner('conv-3'), /connection reset/);
    ownerLookupFails = false;
    const before = ownerLookups;
    assert.deepEqual(await maps._resolveOwner('conv-3'), { userId: 'u1', table: 'agent_conversations' });
    assert.equal(ownerLookups, before + 1, 'asked again');
});
