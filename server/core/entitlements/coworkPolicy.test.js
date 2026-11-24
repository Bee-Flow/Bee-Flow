// @typecheck
/**
 * An organisation's Cowork policy (./coworkPolicy.mts): what is stored is normalised, a policy that cannot be read is
 * the strictest one, the ceiling caps a level, and the run refusal says why. The config store is handed in.
 *
 * Run: cd server && node --test core/entitlements/coworkPolicy.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { normalizePolicy, capLevel, resolveCoworkPolicy, setCoworkPolicy, policyOfOwner, runRefusalOf, appsNotAllowed, _clearCoworkPolicyCache } = require('./coworkPolicy.mts');

/** @returns {{ map: Map<string, unknown>, getConfig: (k: string) => Promise<unknown>, setConfig: (k: string, v: unknown) => Promise<void> }} */
const memory = () => {
    const map = new Map();
    return { map, getConfig: async (k) => map.get(k) ?? null, setConfig: async (k, v) => { map.set(k, v); } };
};

beforeEach(() => { _clearCoworkPolicyCache(); });

test('nothing stored is the open policy; what is not understood is the open value of that field', () => {
    assert.deepStrictEqual(normalizePolicy(null), { ceiling: 'on_its_own', readOnly: false, unattendedApps: null, monthlyBudget: null, habitsAllowed: true });
    assert.deepStrictEqual(normalizePolicy({ ceiling: 'never', readOnly: 'yes', unattendedApps: ['outlook', ' outlook ', 3, 'datatables'], monthlyBudget: -5 }), { ceiling: 'on_its_own', readOnly: false, unattendedApps: ['datatables', 'outlook'], monthlyBudget: null, habitsAllowed: true });
});

test('a monthly budget is a positive amount in euros, rounded to cents; anything else is no limit', () => {
    assert.strictEqual(normalizePolicy({ monthlyBudget: 12.345 }).monthlyBudget, 12.35);
    for (const v of [0, -1, '50', Number.NaN, Infinity, 20_000_000, null]) assert.strictEqual(normalizePolicy({ monthlyBudget: v }).monthlyBudget, null, String(v));
});

test('the ceiling caps a level; the apps outside the list are named once each', () => {
    assert.strictEqual(capLevel('on_its_own', 'asks_before_sending'), 'asks_before_sending');
    assert.strictEqual(capLevel('asks_everything', 'asks_before_sending'), 'asks_everything');
    const policy = normalizePolicy({ unattendedApps: ['datatables'] });
    assert.deepStrictEqual(appsNotAllowed(['outlook', 'datatables', 'outlook'], policy), ['outlook']);
    assert.deepStrictEqual(appsNotAllowed(['outlook'], normalizePolicy(null)), []);
});

test('stored per organisation; a change is read at once; an unreadable policy is the strictest and stops runs', async () => {
    const store = memory();
    assert.strictEqual((await resolveCoworkPolicy('org-1', store)).readOnly, false);
    await setCoworkPolicy('org-1', { readOnly: true }, store);
    assert.strictEqual((await resolveCoworkPolicy('org-1', store)).readOnly, true);
    assert.match(runRefusalOf(await resolveCoworkPolicy('org-1', store)) ?? '', /read-only/);
    assert.deepStrictEqual(await resolveCoworkPolicy(null, store), { ceiling: 'on_its_own', readOnly: false, unattendedApps: null, monthlyBudget: null, habitsAllowed: true });
    const broken = { getConfig: async () => { throw new Error('down'); }, setConfig: async () => {} };
    const strict = await resolveCoworkPolicy('org-2', broken);
    assert.deepStrictEqual([strict.readOnly, strict.ceiling, strict.unreadable], [true, 'asks_everything', true]);
    assert.match(runRefusalOf(strict) ?? '', /could not be read/);
});

test('an owner\'s policy is their organisation\'s; a person without one has the open policy, an unreadable user the strictest', async () => {
    const store = memory();
    await setCoworkPolicy('org-9', { ceiling: 'asks_everything' }, store);
    const resolve = (/** @type {string | null | undefined} */ orgId) => resolveCoworkPolicy(orgId, store);
    assert.strictEqual((await policyOfOwner('u1', { getUser: async () => ({ organizationId: 'org-9' }), resolve })).ceiling, 'asks_everything');
    assert.strictEqual((await policyOfOwner('u2', { getUser: async () => null, resolve })).ceiling, 'on_its_own');
    assert.strictEqual((await policyOfOwner('u3', { getUser: async () => { throw new Error('down'); }, resolve })).readOnly, true);
});
