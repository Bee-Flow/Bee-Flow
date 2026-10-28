// @typecheck
'use strict';
const { _stringify } = require('./safetyLeaves');
const { PII_SCAN_WINDOW, _detectPii, _scanText } = require('./safetyScan');
const { mintTokensFor, tokenizeIntoVault, egressMode, maskTokens, prepareForEgress, restoreForRunState, logEgress } = require('./safetyEgress');
const { GuardrailBlockError, guardToolInput, guardToolOutput, guardAiInput, guardAiOutput } = require('./safetyGuard');
const { fallback } = require('../../utils/bestEffort');

/**
 * Safety / monitoring backbone for the automation runner.
 *
 * Automations historically bypassed every control that agents and direct chat
 * apply: no PII detection, no regex guardrails, and — critically — no
 * `integration_activity_log` egress rows, so "where did this automation send my
 * data and what type was it" was invisible. This module gives the runner the
 * same pipeline ordering chat uses (PII -> regex -> {LLM/tool} -> PII/regex ->
 * un-tokenize) plus unconditional egress logging.
 *
 * All heavyweight deps are required lazily inside functions to avoid the
 * well-known aiAgent <-> piiDetection require cycle (see piiDetection.js header).
 *
 * Design decisions (see plan):
 *  - Automations INHERIT the org Privacy Shield; no separate enable flag. A
 *    per-automation `definition.safety` block may only TIGHTEN.
 *  - Egress logging is UNCONDITIONAL (every integration_action / ai_step tool
 *    call writes a metadata row for source='automation'), and since 2026-08 the
 *    chat paths follow the same rule (owner decision — the ledger is the
 *    Art-44/RoPA evidence base). `monitorIntegrations` gates CONTENT scanning
 *    only: off = no payload inspection at all; on = regex sniff + GLiNER when
 *    the org has PII detection. See core/integrationLogging.js.
 *  - The org's `piiFailureMode` decides what happens when the detector is
 *    unreachable or degraded. It used to be hard fail-OPEN here — worse, a
 *    degraded result ({hasPii:false, degraded:true}, e.g. the guard circuit
 *    open) was read as "clean", so an org that had explicitly chosen
 *    fail_closed shipped everything unscanned. "No detector" and "no PII" are
 *    different answers.
 *  - In dry-run a `block` is converted to an annotation, never a hard failure,
 *    so the builder preview can show "would block".
 *
 * Token model (see tokenVault.js): the guard TOKENIZES; it never decides what
 * leaves the platform. Tokens are minted into the run-scoped vault, so the same
 * value keeps the same placeholder in every node, and `runState` always holds
 * restorable values. What actually egresses is decided per destination by
 * `prepareForEgress` — placeholders, an irreversible mask, or real values.
 */

// ── small utilities ─────────────────────────────────────────────────────────

// ── policy resolution (memoized per run on ctx) ─────────────────────────────

async function resolveAutomationPolicy(ctx, { honourAutomationOptOut = true } = {}) {
    if (ctx._safetyPolicy) return ctx._safetyPolicy;

    let shield = null;
    try {
        const { resolveOrgShield } = require('../privacy/orgShield');
        shield = await resolveOrgShield(ctx.orgId);
    } catch (err) { fallback('core/automationRunner/safety:resolveAutomationPolicy', err); /* fail-open */ }

    // Org-level opt-out: the org admin can exclude automations from the
    // Privacy Shield (Settings → Organisation → Privacy Shield → "Apply to
    // automations"). Missing field (older saves) = applied. When excluded,
    // automation runs skip PII/regex guarding entirely — egress logging in
    // logEgress still records where data went (that's audit, not guarding).
    //
    // `honourAutomationOptOut: false` is for callers that are NOT automations.
    // This setting's own label is "Apply to automations", so a webpage api/
    // handler inheriting it would drop the shield on a surface the admin
    // never agreed to exclude — a switch that silently means more than it
    // says. Such callers keep the shield on; every other rule below is
    // shared, so there is still one place the policy is decided.
    if (honourAutomationOptOut && shield && shield.applyToAutomations === false) {
        const policy = {
            shield: null,
            orgId: ctx.orgId || null,
            piiEnabled: false,
            action: 'off',
            regexRules: [],
            monitorIntegrations: false,
            scope: { toolInput: false, toolOutput: false, userInput: false, agentOutput: false },
            privacyScope: 'all',
            confidence: 0.7,
            categories: null,
            failureMode: 'fail_open',
            largeInputPolicy: 'fail_open',
            disabledForAutomations: true,
        };
        ctx._safetyPolicy = policy;
        return policy;
    }

    let aiConfig = {};
    try { aiConfig = (await require('../aiAgent').getAIConfig()) || {}; } catch (err) { fallback('core/automationRunner/safety:resolveAutomationPolicy#2', err); /* tolerate */ }

    const override = (ctx.definition && ctx.definition.safety) || {};

    const piiEnabled = !!(aiConfig.piiDetectionEnabled || (shield && shield.enabled) || override.scanEnabled);
    // strictest action wins; override may only tighten relative to the org shield.
    /** @type {Record<string, number>} */
    const STRICTNESS = { block: 3, tokenize: 2, redact: 1, off: 0 };
    const baseAction = (shield && shield.piiDetectionAction) || aiConfig.piiDetectionAction || 'block';
    const overrideAction = override.action || null;
    const action = overrideAction && STRICTNESS[overrideAction] > STRICTNESS[baseAction]
        ? overrideAction
        : baseAction;

    const policy = {
        shield,
        orgId: ctx.orgId || null,
        piiEnabled,
        action,
        regexRules: (shield && shield.rulesWithNames) || [],
        // egress row is always written; this only gates the GLiNER output scan.
        monitorIntegrations: shield ? shield.monitorIntegrations !== false : true,
        scope: (shield && shield.scope) || { toolInput: true, toolOutput: true, userInput: true, agentOutput: true },
        // Which DESTINATIONS the privacy rule covers — the same meaning it has
        // in DLP, where it comes from: 'external' = third parties only,
        // 'all' = third parties AND on-box destinations (the stricter setting).
        // It used to be read backwards here: 'all' restored real values before
        // egress while 'external' kept them tokenized, so the strictest setting
        // gave the least protection. See prepareForEgress.
        privacyScope: override.privacyScope || (shield && shield.privacyScope) || 'external',
        confidence: (shield && shield.piiDetectionConfidenceThreshold)
            ?? aiConfig.piiDetectionConfidenceThreshold ?? 0.7,
        // Includes the org's own data types ("Your own data"): the resolver
        // puts their ids in this list and detectPii runs them, so automations
        // hide the same terms chat does.
        categories: (shield && shield.piiDetectionCategories) || aiConfig.piiDetectionCategories || null,
        // What to do when the detector is unreachable or only partly ran.
        // The org shield is where this setting lives; AIConfig never carries it.
        failureMode: (shield && (shield.piiFailureMode || shield.dlpFailureMode)) || 'fail_closed',
        // What to do with the UNSCANNED tail of an oversize value (same setting
        // the attachment path uses; default preserves today's pass-through).
        largeInputPolicy: (shield && shield.attachmentLargeInputPolicy) === 'fail_closed' ? 'fail_closed' : 'fail_open',
    };
    ctx._safetyPolicy = policy;
    return policy;
}

/**
 * @param {{ id: string; }} step
 */
function buildAuditBase(ctx, step, { source = 'automation' } = {}) {
    return {
        organization_id: ctx.orgId || null,
        user_id: ctx.userId || null,
        agent_id: null,
        agent_name: ctx.automationTitle || null,
        conversation_id: ctx.automationId || null,   // group all activity per automation
        automation_id: ctx.automationId || null,
        run_id: ctx.runId || null,
        step_id: step && step.id ? step.id : null,
        // Carried into the ledger row by logEgress, so a non-automation caller
        // (a webpage api/ handler) is not filed as an automation in the audit
        // trail — which is a compliance surface, not a label.
        source,
        model: null,
        // Lets resolveIntegration() fill the destination for nextcloud_* tools.
        // When absent the probe still captures the real peer IP, so geo is correct.
        nextcloudUrl: ctx.nextcloudUrl || null,
    };
}

// ── guardrail event helper ──────────────────────────────────────────────────

// ── PII/regex scan core ─────────────────────────────────────────────────────

// ── public guards ───────────────────────────────────────────────────────────

// ── PII summaries for the builder canvas ────────────────────────────────────
//
// The canvas can colour connections by the PII flowing through them. That
// needs a COMPACT per-step record — aggregate counts per category and per
// category-group, never the detected values — persisted on the run-step row
// (`pii_summary`, its own column: output_json is truncation-prone and the
// bindable namespace must stay clean).

/**
 * Fold detected categories into `{ categories: {Email: n…}, groups:
 * {Contact: n…}, source, degraded? }`.
 *
 * Accepts detectPii entities ({category, label}) or plain strings — the
 * guards report human LABELS ('Email Address'), older configs may carry
 * legacy ids, and regex RULE names also travel in the same lists; anything
 * that doesn't resolve to a canonical PII category is skipped (a guardrail
 * rule name is not PII metadata). Returns null when nothing resolves.
 */
function buildPiiSummary(entries, { source = 'guard', degraded = false } = {}) {
    if (!Array.isArray(entries) || !entries.length) return null;
    let meta;
    try { meta = require('../privacy/piiDetection'); } catch (_) { return null; }
    const { PII_CATEGORIES, LEGACY_CATEGORY_ALIASES } = meta;
    const byLabel = new Map(Object.entries(PII_CATEGORIES).map(([id, m]) => [m.label, id]));
    const categories = {};
    const groups = {};
    for (const entry of entries) {
        const raw = entry && typeof entry === 'object' ? (entry.category ?? entry.label) : entry;
        if (typeof raw !== 'string' || !raw) continue;
        const id = PII_CATEGORIES[raw] ? raw
            : (LEGACY_CATEGORY_ALIASES[raw] && PII_CATEGORIES[LEGACY_CATEGORY_ALIASES[raw]]) ? LEGACY_CATEGORY_ALIASES[raw]
                : byLabel.get(raw) || null;
        if (!id) continue;
        categories[id] = (categories[id] || 0) + 1;
        const group = PII_CATEGORIES[id].group;
        groups[group] = (groups[group] || 0) + 1;
    }
    if (!Object.keys(categories).length) return null;
    return { categories, groups, source, ...(degraded ? { degraded: true } : {}) };
}

/**
 * Scan arbitrary text with EXACTLY the pipeline the Privacy Shield runs:
 * the org's GLiNER detector, then its allowlist, then its custom terms. The
 * guard STEP (engine.js execGuard) is the caller — an author asking "does this
 * contain personal data?" must get the same answer the shield would give, or the
 * two disagree and neither can be trusted.
 *
 * Never throws. The distinction that matters is preserved all the way out:
 * `entities: []` with `degraded: true` means "we could not look", which is not
 * the same answer as "there is nothing here" and must never be collapsed into it.
 *
 * @param {string} text
 * @param {Parameters<typeof _scanText>[1]} [policy]
 * @returns {ReturnType<typeof _scanText>}
 */
async function scanTextForPii(text, policy) {
    return _scanText(String(text ?? ''), policy || {});
}

/**
 * Builder-run PII scan of a step's output (decided with the owner: builder
 * test-runs only — production runs never pay for extra scanning; there the
 * summaries come free from the guards that already ran).
 *
 * Gated on the resolved policy (org shield "Apply to automations" + PII
 * detection on) and capped at ONE scan window (8 000 chars) so a ▶ Execute
 * stays snappy; a longer output is scanned partially and flagged
 * `degraded` so the UI can say "approximate".
 */
async function scanOutputForPiiSummary(output, ctx) {
    if (output == null) return null;
    const policy = await resolveAutomationPolicy(ctx);
    if (!policy.piiEnabled || policy.disabledForAutomations) return null;
    const full = _stringify(output);
    if (full.length < 3) return null;
    const text = full.slice(0, PII_SCAN_WINDOW);
    const det = await _detectPii(text, policy);
    if (!det || !Array.isArray(det.entities) || !det.entities.length) return null;
    return buildPiiSummary(det.entities, { source: 'scan', degraded: full.length > text.length });
}

// ── the egress boundary ─────────────────────────────────────────────────────
//
// The ONE place that decides what actually leaves the platform. Everything
// upstream only tokenizes; nothing upstream may assume a destination.

module.exports = {
    GuardrailBlockError,
    resolveAutomationPolicy,
    buildAuditBase,
    guardToolInput,
    guardToolOutput,
    guardAiInput,
    guardAiOutput,
    buildPiiSummary,
    scanOutputForPiiSummary,
    // The guard STEP's scanner — the shield's own pipeline, exposed so a step
    // an author placed can never disagree with the policy running underneath.
    scanTextForPii,
    // The tokenize STEP's minting path — reversible placeholders in the run
    // vault, which is what makes putting the real values back automatic.
    tokenizeIntoVault,
    mintTokensFor,
    prepareForEgress,
    restoreForRunState,
    egressMode,
    maskTokens,
    logEgress,
};

/** @typedef {ReturnType<typeof import('./tokenVault').createTokenVault>} TokenVault */

/** @typedef {Awaited<ReturnType<typeof import('../privacy/orgShield').resolveOrgShield>>} OrgShield */

/** @typedef {{ name: string, pattern: string }} RegexRule */

/**
 * The run's resolved safety policy (resolveAutomationPolicy).
 * @typedef {{ shield: OrgShield | null, orgId: string | null, piiEnabled: boolean, action: string,
 *   regexRules: RegexRule[], monitorIntegrations: boolean,
 *   scope: { toolInput?: boolean, toolOutput?: boolean, userInput?: boolean, agentOutput?: boolean },
 *   privacyScope: string, confidence: number, categories: string[] | null, failureMode: string,
 *   largeInputPolicy: string, disabledForAutomations?: boolean }} SafetyPolicy
 */

/** What the scanners read of a policy (callers may hand in a partial one).
 * @typedef {{ categories?: string[] | null, confidence?: number, shield?: OrgShield | null }} ScanPolicy
 */

/**
 * The run context, as far as the safety layer reads and memoizes on it.
 * @typedef {{ orgId?: string, userId?: string, automationTitle?: string, automationId?: string, runId?: string,
 *   nextcloudUrl?: string, definition?: object,
 *   tokenVault?: TokenVault, _ephemeralTokenVault?: TokenVault, _safetyPolicy?: SafetyPolicy,
 *   _guardrailSeen?: Set<string> }} SafetyCtx
 */

/** One detected span, in detectPii / tokenizeText shape.
 * @typedef {import('../privacy/piiDetection/scanCache').PiiEntity} PiiEntity
 */

/** @typedef {{ entities: PiiEntity[], degraded: boolean, degradedReason: string | null, degradedCategories: string[] | null, overflow: boolean }} RawDetection */

/**
 * @template [T=unknown]
 * @typedef {{ value: T, tokenMap: Record<string, string> | null, blocked: boolean, categories: string[], markers: string[], wouldBlock?: boolean }} GuardResult
 */

/** @typedef {ReturnType<typeof buildAuditBase>} AuditBase */
