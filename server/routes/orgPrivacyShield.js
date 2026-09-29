/**
 * Organization Privacy Shield API
 *
 * Lets org admins manage regex guardrails that apply to ALL agents
 * and direct chat within their organization.
 *
 * ── What the two PUTs accept ────────────────────────────────────────
 *
 * Both saves REPLACE the stored row, and both are measured by a schema
 * below. The body is a round-tripped DOCUMENT, not a form: the admin page
 * (useOrgShield.js `buildPayload`) and the mobile app send back the row they
 * read, with their own fields laid over it, so the body carries whatever an
 * older release wrote into that row — `moderationEnabled`, `azurePiiEnabled`
 * and the rest. That is why the key check is not a plain `.strict()`: a key
 * the schema does not name is accepted when the STORED row already has it
 * (an echo, dropped on write exactly as before), and refused otherwise. A
 * plain `.strict()` would lock every org with an old row out of saving its
 * own Privacy Shield; no check at all let `dlpEnabeld: true` answer "saved"
 * while the rebuild wrote DLP off.
 *
 * The GETs read nothing from the query and have no schema.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const configStore = require('../stores/configStore');
require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const { validate } = require('../core/http/validate');
const { badRequest } = require('../core/http/errors');
const { z } = require('zod');
const { isCustomTypeId } = require('../core/privacy/customTypes/ids');
const { hasCustomDataFeature } = require('../core/privacy/customTypes/resolve');
const customShieldDoc = require('../core/privacy/customTypes/shieldDoc');
const customTypeRegistry = require('../core/privacy/customTypes/registry');

// ── What a caller may send ──────────────────────────────────────────
//
// Every value below was read with a fall-back, and the fall-backs are where
// this file lied. Each was a 200 with "saved" on screen:
//
//   - a boolean read as `!!x`: the STRING "false" switched `dlpEnabled`,
//     `showRawPayload` and `webSearchGuardEnabled` ON, and `piiAllowPublicOrgs`
//     read `!== false`, so "false" kept the public-organisation allowlist on;
//   - `attachmentLargeInputPolicy: 'fail_closd'` became **fail_open** — the
//     one fall-back here that runs towards LESS protection;
//   - `dlpScope: 'All'` became 'external', `dlpMode: 'auto-redact'` became
//     'ask', `piiDetectionAction: 'tokenise'` became 'block' (every message
//     with a name in it refused instead of masked);
//   - `piiDetectionConfidenceThreshold: 70` (a percentage) was stored as 70,
//     and no detector ever scores above 1 — detection silently off;
//   - a list that was not a list (`customSensitiveTerms: {…}`) became [],
//     which WIPED the org's own sensitive terms;
//   - `scope: { userInput: true }` switched output scanning off.
//
// Custom terms keep their own reader: an invalid pattern is reported per term
// in `termErrors` while the rest of the shield is saved (the page shows each
// one), so the schema only insists that the list IS a list. The "Your own
// data" types (`customDataTypes`) work the same way with `typeErrors`
// (core/privacy/customTypes/shieldDoc.js); their test sets
// (`customDataTests`) are stored encrypted and apart, never in this row.

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const documentOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the Privacy Shield settings as a JSON object.' }).passthrough(),
);
const flag = (name) => z.boolean({ invalid_type_error: `${name} is true or false.` }).optional();
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) }).optional();
const textList = (name, max) => {
    const message = `${name} is a list of text.`;
    const list = z.array(z.string({ invalid_type_error: message }), { invalid_type_error: message });
    return (max ? list.max(max, `${name} holds at most ${max} entries.`) : list).optional();
};

const SWITCH_TEXT = 'Say whether the Privacy Shield is on: enabled is true or false.';
const THRESHOLD_TEXT = 'piiDetectionConfidenceThreshold is a number between 0.1 and 1 (0.7 is the tested setting).';
const FAIL_TEXT = (name) => `${name} is fail_closed or fail_open.`;
const masterSwitch = z.boolean({ required_error: SWITCH_TEXT, invalid_type_error: SWITCH_TEXT });
const threshold = z.number({ invalid_type_error: THRESHOLD_TEXT })
    .min(0.1, THRESHOLD_TEXT).max(1, THRESHOLD_TEXT).optional();

// `scope` was once stored verbatim, so an old row's scope can carry flags no
// runtime reads (`toolInput`, `toolOutput`); its keys get the same echo rule
// as the document's (refuseStrangers below). A flag left out reads as ON, the
// way a scope left out always has — it used to read as OFF.
const SCOPE_TEXT = 'scope says what is scanned: { userInput: true|false, agentOutput: true|false }.';
const scopeFlag = z.boolean({ invalid_type_error: SCOPE_TEXT }).optional();
const SCOPE_SHAPE = { userInput: scopeFlag, agentOutput: scopeFlag };
const Scope = z.object(SCOPE_SHAPE, { invalid_type_error: SCOPE_TEXT }).passthrough();

const POLICY_TEXT = 'toolPiiPolicy is { external: { blockCategories: [...] }, internal: { blockCategories: [...] } }.';
const BlockList = z.object({ blockCategories: textList('blockCategories') }, { invalid_type_error: POLICY_TEXT }).strict();
const ToolPiiPolicy = z.object({
    external: BlockList.optional(),
    internal: BlockList.optional(),
}, { invalid_type_error: POLICY_TEXT }).strict();

const ALLOW_TEXT = 'piiAllowTerms is a list of terms (text) that are never treated as personal data.';
const AllowTerm = z.union([
    z.string(),
    // The shape older rows hold; the reader (allowTerms.js) still accepts it.
    z.object({ term: z.string() }).passthrough(),
], { errorMap: () => ({ message: ALLOW_TEXT }) });

const ORG_SHAPE = {
    enabled: masterSwitch,
    collectionIds: textList('collectionIds'),
    scope: Scope.optional(),
    action: choice(['delete', 'redact'], 'action is delete or redact.'),
    euModeEnabled: flag('euModeEnabled'),
    webSearchGuardEnabled: flag('webSearchGuardEnabled'),
    disableSearchOnUpload: flag('disableSearchOnUpload'),
    piiDetectionCategories: textList('piiDetectionCategories'),
    piiDetectionConfidenceThreshold: threshold,
    piiDetectionAction: choice(['block', 'tokenize', 'warn'], 'piiDetectionAction is block, tokenize or warn.'),
    piiFailureMode: choice(['fail_closed', 'fail_open'], FAIL_TEXT('piiFailureMode')),
    attachmentLargeInputPolicy: choice(['fail_open', 'fail_closed'], FAIL_TEXT('attachmentLargeInputPolicy')),
    webSearchGuardPiiCategories: textList('webSearchGuardPiiCategories'),
    toolPiiPolicy: ToolPiiPolicy.optional(),
    monitorIntegrations: flag('monitorIntegrations'),
    applyToAutomations: flag('applyToAutomations'),
    privacy_scan_knowledge_bases: flag('privacy_scan_knowledge_bases'),
    dlpEnabled: flag('dlpEnabled'),
    dlpScope: choice(['external', 'all'], 'dlpScope is external or all.'),
    dlpMode: choice(['ask', 'auto_redact', 'block'], 'dlpMode is ask, auto_redact or block.'),
    dlpAlwaysReview: flag('dlpAlwaysReview'),
    dlpFailureMode: choice(['fail_closed', 'fail_open'], FAIL_TEXT('dlpFailureMode')),
    dlpAllowlistedHosts: textList('dlpAllowlistedHosts', 50),
    customSensitiveTerms: z.array(z.unknown(), { invalid_type_error: 'customSensitiveTerms is a list of terms.' }).optional(),
    customDataTypes: z.array(z.unknown(), { invalid_type_error: 'customDataTypes is a list of data types.' }).optional(),
    customDataTests: z.object({}, { invalid_type_error: 'customDataTests is an object keyed by data type id.' }).passthrough().optional(),
    piiAllowTerms: z.array(AllowTerm, { invalid_type_error: ALLOW_TEXT }).optional(),
    piiAllowPublicOrgs: flag('piiAllowPublicOrgs'),
    showRawPayload: flag('showRawPayload'),
};
const OrgShieldBody = documentOf(ORG_SHAPE);

const USER_SHAPE = {
    enabled: masterSwitch,
    euModeEnabled: flag('euModeEnabled'),
    disableSearchOnUpload: flag('disableSearchOnUpload'),
    piiDetectionEnabled: flag('piiDetectionEnabled'),
    piiDetectionCategories: textList('piiDetectionCategories'),
    piiDetectionConfidenceThreshold: threshold,
    piiDetectionAction: choice(['block', 'tokenize'], 'piiDetectionAction is block or tokenize.'),
    piiFailureMode: choice(['fail_closed', 'fail_open'], FAIL_TEXT('piiFailureMode')),
    showRawPayload: flag('showRawPayload'),
};
const UserShieldBody = documentOf(USER_SHAPE);

// Keys the GET answers with that are the SERVER's to write. A client that
// sends the document back verbatim sends these too; they are ignored.
const ECHOED = new Set(['stalenessWarnings', 'clamped_fields', 'clamped_tier', 'updatedAt', 'updatedBy', 'implicitDefault']);

// The test sets of the "Your own data" types: an encrypted row of their own
// (core/privacy/customData/testsStore.js), read and written through THIS
// file's configStore.
let _testsStore = null;
function _customTests() {
    if (!_testsStore) {
        const m = require('../core/privacy/customData/testsStore');
        _testsStore = { sanitizeTests: m.sanitizeTests, ...m.createTestsStore({ configStore }) };
    }
    return _testsStore;
}

/**
 * The org's test sets for a response, or undefined when they cannot be read.
 * Undefined, not `{}`: a page that got `{}` would save `{}` back and wipe
 * sets that only failed to load this once.
 */
async function _readTestsForResponse(orgId, types) {
    if (!types.length) return {};
    try {
        return (await _customTests().readTests(orgId)) || {};
    } catch (e) {
        log.warn(`[OrgPrivacyShield] test sets for org ${orgId} could not be read: ${e.message}`);
        return undefined;
    }
}

/** Built-in part of a category list: every string that is not a custom type id. */
const _builtInPart = (list, max = Infinity) => (Array.isArray(list)
    ? list.filter(c => typeof c === 'string' && !isCustomTypeId(c)).slice(0, max)
    : []);

/**
 * Refuse a key nobody reads, unless it is an echo of the stored row.
 * Throws the same 400 `validate` answers with, naming every stranger.
 */
function refuseStrangers(body, stored, shape, where = 'body') {
    const has = (obj, k) => !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, k);
    const strangers = Object.keys(body || {}).filter((k) => !has(shape, k) && !ECHOED.has(k) && !has(stored, k));
    if (!strangers.length) return;
    const name = (k) => (where === 'body' ? k : `${where.slice('body.'.length)}.${k}`);
    const details = strangers.map((k) => ({ path: `${where}.${k}`, message: `${name(k)} is not a Privacy Shield setting.` }));
    throw badRequest('invalid_request', details[0].message, details);
}

// Lazy-required to avoid pulling the licence module into the route's
// import chain at boot. Licence module depends on stores/userStore which
// some test fixtures stub — keeping this lazy preserves backward compat.
let _license = null;
function _licenseModule() {
    if (!_license) _license = require('../license');
    return _license;
}

/**
 * Returns the tier-driven clamps that apply to a privacy-shield config
 * for the given org. Resolves the tier (via the licence resolver, which
 * already honours the server-wide override) and returns the set of
 * fields that need clamping.
 *
 *   - `pii_tokenize` missing → piiDetectionAction must be 'block'
 *   - `web_search_guard` missing → webSearchGuardEnabled = false,
 *                                  webSearchGuardPiiCategories = []
 *
 * Returns { tier, hasPiiTokenize, hasWebSearchGuard }.
 */
async function _tierClamps({ organizationId, userId }) {
    try {
        const lic = _licenseModule();
        const tier = await lic.resolveTier({ organizationId, userId });
        return {
            tier,
            hasPiiTokenize: lic.tiers.tierHasFeature(tier, 'pii_tokenize'),
            hasWebSearchGuard: lic.tiers.tierHasFeature(tier, 'web_search_guard'),
        };
    } catch (e) {
        // Fail closed: if tier resolution breaks we clamp to the
        // strictest community-tier behaviour. Prevents an upgrade from
        // accidentally getting downgraded; the affected admin sees the
        // clamped values, retries, and gets the real ones.
        log.warn('[OrgPrivacyShield] tier resolve failed, applying community clamps:', e.message);
        return { tier: 'community', hasPiiTokenize: false, hasWebSearchGuard: false };
    }
}

/**
 * In-place clamp of a stored config blob to the tier's allowed values.
 * Returns the list of fields that had to be clamped so the caller can
 * surface a `clamped_fields` marker in the response.
 */
function _applyTierClamps(config, { hasWebSearchGuard }) {
    const clamped = [];
    // NOTE: `piiDetectionAction` is intentionally NOT clamped to 'block' anymore.
    // An explicitly-saved "tokenize" is honored end-to-end (see
    // orgShield.applyTierClampsToShield). The SPA already gates SELECTING tokenize
    // via `canTokenizePii`, so the page shows + persists the admin's real choice.
    if (!hasWebSearchGuard) {
        if (config.webSearchGuardEnabled) {
            config.webSearchGuardEnabled = false;
            clamped.push('webSearchGuardEnabled');
        }
        if (Array.isArray(config.webSearchGuardPiiCategories) && config.webSearchGuardPiiCategories.length > 0) {
            config.webSearchGuardPiiCategories = [];
            clamped.push('webSearchGuardPiiCategories');
        }
        // External-tool PII blocking shares the Web-Search-Guard licence gate
        // (it's the generalization). Internal-tool blocking is left untouched
        // on every tier (the data never leaves the box).
        if (config.toolPiiPolicy?.external?.blockCategories?.length > 0) {
            config.toolPiiPolicy = {
                ...config.toolPiiPolicy,
                external: { blockCategories: [] },
            };
            clamped.push('toolPiiPolicy.external');
        }
    }
    return clamped;
}

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// "Your own data" test bench (assistant, test, tune): its own router, every
// route gated there (auth, rate limit, org admin, target-org licence).
router.use('/:orgId/custom-data', require('./orgCustomData'));

/**
 * Check if the current user is an admin for the given org.
 * Super admins (platform role=admin) can manage any org.
 * Org admins = users whose group belongs to the org AND group has admin role/permission.
 */
const { isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');

// GET /:orgId — get shield config
router.get('/:orgId', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    // Must be member of org or super admin
    const orgIds = await resolveUserOrgIds(req);
    const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
    if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

    const stored = await configStore.getConfig(`org_privacy_shield_${orgId}`);
    const config = stored || {
        enabled: false,
        collectionIds: [],
        scope: { userInput: true, agentOutput: true },
        action: 'delete',
        euModeEnabled: false,
        piiDetectionCategories: [],
        piiDetectionConfidenceThreshold: 0.7,
        piiDetectionAction: 'block',
        piiFailureMode: 'fail_closed',
        attachmentLargeInputPolicy: 'fail_open',
        webSearchGuardPiiCategories: [],
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
        monitorIntegrations: false,
        applyToAutomations: true,
        // Stated explicitly rather than left undefined: the runtime treats an
        // absent value as ON, so a UI that rendered `undefined` would show
        // "off" for a list that is actually active — a lie about what the
        // shield is doing.
        piiAllowTerms: [],
        piiAllowPublicOrgs: true,
    };

    // Seed the PII fields from the global AI config ONLY for an org that has
    // never saved a shield row. Once a row exists we honour it verbatim —
    // otherwise a deliberately-saved empty category list (the "None" button)
    // or a narrowed selection would be silently resurrected from the global
    // blob on every reload, so the admin's choice never sticks.
    if (!stored) {
        const aiBlob = await configStore.getConfig('ai') || {};
        if (!config.piiDetectionCategories?.length) {
            config.piiDetectionCategories = aiBlob.piiDetectionCategories || [];
        }
        if (config.piiDetectionConfidenceThreshold === undefined) {
            config.piiDetectionConfidenceThreshold = aiBlob.piiDetectionConfidenceThreshold ?? 0.7;
        }
        if (!config.piiDetectionAction) {
            config.piiDetectionAction = aiBlob.piiDetectionAction || 'block';
        }
    }

    // Annotate with resolved-shield warnings so the admin UI can flag
    // orphaned collection / rule references. resolveOrgShield returns null
    // when the shield is disabled, so this is best-effort.
    try {
        const { resolveOrgShield } = require('../core/privacy/orgShield');
        const resolved = await resolveOrgShield(orgId);
        if (resolved?.stalenessWarnings?.length) {
            config.stalenessWarnings = resolved.stalenessWarnings;
        }
    } catch (_) { /* non-fatal */ }

    // Tier-driven clamps: a community-tier read of a stored config
    // that pre-dates the tightening must surface the EFFECTIVE values
    // the runtime will honour, not the stale-stored ones — otherwise
    // the admin UI shows "tokenize" while the backend silently treats
    // PII as block-only. We don't rewrite the stored row; we only
    // clamp the response payload. Deep-clone first so we never mutate
    // the (potentially shared) configStore reference.
    const clamps = await _tierClamps({ organizationId: orgId, userId: req.session?.user?.id });
    const responseConfig = JSON.parse(JSON.stringify(config));
    const clampedFields = _applyTierClamps(responseConfig, clamps);

    // "Your own data": always the type list (migrated from the old terms when
    // the row predates it); the test sets only for an admin of an org that
    // has the feature. The licence is the TARGET org's.
    const customFeature = await hasCustomDataFeature(orgId, _licenseModule());
    clampedFields.push(...customShieldDoc.applyToGetResponse(responseConfig, { orgId, stored, featureEnabled: customFeature }));
    if (customFeature && await isOrgAdmin(req, orgId)) {
        const tests = await _readTestsForResponse(orgId, responseConfig.customDataTypes);
        if (tests !== undefined) responseConfig.customDataTests = tests;
    }

    if (clampedFields.length > 0) {
        responseConfig.clamped_fields = clampedFields;
        responseConfig.clamped_tier = clamps.tier;
    }

    res.json(responseConfig);
});

// PUT /:orgId — save shield config (org admin or super admin only)
router.put('/:orgId', requireAuth, validate({ body: OrgShieldBody }), async (req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdmin(req, orgId))) {
        return res.status(403).json({ error: 'Only organization admins can manage the privacy shield' });
    }
    const storedRow = await configStore.getConfig(`org_privacy_shield_${orgId}`);
    refuseStrangers(req.body, storedRow, ORG_SHAPE);
    refuseStrangers(req.body.scope, storedRow && storedRow.scope, SCOPE_SHAPE, 'body.scope');

    const { enabled, collectionIds, scope, action, euModeEnabled, webSearchGuardEnabled, disableSearchOnUpload, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionAction, piiFailureMode, webSearchGuardPiiCategories, toolPiiPolicy, monitorIntegrations, applyToAutomations,
        // Screen documents on their way INTO a knowledge base (K4). The page
        // has sent it since that setting existed; this handler never wrote it,
        // so "off" was dropped on every save and the runtime read the absent
        // key as ON (orgShield.js / ingestPrivacy.js: `!== false`).
        privacy_scan_knowledge_bases,
        // Large-file / attachment scan policy
        attachmentLargeInputPolicy,
        // DLP
        dlpEnabled, dlpScope, dlpMode, dlpAlwaysReview, dlpFailureMode, dlpAllowlistedHosts,
        // Never-redact allowlist — the mirror image of customSensitiveTerms:
        // values that must NOT be treated as personal data (public company
        // names, product names). See server/core/dlp/allowTerms.js.
        piiAllowTerms, piiAllowPublicOrgs,
        // Transparency
        showRawPayload } = req.body;

    // "Your own data": the type list, their switches (ids in the category
    // lists), the mirror written to customSensitiveTerms, the licence of the
    // TARGET org. The old custom-terms validation lives there too and still
    // answers `termErrors`.
    const customFeature = await hasCustomDataFeature(orgId, _licenseModule());
    const custom = await customShieldDoc.planPut({
        orgId, body: req.body, storedRow, featureEnabled: customFeature,
        userId: req.session.user.id, configStore,
    });
    const termErrors = custom.termErrors;
    const typeErrors = [...custom.typeErrors];
    const customClamped = [...custom.clamped];

    // Test sets are checked before anything is written (a set over its size
    // limit refuses the whole save) and stored after the shield is.
    let customTestsDoc = null;
    if (req.body.customDataTests !== undefined) {
        if (customFeature) {
            const { doc, errors } = _customTests().sanitizeTests(req.body.customDataTests, {
                typeIds: custom.customDataTypes.map(t => t.id),
                methods: Object.fromEntries(custom.customDataTypes.map(t => [t.id, t.method])),
            });
            customTestsDoc = doc;
            typeErrors.push(...errors);
        } else {
            customClamped.push('customDataTests');
        }
    }

    // Sanitize the per-tool-class block policy: coerce each class to a
    // { blockCategories: string[] } shape, drop non-strings, cap length.
    // Built-in categories as before; the org's own types after them.
    const sanitizedToolPiiPolicy = {
        external: { blockCategories: [..._builtInPart(toolPiiPolicy?.external?.blockCategories, 40), ...custom.lists.external] },
        internal: { blockCategories: [..._builtInPart(toolPiiPolicy?.internal?.blockCategories, 40), ...custom.lists.internal] },
    };

    const config = {
        enabled: !!enabled,
        collectionIds: Array.isArray(collectionIds) ? collectionIds : [],
        // Drop legacy `toolInput`/`toolOutput` scope flags — no runtime code
        // reads them, and keeping them in the form just confuses admins.
        scope: {
            userInput: scope?.userInput !== false,
            agentOutput: scope?.agentOutput !== false,
        },
        action: action === 'redact' ? 'redact' : 'delete',
        euModeEnabled: !!euModeEnabled,
        webSearchGuardEnabled: !!webSearchGuardEnabled,
        disableSearchOnUpload: !!disableSearchOnUpload,
        piiDetectionCategories: [..._builtInPart(piiDetectionCategories), ...custom.lists.pii],
        piiDetectionConfidenceThreshold: typeof piiDetectionConfidenceThreshold === 'number' ? piiDetectionConfidenceThreshold : 0.7,
        piiDetectionAction: ['block', 'tokenize', 'warn'].includes(piiDetectionAction) ? piiDetectionAction : 'block',
        // Policy when detection can't fully run (guard unreachable / GLiNER
        // model not ready). Default fail_closed so we never silently send
        // unmasked text to the LLM (BFSF-269).
        piiFailureMode: piiFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        // Policy for the UNSCANNED part of a large upload (page-cap overflow /
        // scan timeout). Default fail_open preserves today's pass-through for
        // big docs — but now VISIBLY (amber warning + audit), never silent.
        // Admins opt into fail_closed (block/hold). See attachmentScanner.js.
        attachmentLargeInputPolicy: attachmentLargeInputPolicy === 'fail_closed' ? 'fail_closed' : 'fail_open',
        webSearchGuardPiiCategories: [..._builtInPart(webSearchGuardPiiCategories), ...custom.lists.webSearch],
        toolPiiPolicy: sanitizedToolPiiPolicy,
        monitorIntegrations: !!monitorIntegrations,
        // Whether the shield also guards automation/routine runs.
        // Default TRUE (an omitted field never silently disables guarding).
        applyToAutomations: applyToAutomations !== false,
        // `!== false` for the same reason as piiAllowPublicOrgs below: the
        // runtime reads an absent key as ON, so an absent field is ON here too.
        privacy_scan_knowledge_bases: privacy_scan_knowledge_bases !== false,
        // DLP fields
        dlpEnabled: !!dlpEnabled,
        dlpScope: dlpScope === 'all' ? 'all' : 'external',
        dlpMode: ['ask', 'auto_redact', 'block'].includes(dlpMode) ? dlpMode : 'ask',
        // Pause for review even on a clean scan (0 findings) — the only
        // way to catch a false negative. Default off, opt-in per org.
        dlpAlwaysReview: !!dlpAlwaysReview,
        dlpFailureMode: dlpFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        dlpAllowlistedHosts: Array.isArray(dlpAllowlistedHosts) ? dlpAllowlistedHosts.slice(0, 50).map(String) : [],
        // A written MIRROR of the enforced words/pattern types, for one
        // release: a rollback to a server without types still hides them.
        customSensitiveTerms: custom.mirror,
        customDataTypes: custom.customDataTypes,
        // Never-redact allowlist. Normalised to bare strings on write; the
        // reader still accepts legacy `{ term }` objects (allowTerms.js).
        piiAllowTerms: Array.isArray(piiAllowTerms)
            ? piiAllowTerms
                .map(v => (typeof v === 'string' ? v : v?.term))
                .filter(v => typeof v === 'string' && v.trim())
                .map(v => v.trim().slice(0, 120))
                .slice(0, 500)
            : [],
        // `!== false`, never `!!`. The shipped public-organisation list is ON
        // by default (allowTerms.js:51 reads it the same way), so an absent
        // field must not persist as "off" — that would silently start
        // redacting Microsoft, PostNL and the rest for every org that saves.
        piiAllowPublicOrgs: piiAllowPublicOrgs !== false,
        showRawPayload: !!showRawPayload,
        updatedAt: new Date().toISOString(),
        updatedBy: req.session.user.id,
    };

    // Tier-driven clamps: on community tier we force
    // piiDetectionAction → 'block' and webSearchGuardEnabled → false
    // BEFORE persisting, so the stored row matches what the runtime
    // will honour. Enterprise+ (or a server-wide override) passes
    // through unchanged. The clamp persists in the row: when the
    // customer later upgrades the value stays 'block' and they must
    // re-pick 'tokenize' to opt in — safer default after an upgrade
    // than silently re-enabling a stricter mode.
    const clamps = await _tierClamps({ organizationId: orgId, userId: req.session?.user?.id });
    const clampedFields = _applyTierClamps(config, clamps);

    await configStore.setConfig(`org_privacy_shield_${orgId}`, config);

    // The save route is the registry's other writer (resolveOrgShield is the
    // first): this replica scans with the new types from the next request on;
    // the others pick them up when the configStore invalidation lands.
    customTypeRegistry.syncOrg(orgId, custom.enforced);

    let customTestsOut = customTestsDoc;
    if (customTestsDoc) {
        await _customTests().writeTests(orgId, customTestsDoc);
    } else if (custom.removedIds.length) {
        // A removed type's test sentences go with it. Best effort: the shield
        // itself is saved.
        try {
            const current = await _customTests().readTests(orgId);
            if (current && custom.removedIds.some(id => id in current)) {
                const { doc } = _customTests().sanitizeTests(current, { typeIds: custom.customDataTypes.map(t => t.id) });
                await _customTests().writeTests(orgId, doc);
                customTestsOut = doc;
            }
        } catch (e) {
            log.warn(`[OrgPrivacyShield] could not prune test sets for org ${orgId}: ${e.message}`);
        }
    }

    // DLP posture changed — re-run the Art-32 DLP compliance check now
    // instead of waiting for the 6-hour sweep. Fire-and-forget.
    try {
        const events = require('../compliance/events');
        events.emit(events.EVENTS.DLP_CONFIG_CHANGED, { orgId });
    } catch (_) { /* compliance bus is best-effort */ }

    // NOTE: we used to copy this org's PII / Azure / severity settings into
    // the global `ai` configStore blob here. That caused a cross-org leak:
    // org A saving a stricter threshold changed the defaults for org B.
    // The runtime already reads org shield first (resolveOrgShield) and
    // falls back to the global blob only when the org has no config, so
    // the sync-write served no purpose. It was removed in the Privacy
    // Shield redesign.

    clampedFields.push(...customClamped.filter(f => !clampedFields.includes(f)));
    log.info(`[OrgPrivacyShield] Saved config for org ${orgId} by ${req.session.user.id}${termErrors.length ? ` (with ${termErrors.length} invalid term(s))` : ''}${typeErrors.length ? ` (with ${typeErrors.length} data type error(s))` : ''}${clampedFields.length ? ` (clamped ${clampedFields.join(',')} for tier=${clamps.tier})` : ''}`);
    // If some custom terms or types failed, the rest of the shield and the
    // valid ones are still persisted. The client shows per-term errors from
    // `termErrors`, per-type errors from `typeErrors`, and keeps the user's
    // other edits in place.
    const responseConfig = { ...config };
    if (customFeature) {
        const tests = customTestsOut || await _readTestsForResponse(orgId, custom.customDataTypes);
        if (tests !== undefined) responseConfig.customDataTests = tests;
    }
    const response = { ok: true, config: responseConfig, termErrors, typeErrors };
    if (clampedFields.length > 0) {
        response.clamped_fields = clampedFields;
        response.clamped_tier = clamps.tier;
    }
    res.json(response);
});


// GET /:orgId/effective — inspection-only view of the config the runtime
// actually sees for this org. Useful after a deploy to verify that custom
// deploys aren't stuck on a legacy config shape, or that PII/DLP is
// really enabled (not just toggled in the UI). Mirrors what
// `resolveOrgShield` returns — same fields, same defaults, same warnings.
router.get('/:orgId/effective', requireAuth, async (req, res) => {
    const { orgId } = req.params;
    const orgIds = await resolveUserOrgIds(req);
    const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
    if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

    const raw = await configStore.getConfig(`org_privacy_shield_${orgId}`);
    const { resolveOrgShield } = require('../core/privacy/orgShield');
    const resolved = await resolveOrgShield(orgId);
    const summary = resolved ? {
        shieldEnabled: resolved.enabled,
        piiEnabled: resolved.enabled,
        piiCategoriesCount: (resolved.piiDetectionCategories || []).length,
        piiConfidenceThreshold: resolved.piiDetectionConfidenceThreshold,
        piiConfidenceWarning: resolved.piiDetectionConfidenceThreshold >= 0.85
            ? 'Threshold is unusually high; the detector may return scores below this value. Lower to 0.70 if PII does not fire.'
            : null,
        dlpEnabled: resolved.dlpEnabled,
        privacyScanEnabled: resolved.privacyScanEnabled,
        privacyAction: resolved.privacyAction,
        privacyScope: resolved.privacyScope,
        customTermsCount: (resolved.customSensitiveTerms || []).length,
        customTypesCount: (resolved.customDataTypes || []).length,
        stalenessWarnings: resolved.stalenessWarnings || [],
    } : { shieldEnabled: false };

    const rawShape = raw && typeof raw === 'object' ? {
        hasPrivacyScanEnabled: 'privacyScanEnabled' in raw,
        hasAzurePiiEnabled: 'azurePiiEnabled' in raw,
        hasDlpEnabled: 'dlpEnabled' in raw,
        hasPiiDetectionAction: 'piiDetectionAction' in raw,
        hasDlpMode: 'dlpMode' in raw,
        legacyShape: ('azurePiiEnabled' in raw || 'piiDetectionAction' in raw) && !('privacyScanEnabled' in raw),
        updatedAt: raw.updatedAt || null,
        updatedBy: raw.updatedBy || null,
    } : null;

    res.json({ orgId, summary, rawShape, resolved });
});


// ═══════════════════════════════════════
//  User-level Privacy Shield (Consumer Accounts)
// ═══════════════════════════════════════

// Secure by default (BFSF-289) — shared with the runtime resolver and the
// consumer signup paths so the panel can never drift from what actually runs.
const { USER_SHIELD_DEFAULTS } = require('../core/privacy/userShieldDefaults');

// GET /user/guard-status — is PII detection actually able to run?
//
// The personal Privacy panel used to give no indication whether the PII Guard
// service exists, so "shield on, guard not configured" looked identical to
// "shield on and working" while `detectPii()` quietly failed open. Two
// segments so it can't be swallowed by the `/:orgId` route above.
router.get('/user/guard-status', requireAuth, async (req, res) => {
    try {
        const { getGuardEndpoint } = require('../core/privacy/piiDetection');
        const endpoint = await getGuardEndpoint();
        if (!endpoint?.url) {
            return res.json({ configured: false, reachable: false });
        }
        const { probeGuardHealth } = require('../services/guardInstaller');
        const health = await probeGuardHealth(endpoint.url, endpoint.apiKey);
        res.json({ configured: true, reachable: !!health });
    } catch (e) {
        // Never break the settings page over a status probe.
        log.warn('[UserPrivacyShield] guard-status probe failed:', e.message);
        res.json({ configured: false, reachable: false });
    }
});

// GET /user/me — get user-level shield config (consumer accounts)
router.get('/user/me', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const stored = await configStore.getConfig(`user_privacy_shield_${userId}`);
    if (stored) {
        return res.json({ ...USER_SHIELD_DEFAULTS, ...stored });
    }
    // Legacy migration: users who turned on EU mode through the
    // (now-removed) Startup Agent toggle had it written to
    // `user_eu_mode_${userId}`. Surface that as enabled+euModeEnabled
    // so the new panel reflects their existing preference; the next
    // Save through the panel persists into the canonical key.
    const legacyEu = await configStore.getConfig(`user_eu_mode_${userId}`);
    if (legacyEu === true) {
        return res.json({ ...USER_SHIELD_DEFAULTS, enabled: true, euModeEnabled: true, implicitDefault: true });
    }
    // `implicitDefault` tells the panel these values are the secure
    // defaults in force rather than a saved choice (BFSF-289), so it can
    // label them instead of pretending the user configured them.
    res.json({ ...USER_SHIELD_DEFAULTS, implicitDefault: true });
});

// PUT /user/me — save user-level shield config (consumer accounts)
router.put('/user/me', requireAuth, validate({ body: UserShieldBody }), async (req, res) => {
    const userId = req.session.user.id;
    refuseStrangers(req.body, await configStore.getConfig(`user_privacy_shield_${userId}`), USER_SHAPE);
    const {
        enabled, euModeEnabled, disableSearchOnUpload,
        piiDetectionEnabled, piiDetectionCategories,
        piiDetectionConfidenceThreshold, piiDetectionAction, piiFailureMode,
        showRawPayload,
    } = req.body;

    // The schema holds it to 0.1–1. It used to be CLAMPED there, and a
    // clamp runs the wrong way for this number: `70` (a percentage) became
    // 1, the setting at which the detector finds almost nothing.
    const threshold = typeof piiDetectionConfidenceThreshold === 'number' ? piiDetectionConfidenceThreshold : 0.7;

    const config = {
        enabled: !!enabled,
        euModeEnabled: !!euModeEnabled,
        disableSearchOnUpload: !!disableSearchOnUpload,
        piiDetectionEnabled: !!piiDetectionEnabled,
        piiDetectionCategories: Array.isArray(piiDetectionCategories) ? piiDetectionCategories : [],
        piiDetectionConfidenceThreshold: threshold,
        piiDetectionAction: ['block', 'tokenize'].includes(piiDetectionAction) ? piiDetectionAction : 'tokenize',
        piiFailureMode: piiFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        showRawPayload: !!showRawPayload,
        updatedAt: new Date().toISOString(),
        updatedBy: userId,
    };

    await configStore.setConfig(`user_privacy_shield_${userId}`, config);
    log.info(`[UserPrivacyShield] Saved config for user ${userId}`);
    res.json({ ok: true, config });
});

module.exports = router;
