'use strict';

/**
 * "May this person use this tier?" (core/entitlements/tierAccess.js) — the
 * one answer the playbook routes and both builders ask, measured against the
 * set userTiers.getPermittedTierKeys hands the tier dropdown.
 *
 * What this file pins:
 *
 *   - an explicit tier is allowed only when the set holds it, under the name
 *     the set uses (`deep_thinking` is `pro`, `smart` is `thinking`, an
 *     agent's `tier:` prefix is not part of the name); a name the set does
 *     not know is not allowed;
 *   - `auto` is measured by what it may choose from: allowed while the
 *     person has any tier it could land on, never a custom tier or swarm;
 *   - narrow() keeps only the tiers of a map this person may use;
 *   - autoChoice() hands `auto` the person's configured tiers, and refuses
 *     only when the workspace has tiers `auto` could use and none is theirs —
 *     a workspace with nothing configured is not a permission question;
 *   - cheapestTier() is `fast` first, the project's default;
 *   - choose() is the tier a request with no tier map runs on: an explicit
 *     one when it is theirs, `auto` and no tier at all the cheapest that is;
 *   - tierAccessFor() asks the list for the caller's own task type.
 *
 * Run: cd server && node --test core/entitlements/tierAccess.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const asked = [];
let permitted = new Set();
{
    const p = require.resolve(path.join(__dirname, 'userTiers'));
    const m = new Module(p);
    m.exports = { getPermittedTierKeys: async (args) => { asked.push(args); return permitted; } };
    m.loaded = true;
    require.cache[p] = m;
}

const {
    tierAccessOf, tierAccessFor, tierRefusal, cheapestTier, permissionNameOf,
} = require('./tierAccess');

const TIERS = {
    fast: { modelId: 'small-model' },
    thinking: { modelId: 'mid-model' },
    pro: { modelId: 'big-model' },
    deep_thinking: { modelId: 'bigger-model' },
    standard: { modelId: 'flow-model' },
    swarm: { modelId: 'swarm-model' },
    'custom:legal': { modelId: 'legal-model', custom: true },
    writer: { modelId: '' },
};

test('an explicit tier is allowed only when the set holds it', () => {
    const access = tierAccessOf(new Set(['auto', 'fast', 'thinking']));
    assert.strictEqual(access.allows('fast'), true);
    assert.strictEqual(access.allows('thinking'), true);
    assert.strictEqual(access.allows('pro'), false);
    assert.strictEqual(access.allows('thinkin'), false, 'a name the set does not know');
    assert.strictEqual(access.allows(''), false);
    assert.strictEqual(access.allows(undefined), false);
});

test('a tier is measured under the name the set uses', () => {
    assert.strictEqual(permissionNameOf('deep_thinking'), 'pro');
    assert.strictEqual(permissionNameOf('smart'), 'thinking');
    assert.strictEqual(permissionNameOf('tier:fast'), 'fast');
    assert.strictEqual(permissionNameOf('tier:smart'), 'thinking');
    const access = tierAccessOf(new Set(['pro', 'thinking']));
    assert.strictEqual(access.allows('deep_thinking'), true, 'deep_thinking is pro under its other name');
    assert.strictEqual(access.allows('smart'), true, 'smart is the legacy name of thinking');
    assert.strictEqual(tierAccessOf(new Set(['fast'])).allows('deep_thinking'), false);
});

test('auto is allowed while the person has a tier it could land on, and a custom tier or swarm is not one', () => {
    assert.strictEqual(tierAccessOf(new Set(['fast'])).allows('auto'), true, 'a group that lists only fast still gets auto — within fast');
    assert.strictEqual(tierAccessOf(new Set(['auto'])).allows('auto'), false, 'auto alone has nothing to choose');
    assert.strictEqual(tierAccessOf(new Set(['custom:legal', 'swarm'])).allows('auto'), false, 'custom tiers are picked by hand; swarm never by auto');
    assert.strictEqual(tierAccessOf(new Set()).allows('auto'), false);
});

test('narrow() keeps the tiers of a map this person may use, aliases included', () => {
    const access = tierAccessOf(new Set(['fast', 'pro', 'custom:legal']));
    assert.deepStrictEqual(Object.keys(access.narrow(TIERS)).sort(), ['custom:legal', 'deep_thinking', 'fast', 'pro']);
    assert.deepStrictEqual(access.narrow(null), {});
});

test('autoChoice() hands auto the person\'s configured tiers — never custom, swarm or an empty slot', () => {
    const access = tierAccessOf(new Set(['auto', 'fast', 'thinking', 'writer', 'standard', 'swarm', 'custom:legal']));
    const { candidates, refused } = access.autoChoice(TIERS);
    assert.strictEqual(refused, false);
    assert.deepStrictEqual(Object.keys(candidates).sort(), ['fast', 'standard', 'thinking']);
});

test('autoChoice() refuses only when the workspace has tiers auto could use and none is theirs', () => {
    const none = tierAccessOf(new Set(['writer'])).autoChoice(TIERS);
    assert.deepStrictEqual(none, { candidates: {}, refused: true }, 'writer is theirs but has no model; nothing else is');
    const unconfigured = tierAccessOf(new Set(['fast'])).autoChoice({ fast: { modelId: '' } });
    assert.deepStrictEqual(unconfigured, { candidates: {}, refused: false }, 'nothing configured is the caller\'s fallback, not a refusal');
});

test('cheapestTier() is fast first, then up the ladder; custom tiers and swarm never', () => {
    assert.strictEqual(cheapestTier(['pro', 'thinking', 'fast']), 'fast');
    assert.strictEqual(cheapestTier(['pro', 'thinking']), 'thinking');
    assert.strictEqual(cheapestTier(['deep_thinking', 'pro']), 'pro');
    assert.strictEqual(cheapestTier(['custom:legal', 'swarm', 'auto']), null);
    assert.strictEqual(cheapestTier([]), null);
    assert.strictEqual(tierAccessOf(new Set(['pro', 'thinking', 'custom:legal'])).cheapest(), 'thinking');
});

// A caller with no tier map (the playbook routes) still has to answer "which
// tier does this run on" for a request that named none, or named `auto`. The
// playbook routes answered `fast` without asking, so a group narrowed to
// `thinking` still ran on the fast model.
test('choose() is the tier a request runs on: an explicit one when it is theirs; auto and no tier at all the cheapest that is', () => {
    const narrowed = tierAccessOf(new Set(['pro', 'thinking', 'custom:legal']));
    assert.strictEqual(narrowed.choose(undefined), 'thinking', 'no tier is not fast when fast is not theirs');
    assert.strictEqual(narrowed.choose(null), 'thinking');
    assert.strictEqual(narrowed.choose('auto'), 'thinking');
    assert.strictEqual(narrowed.choose('pro'), 'pro');
    assert.strictEqual(narrowed.choose('deep_thinking'), 'deep_thinking', 'measured as pro, run under the name it was given');
    assert.strictEqual(narrowed.choose('custom:legal'), 'custom:legal', 'picked by hand, so allowed by hand');
    assert.strictEqual(narrowed.choose('fast'), null, 'an explicit tier that is not theirs is refused');
    const everyone = tierAccessOf(new Set(['auto', 'fast', 'thinking', 'pro']));
    assert.strictEqual(everyone.choose(undefined), 'fast', 'the default tier, when it is theirs');
    assert.strictEqual(everyone.choose('auto'), 'fast');
    const onlyCustom = tierAccessOf(new Set(['custom:legal']));
    assert.strictEqual(onlyCustom.choose(undefined), null, 'a custom tier is never chosen for somebody');
    assert.strictEqual(onlyCustom.choose('auto'), null);
});

test('the refusal names the tier, in the words every route gives', () => {
    assert.deepStrictEqual(tierRefusal('pro'), { status: 403, code: 'tier_not_permitted', error: 'Tier "pro" is not available on your account.' });
    assert.ok(tierRefusal('x'.repeat(500)).error.length < 120, 'an echoed name is capped');
});

test('tierAccessFor() asks the caller\'s own list, for the task type it names', async () => {
    asked.length = 0;
    permitted = new Set(['fast']);
    const session = { user: { id: 'me' } };
    const access = await tierAccessFor({ userId: 'me', session, taskType: 'automation' });
    assert.strictEqual(access.allows('fast'), true);
    assert.strictEqual(access.allows('pro'), false);
    assert.deepStrictEqual(asked, [{ userId: 'me', session, taskType: 'automation' }]);
});
