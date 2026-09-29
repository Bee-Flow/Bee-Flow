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

/**
 * @param {string} text
 * @param {NonNullable<Awaited<ReturnType<typeof import('./plan').planScan>>>} plan
 * @param {number} threshold
 * @param {{ priority?: string, onProgress?: Function }} opts
 */
async function _scanOnce(text, plan, threshold, opts) {
    const priority = opts?.priority === 'bulk' ? 'bulk' : 'interactive';
    const onProgress = typeof opts?.onProgress === 'function' ? opts.onProgress : null;

    // Degraded ids and why, in the order they were found.
    /** @type {Map<string, string>} */
    const customDegraded = new Map();
    for (const id of plan.unknown) customDegraded.set(id, 'custom_type_unknown');
    for (const id of plan.conflicted || []) customDegraded.set(id, 'custom_type_conflict');

    // ── 1. Node matchers ──────────────────────────────────────────────
    const node = matchNode(text, plan.compiled);
    for (const id of node.failed) customDegraded.set(id, 'custom_type_invalid');
    for (const id of node.timedOut) customDegraded.set(id, 'custom_pattern_timeout');
    for (const id of node.partialIds) if (!customDegraded.has(id)) customDegraded.set(id, 'custom_scan_partial');
    const nodeEntities = spansToEntities(node.spans, text);

    // ── 2. Guard, when the list needs it ──────────────────────────────
    const aiIds = plan.aiTypes.map(t => t.id);
    const guardNeeded = plan.builtIns.length > 0 || aiIds.length > 0;
    /** @type {any} */
    let guardRes = null;
    let guardAbsent = false;
    if (guardNeeded) {
        const endpoint = await getGuardEndpoint();
        if (!endpoint.url) {
            guardAbsent = true;
        } else if (circuitIsOpen()) {
            log.warn('[PiiDetection] guard circuit open — short-circuiting to degraded');
            guardRes = { entities: [], degraded: true, degradedReason: 'guard_circuit_open', degradedCategories: null };
        } else {
            let custom = null;
            if (aiIds.length) {
                if (await guardCapabilities.supportsCustomLabels(endpoint)) {
                    // Saved lists never repeat a prompt (spec.js); types passed
                    // in directly might, and the guard refuses the request.
                    const seenPrompts = new Set();
                    const labels = [];
                    for (const t of plan.aiTypes) {
                        const p = String(t.ai.prompt).trim().toLowerCase();
                        if (seenPrompts.has(p)) { customDegraded.set(t.id, 'custom_labels_duplicate'); continue; }
                        seenPrompts.add(p);
                        labels.push({ id: t.id, prompt: t.ai.prompt, floor: t.ai.floor });
                    }
                    custom = { labels, key: plan.digest };
                } else {
                    for (const id of aiIds) customDegraded.set(id, 'custom_labels_unsupported');
                }
            }
            if (plan.builtIns.length || custom) {
                try {
                    guardRes = await _callGuard(text, plan.builtIns, threshold, endpoint, priority, onProgress, custom);
                    noteGuardSuccess();
                } catch (err) {
                    if (custom && err?.status === 422) {
                        // The guard is up; it does not know the field. Not a
                        // guard failure, so the breaker stays shut.
                        guardCapabilities.clearGuardCapabilities(endpoint.url);
                        for (const id of aiIds) customDegraded.set(id, 'custom_labels_rejected');
                        log.warn(`[PiiDetection] guard refused custom_labels (${err.message}); retrying without them`);
                        if (plan.builtIns.length) {
                            try {
                                guardRes = await _callGuard(text, plan.builtIns, threshold, endpoint, priority, onProgress, null);
                                noteGuardSuccess();
                            } catch (err2) {
                                noteGuardFailure();
                                log.warn('[PiiDetection] guard-service unavailable:', err2.message);
                                guardRes = { entities: [], degraded: true, degradedReason: `guard_unreachable: ${err2.message}`, degradedCategories: null };
                            }
                        }
                    } else {
                        noteGuardFailure();
                        log.warn('[PiiDetection] guard-service unavailable:', err?.message);
                        guardRes = { entities: [], degraded: true, degradedReason: `guard_unreachable: ${err?.message}`, degradedCategories: null };
                    }
                }
            }
        }
    }

    // ── 3. Merge ──────────────────────────────────────────────────────
    const all = [
        ...(guardRes?.entities || []),
        ...(guardRes?.customEntities || []),
        ...nodeEntities,
    ];
    const entities = mergeEntities(all, text, plan);

    const degraded = !!guardRes?.degraded || customDegraded.size > 0;
    let degradedReason = guardRes?.degraded ? (guardRes.degradedReason || null) : null;
    if (!degradedReason && customDegraded.size) degradedReason = customDegraded.values().next().value || null;
    let degradedCategories = null;
    if (degraded) {
        const affected = new Set(customDegraded.keys());
        if (guardRes?.degraded) {
            // The guard names what it lost when it can; otherwise it lost
            // everything it was asked for: the built-ins and the ai types.
            const lost = Array.isArray(guardRes.degradedCategories) ? guardRes.degradedCategories : [...plan.builtIns, ...aiIds];
            lost.forEach(c => affected.add(c));
        }
        degradedCategories = affected.size ? [...affected] : null;
        // A partial guard scan (oversize) leaves an unscanned tail that can
        // hide anything: keep the guard's "unknown scope" answer.
        if (guardRes?.degraded && typeof guardRes.processedChars === 'number') degradedCategories = null;
    }

    // Memoising callers (scanLedger) may only store an answer from an
    // identified engine. Mixed with Node matchers the identity also has to
    // cover their specs; a Node-only answer carries none and is never stored.
    const fp = guardRes && !guardRes.degraded && guardRes.engineFingerprint
        ? `${guardRes.engineFingerprint}+c${crypto.createHash('sha256').update(`${guardRes.engineFingerprint}|${plan.digest}`).digest('hex').slice(0, 12)}`
        : null;

    const result = {
        hasPii: entities.length > 0,
        entities,
        redactedText: text,
        degraded,
        degradedReason,
        degradedCategories,
        processedChars: typeof guardRes?.processedChars === 'number' ? guardRes.processedChars : null,
        totalChars: typeof guardRes?.totalChars === 'number' ? guardRes.totalChars : null,
        tierMode: guardRes?.tierMode || null,
        engineFingerprint: fp,
    };
    if (guardAbsent) result.guardAbsent = true;
    // Ids and counts only, never names or matches.
    if (customDegraded.size) {
        log.warn(`[PiiDetection] custom types degraded: ${[...customDegraded].map(([id, why]) => `${id}=${why}`).join(' ')}`);
    }
    return result;
}

/**
 * The custom-type branch of detectPii: cached, single-flighted, never
 * caching a degraded or guard-less answer (same rules as the built-in path).
 * @param {string} text
 * @param {string[]} enabledCategories
 * @param {number} threshold
 * @param {any} plan  planScan() result
 * @param {object} [opts]
 */
async function detectWithCustomTypes(text, enabledCategories, threshold, plan, opts = {}) {
    const t0 = Date.now();
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
