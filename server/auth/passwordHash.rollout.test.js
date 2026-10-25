// @typecheck strict
'use strict';
/**
 * ROLLOUT default of auth/passwordHash.js: without PASSWORD_HASH_ALGORITHM the
 * server keeps writing bcrypt exactly as before (cost 10, the built-in admin 12)
 * and never upgrades a hash, so a rollback to a bcrypt-only release keeps every
 * account signing in. Reading argon2id already works, for the release after.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const argon2 = require('argon2');

delete process.env.PASSWORD_HASH_ALGORITHM;
const passwords = require('./passwordHash');

test('the default write algorithm is bcrypt', () => {
    assert.equal(passwords.writeAlgorithm(), 'bcrypt');
});

test('a new hash is bcrypt at cost 10, or the cost the caller asks for', async () => {
    const h = await passwords.hash('correct horse');
    assert.match(h, /^\$2[ab]\$10\$/);
    assert.equal(await bcrypt.compare('correct horse', h), true);
    assert.match(await passwords.hash('admin pw', { bcryptRounds: 12 }), /^\$2[ab]\$12\$/);
});

test('no hash is marked for an upgrade', async () => {
    assert.equal(passwords.needsRehash(await bcrypt.hash('x', 4), 'x'), false);
    assert.equal(passwords.needsRehash(await argon2.hash('x', { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 }), 'x'), false);
});

test('an argon2id hash still verifies, so a later release can switch the write path on', async () => {
    const h = await argon2.hash('pw', { type: argon2.argon2id });
    assert.equal(await passwords.verify('pw', h), true);
    assert.equal(await passwords.verify('nope', h), false);
});

test('the opt-in switches new hashes to argon2id', async () => {
    process.env.PASSWORD_HASH_ALGORITHM = 'argon2id';
    try {
        assert.match(await passwords.hash('pw'), /^\$argon2id\$/);
    } finally {
        delete process.env.PASSWORD_HASH_ALGORITHM;
    }
});
