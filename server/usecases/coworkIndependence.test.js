// @typecheck
/**
 * Choosing how independent a plan may be (./coworkIndependence.mts): what each level asks about, which levels are
 * open (asking needs approvals in the licence; "on its own" opens after enough runs let through), and the refusals.
 * Every part is handed in.
 *
 * Run: cd server && node --test usecases/coworkIndependence.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { independenceOf, chooseIndependence } = require('./coworkIndependence.mts');
const { fakeLookups, planOf, literal } = require('../core/cowork/plan/plan.testkit');

const PLAN = planOf([
    { id: 'mail', type: 'integration_action', label: 'Read the mail', tool: 'outlook_search', inputs: {} },
    { id: 'table', type: 'datatable', label: 'Update the table', datatableId: 't1', op: 'save_row', values: {} },
    { id: 'send', type: 'integration_action', label: 'Mail the supplier', tool: 'outlook_compose', inputs: { to: literal('x@supplier.example') } },
]);

/** @param {{ letThrough?: number, mayAsk?: boolean, plan?: any }} [o] */
function world({ letThrough = 0, mayAsk = true, plan = { id: 'p1', definition: PLAN } } = {}) {
    /** @type {Array<[string, string | null]>} */
    const saved = [];
    const deps = {
        store: {
            getApprovedPlan: async () => plan,
            countLetThrough: async () => letThrough,
            setIndependence: async (/** @type {string} */ id, /** @type {string | null} */ level) => { saved.push([id, level]); },
        },
        mayAsk: async () => mayAsk,
        lookups: fakeLookups(),
    };
    return { deps, saved };
}
const ITEM = { id: 'w1', userId: 'u1', independence: null };
const open = (/** @type {any} */ state) => Object.fromEntries(state.options.map((/** @type {any} */ o) => [o.level, o.open]));

test('what each level asks about, and the level a run uses when the owner chose none', async () => {
    const state = await independenceOf(ITEM, world().deps);
    assert.deepStrictEqual([state.chosen, state.level, state.letThrough, state.needed], [null, 'asks_before_sending', 0, 10]);
    const asks = Object.fromEntries(state.options.map((/** @type {any} */ o) => [o.level, o.asksBefore]));
    assert.deepStrictEqual(asks, { asks_everything: ['Update the table', 'Mail the supplier'], asks_before_sending: ['Mail the supplier'], on_its_own: [] });
    assert.deepStrictEqual(open(state), { asks_everything: true, asks_before_sending: true, on_its_own: false });
});

test('"on its own" opens after ten runs let through, and at once where asking is not possible', async () => {
    assert.strictEqual(open(await independenceOf(ITEM, world({ letThrough: 9 }).deps)).on_its_own, false);
    assert.strictEqual(open(await independenceOf(ITEM, world({ letThrough: 10 }).deps)).on_its_own, true);
    const noApprovals = await independenceOf(ITEM, world({ mayAsk: false }).deps);
    assert.deepStrictEqual(open(noApprovals), { asks_everything: false, asks_before_sending: false, on_its_own: true });
    assert.strictEqual(noApprovals.level, 'on_its_own');
    // An owner who chose to be asked, when asking is no longer possible: the run would refuse, and the card says so.
    assert.strictEqual((await independenceOf({ ...ITEM, independence: 'asks_everything' }, world({ mayAsk: false }).deps)).level, null);
});

test('choosing: an open level is saved; a closed one is refused with why, and nothing is saved', async () => {
    const ok = world();
    const state = await chooseIndependence({ item: ITEM, level: 'asks_everything' }, ok.deps);
    assert.deepStrictEqual([state.chosen, ok.saved], ['asks_everything', [['w1', 'asks_everything']]]);

    const early = world({ letThrough: 3 });
    await assert.rejects(chooseIndependence({ item: ITEM, level: 'on_its_own' }, early.deps), (/** @type {any} */ e) => e.status === 409 && /3 so far/.test(e.message));
    const unlicensed = world({ mayAsk: false });
    await assert.rejects(chooseIndependence({ item: ITEM, level: 'asks_before_sending' }, unlicensed.deps), (/** @type {any} */ e) => e.status === 409 && /approvals/.test(e.message));
    await assert.rejects(chooseIndependence({ item: ITEM, level: 'never_asks' }, ok.deps), (/** @type {any} */ e) => e.status === 400);
    assert.deepStrictEqual([early.saved, unlicensed.saved], [[], []]);
});

test('the organisation\'s ceiling closes the levels above it and holds the level a run uses', async () => {
    const capped = world({ letThrough: 12 });
    const deps = { ...capped.deps, policyOf: async () => ({ ceiling: /** @type {const} */ ('asks_before_sending'), readOnly: false, unattendedApps: null, monthlyBudget: null, habitsAllowed: true }) };
    const state = await independenceOf({ ...ITEM, independence: 'on_its_own' }, deps);
    assert.deepStrictEqual([state.ceiling, state.level], ['asks_before_sending', 'asks_before_sending']);
    assert.deepStrictEqual(open(state), { asks_everything: true, asks_before_sending: true, on_its_own: false });
    await assert.rejects(chooseIndependence({ item: ITEM, level: 'on_its_own' }, deps), (/** @type {any} */ e) => e.status === 409 && /does not allow this much/.test(e.message));
});
