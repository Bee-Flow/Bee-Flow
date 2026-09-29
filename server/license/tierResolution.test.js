/**
 * The CI gate for "a renamed plan silently stops licence issuance".
 *
 * Tier used to be inferred by substring-matching the plan's display name, while
 * subscription_plans.tier sat unused. Renaming "Pro" to "Business" made
 * resolution return null, and a null tier means the Stripe webhook writes an
 * audit row and issues nothing — the customer pays and stays on Community.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    normalizeTier, tierFromPlanName, resolveTierForPlan,
    validateAllPlanTiers, reportPlanTierProblems,
} = require('./tierResolution');
const { TIER_HIERARCHY } = require('./tiers');

describe('normalizeTier', () => {
    test('every tier in the hierarchy round-trips', () => {
        for (const t of TIER_HIERARCHY) assert.equal(normalizeTier(t), t);
    });

    test('the legacy pro alias resolves to enterprise', () => {
        assert.equal(normalizeTier('pro'), 'enterprise');
        assert.equal(normalizeTier('PRO'), 'enterprise');
        assert.equal(normalizeTier('  Pro  '), 'enterprise');
    });

    test('an unknown value is null rather than passed through', () => {
        for (const v of ['business', 'gold', '', null, undefined, 'enterprise-plus']) {
            assert.equal(normalizeTier(v), null, String(v));
        }
    });
});

describe('resolveTierForPlan — the tier column wins', () => {
    test('the column is used even when the name says something else', () => {
        assert.equal(resolveTierForPlan({ id: 'p1', name: 'Community Starter', tier: 'enterprise' }), 'enterprise');
    });

    test('a renamed plan keeps its tier — this is the bug this module exists for', () => {
        assert.equal(resolveTierForPlan({ id: 'p1', name: 'Business', tier: 'enterprise' }), 'enterprise');
        // Under the old name-match this returned null and issued no licence.
        assert.equal(tierFromPlanName('Business'), null);
    });

    test('a join exposing plan_tier / plan_name is accepted', () => {
        assert.equal(resolveTierForPlan({ plan_id: 'p1', plan_name: 'X', plan_tier: 'pro' }), 'enterprise');
    });

    test('an unrecognised column value falls back to the name', () => {
        assert.equal(resolveTierForPlan({ id: 'p1', name: 'Enterprise Annual', tier: 'platinum' }), 'enterprise');
    });

    test('no column and no name match means no licence', () => {
        assert.equal(resolveTierForPlan({ id: 'p1', name: 'Starter' }), null);
    });

    test('a null plan is null, not a crash', () => {
        assert.equal(resolveTierForPlan(null), null);
    });
});

describe('tierFromPlanName legacy fallback', () => {
    for (const [name, expected] of [
        ['Bee Flow Enterprise', 'enterprise'],
        ['Bee Flow Pro Monthly', 'enterprise'], // pro is aliased
        ['Community', 'community'],
        ['__consumer_default__', 'community'],
        ['Starter', null],
        ['Business', null],
    ]) {
        test(`${JSON.stringify(name)} → ${expected}`, () => {
            assert.equal(tierFromPlanName(name), expected);
        });
    }

    test('it normalises rather than returning the raw legacy string', () => {
        // The old implementation returned 'pro', which is not in TIER_HIERARCHY.
        assert.ok(TIER_HIERARCHY.includes(tierFromPlanName('Pro Consumer')));
    });
});

describe('validateAllPlanTiers', () => {
    test('a clean catalogue passes', () => {
        const { ok, offenders } = validateAllPlanTiers([
            { id: 'p1', name: 'Free', price: 0, tier: null },
            { id: 'p2', name: 'Business', price: 29, tier: 'enterprise' },
        ]);
        assert.equal(ok, true);
        assert.deepEqual(offenders, []);
    });

    test('a paid plan that grants no tier is flagged — the customer would pay for nothing', () => {
        const { ok, offenders } = validateAllPlanTiers([{ id: 'p2', name: 'Starter', price: 19, tier: null }]);
        assert.equal(ok, false);
        assert.equal(offenders[0].reason, 'paid_plan_grants_no_tier');
    });

    test('an unknown tier value is flagged', () => {
        const { offenders } = validateAllPlanTiers([{ id: 'p3', name: 'Gold', price: 99, tier: 'gold' }]);
        assert.equal(offenders[0].reason, 'unknown_tier_value');
    });

    test('a plan surviving only on a name match is flagged as fragile', () => {
        const { offenders } = validateAllPlanTiers([{ id: 'p4', name: 'Enterprise Annual', price: 99 }]);
        assert.equal(offenders[0].reason, 'tier_only_from_name_match');
    });

    test('a free plan with no tier is fine — Free grants no licence by design', () => {
        assert.equal(validateAllPlanTiers([{ id: 'p5', name: 'Free', price: 0 }]).ok, true);
    });

    test('an empty or missing catalogue does not throw', () => {
        assert.equal(validateAllPlanTiers([]).ok, true);
        assert.equal(validateAllPlanTiers(undefined).ok, true);
    });
});

describe('reportPlanTierProblems', () => {
    test('returns true and logs nothing for a clean catalogue', () => {
        const errors = [];
        const ok = reportPlanTierProblems([{ id: 'p', name: 'Biz', price: 10, tier: 'enterprise' }],
            { error: (m) => errors.push(m) });
        assert.equal(ok, true);
        assert.deepEqual(errors, []);
    });

    test('logs one error per offender and says what breaks', () => {
        const errors = [];
        const ok = reportPlanTierProblems([{ id: 'p', name: 'Starter', price: 19 }],
            { error: (m) => errors.push(m) });
        assert.equal(ok, false);
        assert.equal(errors.length, 1);
        assert.match(errors[0], /NO licence/);
    });
});
