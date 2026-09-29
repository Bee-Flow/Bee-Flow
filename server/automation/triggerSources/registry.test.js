const test = require('node:test');
const assert = require('node:assert');

const { validateTriggerSource } = require('./validate');

/**
 * The registry, and the invariant that replaces the old hardcoded join test.
 *
 * Previously a colocated test asserted that every provider.event in one
 * hardcoded array also appeared in two other hardcoded maps. That could only
 * ever see the built-ins. Now every declaration — first-party, bundled MCP, or
 * pushed at runtime — is validated on the way in, so the guarantee covers
 * integrations that did not exist when this test was written.
 */

function freshRegistry() {
    // The registry caches its readdir sweep, so reload it per test that needs
    // to register fixtures without leaking them into the next one.
    delete require.cache[require.resolve('./index')];
    return require('./index');
}

const minimal = (over = {}) => ({
    id: 'acme',
    label: 'Acme',
    order: 100,
    defaultEvent: 'widget.changed',
    availability: { kind: 'check', check: 'acme' },
    events: [{
        id: 'widget.changed',
        label: 'Widget changed',
        fields: ['sku'],
        sample: { sku: 'W-1' },
        scope: 'user',
        source: { kind: 'poll_diff', tool: 't', requiresIntegration: 'acme', itemsPath: 'w', idPath: 'sku', changePaths: ['state'], emit: { mode: 'item', map: { sku: 'sku' } } },
    }],
    ...over,
});

test('every declaration discovered on this install is valid', () => {
    const { listTriggerSources } = freshRegistry();
    const sources = listTriggerSources();
    assert.ok(sources.length >= 8, 'the built-in providers were discovered');
    for (const src of sources) {
        const errors = validateTriggerSource(src).filter(i => i.severity === 'error');
        assert.deepStrictEqual(errors, [], `${src.id}: ${errors.map(e => `${e.code}@${e.path}`).join(', ')}`);
    }
});

test('the original providers keep their relative order, and Gmail stays first', () => {
    // The builder snaps a fresh trigger to providers[0], so discovery order
    // must never decide the default. New declarations slot in by their own
    // `order`; the ones that existed before must not shuffle around each other.
    const ids = freshRegistry().listTriggerSources().map(s => s.id);
    assert.strictEqual(ids[0], 'gmail');
    const original = ['gmail', 'google-calendar', 'google-drive', 'nextcloud', 'support', 'msgraph', 'github'];
    assert.deepStrictEqual(ids.filter(id => original.includes(id)), original);
});

test('a declaration without an explicit order sorts after everything that has one', () => {
    const reg = freshRegistry();
    reg.registerTriggerSource({
        id: 'zzz-late', label: 'Late', defaultEvent: 'a.b',
        availability: { kind: 'check', check: 'zzz' },
        events: [{
            id: 'a.b', label: 'A', fields: ['x'], sample: { x: 1 }, scope: 'user',
            source: { kind: 'poll_diff', tool: 't', requiresIntegration: 'z', itemsPath: 'i', idPath: 'id', changePaths: ['x'], emit: { mode: 'item', map: { x: 'x' } } },
        }],
    }, { origin: 'test' });
    const ids = reg.listTriggerSources().map(s => s.id);
    assert.strictEqual(ids[ids.length - 1], 'zzz-late');
});

test('hidden providers are resolvable but never listed', () => {
    const { listTriggerSources, getTriggerSource } = freshRegistry();
    assert.ok(!listTriggerSources({ includeHidden: false }).some(s => s.id === 'github'));
    assert.ok(getTriggerSource('github'), 'still resolves a label for saved automations');
});

test('a declaration carrying an error is rejected whole, not partly honoured', () => {
    const reg = freshRegistry();
    // An event with no sample would list in the builder and offer bindings that
    // resolve to nothing.
    const issues = reg.registerTriggerSource(minimal({
        id: 'broken',
        events: [{ id: 'a.b', label: 'A', fields: ['x'], scope: 'user', source: { kind: 'poll_diff' } }],
    }), { origin: 'test' });
    assert.ok(issues.some(i => i.severity === 'error'));
    assert.strictEqual(reg.getTriggerSource('broken'), null);
});

test("one org's declarations never appear in the global list or another org's", () => {
    const reg = freshRegistry();
    reg.registerTriggerSource(minimal({ id: 'acme' }), { origin: 'test', orgId: 'org-A' });

    assert.ok(!reg.listTriggerSources().some(s => s.id === 'acme'),
        'the global enumeration feeds the LLM prompt — it must not disclose one org to all');
    assert.ok(reg.listTriggerSourcesForOrg('org-A').some(s => s.id === 'acme'));
    assert.ok(!reg.listTriggerSourcesForOrg('org-B').some(s => s.id === 'acme'));
});

test('scope is readable per provider and absent when undeclared', () => {
    const reg = freshRegistry();
    assert.strictEqual(reg.getProviderScope('gmail'), 'user');
    assert.strictEqual(reg.getProviderScope('nextcloud'), 'org');
    // github has no events, so it declares no scope and stays on the legacy path.
    assert.strictEqual(reg.getProviderScope('github'), null);
    assert.strictEqual(reg.getProviderScope('nope'), null);
});

test('only events with a known producer count as producible', () => {
    const { canProduce } = freshRegistry();
    assert.strictEqual(canProduce({ kind: 'poll_diff' }), true);
    assert.strictEqual(canProduce({ kind: 'poller' }), true);
    assert.strictEqual(canProduce({ kind: 'imaginary' }), false);
    assert.strictEqual(canProduce(null), false);
});

test('getEventDef finds hidden events so saved automations still resolve', () => {
    const { getEventDef } = freshRegistry();
    assert.ok(getEventDef('msgraph', 'event.updated'), 'withdrawn from the dropdown, still valid');
    assert.strictEqual(getEventDef('gmail', 'nope.nope'), null);
});

// ── every bundled declaration must actually LOAD ─────────────────────────
//
// A declaration that fails validation is skipped with a `console.warn` and
// nothing else: the integration silently has no triggers, the builder's
// provider list is one entry shorter, and the only evidence is a line in a
// startup log nobody reads. That is how `meeting_notes` shipped rejected —
// the provider id has to be kebab-case (PROVIDER_ID_RE) and an underscore is
// not, so the source declared by K7 never registered at all.
//
// The file names the providers, so nothing has to be listed here by hand.
test('every declared/*.js provider is in the registry', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'declared');
    const expected = fs.readdirSync(dir)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .flatMap(f => {
            const mod = require(path.join(dir, f));
            const decls = Array.isArray(mod.TRIGGER_SOURCES) ? mod.TRIGGER_SOURCES : [];
            return decls.map(d => d.id);
        });
    assert.ok(expected.length > 5, 'the declared/ scan has gone stale');

    const registered = new Set(freshRegistry().listTriggerSources().map(s => s.id));
    const missing = expected.filter(id => !registered.has(id));
    assert.deepStrictEqual(missing, [], 'a declaration was rejected at load — check the [triggerSources] warning');
});

test('a declaration file is named after the provider it declares', () => {
    // Not cosmetic: it is how you find the declaration from a provider id in
    // a log line, and `meeting_notes.js` declaring `meeting-notes` is exactly
    // the pair that hid a rejected source.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, 'declared');
    const drift = [];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))) {
        const decls = require(path.join(dir, f)).TRIGGER_SOURCES || [];
        if (decls.length !== 1) continue; // a multi-provider file has no one name to match
        if (decls[0].id !== path.basename(f, '.js')) drift.push(`${f} declares "${decls[0].id}"`);
    }
    assert.deepStrictEqual(drift, []);
});
