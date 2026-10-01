// @typecheck
/**
 * Organization Privacy Shield — resolve org-level regex guardrail rules
 * 
 * Used by agentRuntime.js and directChat.js to enforce org-wide guardrails
 * before agent-specific or direct-chat-specific guardrails.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');
const { applyCustomTypes, deriveCustomState } = require('./customTypes/resolve');

/**
 * The seams resolveOrgShield reads through. Production never touches this;
 * a test swaps a field instead of intercepting the module system.
 */
const _deps = {
    configStore,
    getAIConfig: () => require('../aiAgent').getAIConfig(),
    license: () => _licenseModule(),
};

// ── Tier-driven shield clamps ─────────────────────────────────────────
//
// The licence-aware Privacy Shield clamps in server/routes/orgPrivacyShield.js
// stop tokenize / web-search-guard from being SAVED on community tier.
// This helper applies the same clamps when the runtime READS a stored
// row directly via configStore — covers stale pre-clamp rows and the
// guardrailsRunner / piiDetection read paths that bypass the route's
// GET handler.
//
// Lazy-required to avoid a circular import (license → store/userStore →
// orgShield is a possible chain through future hot-path additions).
let _license = null;
function _licenseModule() {
    if (!_license) _license = require('../../license/index');
    return _license;
}

/**
 * Mutates `shield` in-place to enforce tier-driven clamps:
 *   - `pii_tokenize` missing → piiDetectionAction → 'block'
 *   - `web_search_guard` missing → webSearchGuardEnabled = false,
 *                                  webSearchGuardPiiCategories = []
 *
 * Safe to call with null/undefined; no-op when nothing to clamp.
 * Fails closed: any resolver error falls back to community-tier clamps
 * (strictest), matching server/routes/orgPrivacyShield.js _tierClamps.
 * @param shield
 * @param {{ organizationId?: string, userId?: string }} [opts]
 */
async function applyTierClampsToShield(shield, { organizationId, userId } = {}) {
    if (!shield || typeof shield !== 'object') return shield;
    let hasWebSearchGuard = false;
    try {
        const lic = _deps.license();
        const tier = await lic.resolveTier({ organizationId, userId });
        hasWebSearchGuard = lic.tiers.tierHasFeature(tier, 'web_search_guard');
    } catch (_) {
        // fail closed — leave `false`, strictest clamp applies
    }
    // NOTE: we deliberately do NOT clamp `piiDetectionAction` down to 'block'
    // here. An explicitly-saved "tokenize" is honored everywhere (text chat
    // already reads the raw config and tokenizes; clamping only the attachment /
    // file path produced the "files get blocked but text tokenizes" split).
    // Entitlement is gated where the admin SELECTS the action (the SPA's
    // `canTokenizePii`, which is grant- + operator-floor-aware); tokenizing is a
    // privacy/safety action, so honoring the chosen value is the safe default.
    if (!hasWebSearchGuard) {
        shield.webSearchGuardEnabled = false;
        shield.webSearchGuardPiiCategories = [];
        // Tool-call PII blocking for EXTERNAL tools is the generalization of
        // Web Search Guard, so it shares the same licence gate. Internal-tool
        // blocking stays available on every tier (the data never leaves the
        // box, and it's the differentiator a community org would want).
        if (shield.toolPiiPolicy && shield.toolPiiPolicy.external) {
            shield.toolPiiPolicy = {
                ...shield.toolPiiPolicy,
                external: { blockCategories: [] },
            };
        }
    }
    return shield;
}

/**
 * Resolve org privacy shield rules for a given organization ID.
 * Returns null if no shield is configured or enabled.
 * 
 * @param {string} orgId - Organization ID
 * @returns {Promise<{ enabled: boolean, rulesWithNames: Array, scope: object, action: string, [key: string]: any } | null>}
 *   plus every other field of the stored shield config (dlpEnabled, euModeEnabled, ...)
 */
async function resolveOrgShield(orgId) {
    if (!orgId) return null;

    const shield = await _deps.configStore.getConfig(`org_privacy_shield_${orgId}`);
    if (!shield?.enabled) return null;

    // Apply tier-driven clamps before any further resolution so a
    // pre-clamp stored row can't sneak a tokenize PII action or active
    // Web Search Guard past the licence on a community install.
    await applyTierClampsToShield(shield, { organizationId: orgId });

    // Need global regex config to resolve collection IDs to actual rules
    const globalConfig = await _deps.getAIConfig();
    const globalRegexConfig = globalConfig.regexGuardrails || {};
    const globalRules = globalRegexConfig.rules || [];
    const globalCollections = globalRegexConfig.collections || [];

    const rulesWithNames = [];
    const stalenessWarnings = [];
    if (shield.collectionIds?.length > 0) {
        for (const colId of shield.collectionIds) {
            const collection = globalCollections.find(c => c.id === colId);
            if (!collection) {
                // The collection was deleted but the shield still references it
                // → the org's regex guard silently stops firing. Surface this to
                // the admin UI without blowing up the runtime (the existing
                // behaviour of silently skipping is preserved).
                stalenessWarnings.push({ collectionId: colId, reason: 'collection_not_found' });
                continue;
            }
            const resolvedRules = [];
            for (const ruleId of collection.ruleIds || []) {
                const rule = globalRules.find(r => r.id === ruleId);
                if (rule?.pattern) {
                    resolvedRules.push({ name: rule.name, pattern: rule.pattern });
                } else {
                    stalenessWarnings.push({ collectionId: colId, ruleId, reason: 'rule_not_found' });
                }
            }
            if (resolvedRules.length === 0) {
                stalenessWarnings.push({ collectionId: colId, reason: 'collection_empty' });
            }
            rulesWithNames.push(...resolvedRules);
        }
    }

    const resolved = {
        enabled: true,
        rulesWithNames,
        stalenessWarnings,
        // Only userInput / agentOutput are honoured at runtime; any lingering
        // toolInput / toolOutput from older saves is silently dropped.
        scope: shield.scope
            ? { userInput: !!shield.scope.userInput, agentOutput: !!shield.scope.agentOutput }
            : { userInput: true, agentOutput: true },
        action: shield.action || 'delete',
        // PII detection — the master `enabled` flag above is the single switch.
        // azurePiiEnabled / localPiiEnabled are kept on the persisted doc for
        // backwards-compatibility (old saves still parse) but are not surfaced
        // here and are ignored at runtime by piiDetection.js's gate.
        piiDetectionCategories: shield.piiDetectionCategories || [],
        piiDetectionConfidenceThreshold: shield.piiDetectionConfidenceThreshold,
        piiDetectionAction: shield.piiDetectionAction || globalConfig.piiDetectionAction || 'block',
        // Policy when PII detection can't fully run (guard unreachable / GLiNER
        // model not ready). Falls back to the DLP failure mode for older saves,
        // then fail_closed (BFSF-269).
        piiFailureMode: shield.piiFailureMode || shield.dlpFailureMode || 'fail_closed',
        /**
         * Screen documents on their way INTO a knowledge base (K4).
         *
         * `!== false` rather than a truthiness check: a row saved before this
         * setting existed has no key at all, and that is not the same as an
         * admin turning it off. A knowledge base keeps what it is given and
         * quotes it to people who never saw the original, so the default that
         * matches "I switched Privacy Shield on" is ON.
         */
        privacy_scan_knowledge_bases: shield.privacy_scan_knowledge_bases !== false,
        // Policy for the UNSCANNED part of a large upload (page-cap overflow /
        // scan timeout). Default fail_open preserves today's pass-through, but
        // now visibly (amber + audit). Admins opt into fail_closed (block/hold).
        attachmentLargeInputPolicy: shield.attachmentLargeInputPolicy === 'fail_closed' ? 'fail_closed' : 'fail_open',
        // Content moderation was removed; legacy fields stay on disk but
        // are no longer surfaced here.
        euModeEnabled: !!shield.euModeEnabled,
        webSearchGuardEnabled: !!shield.webSearchGuardEnabled,
        disableSearchOnUpload: !!shield.disableSearchOnUpload,
        monitorIntegrations: !!shield.monitorIntegrations,
        // Whether the shield also guards automation/routine runs. Default true
        // (older saves have no field) — an org must explicitly opt out.
        applyToAutomations: shield.applyToAutomations !== false,
        // Transparency: when true, the chat stream emits the tokenised outbound
        // prompt and the raw (pre-un-tokenise) LLM response as SSE events so
        // the user's "How I got this answer" panel can display exactly what
        // the AI saw and said. Default off so orgs have to opt in.
        showRawPayload: !!shield.showRawPayload,
        // The Web-Search Guard PII filter used to maintain its own separate
        // category list, which drifted from the main PII list. The new
        // contract: if Web-Search Guard is enabled and the admin hasn't
        // explicitly picked a subset, fall back to the main PII categories
        // so the two stay in sync. See plan S6.
        webSearchGuardPiiCategories: (Array.isArray(shield.webSearchGuardPiiCategories) && shield.webSearchGuardPiiCategories.length > 0)
            ? shield.webSearchGuardPiiCategories
            : (Array.isArray(shield.piiDetectionCategories) ? shield.piiDetectionCategories : []),
        // Per-tool-class PII block policy: PII categories the org refuses to
        // send into a tool. `external` = tools that leave the box (web search,
        // Gmail, MCP, n8n…); `internal` = on-box tools (notebook/workspace/
        // local integrations). Generalizes the legacy Web-Search Guard.
        toolPiiPolicy: synthesizeToolPiiPolicy(shield),
        // DLP (Data Loss Prevention) — interactive outbound scanner before
        // prompts reach external LLMs. Default off so existing orgs are unaffected.
        dlpEnabled: !!shield.dlpEnabled,
        dlpScope: shield.dlpScope || 'external',            // 'external' | 'all'
        dlpMode: shield.dlpMode || 'ask',                   // 'ask' | 'auto_redact' | 'block'
        // When true, `dlpRunner.scan()` pauses for review even when the
        // detector found nothing — the only way a user can catch a false
        // negative, since "ask" alone only ever pauses on an actual hit.
        // Default off: existing 'ask'-mode orgs see no behaviour change.
        dlpAlwaysReview: !!shield.dlpAlwaysReview,
        dlpFailureMode: shield.dlpFailureMode || 'fail_closed', // 'fail_closed' | 'fail_open'
        dlpAllowlistedHosts: shield.dlpAllowlistedHosts || [],
        customSensitiveTerms: Array.isArray(shield.customSensitiveTerms) ? shield.customSensitiveTerms : [],
        // Never-redact allowlist — the mirror of customSensitiveTerms: values
        // that must NOT be treated as personal data. Read by
        // core/dlp/allowTerms.js via buildAllowMatcher(orgShieldConfig).
        //
        // These MUST be passed through here. Every consumer (piiDetection.js,
        // dlpRunner.js) receives the object this function builds, field by
        // field — so a field that is stored and never listed here does not
        // reach the runtime at all. Omitting them made the org's own terms and
        // the public-list kill switch completely inert while the settings UI
        // happily saved them.
        piiAllowTerms: Array.isArray(shield.piiAllowTerms) ? shield.piiAllowTerms : [],
        // `!== false`: absent means ON, matching allowTerms.js and the route's
        // default. Using `!!` here would switch the shipped public-organisation
        // list off for every org whose row predates the field.
        piiAllowPublicOrgs: shield.piiAllowPublicOrgs !== false,
        // Canonical Privacy fields (the Guardrails Redesign).
        // Runtime code consumes these; legacy dlp*/piiDetection* fields are
        // still returned above for backwards compatibility while call-sites
        // migrate.
        ...synthesizePrivacyFields(shield, orgId),
    };
    // "Your own data": the org's types (migrated from customSensitiveTerms
    // when the row predates them), clamped to the TARGET org's licence
    // (Community keeps only migrated types), the category lists normalised,
    // and the process registry synced so a scan can turn an id back into a
    // matcher. Adds customDataTypes + customTypesDigest; never mutates `shield`.
    await applyCustomTypes(resolved, shield, orgId, { lic: _deps.license() });
    return resolved;
}

/**
 * Map stored legacy fields (`dlpEnabled`, `dlpMode`, `piiDetectionAction`,
 * …) onto the canonical Privacy fields (`privacyScanEnabled`,
 * `privacyAction`, `privacyScope`, `privacyFailureMode`).
 *
 * Rules:
 *   - `privacyScanEnabled` = dlpEnabled OR shield.enabled (the master flag)
 *   - `privacyAction` — if dlpMode is set (new feature), it wins; otherwise
 *     fall back to the legacy `piiDetectionAction` ('tokenize' → 'redact').
 *   - `privacyScope` = dlpScope ('external' by default)
 *   - `privacyFailureMode` = dlpFailureMode ('fail_closed' by default)
 *
 * This is read-only: the stored document is untouched, so we never risk a
 * destructive migration at deploy time.
 */
function synthesizePrivacyFields(shield, orgId) {
    const hasDlpMode = !!shield.dlpMode;
    const mapDlpMode = { ask: 'ask', auto_redact: 'redact', block: 'block' };
    const mapPiiAction = { block: 'block', tokenize: 'redact', redact: 'redact', warn: 'ask' };

    let privacyAction;
    if (hasDlpMode && mapDlpMode[shield.dlpMode]) {
        privacyAction = mapDlpMode[shield.dlpMode];
    } else if (shield.piiDetectionAction && mapPiiAction[shield.piiDetectionAction]) {
        privacyAction = mapPiiAction[shield.piiDetectionAction];
    } else {
        privacyAction = 'ask';
    }

    const privacyScanEnabled = !!(shield.dlpEnabled || shield.enabled);
    const migratedFromLegacy = !shield.privacyScanEnabled && privacyScanEnabled
        && !hasDlpMode && shield.piiDetectionAction;
    if (migratedFromLegacy) {
        // Once-per-process hint so ops can see who still needs a re-save.
        const key = orgId || '(unknown)';
        if (!_legacyLogged.has(key)) {
            _legacyLogged.add(key);
            log.info(`[OrgShield] Migrating legacy PII/DLP fields for org=${key} (on read). Next save will normalise.`);
        }
    }

    return {
        privacyScanEnabled,
        privacyAction,
        privacyScope: shield.dlpScope || 'external',
        privacyFailureMode: shield.dlpFailureMode || 'fail_closed',
    };
}

const _legacyLogged = new Set();

/**
 * Resolve the per-tool-class PII block policy from a stored shield doc.
 * Read-only (never mutates the stored doc), mirroring synthesizePrivacyFields.
 *
 * Canonical shape:
 *   { external: { blockCategories: string[] }, internal: { blockCategories: string[] } }
 *
 * Backward-compat: when no explicit `toolPiiPolicy` is stored, absorb the
 * legacy Web-Search Guard list into the EXTERNAL class — but ONLY when the
 * guard was actively blocking (`webSearchGuardEnabled === true`). Monitor-only
 * orgs (categories picked but guard disabled) must NOT silently become
 * blocking orgs, so they resolve to an empty policy.
 */
function synthesizeToolPiiPolicy(shield) {
    const empty = { external: { blockCategories: [] }, internal: { blockCategories: [] } };
    if (!shield || typeof shield !== 'object') return empty;
    const norm = (v) => ({
        blockCategories: (v && Array.isArray(v.blockCategories))
            ? v.blockCategories.filter(c => typeof c === 'string')
            : [],
    });
    const stored = shield.toolPiiPolicy;
    if (stored && typeof stored === 'object' && (stored.external || stored.internal)) {
        return { external: norm(stored.external), internal: norm(stored.internal) };
    }
    if (shield.webSearchGuardEnabled === true) {
        const legacy = (Array.isArray(shield.webSearchGuardPiiCategories) && shield.webSearchGuardPiiCategories.length > 0)
            ? shield.webSearchGuardPiiCategories
            : (Array.isArray(shield.piiDetectionCategories) ? shield.piiDetectionCategories : []);
        return { external: { blockCategories: legacy.filter(c => typeof c === 'string') }, internal: { blockCategories: [] } };
    }
    return empty;
}

/**
 * Classify a tool as 'external' (data leaves the org) or 'internal' (stays
 * on-box). Reuses integrationToolMap.resolveIntegration: it returns null for
 * internal-prefixed/unknown tools and sets `isLocal` for on-box integrations.
 *
 * Web-search tools are forced 'external' explicitly so the absorbed Web Search
 * Guard always fires; keep this regex in sync with the chatStream tool loop.
 *
 * `toolArgs` matters for tools whose destination depends on the call: a
 * create_word_document / create_presentation with `nextcloudPath` writes into
 * Nextcloud and is external; without it the file stays on-box.
 *
 * Pure + side-effect-free (lazy-requires the map to avoid a circular import).
 */
function classifyToolClass(toolName, toolArgs = {}) {
    if (/^(agent_search|web_search|search|brave_search|browse_web)$/i.test(toolName || '')) return 'external';
    // Custom integrations (cint_<slug>_<tool>, the AI Integration Builder) can
    // only reach a public HTTPS host: the runner and the custom MCP client both
    // go through customIntegrations/ssrfGuard, which refuses private targets.
    // So they always leave the org. resolveIntegration answers null for them
    // without the stored definition, which used to make every custom
    // integration 'internal': the org's "Outside tools" rules never applied.
    if (/^cint_/.test(toolName || '')) return 'external';
    let meta = null;
    try { meta = require('../integrations/integrationToolMap').resolveIntegration(toolName, toolArgs || {}); } catch (_) { /* treat as internal */ }
    if (!meta) return 'internal';            // internal/unknown tools (notebook_*, workspace_*, set_*, regex_*)
    if (meta.isLocal === true) return 'internal'; // local integrations (Nextcloud family, on-box whisper, …)
    return 'external';                       // any resolved integration leaving the box
}

/**
 * Decide whether a tool call must be refused given the categories of PII
 * detected in its (real-value) arguments and the resolved tool block policy.
 *
 * @param {string} toolName
 * @param {string[]} detectedCategories  canonical PII category ids (entity.category)
 * @param {object} policy                resolved toolPiiPolicy from resolveOrgShield
 * @param {object} [toolArgs]            the call's arguments (see classifyToolClass)
 * @returns {{ blocked: boolean, blockedCategories: string[], toolClass: string }}
 */
function isBlockedForTool(toolName, detectedCategories, policy, toolArgs = {}) {
    const toolClass = classifyToolClass(toolName, toolArgs);
    if (!policy || !Array.isArray(detectedCategories) || detectedCategories.length === 0) {
        return { blocked: false, blockedCategories: [], toolClass };
    }
    const blockList = (policy[toolClass] && Array.isArray(policy[toolClass].blockCategories))
        ? policy[toolClass].blockCategories
        : [];
    if (blockList.length === 0) return { blocked: false, blockedCategories: [], toolClass };
    const set = new Set(blockList);
    const hits = [...new Set(detectedCategories)].filter(c => set.has(c));
    return { blocked: hits.length > 0, blockedCategories: hits, toolClass };
}

/**
 * Merge org shield rules with agent/direct-chat rules.
 * Org rules come first. Action uses the stricter of the two ('delete' > 'redact').
 * Scope is merged with OR (if either enables a scope, it's enabled).
 * 
 * @param {object|null} orgConfig - From resolveOrgShield()
 * @param {object|null} localConfig - Agent or direct chat regex config
 * @returns {object|null} Merged config, or null if nothing enabled
 */
function mergeWithOrgShield(orgConfig, localConfig) {
    if (!orgConfig && !localConfig) return null;
    if (!orgConfig) return localConfig;
    if (!localConfig) return orgConfig;

    // Merge rules: org first, then local (dedup by pattern)
    const seenPatterns = new Set();
    const mergedRules = [];
    for (const r of [...orgConfig.rulesWithNames, ...localConfig.rulesWithNames]) {
        if (!seenPatterns.has(r.pattern)) {
            seenPatterns.add(r.pattern);
            mergedRules.push(r);
        }
    }

    // Action: strictest wins (delete > redact)
    const action = (orgConfig.action === 'delete' || localConfig.action === 'delete') ? 'delete' : 'redact';

    // Scope: OR merge. Only userInput and agentOutput are read at runtime;
    // the old toolInput/toolOutput fields were never consumed and have been
    // dropped from the accepted payload.
    const scope = {
        userInput: !!(orgConfig.scope?.userInput || localConfig.scope?.userInput),
        agentOutput: !!(orgConfig.scope?.agentOutput || localConfig.scope?.agentOutput),
    };

    return { enabled: true, rulesWithNames: mergedRules, scope, action, webSearchGuardEnabled: !!(orgConfig.webSearchGuardEnabled || localConfig.webSearchGuardEnabled), disableSearchOnUpload: !!(orgConfig.disableSearchOnUpload || localConfig.disableSearchOnUpload) };
}

/**
 * Boot-time self-check: walk every `org_privacy_shield_*` config and run it
 * through `resolveOrgShield`. Logs warnings for legacy shapes, orphaned
 * collections, and invalid custom-term regexes so an operator can spot issues
 * in the startup log before any user hits them.
 *
 * Never throws — a bad shield must never stop the server.
 */
async function selfCheckOrgShields() {
    try {
        const all = await _deps.configStore.getAllConfig() || {};
        const entries = Object.entries(all).filter(([k]) => k.startsWith('org_privacy_shield_'));
        if (entries.length === 0) {
            log.info('[OrgShieldSelfCheck] No org shields stored yet.');
            return;
        }
        let ok = 0, warnings = 0;
        // Running totals across all orgs so operators can see at a glance which
        // privacy features are actually active in this deployment. This is the
        // one place to notice "customer deploys without PII enabled" at a glance.
        const fleet = {
            total: entries.length,
            shieldEnabled: 0,
            piiEnabled: 0,
            dlpEnabled: 0,
            privacyScanEnabled: 0,
            euMode: 0,
            monitorIntegrations: 0,
            legacyShape: 0,
            customTypes: 0,
            re2Fallbacks: 0,
        };
        for (const [key, rawShield] of entries) {
            const orgId = key.replace(/^org_privacy_shield_/, '');
            try {
                const resolved = await resolveOrgShield(orgId);
                if (!resolved) continue; // shield disabled
                fleet.shieldEnabled++;
                if (resolved.enabled) fleet.piiEnabled++;
                if (resolved.dlpEnabled) fleet.dlpEnabled++;
                if (resolved.privacyScanEnabled) fleet.privacyScanEnabled++;
                if (resolved.euModeEnabled) fleet.euMode++;
                if (resolved.monitorIntegrations) fleet.monitorIntegrations++;
                // Detect the "legacy shape" — old storage keys without the new
                // canonical names. An operator seeing a high count here knows
                // those orgs must be re-saved once through the new UI before
                // their config cleans up.
                const isLegacy = rawShield && typeof rawShield === 'object'
                    && (('azurePiiEnabled' in rawShield || 'piiDetectionAction' in rawShield)
                        && !('privacyScanEnabled' in rawShield));
                if (isLegacy) fleet.legacyShape++;

                if (resolved.stalenessWarnings?.length) {
                    warnings += resolved.stalenessWarnings.length;
                    for (const w of resolved.stalenessWarnings) {
                        log.warn(`[OrgShieldSelfCheck] org=${orgId} stale reference:`, w);
                    }
                }
                // "Your own data": count the migrated patterns RE2 could not
                // take (they run in the time-boxed V8 worker) and the types
                // saved red. Ids only; a type's name is the admin's words.
                const { types } = deriveCustomState(rawShield, orgId);
                for (const t of types) {
                    if (t.method === 'pattern' && t.pattern?.engine === 'v8-legacy' && t.status !== 'invalid') fleet.re2Fallbacks++;
                    if (t.status === 'invalid') {
                        warnings++;
                        log.warn(`[OrgShieldSelfCheck] org=${orgId} data type ${t.id} is invalid and not enforced`);
                    }
                }
                fleet.customTypes += (resolved.customDataTypes || []).length;
                ok++;
            } catch (err) {
                warnings++;
                log.warn(`[OrgShieldSelfCheck] org=${orgId} resolve error: ${err.message}`);
            }
        }
        log.info(
            `[OrgShieldSelfCheck] ${entries.length} shield(s) scanned — ${ok} OK, ${warnings} warning(s). ` +
            `Fleet: shield=${fleet.shieldEnabled}/${fleet.total}, ` +
            `pii=${fleet.piiEnabled}, dlp=${fleet.dlpEnabled}, privacyScan=${fleet.privacyScanEnabled}, ` +
            `euMode=${fleet.euMode}, monitorIntegrations=${fleet.monitorIntegrations}, ` +
            `legacyShape=${fleet.legacyShape}, customTypes=${fleet.customTypes}, re2Fallbacks=${fleet.re2Fallbacks}.`
        );
        if (fleet.legacyShape > 0) {
            log.info(`[OrgShieldSelfCheck] \u26A0\uFE0F ${fleet.legacyShape} org(s) still on legacy shape. They work via read-time mapping; re-save once through the admin UI to normalise.`);
        }
    } catch (err) {
        log.warn('[OrgShieldSelfCheck] Self-check failed:', err.message);
    }
}

/**
 * Resolve a *user-level* privacy shield for consumer accounts (no org).
 * Stored under `user_privacy_shield_${userId}` by the consumer Privacy
 * Shield settings panel. Returns null when the user hasn't enabled it,
 * mirroring resolveOrgShield's contract so callers can use the same
 * downstream merge logic.
 *
 * The shape returned is intentionally a subset of resolveOrgShield's
 * output — consumer accounts can't configure regex collections, DLP,
 * Content Safety moderation, or web-search guard categories. They get
 * the basic Privacy Shield: EU mode, search-on-upload, and PII detection
 * with per-category, threshold and action choices.
 *
 * Secure by default (BFSF-289): with `allowImplicitDefault`, a user with NO
 * stored row resolves to the shared USER_SHIELD_DEFAULTS (shield active,
 * tokenize, all categories) rather than to null. A row that explicitly says
 * `enabled: false` is the user's own decision and still resolves to null —
 * "never configured" and "deliberately off" are different states and must not
 * collapse into each other.
 *
 * The implicit default is only applied for accounts with no org binding (see
 * resolveShieldFor). An org member whose org has the shield switched off must
 * not silently acquire a personal one — that is the org admin's call.
 *
 * @param {string} userId
 * @param {{ allowImplicitDefault?: boolean }} [opts]
 */
async function resolveUserShield(userId, { allowImplicitDefault = true } = {}) {
    if (!userId) return null;
    const stored = await _deps.configStore.getConfig(`user_privacy_shield_${userId}`);
    if (!stored && !allowImplicitDefault) return null;
    const { USER_SHIELD_DEFAULTS } = require('./userShieldDefaults');
    const shield = stored || USER_SHIELD_DEFAULTS;
    if (!shield?.enabled) return null;

    return {
        enabled: true,
        rulesWithNames: [],
        stalenessWarnings: [],
        scope: { userInput: true, agentOutput: true },
        action: 'delete',
        // PII — the user opted in via the consumer panel; the master
        // `enabled` flag above propagates through the gate at request time.
        piiDetectionCategories: Array.isArray(shield.piiDetectionCategories) ? shield.piiDetectionCategories : [],
        piiDetectionConfidenceThreshold: typeof shield.piiDetectionConfidenceThreshold === 'number' ? shield.piiDetectionConfidenceThreshold : 0.7,
        piiDetectionAction: ['block', 'tokenize'].includes(shield.piiDetectionAction) ? shield.piiDetectionAction : 'tokenize',
        piiFailureMode: shield.piiFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        attachmentLargeInputPolicy: shield.attachmentLargeInputPolicy === 'fail_closed' ? 'fail_closed' : 'fail_open',
        // Same default as the org shield, same reason (K4).
        privacy_scan_knowledge_bases: shield.privacy_scan_knowledge_bases !== false,
        // DLP / web-search guard are org-only features
        euModeEnabled: !!shield.euModeEnabled,
        webSearchGuardEnabled: false,
        disableSearchOnUpload: !!shield.disableSearchOnUpload,
        monitorIntegrations: false,
        showRawPayload: !!shield.showRawPayload,
        webSearchGuardPiiCategories: [],
        // Consumer accounts get no tool-class PII blocking (an org-only
        // feature) — return the empty shape so callers can read it uniformly.
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
        dlpEnabled: false,
        dlpScope: 'external',
        dlpMode: 'ask',
        dlpFailureMode: 'fail_closed',
        dlpAllowlistedHosts: [],
        customSensitiveTerms: [],
        // "Your own data" is an org feature.
        customDataTypes: [],
        customTypesDigest: '',
        // Canonical Privacy fields (mirror of org synth path).
        privacyScanEnabled: !!shield.enabled,
        privacyAction: shield.piiDetectionAction === 'block' ? 'block' : 'redact',
        privacyScope: 'external',
        privacyFailureMode: 'fail_closed',
    };
}

/**
 * Convenience for code paths that have both an orgId (often null for
 * consumer accounts) and a userId. Returns the org shield when it exists,
 * otherwise falls back to the user shield, otherwise null. Keeps callers
 * from having to branch on "do I have an org?" themselves.
 */
async function resolveShieldFor({ orgId, userId }) {
    const org = orgId ? await resolveOrgShield(orgId) : null;
    if (org) return org;
    // The secure-by-default user shield (BFSF-289) is for personal accounts.
    // An org member still gets their explicitly-saved user shield here when the
    // org's own shield is off, but never an implicit one.
    return resolveUserShield(userId, { allowImplicitDefault: !orgId });
}

module.exports = { resolveOrgShield, resolveUserShield, resolveShieldFor, mergeWithOrgShield, selfCheckOrgShields, applyTierClampsToShield, synthesizeToolPiiPolicy, classifyToolClass, isBlockedForTool, _deps };
