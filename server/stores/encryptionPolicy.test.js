const test = require('node:test');
const assert = require('node:assert');

const {
    SURFACES, ALL_SURFACES, policyFromRow, shouldEncrypt, defaultTier,
} = require('./encryptionPolicy');

// ── Deploy safety ───────────────────────────────────────────────────────────
// An existing install upgrading to this build must behave exactly as before.

test('no org row at all resolves to fully disabled', () => {
    const p = policyFromRow(null);
    assert.strictEqual(p.tier, 'none');
    assert.strictEqual(p.enabled, false);
    for (const s of ALL_SURFACES) {
        assert.strictEqual(shouldEncrypt(p, s), false, `${s} must be off`);
    }
});

test('a row from before the columns existed resolves to disabled', () => {
    const p = policyFromRow({ id: 'org-legacy', name: 'Legacy' });
    assert.strictEqual(p.enabled, false);
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGES), false);
});

test('an unrecognised tier value falls back to disabled, not to on', () => {
    const p = policyFromRow({ encryption_tier: 'turbo' });
    assert.strictEqual(p.tier, 'none');
    assert.strictEqual(p.enabled, false);
});

test('the default tier for new orgs is none unless an operator overrides it', () => {
    const prev = process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER;
    try {
        delete process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER;
        assert.strictEqual(defaultTier(), 'none');
        process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER = 'managed';
        assert.strictEqual(defaultTier(), 'managed');
        process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER = 'nonsense';
        assert.strictEqual(defaultTier(), 'none', 'a bad env value must not enable anything');
    } finally {
        if (prev === undefined) delete process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER;
        else process.env.BEEFLOW_DEFAULT_ENCRYPTION_TIER = prev;
    }
});

// ── Full enablement ─────────────────────────────────────────────────────────

test('managed with no explicit scope turns every surface on', () => {
    const p = policyFromRow({ encryption_tier: 'managed' });
    assert.strictEqual(p.enabled, true);
    for (const s of ALL_SURFACES) {
        assert.strictEqual(shouldEncrypt(p, s), true, `${s} should be on`);
    }
});

test('zk behaves like managed for scope purposes', () => {
    const p = policyFromRow({ encryption_tier: 'zk' });
    assert.strictEqual(p.tier, 'zk');
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGES), true);
});

// ── Partial enablement ──────────────────────────────────────────────────────

test('a single surface can be switched off while the rest stay on', () => {
    // The realistic case: keep SQL search over bodies, still protect the PII map.
    const p = policyFromRow({
        encryption_tier: 'managed',
        encryption_scope: JSON.stringify({ messages: false }),
    });
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGES), false);
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGE_META), true);
    assert.strictEqual(shouldEncrypt(p, SURFACES.PII_TOKEN_MAP), true);
    assert.strictEqual(shouldEncrypt(p, SURFACES.CONVERSATION_META), true);
});

test('scope accepts an already-parsed object as well as a JSON string', () => {
    const p = policyFromRow({
        encryption_tier: 'managed',
        encryption_scope: { piiTokenMap: false },
    });
    assert.strictEqual(shouldEncrypt(p, SURFACES.PII_TOKEN_MAP), false);
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGES), true);
});

test('every surface can be switched off individually', () => {
    for (const off of ALL_SURFACES) {
        const p = policyFromRow({
            encryption_tier: 'managed',
            encryption_scope: JSON.stringify({ [off]: false }),
        });
        for (const s of ALL_SURFACES) {
            assert.strictEqual(shouldEncrypt(p, s), s !== off, `${s} with ${off} disabled`);
        }
    }
});

test('scope is ignored when the tier is none — off means off', () => {
    const p = policyFromRow({
        encryption_tier: 'none',
        encryption_scope: JSON.stringify({ messages: true, piiTokenMap: true }),
    });
    assert.strictEqual(p.enabled, false);
    for (const s of ALL_SURFACES) {
        assert.strictEqual(shouldEncrypt(p, s), false, `${s} must stay off`);
    }
});

test('a malformed scope fails toward protecting data, not exposing it', () => {
    for (const bad of ['not json', '[]', '{"messages":', 'null', '""']) {
        const p = policyFromRow({ encryption_tier: 'managed', encryption_scope: bad });
        assert.strictEqual(
            shouldEncrypt(p, SURFACES.MESSAGES), true,
            `malformed scope ${JSON.stringify(bad)} should not silently disable encryption`
        );
    }
});

test('only a strict false disables a surface', () => {
    const p = policyFromRow({
        encryption_tier: 'managed',
        encryption_scope: JSON.stringify({ messages: 0, messageMeta: 'no', piiTokenMap: null }),
    });
    // None of those are `false`, so all stay on rather than being half-guessed.
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGES), true);
    assert.strictEqual(shouldEncrypt(p, SURFACES.MESSAGE_META), true);
    assert.strictEqual(shouldEncrypt(p, SURFACES.PII_TOKEN_MAP), true);
});

test('an unknown surface name is never encrypted', () => {
    const p = policyFromRow({ encryption_tier: 'managed' });
    assert.strictEqual(shouldEncrypt(p, 'somethingElse'), false);
    assert.strictEqual(shouldEncrypt(p, undefined), false);
    assert.strictEqual(shouldEncrypt(null, SURFACES.MESSAGES), false);
});
