/**
 * resolveAttachmentShield: the super-admin fallback to the sole org shield uses
 * the RESOLVED shield (licence rules applied), the raw row only when that is null.
 *
 * Run: cd server && node --test routes/ai/directChat/attachmentScan.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const orgShield = require('../../../core/privacy/orgShield');
const { resolveAttachmentShield } = require('./attachmentScan');

const KEY = 'org_privacy_shield_org1';
const req = { session: { isAdmin: true } };

function arrange(stored) {
    const real = { ...orgShield._deps };
    orgShield._deps.configStore = { getConfig: async (k) => (k === KEY ? stored : null) };
    orgShield._deps.getAIConfig = async () => ({});
    orgShield._deps.license = () => ({ resolveTier: async () => 'community', tiers: { tierHasFeature: () => false } });
    return {
        restore: () => Object.assign(orgShield._deps, real),
        deps: { resolveUserOrgIds: async () => new Set(), getAllConfig: async () => ({ [KEY]: stored }) },
    };
}

test('super-admin fallback: a Community org with a saved tokenize is scanned as block', async () => {
    const stored = { enabled: true, piiDetectionAction: 'tokenize', piiDetectionCategories: ['Email'] };
    const { restore, deps } = arrange(stored);
    try {
        const { shield } = await resolveAttachmentShield(req, deps);
        assert.strictEqual(shield.enabled, true);
        assert.strictEqual(shield.piiDetectionAction, 'block');
        assert.strictEqual(stored.piiDetectionAction, 'tokenize');
    } finally { restore(); }
});
