'use strict';
const log = require('../../telemetry/log');

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
 *    call writes a metadata row for source='routine'), and since 2026-08 the
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

class GuardrailBlockError extends Error {
    constructor(message, { violationType = 'pii', categories = [], scope = 'input' } = {}) {
        super(message);
        this.name = 'GuardrailBlockError';
        this.guardrailBlocked = true;
        this.violationType = violationType;
        this.categories = Array.isArray(categories) ? categories : [categories].filter(Boolean);
        this.scope = scope;
    }
}

// ── small utilities ─────────────────────────────────────────────────────────

function _stringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

// Collect / re-apply string leaves in a stable order. The guard needs TWO
// passes over the same leaves — scan everything first (so a block decision is
// made before anything is transformed), then rewrite — and scanning twice is
// what the old implementation did: it scanned the whole stringified value AND
// then every leaf again, i.e. two GLiNER rounds per guarded value, with the
// outer pass matching regex rules across JSON field boundaries. Object.keys
// order is insertion-stable, so index N means the same leaf in both walks.
function collectStringLeaves(value, out = []) {
    if (value == null) return out;
    if (typeof value === 'string') { out.push(value); return out; }
    if (Array.isArray(value)) { for (const v of value) collectStringLeaves(v, out); return out; }
    if (typeof value === 'object') { for (const k of Object.keys(value)) collectStringLeaves(value[k], out); return out; }
    return out;
}

/**
 * The FIELD NAME each string leaf sat under, in `collectStringLeaves` order.
 * An array inherits its parent key, so `messageIds: ['a','b']` yields
 * 'messageIds' twice. Index N means the same leaf in both walks.
 */
function collectStringLeafKeys(value, key = null, out = []) {
    if (value == null) return out;
    if (typeof value === 'string') { out.push(key); return out; }
    if (Array.isArray(value)) { for (const v of value) collectStringLeafKeys(v, key, out); return out; }
    if (typeof value === 'object') { for (const k of Object.keys(value)) collectStringLeafKeys(value[k], k, out); return out; }
    return out;
}

// ── identifier arguments ────────────────────────────────────────────────────
//
// A tool input named like an id (`messageId`, `thread_id`, `fileID`, `uuid`)
// holds an ADDRESS: the handle the provider itself issued, being handed straight
// back to that same provider so it knows which record to act on. Redacting one
// protects nothing — the provider already has it, by definition — and guarantees
// the call fails. That is not hypothetical: GLiNER reads a 16-hex-character Gmail
// message id as a phone number (8 of its characters are digits), so a routine
// that read each mail of a search result sent a placeholder to Gmail and died on
// "Invalid id value" for all ten iterations, with the shield reporting a
// successful redaction.
//
// So the PII detector's verdict is not applied to these fields. Deliberately
// NARROW:
//   - the tool-INPUT scope only (an id in an OUTPUT is content the author sees,
//     and nothing downstream is broken by tokenizing it — the vault restores it);
//   - the value must be a single whitespace-free token, so a field called `id`
//     carrying a whole mail body is still scanned like any other text;
//   - REGEX GUARDRAIL RULES still apply in full. A rule is an explicit
//     instruction from the org ("this pattern must not leave"), not a statistical
//     guess, and an org that writes one about its record ids means it.
// Findings are still LOGGED (action 'passed_unredacted'), so the Shield's
// "What happened" shows the detection and what was done with it.
const _ID_KEY_RE = /(?:^|[_\-.])(?:id|ids|uid|uuid|guid|sid)$|[a-z0-9](?:Id|Ids|ID|IDs|Uid|UID|Uuid|UUID|Guid|GUID)$/;

function _isIdentifierKey(key) {
    const k = String(key || '').trim();
    if (!k) return false;
    if (/^(?:id|ids|uid|uuid|guid|sid)$/i.test(k)) return true;
    return _ID_KEY_RE.test(k);
}

/** An addressing handle, not prose: one token, no whitespace, bounded length. */
function _isHandleValue(v) {
    return typeof v === 'string' && v.length > 0 && v.length <= 256 && !/\s/.test(v);
}

function applyStringLeaves(value, replacements, cursor = { i: 0 }) {
    if (value == null) return value;
    if (typeof value === 'string') return replacements[cursor.i++];
    if (Array.isArray(value)) return value.map(v => applyStringLeaves(v, replacements, cursor));
    if (typeof value === 'object') {
        const out = {};
        for (const k of Object.keys(value)) out[k] = applyStringLeaves(value[k], replacements, cursor);
        return out;
    }
    return value;
}

/**
 * The run-scoped token vault, or an ephemeral per-ctx stand-in.
 *
 * Every real run gets one from executeAutomation. The fallback keeps unit tests
 * (and any future caller that builds a bare ctx) correct rather than crashing:
 * they get a vault scoped to that ctx object instead of a run.
 */
function _vaultOf(ctx) {
    if (ctx && ctx.tokenVault) return ctx.tokenVault;
    if (!ctx) {
        const { createTokenVault } = require('./tokenVault');
        return createTokenVault({});
    }
    if (!ctx._ephemeralTokenVault) {
        const { createTokenVault } = require('./tokenVault');
        ctx._ephemeralTokenVault = createTokenVault({});
    }
    return ctx._ephemeralTokenVault;
}
// ── policy resolution (memoized per run on ctx) ─────────────────────────────

async function resolveAutomationPolicy(ctx, { honourAutomationOptOut = true } = {}) {
    if (ctx._safetyPolicy) return ctx._safetyPolicy;

    let shield = null;
    try {
        const { resolveOrgShield } = require('../privacy/orgShield');
        shield = await resolveOrgShield(ctx.orgId);
    } catch (_) { /* fail-open */ }

    // Org-level opt-out: the org admin can exclude automations from the
    // Privacy Shield (Settings → Organisation → Privacy Shield → "Apply to
    // routines"). Missing field (older saves) = applied. When excluded,
    // automation runs skip PII/regex guarding entirely — egress logging in
    // logEgress still records where data went (that's audit, not guarding).
    //
    // `honourAutomationOptOut: false` is for callers that are NOT routines.
    // This setting's own label is "Apply to routines", so a webpage api/
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
    try { aiConfig = (await require('../aiAgent').getAIConfig()) || {}; } catch (_) { /* tolerate */ }

    const override = (ctx.definition && ctx.definition.safety) || {};

    const piiEnabled = !!(aiConfig.piiDetectionEnabled || (shield && shield.enabled) || override.scanEnabled);
    // strictest action wins; override may only tighten relative to the org shield.
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
        // puts their ids in this list and detectPii runs them, so routines
        // hide the same terms chat does.
        categories: (shield && shield.piiDetectionCategories) || aiConfig.piiDetectionCategories || null,
        // What to do when the detector is unreachable or only partly ran.
        failureMode: (shield && (shield.piiFailureMode || shield.dlpFailureMode))
            || aiConfig.piiFailureMode || 'fail_closed',
        // What to do with the UNSCANNED tail of an oversize value (same setting
        // the attachment path uses; default preserves today's pass-through).
        largeInputPolicy: (shield && shield.attachmentLargeInputPolicy) === 'fail_closed' ? 'fail_closed' : 'fail_open',
    };
    ctx._safetyPolicy = policy;
    return policy;
}

function buildAuditBase(ctx, step, { source = 'routine' } = {}) {
    return {
        organization_id: ctx.orgId || null,
        user_id: ctx.userId || null,
        agent_id: null,
        agent_name: ctx.automationTitle || null,
        conversation_id: ctx.automationId || null,   // group all activity per automation
        automation_id: ctx.automationId || null,
        run_id: ctx.runId || null,
        step_id: step && step.id ? step.id : null,
        // Carried into the ledger row by logEgress, so a non-routine caller
        // (a webpage api/ handler) is not filed as a routine in the audit
        // trail — which is a compliance surface, not a label.
        source,
        model: null,
        // Lets resolveIntegration() fill the destination for nextcloud_* tools.
        // When absent the probe still captures the real peer IP, so geo is correct.
        nextcloudUrl: ctx.nextcloudUrl || null,
    };
}

// ── guardrail event helper ──────────────────────────────────────────────────

function _logGuardrail(auditBase, { violation_type, categories, direction, action_taken, isDryRun, dedupeKey, ctx }) {
    try {
        // A step retry re-scans the SAME payload, so one finding used to appear
        // once per attempt in the dashboard ("4 catches" for one email). Dedupe
        // on the content itself, not on the step: a loop iteration carrying
        // different data is a genuinely new finding and must still count.
        if (dedupeKey && ctx) {
            if (!ctx._guardrailSeen) ctx._guardrailSeen = new Set();
            if (ctx._guardrailSeen.has(dedupeKey)) return;
            // Bound the memory of a very long run.
            if (ctx._guardrailSeen.size < 5000) ctx._guardrailSeen.add(dedupeKey);
        }
        const store = require('../../stores/guardrailEventStore');
        store.logGuardrailEvent({
            ...auditBase,
            violation_type,
            violation_categories: (categories || []).join(', ') || null,
            direction: direction || 'input',
            action_taken,
            is_dry_run: !!isDryRun,
        }).catch(() => {});
    } catch (_) { /* never fail the run on logging */ }
}

function _hash(s) {
    return require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

// ── PII/regex scan core ─────────────────────────────────────────────────────

// The GLiNER detector caps each request; scan long text in overlapping
// windows so PII past the single-request cap isn't silently skipped and
// egressed raw. Overlap catches an entity straddling a window boundary; a
// window ceiling bounds cost on pathological inputs.
const PII_SCAN_WINDOW = 8000;
const PII_SCAN_OVERLAP = 256;
const PII_SCAN_MAX_WINDOWS = 40; // ~310K chars scanned before we bound it

// Run the org-configured GLiNER detector. Returns null on any failure
// (fail-open) or when nothing is found. Text longer than one window is scanned
// in overlapping windows and the entities merged with ABSOLUTE offsets so the
// downstream tokenizer (which splices by offset) redacts every occurrence.
//
// Kept for logEgress's `fullScan` hook, which only wants "is there PII in this
// payload" for the egress row's labels. The GUARD path uses _scanText below,
// which additionally applies the org's allowlist + custom terms and reports
// degradation instead of swallowing it.
async function _detectPii(text, policy) {
    const r = await _rawDetect(text, policy);
    return r && r.entities.length ? { hasPii: true, entities: r.entities } : null;
}

// Windowed detectPii. Never throws; reports degradation rather than hiding it.
// Returns { entities, degraded, degradedReason, degradedCategories, overflow }.
async function _rawDetect(text, policy) {
    const full = String(text || '');
    const empty = { entities: [], degraded: false, degradedReason: null, degradedCategories: null, overflow: false };
    if (full.length < 3) return empty;
    try {
        const { detectPii } = require('../privacy/piiDetection');
        if (full.length <= PII_SCAN_WINDOW) {
            const res = await detectPii(full, policy.categories, policy.confidence);
            if (!res || res.guardAbsent) {
                // detectPii returns null when no detector is installed at all.
                // That is NOT "clean" — it is "we did not look". `guardAbsent`
                // says the same, but the org's own words/patterns did run in
                // Node: keep what they found.
                return {
                    ...empty, degraded: true, degradedReason: 'guard_not_installed',
                    entities: res && res.hasPii && Array.isArray(res.entities) ? res.entities : [],
                };
            }
            return {
                entities: res.hasPii && Array.isArray(res.entities) ? res.entities : [],
                degraded: !!res.degraded,
                degradedReason: res.degradedReason || null,
                degradedCategories: res.degradedCategories || null,
                overflow: false,
            };
        }
        const step = PII_SCAN_WINDOW - PII_SCAN_OVERLAP;
        const merged = [];
        const seen = new Set();
        let windows = 0;
        let degraded = false;
        let degradedReason = null;
        let degradedCategories = null;
        for (let start = 0; start < full.length && windows < PII_SCAN_MAX_WINDOWS; start += step, windows++) {
            const chunk = full.slice(start, start + PII_SCAN_WINDOW);
            const res = await detectPii(chunk, policy.categories, policy.confidence);
            if (!res) { degraded = true; degradedReason = degradedReason || 'guard_not_installed'; continue; }
            if (res.guardAbsent) { degraded = true; degradedReason = degradedReason || 'guard_not_installed'; }
            if (res.degraded) {
                degraded = true;
                degradedReason = degradedReason || res.degradedReason || null;
                if (res.degradedCategories) degradedCategories = [...new Set([...(degradedCategories || []), ...res.degradedCategories])];
            }
            if (!res.hasPii || !Array.isArray(res.entities)) continue;
            for (const e of res.entities) {
                const absOffset = (e.offset !== undefined && e.offset >= 0) ? start + e.offset : undefined;
                const key = `${absOffset ?? 'x'}|${e.text}`;
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(absOffset !== undefined ? { ...e, offset: absOffset } : { ...e });
            }
        }
        const overflow = windows >= PII_SCAN_MAX_WINDOWS && full.length > PII_SCAN_MAX_WINDOWS * step;
        if (overflow) {
            log.warn(`[safety] PII scan window cap (${PII_SCAN_MAX_WINDOWS}) hit — tail of a ${full.length}-char value was not scanned`);
        }
        return { entities: merged, degraded, degradedReason, degradedCategories, overflow };
    } catch (e) {
        return { ...empty, degraded: true, degradedReason: `guard_unreachable: ${e.message}` };
    }
}

/**
 * Full scan of ONE string leaf, in the same order chat uses (dlpRunner):
 * detect (which includes the org's own data types) → never-redact allowlist.
 * Entities come back in `tokenizeText` shape (offset/length/text/category/
 * label); detectPii's spans are disjoint, and overlaps across windows are
 * resolved at the mint site by tokenizeText itself.
 *
 * The allowlist and custom terms were completely inert on routines: safety.js
 * called the bare detector, so an org's own company name kept being redacted
 * (false positives, garbled outputs) and its own codenames were never caught —
 * while the very same settings worked in chat. The codenames now travel as
 * category ids in `policy.categories` (core/privacy/customTypes).
 */
async function _scanText(text, policy) {
    const det = await _rawDetect(text, policy);
    let entities = det.entities.map(e => ({
        category: e.category || e.label || 'PII',
        label: e.label || e.category || 'PII',
        offset: typeof e.offset === 'number' ? e.offset : 0,
        length: e.length || (e.text ? e.text.length : 0),
        text: e.text || '',
        confidence: e.confidence,
    }));

    if (entities.length) {
        try {
            const { buildAllowMatcher, filterAllowedEntities } = require('../dlp/allowTerms');
            const filtered = filterAllowedEntities(entities, buildAllowMatcher(policy.shield || {}));
            if (filtered.allowed.length) {
                const byCat = {};
                for (const e of filtered.allowed) byCat[e.category] = (byCat[e.category] || 0) + 1;
                log.info('[safety] allowlist kept spans unredacted:', JSON.stringify(byCat));
            }
            entities = filtered.entities;
        } catch (_) { /* allowlist unavailable — keep the raw detections */ }
    }

    return {
        entities,
        degraded: det.degraded,
        degradedReason: det.degradedReason,
        degradedCategories: det.degradedCategories,
        overflow: det.overflow,
    };
}

/**
 * Does a degraded scan actually affect what this org asked us to look for?
 * Mirrors piiDetection's narrowing: an empty/absent list means "unknown —
 * assume everything".
 */
function _degradationIsRelevant(degradedCategories, requested) {
    if (!Array.isArray(degradedCategories) || degradedCategories.length === 0) return true;
    if (!Array.isArray(requested) || requested.length === 0) return true;
    return degradedCategories.some(c => requested.includes(c));
}

function _regexHits(text, policy) {
    if (!policy.regexRules || !policy.regexRules.length) return [];
    try {
        const { checkRegexPatterns } = require('../privacy/guardrails');
        return checkRegexPatterns(text, policy.regexRules) || [];
    } catch (_) { return []; }
}

/**
 * The sentence a user reads when a fail-closed privacy check could not run.
 *
 * It used to carry the raw guard reason ("guard_unreachable: socket hang up"),
 * which says nothing to the person looking at a failed step and nothing about
 * what to do next (BFSF-373). The advice follows the kind of failure
 * (piiDetection/degradation.js): retry for a transient failure, less data for
 * an oversize one, an admin for a missing detector. Only the COPY differs per
 * kind; every one of them still blocks.
 */
function _scanFailedMessage(degradedReason, direction, valueCount) {
    const reason = String(degradedReason || '');
    const n = Number(valueCount) || 0;
    const values = `${n} ${n === 1 ? 'value' : 'values'}`;
    const head = `Blocked: the privacy check could not run on this step's ${direction === 'output' ? 'output' : 'input'} (${values}), `
        + 'and this organisation requires content to be checked before it is used.';
    let advice;
    if (/guard_not_installed/.test(reason)) {
        advice = 'No privacy check service is installed on this server. Ask an admin to install it, or to review the Privacy Shield setting for when the check cannot run.';
    } else if (/guard_circuit_open/.test(reason)) {
        advice = 'The privacy check service failed several times in a row and is paused for a moment. Wait a minute and run it again. If it keeps happening, ask an admin to check the privacy check service.';
    } else {
        const kind = require('../privacy/piiDetection/degradation').classifyDegradation(reason);
        if (kind === 'too_large') {
            advice = 'The content was too large to check. Make the step handle less data (for example a lower result limit) and run it again.';
        } else if (kind === 'timeout') {
            advice = 'The privacy check service took too long to answer. Run it again. If it keeps happening, make the step handle less data (for example a lower result limit) or ask an admin to check the privacy check service.';
        } else {
            advice = 'The privacy check service could not be reached. Run it again. If it keeps happening, make the step handle less data (for example a lower result limit), or ask an admin to check the privacy check service or the Privacy Shield setting for when the check cannot run.';
        }
    }
    return `${head} ${advice}`;
}

/**
 * Guard a structured value (tool inputs OR tool/ai output).
 *
 * Scans every string leaf ONCE, then rewrites: regex hits become an in-place
 * `[REDACTED:<rule>]` marker (a guardrail rule means "this content must not
 * travel", so it is deliberately irreversible), PII is tokenized into the
 * run-scoped vault (reversible — what actually leaves is decided later by
 * prepareForEgress).
 *
 * Mutates nothing. Returns { value, tokenMap, blocked, categories, markers }.
 * Throws GuardrailBlockError on a block action or a fail-closed scan failure
 * (in dry-run it annotates with wouldBlock instead).
 */
async function _guardValue(value, policy, auditBase, { direction, scopeOn, mode, ctx, exemptIdentifiers = false }) {
    const noop = { value, tokenMap: null, blocked: false, categories: [], markers: [] };
    if (!policy.piiEnabled && !policy.regexRules.length) return noop;
    if (scopeOn === false) return noop;

    const isDryRun = mode === 'dry_run';
    const leaves = collectStringLeaves(value);
    if (!leaves.length) return noop;
    // Identifier arguments keep their PII findings out of the redact/block
    // decision (see _isIdentifierKey) — regex rules below are unaffected.
    const leafKeys = exemptIdentifiers ? collectStringLeafKeys(value) : null;
    const isExempt = (i) => !!leafKeys && _isIdentifierKey(leafKeys[i]) && _isHandleValue(leaves[i]);

    // ── pass 1: scan (no transformation yet — a block decision must be made
    // before anything is rewritten) ──
    const perLeaf = [];
    const regexNames = new Set();
    const piiCats = new Set();
    const markers = new Set();
    let degraded = false;
    let degradedReason = null;
    let degradedCategories = null;
    let overflow = false;

    const exemptCats = new Set();
    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        const rHits = _regexHits(leaf, policy);
        for (const h of rHits) regexNames.add(h.ruleName);
        let scan = null;
        if (policy.piiEnabled) {
            scan = await _scanText(leaf, policy);
            const exempt = isExempt(i);
            for (const e of scan.entities) (exempt ? exemptCats : piiCats).add(e.label || e.category);
            if (exempt) scan = { ...scan, entities: [] };
            if (scan.degraded) {
                degraded = true;
                degradedReason = degradedReason || scan.degradedReason;
                if (scan.degradedCategories) degradedCategories = [...new Set([...(degradedCategories || []), ...scan.degradedCategories])];
            }
            if (scan.overflow) overflow = true;
        }
        perLeaf.push({ leaf, rHits, entities: scan ? scan.entities : [] });
    }

    const contentKey = _hash(leaves.join('\u0000'));
    const dedupeBase = `${auditBase.step_id || '-'}|${direction}`;

    // ── scan failure / degradation policy ──
    // "The detector could not look" is not "there is nothing to find". Honour
    // the org's piiFailureMode, narrowed to the categories it actually asked
    // for (a category the org doesn't scan for degrading is not its problem).
    if (degraded && _degradationIsRelevant(degradedCategories, policy.categories)) {
        markers.add('privacy_protection_unavailable');
        if (policy.failureMode === 'fail_closed') {
            _logGuardrail(auditBase, {
                violation_type: 'scan_failed', categories: ['privacy_protection_unavailable'],
                direction, action_taken: 'scan_failed', isDryRun, ctx,
                dedupeKey: `${dedupeBase}|scan_failed|${contentKey}`,
            });
            if (!isDryRun) {
                // The raw reason belongs in the log; the person looking at a
                // failed step gets what happened and what to do about it.
                log.warn(`[safety] privacy check degraded (${degradedReason || 'unknown'}) on step ${auditBase.step_id || '-'} ${direction} — fail_closed: blocking`);
                throw new GuardrailBlockError(
                    _scanFailedMessage(degradedReason, direction, leaves.length),
                    { violationType: 'scan_failed', categories: ['privacy_protection_unavailable'], scope: direction },
                );
            }
            return { value, tokenMap: null, blocked: true, categories: ['privacy_protection_unavailable'], markers: [...markers], wouldBlock: true };
        }
        // fail_open still has to be VISIBLE: "we let this through unchecked" is
        // the one outcome an admin must be able to find afterwards, and a
        // console line is not an audit trail.
        _logGuardrail(auditBase, {
            violation_type: 'scan_failed', categories: ['privacy_protection_unavailable'],
            direction, action_taken: 'passed_unredacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|scan_open|${contentKey}`,
        });
        log.warn(`[safety] privacy check degraded (${degradedReason || 'unknown'}) — fail_open: continuing UNCHECKED`);
    }
    if (overflow) {
        markers.add('scan_overflow');
        if (policy.largeInputPolicy === 'fail_closed') {
            _logGuardrail(auditBase, {
                violation_type: 'scan_failed', categories: ['scan_overflow'],
                direction, action_taken: 'scan_failed', isDryRun, ctx,
                dedupeKey: `${dedupeBase}|scan_overflow|${contentKey}`,
            });
            if (!isDryRun) {
                throw new GuardrailBlockError('Blocked: this content was too large to check completely.', { violationType: 'scan_failed', categories: ['scan_overflow'], scope: direction });
            }
            return { value, tokenMap: null, blocked: true, categories: ['scan_overflow'], markers: [...markers], wouldBlock: true };
        }
    }

    const names = [...regexNames];
    const cats = [...piiCats];

    // Detections we deliberately did not act on because the field is the call's
    // own address (see _isIdentifierKey). Logged BEFORE any block/redact decision
    // so "the shield saw this and let it through" is in the audit trail whatever
    // else this value triggers.
    if (exemptCats.size) {
        markers.add('identifier_passed_unredacted');
        _logGuardrail(auditBase, {
            violation_type: 'pii', categories: [...exemptCats], direction,
            action_taken: 'passed_unredacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|pii|identifier|${contentKey}`,
        });
    }

    // ── block action ──
    if (policy.action === 'block' && (names.length || cats.length)) {
        const type = names.length ? 'regex' : 'pii';
        const found = names.length ? names : cats;
        _logGuardrail(auditBase, {
            violation_type: type, categories: found, direction, action_taken: 'blocked', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|${type}|blocked|${contentKey}`,
        });
        if (!isDryRun) {
            throw new GuardrailBlockError(
                names.length
                    ? `Blocked by guardrail rule(s): ${names.join(', ')}`
                    : `Blocked: sensitive data detected (${cats.join(', ')})`,
                { violationType: type, categories: found, scope: direction },
            );
        }
        return { value, tokenMap: null, blocked: true, categories: found, markers: [...markers], wouldBlock: true };
    }

    if (!names.length && !cats.length) {
        return { value, tokenMap: null, blocked: false, categories: [], markers: [...markers] };
    }

    // ── pass 2: rewrite ──
    const { tokenizeText } = require('../privacy/piiDetection');
    const vault = _vaultOf(ctx);
    const tokenMap = {};
    const replacements = [];
    for (const { leaf, rHits, entities } of perLeaf) {
        let out = leaf;
        for (const h of rHits) {
            try {
                const safe = h.pattern.replace(/^\(\?i\)/, '').replace(/^\(\?-[a-z]+\)/, '');
                out = out.replace(new RegExp(safe, 'gi'), `[REDACTED:${h.ruleName}]`);
            } catch (_) { /* skip bad pattern */ }
        }
        if (entities.length) {
            // Regex redaction shifted the offsets, so re-derive the spans on the
            // rewritten text when anything actually changed.
            const spans = out === leaf ? entities : null;
            const src = out;
            const minted = await vault.mint((seed) => tokenizeText(src, spans || _respan(entities, src), seed));
            out = minted.tokenizedText;
            Object.assign(tokenMap, minted.tokenMap);
        }
        replacements.push(out);
    }

    if (names.length) {
        _logGuardrail(auditBase, {
            violation_type: 'regex', categories: names, direction, action_taken: 'redacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|regex|redacted|${contentKey}`,
        });
    }
    if (cats.length) {
        _logGuardrail(auditBase, {
            violation_type: 'pii', categories: cats, direction, action_taken: 'redacted', isDryRun, ctx,
            dedupeKey: `${dedupeBase}|pii|redacted|${contentKey}`,
        });
    }

    return {
        value: applyStringLeaves(value, replacements),
        tokenMap: Object.keys(tokenMap).length ? tokenMap : null,
        blocked: false,
        categories: [...names, ...cats],
        markers: [...markers],
    };
}

/**
 * Re-locate entities in a rewritten string (regex redaction moved the offsets).
 * Falls back to a plain indexOf per entity; entities whose text is gone (it WAS
 * the redacted span) are dropped.
 */
function _respan(entities, text) {
    const out = [];
    for (const e of entities) {
        const idx = e.text ? text.indexOf(e.text) : -1;
        if (idx < 0) continue;
        out.push({ ...e, offset: idx, length: e.text.length });
    }
    return out;
}

// ── public guards ───────────────────────────────────────────────────────────

async function guardToolInput(inputs, policy, auditBase, mode, ctx = null) {
    return _guardValue(inputs, policy, auditBase, {
        direction: 'input', scopeOn: policy.scope.toolInput !== false, mode, ctx,
        // The one scope where a redaction cannot protect anything and can only
        // break the call: the ids this call addresses records BY.
        exemptIdentifiers: true,
    });
}

/**
 * Guard a tool result before it enters runState.
 *
 * Returns its `tokenMap` — dropping it was the single worst bug on this path:
 * the tokenized result was written into runState as a literal `[person_1]` that
 * nothing could restore, and it travelled from there into every downstream node,
 * email and document. The caller merges it into the run vault and restores
 * before writing downstream.
 */
async function guardToolOutput(result, policy, auditBase, mode, ctx = null) {
    const r = await _guardValue(result, policy, auditBase, { direction: 'output', scopeOn: policy.scope.toolOutput !== false, mode, ctx });
    return { result: r.value, tokenMap: r.tokenMap, blocked: r.blocked, categories: r.categories, markers: r.markers, wouldBlock: r.wouldBlock };
}

/**
 * Guard an ai_step's messages before the LLM call. Mutates the guarded messages
 * in place (matching the agent runner) and returns { tokenMap, blocked }.
 *
 * Guards the SYSTEM prompt as well as the user message: a routine's system
 * prompt is `{{…}}`-interpolated from step data, so it routinely carries the
 * very personal data the shield is supposed to catch, and it used to go to the
 * model untouched.
 */
async function guardAiInput(messages, policy, auditBase, mode, ctx = null) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { tokenMap: null, blocked: false };
    if (policy.scope.userInput === false) return { tokenMap: null, blocked: false };

    const targets = (messages || []).filter(m => (m.role === 'user' || m.role === 'system') && typeof m.content === 'string');
    if (!targets.length) return { tokenMap: null, blocked: false };

    const guarded = await _guardValue(targets.map(m => m.content), policy, auditBase, { direction: 'input', scopeOn: true, mode, ctx });
    if (guarded.wouldBlock) return { tokenMap: null, blocked: true, categories: guarded.categories };
    if (Array.isArray(guarded.value)) {
        targets.forEach((m, i) => { if (typeof guarded.value[i] === 'string') m.content = guarded.value[i]; });
    }
    return { tokenMap: guarded.tokenMap, blocked: false, categories: guarded.categories, markers: guarded.markers };
}

/**
 * Guard an ai_step's output. On block (default action) throws; otherwise returns
 * the (possibly redacted) output plus the tokenMap of any PII it tokenized. The
 * caller restores from the run vault before writing the value downstream, so the
 * model saw placeholders and downstream steps see real values.
 *
 * Numbering never collides with the input tokens: both mints go through the same
 * run-scoped vault, which seeds every tokenizeText call.
 */
async function guardAiOutput(content, policy, auditBase, mode, ctx = null) {
    if (!policy.piiEnabled && !policy.regexRules.length) return { content, tokenMap: null, blocked: false };
    if (policy.scope.agentOutput === false) return { content, tokenMap: null, blocked: false };
    const guarded = await _guardValue(content, policy, auditBase, { direction: 'output', scopeOn: true, mode, ctx });
    if (guarded.wouldBlock && mode !== 'dry_run') {
        throw new GuardrailBlockError(`Blocked: AI step output contained sensitive data (${(guarded.categories || []).join(', ')})`, { violationType: 'pii', categories: guarded.categories, scope: 'output' });
    }
    return { content: guarded.value, tokenMap: guarded.tokenMap, blocked: !!guarded.wouldBlock, categories: guarded.categories, markers: guarded.markers };
}

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
 * @returns {{ entities, degraded, degradedReason, degradedCategories, overflow }}
 */
async function scanTextForPii(text, policy) {
    return _scanText(String(text ?? ''), policy || {});
}

/**
 * Replace the personal data in `text` with REVERSIBLE placeholders, minted into
 * the run vault — the same thing chat does before a message reaches a model.
 *
 * The vault is what makes "map it back" automatic, and it is why this cannot
 * just call tokenizeText directly:
 *
 *   • it is run-scoped and shared by reference across branches, iterations and
 *     sub-layers, so one value keeps ONE placeholder everywhere in the run;
 *   • minting is serialised, so two parallel branches can never hand the same
 *     label to two different people;
 *   • it is seeded from what is already in there, so a value tokenized by an
 *     earlier node reuses its existing placeholder rather than gaining a second;
 *   • it is written through to automation_runs.pii_token_map, so an approval
 *     pause or a retry in another process still knows what `[email_1]` meant.
 *
 * Restoration is then free: prepareForEgress and restoreForRunState both read
 * the WHOLE vault, so every point where the runner already puts real values back
 * puts these back too.
 *
 * @returns {{ text, entities, degraded, degradedReason, overflow }}
 */
async function mintTokensFor(text, entities, ctx) {
    const source = String(text ?? '');
    if (!Array.isArray(entities) || !entities.length) return source;
    const { tokenizeText } = require('../privacy/piiDetection');
    // mint() absorbs the `tokenMap` off whatever the callback returns, so the
    // whole tokenizeText result goes back — and the merge happens inside the
    // lock, where it belongs.
    const res = await _vaultOf(ctx).mint((seedMap) => tokenizeText(source, entities, seedMap));
    return res?.tokenizedText ?? source;
}

async function tokenizeIntoVault(text, policy, ctx) {
    const source = String(text ?? '');
    const det = await _scanText(source, policy || {});
    if (!det.entities.length) return { text: source, ...det };
    return { text: await mintTokensFor(source, det.entities, ctx), ...det };
}

/**
 * Builder-run PII scan of a step's output (decided with the owner: builder
 * test-runs only — production runs never pay for extra scanning; there the
 * summaries come free from the guards that already ran).
 *
 * Gated on the resolved policy (org shield "Apply to routines" + PII
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

/**
 * @returns 'tokens' | 'masked' | 'real'
 */
function egressMode(policy, destination) {
    if (!policy) return 'real';
    // 'external' covers third parties; 'all' additionally covers on-box
    // destinations (Nextcloud on the same host, the local notebook store, …).
    const isExternal = destination !== 'internal';
    const covered = policy.privacyScope === 'all' || isExternal;
    if (!covered) return 'real';
    if (policy.action === 'tokenize') return 'tokens';
    // 'redact' used to tokenize and then restore everything, so it protected
    // nothing at all — it only left a guardrail row behind. It masks for real now.
    if (policy.action === 'redact') return 'masked';
    return 'real';
}

// Same shape as piiDetection's _TOKEN_NAME_RE: the category key may itself
// contain underscores (`[credit_card_1]`), so the prefix class must include
// them and let backtracking split off the counter.
const _TOKEN_RE = /\[([a-z0-9_]+)_(\d+)\]/g;

/** Replace `[person_1]` with `[person]` — no counter, so occurrences can't be re-linked. */
function maskTokens(value) {
    try {
        const json = JSON.stringify(value);
        if (json === undefined) return value;
        return JSON.parse(json.replace(_TOKEN_RE, (_m, cat) => `[${cat}]`));
    } catch (_) { return value; }
}

/**
 * Put the real values back, walking the value STRUCTURALLY.
 *
 * This used to serialise the whole value with JSON.stringify, hand the JSON
 * TEXT to restoreTokens and re-parse. restoreTokens is a plain String.replace:
 * it wrote the vault's RAW value straight into the JSON text without
 * JSON-escaping it. Any real value containing a `"`, a backslash, a newline, a
 * tab or any other control character therefore produced BROKEN JSON, JSON.parse
 * threw, and the `catch (_) { return value; }` handed back the still-tokenized
 * value — so the customer received a literal `[person_1]` / `[address_1]` (a
 * multi-line address is the common case), and a crafted value could inject
 * extra JSON keys. This is the single restore point for BOTH prepareForEgress
 * and restoreForRunState, so the damage reached every destination.
 *
 * Walking the leaves means a substituted value is never re-parsed as JSON, so
 * quotes/newlines/backslashes are structurally impossible to misinterpret.
 * (Object KEYS are no longer rewritten. Nothing mints a token into a key — the
 * guard only ever transforms string LEAVES — so no token that this vault can
 * resolve can exist in a key.)
 *
 * No try/catch on purpose: "the restore failed" must never masquerade as "the
 * restore succeeded", because the failure mode is shipping placeholders — or
 * unrestored personal data — to a third party. Both callers are inside a step
 * executor, so a throw surfaces as a normal step failure (on_error edge / a
 * failed run), which is exactly the visible outcome we want.
 */
function restoreFromVault(value, vaultMap) {
    if (!vaultMap || !Object.keys(vaultMap).length) return value;
    const { restoreTokens } = require('../privacy/piiDetection');
    const leaves = collectStringLeaves(value);
    if (!leaves.length) return value;
    return applyStringLeaves(value, leaves.map(leaf => restoreTokens(leaf, vaultMap)));
}

/**
 * Decide what a payload looks like when it leaves the platform.
 *
 * Restoration uses the WHOLE run vault, not just the map of the value that was
 * scanned a moment ago: a placeholder minted by an earlier node is not personal
 * data, so the current step's scan never sees it — that is exactly how
 * `[person_1]` used to be sent to third parties as literal text.
 *
 * @param {object} opts.destination 'external' (default) | 'internal'
 */
function prepareForEgress(value, policy, ctx, { destination = 'external' } = {}) {
    const mode = egressMode(policy, destination);
    if (mode === 'tokens') return value;                 // already tokenized upstream
    if (mode === 'masked') return maskTokens(value);
    return restoreFromVault(value, _vaultOf(ctx).all());
}

/**
 * Restore a guarded value for use INSIDE the platform (writing into runState).
 * Always the full vault — see prepareForEgress.
 */
function restoreForRunState(value, ctx) {
    return restoreFromVault(value, _vaultOf(ctx).all());
}

// ── egress logging (always the metadata row; scan gated by the org toggle) ──
//
// Non-blocking by design: this used to await the full windowed GLiNER scan
// before returning, and engine.js awaits logEgress — monitoring sat on the
// critical path of EVERY automation step. The shared logger detaches the
// scan+insert; this function returns in microseconds.

async function logEgress({ toolName, toolArgs, result, error, blocked, probe, policy, auditBase, mode, durationMs, integMeta: metaOverride, servedFromCache = false }) {
    try {
        // `metaOverride` is for outbound paths that are not catalog tools —
        // http_request, the code step's fetch bridge, notification delivery.
        // Without it, resolveIntegration returns null and those calls left the
        // platform with no ledger row at all.
        let integMeta = metaOverride || null;
        if (!integMeta) {
            const { resolveIntegration } = require('../integrations/integrationToolMap');
            integMeta = resolveIntegration(toolName, toolArgs || {}, { nextcloudUrl: auditBase.nextcloudUrl });
        }
        if (!integMeta) return; // internal / non-integration tool — nothing left the platform

        const { logToolEgress } = require('../integrations/integrationLogging');
        logToolEgress({
            toolName,
            toolArgs,
            result,
            error: error || null,
            blocked: !!blocked,
            probe: probe || null,
            source: auditBase.source || 'routine',
            model: auditBase.model || null,
            durationMs,
            preResolvedMeta: integMeta,
            // The policy is already resolved per run — hand it over so the
            // shared logger doesn't re-fetch the shield config per step.
            shield: {
                monitorIntegrations: !!policy.monitorIntegrations,
                piiDetectionConfidenceThreshold: policy.confidence,
            },
            // Windowed GLiNER scan only when the org has PII detection at all;
            // otherwise stay at the 'basic' regex sniff.
            fullScan: policy.piiEnabled
                ? (text) => _detectPii(text, policy)
                : async () => null,
            ids: {
                organization_id: auditBase.organization_id,
                user_id: auditBase.user_id,
                // Routines are NOT agents. The automation id used to be
                // stuffed into agent_id here, which polluted every 'agent'
                // breakdown with routines; automation_id below is the real
                // attribution, and historical rows remain classifiable via
                // automation_id IS NOT NULL.
                agent_id: null,
                agent_name: auditBase.agent_name,
                conversation_id: auditBase.conversation_id,
                automation_id: auditBase.automation_id,
                run_id: auditBase.run_id,
                step_id: auditBase.step_id,
            },
            isDryRun: mode === 'dry_run',
            // A DURABLE cache hit still writes a row — integration_activity_log
            // is the only evidence the org talks to this processor at all, and
            // its RoPA reader takes MAX(timestamp) — but it is flagged, because
            // no bytes crossed the boundary and the Art-44 transfer count must
            // not count it. A RUN-MEMO hit writes nothing: the first call in
            // that run already logged the real transfer.
            servedFromCache: !!servedFromCache,
        });
    } catch (_) { /* never fail a run on egress logging */ }
}

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
