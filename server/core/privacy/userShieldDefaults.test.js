/**
 * BFSF-289: the shield written at consumer signup.
 *
 * The wizard's privacy step is optional plumbing — the important property is
 * that every path through buildUserShieldConfig produces a *protecting* shield
 * unless the user explicitly opted out, and that its shape matches what the
 * settings panel's PUT stores (otherwise the runtime reads one shape and the
 * panel shows another, which is how BFSF-290 happened).
 *
 * Run: cd server && node --test core/userShieldDefaults.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { USER_SHIELD_DEFAULTS, buildUserShieldConfig } = require('./userShieldDefaults');
const { ALL_PII_CATEGORY_IDS } = require('./piiDetection');

test('defaults protect rather than expose', () => {
    assert.equal(USER_SHIELD_DEFAULTS.enabled, true);
    assert.equal(USER_SHIELD_DEFAULTS.piiDetectionEnabled, true);
    assert.equal(USER_SHIELD_DEFAULTS.piiDetectionAction, 'tokenize');
    assert.equal(USER_SHIELD_DEFAULTS.piiFailureMode, 'fail_closed');
    // Empty means "all" downstream — see piiDetection.js's category fallback.
    assert.deepEqual(USER_SHIELD_DEFAULTS.piiDetectionCategories, []);
});

test('no wizard input → enabled shield with the secure defaults', () => {
    for (const input of [undefined, null, {}, 'nonsense']) {
        const cfg = buildUserShieldConfig(input);
        assert.equal(cfg.enabled, true, `input ${JSON.stringify(input)} must still protect`);
        assert.equal(cfg.piiDetectionAction, 'tokenize');
        assert.equal(cfg.piiFailureMode, 'fail_closed');
        assert.ok(cfg.updatedAt, 'stamped for auditability');
    }
});

test('explicit opt-out is honoured', () => {
    const cfg = buildUserShieldConfig({ enabled: false });
    assert.equal(cfg.enabled, false);
});

test('wizard choices are carried through', () => {
    const cfg = buildUserShieldConfig({
        enabled: true,
        piiDetectionCategories: ['Email', 'Person', 'PhoneNumber'],
        piiDetectionAction: 'block',
        euModeEnabled: true,
    }, { updatedBy: 'system-signup' });

    assert.deepEqual(cfg.piiDetectionCategories, ['Email', 'Person', 'PhoneNumber']);
    assert.equal(cfg.piiDetectionAction, 'block');
    assert.equal(cfg.euModeEnabled, true);
    assert.equal(cfg.updatedBy, 'system-signup');
});

test('unknown categories are dropped, not stored', () => {
    const cfg = buildUserShieldConfig({ piiDetectionCategories: ['Email', 'NotARealCategory'] });
    assert.deepEqual(cfg.piiDetectionCategories, ['Email']);
    for (const id of cfg.piiDetectionCategories) {
        assert.ok(ALL_PII_CATEGORY_IDS.includes(id));
    }
});

test('an invalid action falls back to tokenize, never to "off"', () => {
    assert.equal(buildUserShieldConfig({ piiDetectionAction: 'warn' }).piiDetectionAction, 'tokenize');
    assert.equal(buildUserShieldConfig({ piiDetectionAction: 'allow' }).piiDetectionAction, 'tokenize');
});

test('confidence threshold is clamped to a usable range', () => {
    assert.equal(buildUserShieldConfig({ piiDetectionConfidenceThreshold: 5 }).piiDetectionConfidenceThreshold, 1);
    assert.equal(buildUserShieldConfig({ piiDetectionConfidenceThreshold: -1 }).piiDetectionConfidenceThreshold, 0.1);
    assert.equal(buildUserShieldConfig({ piiDetectionConfidenceThreshold: 0.76 }).piiDetectionConfidenceThreshold, 0.76);
    assert.equal(buildUserShieldConfig({}).piiDetectionConfidenceThreshold, 0.7);
});

test('the built shape carries every field the runtime resolver reads', () => {
    const cfg = buildUserShieldConfig({});
    for (const key of ['enabled', 'piiDetectionCategories', 'piiDetectionConfidenceThreshold',
        'piiDetectionAction', 'piiFailureMode', 'showRawPayload', 'euModeEnabled']) {
        assert.ok(key in cfg, `missing ${key} — resolveUserShield reads it`);
    }
});
