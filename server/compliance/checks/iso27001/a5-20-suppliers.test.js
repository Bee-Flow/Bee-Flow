'use strict';

/**
 * ISO27001-A.5.20-suppliers — a ledger that is not provisioned is not
 * applicable, but any other read error warns instead of dropping the check
 * from the score; and the check is labelled 'hybrid', because its pass rests
 * on the admin's agreement attestations.
 *
 * The check destructures getAll from db at require time, so db.getAll is
 * replaced on the real singleton BEFORE the check is required (the smoke
 * harness does the same).
 *
 * Run: cd server && node --test compliance/checks/iso27001/a5-20-suppliers.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../../db');
let answer = async () => [];
db.getAll = (...args) => answer(...args);

const complianceStore = require('../../../stores/complianceStore');
complianceStore.getSettings = async () => ({ scc_confirmed_operators: [{ operator: 'Mistral' }] });

const check = require('./a5-20-suppliers');

const failWith = (code) => async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code }); };

test('a statement timeout on the ledger warns; it does not leave the score as not applicable', async () => {
    answer = failWith('57014');
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence, { ledger_readable: false, error_code: '57014' });
    assert.match(r.details, /SQL state 57014/);
});

test('a ledger that is not provisioned is not applicable', async () => {
    answer = failWith('42P01');
    assert.equal((await check.evaluate('org1')).status, 'not_applicable');
    answer = failWith('42703');
    assert.equal((await check.evaluate('org1')).status, 'not_applicable');
});

test('attested suppliers still pass', async () => {
    answer = async () => [{ operator: 'Mistral', is_eu: true, calls: 3 }];
    assert.equal((await check.evaluate('org1')).status, 'pass');
});

test('the pass rests on admin attestations, so the check is hybrid', () => {
    assert.equal(check.verification, 'hybrid');
});
