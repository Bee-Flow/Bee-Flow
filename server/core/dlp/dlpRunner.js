// @typecheck
/**
 * DLP (Data Loss Prevention) runner — the single entry point for scanning a
 * user's outbound prompt before it reaches an LLM.
 *
 * Combines two signal sources:
 *   - PII detection (`server/core/privacy/piiDetection.js`), which also runs
 *     the org's own data types ("Your own data", core/privacy/customTypes);
 *     they stand in for a separate custom-terms scan
 *   - Provider classification (external vs. internal)
 *
 * And turns them into a single *action*:
 *   - 'allow'   — send the prompt as-is
 *   - 'redact'  — tokenise findings, send the tokenised text, keep a tokenMap
 *   - 'block'   — refuse the turn, surface an error to the user
 *   - 'ask'     — pause the stream, show the user a preview, wait for their choice
 *
 * The runner never throws for "PII found" the way the old flow does. Instead
 * the caller inspects `action` and drives the UX accordingly. This keeps the
 * interactive path and the auto path in the same function.
 */

const { detectPii } = require('../privacy/piiDetection');
const { buildAllowMatcher, filterAllowedEntities } = require('./allowTerms');
const { classifyProvider } = require('../providers/classification');
const log = require('../../telemetry/log');
const { eviction, _mergeIntoTokenMap, _writeMapToDb, getConversationTokenMap, getConversationTokenMapAsync, clearConversationState, setConversationPref, getConversationPref, gc } = require('./dlpTokenMaps');
const { _normalisePiiEntities, _tokeniseAll, _recordToVault, _extractLastUserText } = require('./dlpTokenise');
const { bestEffort } = require('../../utils/bestEffort');

// ─── DB persistence (write-through + hydrate) ───────────────────────
// Without this, the in-process Map at line 32 is lost on every server
// restart. Persisted content (Notebook, saved messages) that still contains
// `[person_N]` placeholders would then be unredeemable forever. Persisting
// the token map alongside the conversation row makes restore-on-reload
// possible. See plan: token round-trip beyond the chat message.

// ── Token-map encryption ────────────────────────────────────────────────────
// The token map is the reverse dictionary for the Privacy Shield: it maps
// [email_1] back to the real address. In other words it holds precisely the PII
// that was stripped out of the message — and it sat in plaintext JSONB on the
// SAME ROW as the (supposedly) encrypted conversation. Encrypting the messages
// while leaving this readable protects nothing.
//
// The envelope must stay a JSON OBJECT. _hydrateFromDb branches on
// `typeof stored === 'object'` (node-postgres parses JSONB for us); a bare
// ciphertext string would fall through that check silently — no error, no log —
// and every [email_N] placeholder in stored messages would become permanently
// unresolvable. That is why fieldEnvelope has an `asObject` mode.

/**
 * Start the PII half of a DLP scan early, without consuming the result.
 *
 * The chat path pays two sequential guard round trips before the first LLM
 * token: the memory-context scrub, then this scan. They scan DIFFERENT texts,
 * so one cannot serve the other — but they can OVERLAP. Calling this before
 * memory retrieval starts the guard scan of the user message; when scan()
 * later calls detectPii with the same (text, categories, threshold), the
 * single-flight table in piiDetection joins the in-flight request (or the
 * cache serves it), so the real scan pays ~nothing.
 *
 * Correct by construction rather than by a mutation guard: if guardrails
 * rewrite the message in between, scan() derives a DIFFERENT cache key and
 * simply performs a fresh scan — the pre-warm is discarded, never misapplied.
 * The waste of a discarded pre-warm is bounded by the one-window cap below.
 *
 * Deliberately duplicates scan()'s early-exit conditions INSIDE this module
 * (not in the caller) so the two derivations of "what will be scanned, with
 * which arguments" cannot drift apart.
 *
 * Fire-and-forget: never throws, never blocks, returns nothing.
 */
function preWarmPiiScan({ messages, orgShieldConfig, providerConfig }) {
    try {
        if (!orgShieldConfig?.dlpEnabled || !orgShieldConfig?.enabled) return;
        const provider = classifyProvider(providerConfig || {}, orgShieldConfig?.dlpAllowlistedHosts || []);
        const scope = orgShieldConfig.dlpScope || 'external';
        if (scope === 'external' && !provider.isExternal) return;
        const text = _extractLastUserText(messages);
        if (!text || text.length < 3) return;
        // One window max: past that the windowed path is multiple sequential
        // guard calls, too expensive to risk discarding on a guardrail rewrite.
        const { MAX_REQUEST_CHARS } = require('../privacy/piiDetection');
        if (text.length > MAX_REQUEST_CHARS) return;
        const piiCategories = Array.isArray(orgShieldConfig.piiDetectionCategories) && orgShieldConfig.piiDetectionCategories.length > 0
            ? orgShieldConfig.piiDetectionCategories
            : null;
        const piiThreshold = typeof orgShieldConfig.piiDetectionConfidenceThreshold === 'number'
            ? orgShieldConfig.piiDetectionConfidenceThreshold
            : undefined;
        detectPii(text, piiCategories, piiThreshold).catch((e) => bestEffort('core/dlp/dlpRunner:preWarmPiiScan', e));
    } catch (err) { bestEffort('core/dlp/dlpRunner:preWarmPiiScan#2', err); /* pre-warming must never break the turn */ }
}

/**
 * Core entry point.
 *
 * @param {object} params
 * @param {Array}  params.messages            Full messages array (we scan the last user message)
 * @param {any} params.orgShieldConfig     Resolved config from `resolveOrgShield`
 * @param {string} [params.orgId]             Org ID (unused since custom terms moved into detectPii; callers still pass it)
 * @param {string} params.conversationId      Scope for the per-conversation remembered choice + tokenMap
 * @param {Parameters<typeof classifyProvider>[0]} params.providerConfig      { providerType, url, displayName } for classification
 * @param {function} [params.onProgress]      Called per scanned window of a big paste
 *                                            ({ done, total, ... }); the caller renders it.
 * @param {boolean} [params.hasAttachments]  the turn also carries attachments
 * @param {boolean} [params.ephemeral]       `conversationId` is a per-run scope of
 *                                            a server-side AI call (a project chat
 *                                            answer, a relevance gate) with no
 *                                            conversation row: its token map lives
 *                                            in process for the run only, so it is
 *                                            never written through to the database
 *                                            and no owner is looked up for it.
 *                                            Release it with
 *                                            clearConversationState(id, { ephemeral: true }).
 * @returns {Promise<DlpResult>}
 */
async function scan({ messages, orgShieldConfig, conversationId, providerConfig, onProgress, hasAttachments = false, ephemeral = false }) {
    const dlpEnabled = !!orgShieldConfig?.dlpEnabled;
    if (!dlpEnabled) {
        return { action: 'allow', findings: [], provider: { isExternal: false, reason: 'dlp_disabled' }, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    const provider = classifyProvider(providerConfig || {}, orgShieldConfig?.dlpAllowlistedHosts || []);
    const scope = orgShieldConfig.dlpScope || 'external';
    if (scope === 'external' && !provider.isExternal) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    const text = _extractLastUserText(messages);
    if (!text || text.length < 3) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    // detectPii() calls the PII Guard service (GLiNER) and runs the org's
    // own data types; when the guard isn't installed it returns null (or
    // `guardAbsent` with the org's own matches) — a scan failure, below.
    const piiEnabled = !!orgShieldConfig.enabled;
    const piiCategories = Array.isArray(orgShieldConfig.piiDetectionCategories) && orgShieldConfig.piiDetectionCategories.length > 0
        ? orgShieldConfig.piiDetectionCategories
        : null;
    const piiThreshold = typeof orgShieldConfig.piiDetectionConfidenceThreshold === 'number'
        ? orgShieldConfig.piiDetectionConfidenceThreshold
        : undefined;

    let piiResult = null;
    let piiFailed = false;
    let failReason = null;
    try {
        if (piiEnabled) {
            piiResult = await detectPii(text, piiCategories, piiThreshold, { onProgress });
            // detectPii no longer throws on guard errors — it returns a
            // degraded result (guard unreachable, or GLiNER model not ready
            // so only the regex tier answered). Treat that as a scan failure
            // so the fail-closed policy applies instead of trusting an
            // under-redacted result (BFSF-269).
            if (piiResult?.degraded) {
                // Does the degradation touch what THIS org asked for? Same
                // narrowing as validateInputForPii: the guard names WHICH
                // categories lost coverage when it can (a dead label group),
                // and an org scoped to {Email, PhoneNumber} must not be
                // blocked because the healthcare group died. Absent/empty
                // degradedCategories means "unknown — assume all" (older
                // guard, oversize partial scan) and keeps the strict path.
                const affected = piiResult.degradedCategories;
                const requested = Array.isArray(piiCategories) && piiCategories.length
                    ? piiCategories : null;
                if (affected && requested && !affected.some(c => requested.includes(c))) {
                    log.warn(`[DLP] PII scan DEGRADED (${piiResult.degradedReason || 'unknown'}) but only for [${affected.join(', ')}], none of which this org requested — continuing with the result`);
                } else {
                    piiFailed = true;
                    failReason = 'pii_unavailable';
                    log.warn('[DLP] PII scan DEGRADED:', piiResult.degradedReason || 'unknown');
                }
            } else if (piiResult === null || piiResult?.guardAbsent) {
                // NOT the same as "clean". detectPii returns null when the
                // guard is not installed at all, and this branch must not leave
                // piiFailed false — or an org with the shield enabled, DLP
                // enabled and fail_closed set would ship every message unmasked
                // and report scanStatus 'ok'. "No detector" and "no PII" are
                // different answers and must not collapse into one.
                // `guardAbsent` is the same answer from a scan that also ran
                // the org's own words/patterns in Node: same failure, and its
                // findings are still used (fail_open redacts them).
                piiFailed = true;
                failReason = 'guard_not_installed';
                log.warn('[DLP] PII scan requested but the guard service is not installed — treating as a scan failure, not as "clean"');
            }
        }
    } catch (err) {
        piiFailed = true;
        failReason = 'pii_unavailable';
        log.warn('[DLP] PII scan failed:', err.message);
    }

    let piiEntities = piiResult?.hasPii ? _normalisePiiEntities(piiResult.entities) : [];
    // Never-redact layer: public organisations and the org's own allowlist.
    // Never applied to the org's own data types (allowTerms skips them): a
    // type is something the org deliberately asked to hide.
    if (piiEntities.length) {
        const allowMatcher = buildAllowMatcher(orgShieldConfig);
        const filtered = filterAllowedEntities(piiEntities, allowMatcher);
        if (filtered.allowed.length) {
            // Logged by CATEGORY and count, never by value — same privacy
            // contract as the guard's own log lines. But logged: a detection
            // that disappears without a trace is indistinguishable from a
            // detector that broke.
            const byCat = {};
            for (const e of filtered.allowed) byCat[e.category] = (byCat[e.category] || 0) + 1;
            log.info(`[DLP] allowlist kept ${filtered.allowed.length} span(s) unredacted:`,
                JSON.stringify(byCat));
        }
        piiEntities = filtered.entities;
    }
    // detectPii hands back disjoint spans (built-in and custom merged by one
    // rule), so this is only the tail-first order the splice needs.
    const all = [...piiEntities].sort((a, b) => b.offset - a.offset);

    // Handle scan failure / degradation per org policy. `piiFailureMode` is
    // the unified key (shared with the legacy PII path in piiDetection.js);
    // `dlpFailureMode` is kept as a fallback for older stored configs.
    const scanFailed = piiFailed && piiEnabled;
    if (scanFailed) {
        const failMode = orgShieldConfig.piiFailureMode || orgShieldConfig.dlpFailureMode || 'fail_closed';
        if (failMode === 'fail_closed') {
            return { action: 'block', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'failed', summary: {}, reason: failReason || 'pii_unavailable' };
        }
        // fail_open: continue, but mark the scan as failed.
    }

    // Apply mode: honour per-conversation remembered preference first — a
    // "remember my choice" from an earlier ask (this conversation) governs
    // here too, including the always-review case below, so a remembered
    // 'allow' doesn't get re-litigated on every clean message.
    const remembered = getConversationPref(conversationId);
    const mode = orgShieldConfig.dlpMode || 'ask';
    const effectiveChoice = remembered || null;

    if (all.length === 0) {
        // dlpAlwaysReview: pause even on a clean scan, so the user gets a
        // chance to flag what the detector missed — the only false-negative
        // safety net that exists. Skipped once the user has already picked
        // a per-conversation default (rememberForConversation), and skipped
        // when this turn also has attachments: those get their own ask-review
        // a few steps later (attachmentAskFlow.js) with real content to check,
        // so pausing here too — on an empty finding — only added a second,
        // near-empty modal right after the first, not real extra coverage.
        if (orgShieldConfig.dlpAlwaysReview && !effectiveChoice && !hasAttachments) {
            return { action: 'ask', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: scanFailed ? 'failed' : 'ok', summary: {} };
        }
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: scanFailed ? 'failed' : 'ok', summary: {} };
    }

    if (effectiveChoice === 'allow' || mode === 'auto_allow') {
        return { action: 'allow', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary: all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {}) };
    }

    if (effectiveChoice === 'redact' || mode === 'auto_redact') {
        const { tokenizedText, tokenMap, summary } = await _tokeniseAll(text, all, conversationId, { ephemeral });
        _mergeIntoTokenMap(conversationId, tokenMap);
        if (!ephemeral) _writeMapToDb(conversationId).catch((e) => bestEffort('core/dlp/dlpRunner:scan', e));
        return { action: 'redact', findings: all, provider, redactedText: tokenizedText, tokenMap, scanStatus: 'ok', summary };
    }

    if (mode === 'block') {
        const summary = all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {});
        return { action: 'block', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary };
    }

    // Default: ask the user.
    const summary = all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {});
    return { action: 'ask', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary };
}

/**
 * Helper for the callers who chose 'redact' via an interactive decision — apply
 * tokenisation now that the user has said yes.
 */
async function applyRedactionChoice({ conversationId, text, findings, ephemeral = false }) {
    const { tokenizedText, tokenMap, summary } = await _tokeniseAll(text, findings, conversationId, { ephemeral });
    _mergeIntoTokenMap(conversationId, tokenMap);
    if (!ephemeral) _writeMapToDb(conversationId).catch((e) => bestEffort('core/dlp/dlpRunner:applyRedactionChoice', e));
    return { tokenizedText, tokenMap, summary };
}

/**
 * Public helper: merge an externally-built tokenMap into the conversation's
 * shared store so the streaming un-tokeniser (wrapped around `onEvent` in
 * chatStream.js) can restore these tokens on the response.
 *
 * Used by the legacy PII path in `guardrailsRunner.js` and by direct chat,
 * both of which produce their own tokenMap but historically dropped it after
 * rewriting the user message — which meant tokens leaked through to the user
 * when DLP itself was disabled.
 */
function mergeTokenMap(conversationId, tokenMap) {
    if (!conversationId || !tokenMap) return;
    let asObject = tokenMap;
    if (tokenMap instanceof Map) {
        asObject = {};
        for (const [k, v] of tokenMap) asObject[k] = v;
    }
    _mergeIntoTokenMap(conversationId, asObject);

    // Teach the vault, from the one funnel every producer reaches.
    //
    // This is the catch-all. Tokens are minted in six places — the DLP runner,
    // direct chat via validateInputForPii, the attachment scanner, compose
    // scan, tool-result redaction and the automation engine — and they all end
    // up here. Recording only at the mint sites meant direct chat's tokens
    // never reached the vault, so the same address got a stable placeholder in
    // agent chat and a fresh one in direct chat.
    //
    // Duplicate records are free: the value index makes a repeat sighting a
    // usage bump rather than a new row.
    _recordToVault(conversationId, asObject);
    // Write-through to DB so the map survives a server restart. The chat
    // turn does not block on this — failures are logged inside the helper.
    _writeMapToDb(conversationId).catch((e) => bestEffort('core/dlp/dlpRunner:mergeTokenMap', e));
}

module.exports = {
    scan,
    preWarmPiiScan,
    applyRedactionChoice,
    mergeTokenMap,
    getConversationTokenMap,
    getConversationTokenMapAsync,
    clearConversationState,
    setConversationPref,
    getConversationPref,
    gc,
    sweepIdle: eviction.sweepIdle,
};

/**
 * @typedef {{ category: string, label: string, offset: number, length: number, text: string, source: string,
 *            severity: string, confidence?: number }} DlpFinding
 * @typedef {{ role?: string, content?: string | Array<{ type?: string, text?: string }> }} DlpChatMessage
 */

/**
 * `redactedText` and `tokenMap` (Map<token, original>) are present when action is 'redact';
 * `scanStatus` is 'ok' | 'failed' | 'skipped'; `summary` counts per label; `reason` says why a
 * block was chosen, when it was.
 * @typedef {{ action: 'allow'|'redact'|'block'|'ask', findings: Array,
 *   provider: { isExternal: boolean, reason: string, displayName?: string }, redactedText: string|null,
 *   tokenMap: any|null, scanStatus: string, summary: Record<string, number>, reason?: string }} DlpResult
 */
