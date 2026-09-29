/**
 * Unit tests for the App Studio builder model profiles: the profile→tool-menu
 * selection (small = core menu, everything Claude-4.5-class and up = FULL menu
 * incl. app_screenshot) and the "auto" tier policy (most capable configured
 * model wins, newest Claude generation on top, never inventing a model).
 *
 * builderTools/schemas.js loads standalone (its only requires are the pure
 * vocabulary modules it derives enums from), so the REAL tool schema list is
 * used — no mock harness needed.
 *
 * Run: node --test appStudio/builderModelProfiles.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    getProfileForModel,
    selectToolMenu,
    selectAutoBuilderTier,
    APP_CORE_TOOL_NAMES,
} = require('./builderModelProfiles');
const { TOOL_SCHEMAS } = require('./builderTools/schemas');

const namesOf = (menu) => menu.map((t) => t.function.name);

// ── Tool menu keys off the capability profile ───────────────────────

test('claude-sonnet-5 / claude-opus-5 sessions see the FULL menu with app_screenshot', () => {
    for (const id of ['claude-sonnet-5', 'claude-opus-5']) {
        const profile = getProfileForModel(id);
        assert.strictEqual(profile.toolset, 'full', `${id} must map to the full toolset`);
        const menu = selectToolMenu(profile, TOOL_SCHEMAS);
        assert.strictEqual(menu.length, TOOL_SCHEMAS.length, `${id} gets every tool`);
        assert.ok(namesOf(menu).includes('app_screenshot'), `${id} menu carries app_screenshot`);
    }
});

test('the rest of the capable landscape (Claude-4.5-class and up) also gets the full menu', () => {
    for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5', 'gpt-5-pro', 'gpt-4o']) {
        const menu = selectToolMenu(getProfileForModel(id), TOOL_SCHEMAS);
        assert.strictEqual(menu.length, TOOL_SCHEMAS.length, `${id} gets every tool`);
        assert.ok(namesOf(menu).includes('app_screenshot'), `${id} menu carries app_screenshot`);
    }
});

test('a haiku-class session sees the core menu WITHOUT app_screenshot', () => {
    for (const id of ['claude-haiku-4-5', 'gpt-5-mini', 'ministral-8b']) {
        const profile = getProfileForModel(id);
        assert.strictEqual(profile.toolset, 'core', `${id} must map to the core toolset`);
        const menu = selectToolMenu(profile, TOOL_SCHEMAS);
        assert.deepStrictEqual(
            namesOf(menu).sort(),
            [...APP_CORE_TOOL_NAMES].sort(),
            `${id} gets exactly the core subset`,
        );
        assert.ok(!namesOf(menu).includes('app_screenshot'), `${id} menu must not carry app_screenshot`);
    }
});

test('every core tool name still exists in the real schemas (drift guard)', () => {
    const all = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
    for (const name of APP_CORE_TOOL_NAMES) {
        assert.ok(all.has(name), `core tool ${name} is missing from TOOL_SCHEMAS — a rename silently shrinks the small-model menu`);
    }
    assert.ok(all.has('app_screenshot'), 'app_screenshot exists in the full schema list');
});

// ── selectAutoBuilderTier: most capable configured model wins ───────

test('auto picks the most capable configured model — Claude 5 over 4.x over Haiku', () => {
    const pick = selectAutoBuilderTier({
        fast: { modelId: 'claude-haiku-4-5' },
        standard: { modelId: 'claude-sonnet-4-6' },
        thinking: { modelId: 'claude-opus-4-8' },
        smart: { modelId: 'claude-sonnet-5' },
    });
    assert.deepStrictEqual(pick, { tier: 'smart', modelId: 'claude-sonnet-5' }, 'newest Claude generation on top');
});

test('within the Claude 5 generation, Opus outranks Sonnet', () => {
    const pick = selectAutoBuilderTier({
        standard: { modelId: 'claude-sonnet-5' },
        deep_thinking: { modelId: 'claude-opus-5' },
    });
    assert.deepStrictEqual(pick, { tier: 'deep_thinking', modelId: 'claude-opus-5' });
});

test('a configured Claude frontier model outranks a non-Claude frontier model', () => {
    const pick = selectAutoBuilderTier({
        pro: { modelId: 'gpt-5-pro' },
        standard: { modelId: 'claude-sonnet-5' },
    });
    assert.deepStrictEqual(pick, { tier: 'standard', modelId: 'claude-sonnet-5' });
});

test('never invents a model: a small-only org keeps its small model (floor handles the rest)', () => {
    const pick = selectAutoBuilderTier({ fast: { modelId: 'claude-haiku-4-5' } });
    assert.deepStrictEqual(pick, { tier: 'fast', modelId: 'claude-haiku-4-5' });
});

test('skips custom:/swarm tiers and entries without a modelId; empty config → null', () => {
    const pick = selectAutoBuilderTier({
        'custom:my-tier': { modelId: 'claude-opus-5' },
        swarm: { modelId: 'claude-opus-5' },
        broken: {},
        fast: { modelId: 'claude-haiku-4-5' },
    });
    assert.deepStrictEqual(pick, { tier: 'fast', modelId: 'claude-haiku-4-5' }, 'only plain configured tiers rank');

    assert.strictEqual(selectAutoBuilderTier({}), null);
    assert.strictEqual(selectAutoBuilderTier(null), null);
    assert.strictEqual(selectAutoBuilderTier({ swarm: { modelId: 'x' } }), null);
});

test('identical scores tie-break deterministically by tier preference', () => {
    const tiers = {
        fast: { modelId: 'test-model-large' },
        standard: { modelId: 'test-model-large' },
    };
    const a = selectAutoBuilderTier(tiers);
    const b = selectAutoBuilderTier(tiers);
    assert.deepStrictEqual(a, { tier: 'standard', modelId: 'test-model-large' }, 'standard preferred over fast on a tie');
    assert.deepStrictEqual(a, b, 'stable across calls');
});
