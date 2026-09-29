// @typecheck
/**
 * Defaults for the *user-level* Privacy Shield (consumer accounts, no org).
 *
 * Single source of truth for three call sites that used to carry their own
 * copies — the settings route (`routes/orgPrivacyShield.js`), the runtime
 * resolver (`core/orgShield.js` → `resolveUserShield`) and the consumer signup
 * paths. They drifted apart before, which is the class of bug that produced
 * BFSF-290 (settings saved one shape, the runtime read another).
 *
 * SECURE BY DEFAULT (BFSF-289): a personal account that has never opened the
 * Privacy Shield settings is *protected*, not unprotected. A consumer account
 * previously started with `enabled: false`, so every message went to the model
 * in the clear until the user found the panel themselves — the opposite of the
 * product's privacy-first promise.
 *
 * Two states must stay distinguishable and are NOT the same thing:
 *   - no stored row            → these defaults apply (shield active)
 *   - stored row `enabled:false` → the user deliberately turned it off; respect it
 *
 * Notes on the individual values:
 *   - `piiDetectionCategories: []` is deliberate. An empty list makes
 *     piiDetection.js fall back to ALL canonical categories, so a user who never
 *     picked categories gets the widest protection rather than none.
 *   - `piiFailureMode: 'fail_closed'` only bites when the guard is INSTALLED but
 *     unreachable. When no guard is configured at all, `detectPii()` returns
 *     null and the chat proceeds — a self-host without the `guard` profile is
 *     therefore unaffected by this default.
 */

const USER_SHIELD_DEFAULTS = Object.freeze({
    enabled: true,
    euModeEnabled: false,
    disableSearchOnUpload: false,
    piiDetectionEnabled: true,
    piiDetectionCategories: [],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'tokenize',
    piiFailureMode: 'fail_closed',
    showRawPayload: false,
});

/**
 * Build a persistable user-shield document from (optional) signup-wizard
 * choices, falling back to the secure defaults above. Mirrors what
 * `PUT /api/org-privacy-shield/user/me` writes so a wizard-created shield is
 * byte-compatible with one saved from the settings panel.
 *
 * @param {object} choices  { enabled, piiDetectionCategories, piiDetectionAction, euModeEnabled }
 * @param {object} opts     { updatedBy }
 * @returns {object} the config to store under `user_privacy_shield_${userId}`
 */
function buildUserShieldConfig(choices = {}, { updatedBy = 'system-signup' } = {}) {
    const { ALL_PII_CATEGORY_IDS } = require('./piiDetection');
    const valid = new Set(ALL_PII_CATEGORY_IDS);
    const c = choices && typeof choices === 'object' ? choices : {};

    const categories = Array.isArray(c.piiDetectionCategories)
        ? c.piiDetectionCategories.filter(id => valid.has(id))
        : [...USER_SHIELD_DEFAULTS.piiDetectionCategories];

    const threshold = typeof c.piiDetectionConfidenceThreshold === 'number'
        ? Math.max(0.1, Math.min(1, c.piiDetectionConfidenceThreshold))
        : USER_SHIELD_DEFAULTS.piiDetectionConfidenceThreshold;

    return {
        ...USER_SHIELD_DEFAULTS,
        // Only an explicit `false` turns the shield off; anything else (absent,
        // undefined, true) keeps the secure default.
        enabled: c.enabled !== false,
        euModeEnabled: !!c.euModeEnabled,
        disableSearchOnUpload: !!c.disableSearchOnUpload,
        piiDetectionEnabled: true,
        piiDetectionCategories: categories,
        piiDetectionConfidenceThreshold: threshold,
        piiDetectionAction: ['block', 'tokenize'].includes(c.piiDetectionAction)
            ? c.piiDetectionAction
            : USER_SHIELD_DEFAULTS.piiDetectionAction,
        piiFailureMode: c.piiFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        showRawPayload: !!c.showRawPayload,
        updatedAt: new Date().toISOString(),
        updatedBy,
    };
}

module.exports = { USER_SHIELD_DEFAULTS, buildUserShieldConfig };
