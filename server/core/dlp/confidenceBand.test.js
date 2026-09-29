/**
 * confidenceBand — turns a raw detector score into a category the review UI
 * can render as color/intensity instead of a percentage. Anchored to the
 * org's own piiDetectionConfidenceThreshold so "high confidence" means the
 * same thing here as it does in PiiSensitivityPicker's Low/Balanced/High.
 *
 * Run: cd server && node --test core/dlp/confidenceBand.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { bandForConfidence } = require('./confidenceBand');

test('no confidence (custom term / manual span) → null band', () => {
    assert.strictEqual(bandForConfidence(undefined, {}), null);
    assert.strictEqual(bandForConfidence(null, {}), null);
});

test('bands anchor to the org threshold, not a fixed cutoff', () => {
    const shield = { piiDetectionConfidenceThreshold: 0.5 };
    assert.strictEqual(bandForConfidence(0.4, shield), 'low');
    assert.strictEqual(bandForConfidence(0.5, shield), 'medium');
    assert.strictEqual(bandForConfidence(0.66, shield), 'high');

    const strictShield = { piiDetectionConfidenceThreshold: 0.85 };
    // The same raw 0.66 that was "high" against a 0.5 threshold is "low" here —
    // the point of anchoring is that the band tracks the org's own bar.
    assert.strictEqual(bandForConfidence(0.66, strictShield), 'low');
});

test('missing/invalid org threshold falls back to the default anchor (0.7)', () => {
    assert.strictEqual(bandForConfidence(0.9, {}), 'high');
    assert.strictEqual(bandForConfidence(0.9, null), 'high');
    assert.strictEqual(bandForConfidence(0.5, { piiDetectionConfidenceThreshold: 'nope' }), 'low');
});
