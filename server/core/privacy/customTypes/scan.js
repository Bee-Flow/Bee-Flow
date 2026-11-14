// @typecheck
'use strict';
/**
 * detectPii for a category list that holds "Your own data" ids.
 *
 * detect.js forks here only when planScan found custom ids; a list without
 * them never reaches this file. The work, in order:
 *
 *   1. `words` / `pattern` types run in Node (nodeMatch.js). They need no
 *      guard, exactly like the old custom terms did.
 *   2. The guard runs only when there is something for it: built-in
 *      categories, or `ai` types (sent as custom_labels when the guard is new
 *      enough to understand them).
 *   3. Everything is merged by the one rule in merge.js.
 *
 * What can go wrong, and what the caller is told:
 *   - no guard installed but the list needs one → the Node findings with
 *     `guardAbsent: true` (not null: the custom matches are real and must be
 *     redacted; callers count it like null for their failure policy);
 *   - breaker open / guard unreachable → degraded, Node findings kept;
 *   - guard too old for custom_labels → the ai ids degraded, the rest scanned;
 *   - a guard that refuses custom_labels (422) → the version memo is cleared,
 *     the scan is retried ONCE without them, the ai ids are degraded, and the
 *     breaker is NOT tripped (the guard is fine; the field is new);
 *   - an id nobody can resolve → degraded `custom_type_unknown`;
 *   - a migrated V8 pattern over its time budget → that id degraded.
 * `degradedCategories` names the affected ids, so a caller whose scope does
 * not include them can carry on.
 */

const crypto = require('crypto');
const { getGuardEndpoint } = require('../piiDetection/guardEndpoint');
const { cacheKey, cacheGet, cacheSet, _inflightScans, _cloneScanResult } = require('../piiDetection/scanCache');
const { MAX_REQUEST_CHARS, circuitIsOpen, noteGuardFailure, noteGuardSuccess } = require('../piiDetection/requestShaping');
const { windowCountFor, detectPiiWindowed } = require('../piiDetection/windowing');
const { detectPiiViaCpuModel } = require('../piiDetection/guardClient');
const guardCapabilities = require('./guardCapabilities');
const { matchNode } = require('./nodeMatch');
const { mergeEntities, spansToEntities } = require('./merge');
const log = require('../../../telemetry/log');

/**
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('./plan').planScan>>>} ScanPlan
 * @typedef {{ text: string, plan: ScanPlan, threshold: number, priority: 'interactive'|'bulk', onProgress: Function|null, aiIds: string[], customDegraded: Map<string, string> }} ScanContext
 *   `customDegraded`: the degraded ids and why, in the order they were found
 * @typedef {{ entities?: any[], customEntities?: any[], degraded?: boolean, degradedReason?: string | null, degradedCategories?: string[] | null, processedChars?: unknown, totalChars?: unknown, tierMode?: string | null, engineFingerprint?: string | null }} GuardAnswer
 *   the guard's answer as _callGuard returns it (or a degraded stand-in)
 * @typedef {{ hasPii: boolean, entities: any[], redactedText: string, degraded: boolean, degradedReason: string | null, degradedCategories: string[] | null, processedChars: number | null, totalChars: number | null, tierMode: string | null, engineFingerprint: string | null, guardAbsent?: boolean }} ScanResult
 */

/**
 * @param {string} text
 * @param {string[]} builtIns
 * @param {number} threshold
 * @param {{ url: string, apiKey?: string }} endpoint
 * @param {'interactive'|'bulk'} priority
 * @param {Function|null} onProgress
 * @param {{ labels: object[], key: string } | null} custom
 */
function _callGuard(text, builtIns, threshold, endpoint, priority, onProgress, custom) {
    return text.length > MAX_REQUEST_CHARS
        ? detectPiiWindowed(text, builtIns, threshold, endpoint, priority, onProgress, custom)
        : detectPiiViaCpuModel(text, builtIns, threshold, endpoint, priority, custom ? custom.labels : null);
}

/** @param {string} reason */
const guardDegraded = (reason) => ({ entities: [], degraded: true, degradedReason: reason, degradedCategories: null });

/**
 * The ids degraded by what the Node matchers ran into. A partial scan never
 * replaces a reason found before it.
 * @param {ReturnType<typeof matchNode>} node
 * @param {Map<string, string>} customDegraded
 */
function noteNodeDegraded(node, customDegraded) {
    for (const id of node.failed) customDegraded.set(id, 'custom_type_invalid');
    for (const id of node.timedOut) customDegraded.set(id, 'custom_pattern_timeout');
    for (const id of node.partialIds) if (!customDegraded.has(id)) customDegraded.set(id, 'custom_scan_partial');
}

/**
 * The custom_labels of the `ai` types, or null when there are none or the
 * guard is too old for them (then the ai ids are degraded).
 * @param {ScanContext} ctx
 * @param {{ url: string, apiKey?: string }} endpoint
 */
async function customLabelsFor(ctx, endpoint) {
    if (!ctx.aiIds.length) return null;
    if (!(await guardCapabilities.supportsCustomLabels(endpoint))) {
        for (const id of ctx.aiIds) ctx.customDegraded.set(id, 'custom_labels_unsupported');
        return null;
    }
    // Saved lists never repeat a prompt (spec.js); types passed in directly
    // might, and the guard refuses the request.
    const seenPrompts = new Set();
    const labels = [];
    for (const t of ctx.plan.aiTypes) {
        const p = String(t.ai.prompt).trim().toLowerCase();
        if (seenPrompts.has(p)) { ctx.customDegraded.set(t.id, 'custom_labels_duplicate'); continue; }
        seenPrompts.add(p);
        labels.push({ id: t.id, prompt: t.ai.prompt, floor: t.ai.floor });
    }
    return { labels, key: ctx.plan.digest };
}

/**
 * One guard call, counted by the breaker. A failure answers degraded, except
 * the guard refusing the custom labels (a 422), which is rethrown: the guard
 * is up, it does not know the field.
 * @param {ScanContext} ctx
 * @param {{ url: string, apiKey?: string }} endpoint
 * @param {{ labels: object[], key: string } | null} custom
 */
async function callGuardCounted(ctx, endpoint, custom) {
    try {
        const res = await _callGuard(ctx.text, ctx.plan.builtIns, ctx.threshold, endpoint, ctx.priority, ctx.onProgress, custom);
        noteGuardSuccess();
        return res;
    } catch (err) {
        if (custom && err?.status === 422) throw err;
        noteGuardFailure();
        log.warn('[PiiDetection] guard-service unavailable:', /** @type {Error} */ (err)?.message);
        return guardDegraded(`guard_unreachable: ${/** @type {Error} */ (err)?.message}`);
    }
}

/**
 * The guard scan. A guard that refuses custom_labels gets its version memo
 * cleared and ONE retry without them (only when built-ins remain to scan);
 * the breaker is not tripped for it.
 * @param {ScanContext} ctx
 * @param {{ url: string, apiKey?: string }} endpoint
 * @param {{ labels: object[], key: string } | null} custom
 */
async function scanWithGuard(ctx, endpoint, custom) {
    try {
        return await callGuardCounted(ctx, endpoint, custom);
    } catch (err) {
        guardCapabilities.clearGuardCapabilities(endpoint.url);
        for (const id of ctx.aiIds) ctx.customDegraded.set(id, 'custom_labels_rejected');
        log.warn(`[PiiDetection] guard refused custom_labels (${/** @type {Error} */ (err).message}); retrying without them`);
        return ctx.plan.builtIns.length ? callGuardCounted(ctx, endpoint, null) : null;
    }
}

/**
 * The guard's answer, when the list needs the guard: built-in categories or
 * `ai` types. `guardAbsent` when none is installed.
 * @param {ScanContext} ctx
 * @returns {Promise<{ guardRes: GuardAnswer | null, guardAbsent: boolean }>}
 */
async function askGuard(ctx) {
    const { plan } = ctx;
    if (!plan.builtIns.length && !ctx.aiIds.length) return { guardRes: null, guardAbsent: false };
    const endpoint = await getGuardEndpoint();
    if (!endpoint.url) return { guardRes: null, guardAbsent: true };
    if (circuitIsOpen()) {
        log.warn('[PiiDetection] guard circuit open — short-circuiting to degraded');
        return { guardRes: guardDegraded('guard_circuit_open'), guardAbsent: false };
    }
    const custom = await customLabelsFor(ctx, endpoint);
    if (!plan.builtIns.length && !custom) return { guardRes: null, guardAbsent: false };
    return { guardRes: await scanWithGuard(ctx, endpoint, custom), guardAbsent: false };
}

/**
 * The ids and categories a degraded answer did not cover, or null for an
 * unknown scope.
 * @param {GuardAnswer | null} guardRes
 * @param {ScanContext} ctx
 * @returns {string[] | null}
 */
function affectedCategories(guardRes, ctx) {
    // A partial guard scan (oversize) leaves an unscanned tail that can hide
    // anything: keep the guard's "unknown scope" answer.
    if (guardRes?.degraded && typeof guardRes.processedChars === 'number') return null;
    const affected = new Set(ctx.customDegraded.keys());
    if (guardRes?.degraded) {
        // The guard names what it lost when it can; otherwise it lost
        // everything it was asked for: the built-ins and the ai types.
        const lost = Array.isArray(guardRes.degradedCategories) ? guardRes.degradedCategories : [...ctx.plan.builtIns, ...ctx.aiIds];
        lost.forEach(c => affected.add(c));
    }
    return affected.size ? [...affected] : null;
}

/**
 * Whether the answer is degraded, the first reason (the guard's before the
 * custom ids'), and what it did not cover.
 * @param {GuardAnswer | null} guardRes
 * @param {ScanContext} ctx
 */
function degradedSummary(guardRes, ctx) {
    const { customDegraded } = ctx;
    const degraded = !!guardRes?.degraded || customDegraded.size > 0;
    let degradedReason = guardRes?.degraded ? (guardRes.degradedReason || null) : null;
    if (!degradedReason && customDegraded.size) degradedReason = customDegraded.values().next().value || null;
    return { degraded, degradedReason, degradedCategories: degraded ? affectedCategories(guardRes, ctx) : null };
}

/**
 * Memoising callers (scanLedger) may only store an answer from an identified
 * engine. Mixed with Node matchers the identity also has to cover their
 * specs; a Node-only or degraded answer carries none and is never stored.
 * @param {GuardAnswer | null} guardRes
 * @param {string} digest
 */
function combinedFingerprint(guardRes, digest) {
    if (!guardRes || guardRes.degraded || !guardRes.engineFingerprint) return null;
    const fp = guardRes.engineFingerprint;
    return `${fp}+c${crypto.createHash('sha256').update(`${fp}|${digest}`).digest('hex').slice(0, 12)}`;
}

/** @param {unknown} v */
const numberOrNull = (v) => (typeof v === 'number' ? v : null);

/**
 * @param {string} text
 * @param {ScanPlan} plan
 * @param {number} threshold
 * @param {{ priority?: string, onProgress?: Function }} opts
 */
async function _scanOnce(text, plan, threshold, opts) {
    /** @type {ScanContext} */
    const ctx = {
        text, plan, threshold,
        priority: opts?.priority === 'bulk' ? 'bulk' : 'interactive',
        onProgress: typeof opts?.onProgress === 'function' ? opts.onProgress : null,
        aiIds: plan.aiTypes.map(t => t.id),
        customDegraded: new Map(),
    };
    for (const id of plan.unknown) ctx.customDegraded.set(id, 'custom_type_unknown');
    for (const id of plan.conflicted || []) ctx.customDegraded.set(id, 'custom_type_conflict');

    // 1. Node matchers, 2. the guard when the list needs it, 3. the merge.
    const node = matchNode(text, plan.compiled);
    noteNodeDegraded(node, ctx.customDegraded);
    const nodeEntities = spansToEntities(node.spans, text);
    const { guardRes, guardAbsent } = await askGuard(ctx);
    const entities = mergeEntities([...(guardRes?.entities || []), ...(guardRes?.customEntities || []), ...nodeEntities], text, plan);

    /** @type {ScanResult} */
    const result = {
        hasPii: entities.length > 0,
        entities,
        redactedText: text,
        ...degradedSummary(guardRes, ctx),
        processedChars: numberOrNull(guardRes?.processedChars),
        totalChars: numberOrNull(guardRes?.totalChars),
        tierMode: guardRes?.tierMode || null,
        engineFingerprint: combinedFingerprint(guardRes, plan.digest),
    };
    if (guardAbsent) result.guardAbsent = true;
    // Ids and counts only, never names or matches.
    if (ctx.customDegraded.size) {
        log.warn(`[PiiDetection] custom types degraded: ${[...ctx.customDegraded].map(([id, why]) => `${id}=${why}`).join(' ')}`);
    }
    return result;
}

/**
 * The custom-type branch of detectPii: cached, single-flighted, never
 * caching a degraded or guard-less answer (same rules as the built-in path).
 * @param {string} text
 * @param {string[]} enabledCategories
 * @param {number} threshold
 * @param {ScanPlan} plan  planScan() result
 * @param {Parameters<typeof _scanOnce>[3]} [opts]
 */
async function detectWithCustomTypes(text, enabledCategories, threshold, plan, opts = {}) {
    const t0 = Date.now();
    /**
     * @param {string} how
     */
    const done = (how, r) => log.info(
        `[PiiDetection] pii.client ms=${Date.now() - t0} chars=${text.length} `
        + `windows=${windowCountFor(text)} custom=${plan.ids.length} `
        + `via=${how} degraded=${!!r?.degraded} reason=${r?.degradedReason || '-'}`,
    );

    const key = cacheKey('detect', text, enabledCategories, threshold, plan.digest);
    const cached = cacheGet(key);
    if (cached) { done('cache', cached); return _cloneScanResult(cached); }
    const inflight = _inflightScans.get(key);
    if (inflight) return inflight.then((r) => { done('coalesced', r); return _cloneScanResult(r); });

    const scan = _scanOnce(text, plan, threshold, opts);
    _inflightScans.set(key, scan);
    try {
        const result = await scan;
        if (result && !result.degraded && !result.guardAbsent) cacheSet(key, result);
        done('custom', result);
        return _cloneScanResult(result);
    } finally {
        _inflightScans.delete(key);
    }
}

module.exports = { detectWithCustomTypes };
