/**
 * Catalogue rendering — the per-app action cap.
 *
 * The cap used to be 30 while the demo org's `nextcloud` app had 34 actions,
 * and the overflow vanished with no marker. A list that looks complete is how a
 * model concludes an action does not exist and picks a different one, which is
 * the same failure the app filter caused one level up. The cap now sits above
 * any real app AND announces itself when it bites.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt/catalogRender.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { renderCatalogSlim } = require('./catalogRender');

const mkApp = (id, count) => ({
    id, label: id, available: true,
    actions: Array.from({ length: count }, (_, i) => ({
        name: `${id}_action_${i}`,
        description: `Does thing ${i}`,
        inputSchema: { properties: { a: { type: 'string' } }, required: ['a'] },
    })),
});

test('a real-sized app renders every action, with no truncation note', () => {
    // 34 = the demo org's `nextcloud` app, the case the old cap of 30 silently cut.
    const out = renderCatalogSlim({ apps: [mkApp('nextcloud', 34)] });
    for (let i = 0; i < 34; i++) {
        assert.ok(out.includes(`nextcloud_action_${i}`), `action ${i} must be listed`);
    }
    assert.ok(!/more .* not listed/.test(out), 'nothing was omitted, so nothing should be announced');
});

test('an app over the cap says so, and points at the way to recover', () => {
    const out = renderCatalogSlim({ apps: [mkApp('huge', 57)] });
    assert.ok(out.includes('huge_action_0'));
    assert.ok(!out.includes('huge_action_56'), 'the cap still applies');
    assert.match(out, /…and 7 more huge actions not listed/);
    assert.ok(out.includes('builder_inspect_tool'),
        'the model must be told how to reach an omitted action, not just that it exists');
});

test('the omitted count is exact, and singular reads correctly', () => {
    const out = renderCatalogSlim({ apps: [mkApp('one-over', 51)] });
    assert.match(out, /…and 1 more one-over action not listed/);
});

test('unavailable apps and empty apps render nothing', () => {
    const hidden = { id: 'nope', label: 'nope', available: false, actions: [{ name: 'nope_do' }] };
    const empty = { id: 'bare', label: 'bare', available: true, actions: [] };
    assert.strictEqual(renderCatalogSlim({ apps: [hidden, empty] }), '');
});
