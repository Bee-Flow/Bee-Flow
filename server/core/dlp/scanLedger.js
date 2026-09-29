// @typecheck
/**
 * Memoises exactly one pure function: the guard's verdict for one segment,
 * under one detection policy, from one identified engine.
 *
 * THE WRITE RULE IS THE WHOLE SAFETY ARGUMENT
 * A row is written only when the result carries an `engineFingerprint` that the
 * guard itself put there. That single condition excludes, in one go:
 *   - `detectPii` returning null (guard not installed / URL momentarily absent —
 *     piiDetection.js:1068-1074, which attachmentScanner turns into a clean pass)
 *   - `guard_circuit_open`, `guard_unreachable`
 *   - any degraded or partial result
 * Without it, a ten-second configStore hiccup would be recorded as "there is no
 * personal data here" and, with no expiry, never revisited. That is the failure
 * mode that makes a TTL-free cache dangerous, and it is designed out rather
 * than mitigated.
 *
 * WHAT IS NOT IN THE KEY, ON PURPOSE
 * `piiDetectionAction` (block vs tokenize) and `attachmentLargeInputPolicy`.
 * Neither changes what the detector FINDS, only what the caller does with it,
 * and both are re-read from the live shield every turn. Leaving them out is
 * what lets the ingest-time scan (which forces fail_open) and the chat-time
 * scan share rows — the source reuse the owner asked for — and means flipping
 * block↔tokenize takes effect instantly with no re-scan.
 */

const crypto = require('crypto');
const ledgerStore = require('../../stores/piiScanLedgerStore');
const { segmentText } = require('./segmentText');
const { isCustomTypeId } = require('../privacy/customTypes/ids');
const { displayNameFor } = require('../privacy/customTypes/registry');
const log = require('../../telemetry/log');

// Bump to invalidate every row: covers the marshalling AND the segmentation
// rule, neither of which is otherwise visible in the key. The one-line rollback.
const LEDGER_KEY_VERSION = 1;

const DISABLED = String(process.env.PII_LEDGER_DISABLED || '').toLowerCase() === 'true';
const MAX_REQUEST_CHARS = Math.max(1000, Number(process.env.PII_GUARD_WINDOW_CHARS || 8000));
const WINDOW_OVERLAP_CHARS = 256;

let _hmacKey = null;
function hmacKey() {
    if (_hmacKey) return _hmacKey;
    // A server-side secret rather than a bare hash: units can be short (a source
    // label, a document title), and sha256("Dossier Jan Jansen.pdf") is trivially
    // brute-forced from a candidate list. Derived from an existing secret so
    // there is nothing new to provision or rotate.
    // No literal fallback: a constant shipped with the source defeats the very
    // brute-force this key exists to stop. index.js refuses to boot without
    // SESSION_SECRET, so this only fires outside the server.
    const material = process.env.SESSION_SECRET || process.env.MASTER_ENCRYPTION_KEY;
    if (!material) {
        throw new Error('[ScanLedger] SESSION_SECRET or MASTER_ENCRYPTION_KEY must be set — it keys the HMAC that keeps short unit labels from being brute-forced. See .env.example.');
    }
    _hmacKey = crypto.createHash('sha256').update(`pii-ledger:v1:${material}`).digest();
    return _hmacKey;
}

/** Digest of the category vocabulary, so a later alias fix invalidates by itself. */
let _catTableDigest = null;
function categoryTableDigest() {
    if (_catTableDigest) return _catTableDigest;
    try {
        const { ALL_PII_CATEGORY_IDS } = require('../privacy/piiDetection');
        _catTableDigest = crypto.createHash('sha256')
            .update((ALL_PII_CATEGORY_IDS || []).join(',')).digest('hex').slice(0, 12);
    } catch { _catTableDigest = 'unknown'; }
    return _catTableDigest;
}

function scanKey({ text, categories, threshold, engineFingerprint, scope }) {
    // `null` categories ("everything the guard knows") is a DIFFERENT request
    // from an explicit list of all ids — keep them distinguishable.
    const cats = categories === null || categories === undefined
        ? '\u0000all'
        : [...categories].sort().join(',');
    const thr = Number.isFinite(threshold) ? threshold.toFixed(4) : '\u0000default';
    const geometry = `${MAX_REQUEST_CHARS}:${WINDOW_OVERLAP_CHARS}`;
    const material = [
        String(LEDGER_KEY_VERSION), scope || 'g', engineFingerprint,
        cats, thr, geometry, categoryTableDigest(), text,
    ].join('');
    return crypto.createHmac('sha256', hmacKey()).update(material).digest('hex');
}

// An org's own data type ("Your own data") is stored by id only: its name is
// the admin's words and can change, so it is looked up again on the way out.
// `ac` keeps the categories a merged span also carried (tool blocking reads
// them); both are absent for a built-in-only row, which packs as it always did.
const _pack = e => ({
    o: e.offset, l: e.length, c: e.category,
    ...(e.label && e.label !== e.category && !isCustomTypeId(e.category) ? { lb: e.label } : {}),
    ...(Number.isFinite(e.confidence) ? { cf: Math.round(e.confidence * 1000) / 1000 } : {}),
    ...(Array.isArray(e.alsoCategories) && e.alsoCategories.length ? { ac: e.alsoCategories } : {}),
});
const _unpack = (r, shift) => ({
    offset: r.o + shift, length: r.l, category: r.c,
    label: r.lb || (isCustomTypeId(r.c) ? displayNameFor(r.c) : r.c),
    confidence: Number.isFinite(r.cf) ? r.cf : undefined,
    ...(Array.isArray(r.ac) ? { alsoCategories: r.ac } : {}),
});

/**
 * Detect PII over `text`, reusing previously memoised segment verdicts.
 *
 * @returns {Promise<{entities:Array, degraded:boolean, degradedReason:string|null,
 *                    stats:{segments:number,hits:number,fresh:number}}>}
 *   Entity offsets are absolute against `text`. `degraded` is true when any
 *   segment could not be scanned — the caller applies its own failure policy,
 *   exactly as it does for a direct detectPii call.
 * @param text
 * @param {{ categories?: string[], threshold?: number, scope?: string, detect?: Function }} [opts]
 */
async function detectWithLedger(text, { categories, threshold, scope, detect } = {}) {
    const detectPii = detect || require('../privacy/piiDetection').detectPii;
    const str = typeof text === 'string' ? text : '';
    const stats = { segments: 0, hits: 0, fresh: 0 };
    if (!str) return { entities: [], degraded: false, degradedReason: null, stats };

    const segments = segmentText(str, { maxChars: MAX_REQUEST_CHARS, overlapChars: WINDOW_OVERLAP_CHARS });
    stats.segments = segments.length;

    // One scan first, to learn the engine identity. Without a fingerprint we
    // cannot key anything, so we simply behave like today: scan every segment.
    const probe = await detectPii(segments[0].scanText, categories, threshold, { priority: 'bulk' });
    const engineFingerprint = probe && probe.engineFingerprint;
    const usable = !DISABLED && typeof engineFingerprint === 'string' && engineFingerprint.length > 0;

    const entities = [];
    let degraded = false;
    let degradedReason = null;

    const push = (list, seg) => {
        for (const e of list) {
            if (!Number.isFinite(e.offset) || !Number.isFinite(e.length)) continue;
            entities.push({ ...e, offset: e.offset + seg.scanStart });
        }
    };
    const absorb = (result, seg) => {
        if (result && result.guardAbsent) {
            // No guard, but the org's own words/patterns ran in Node. A
            // failure for the caller's policy, like null, with those
            // findings kept; never memoised (no engine identity).
            degraded = true;
            degradedReason = degradedReason || 'guard_not_installed';
            if (result.hasPii) push(result.entities || [], seg);
            return null;
        }
        if (!result || result.degraded) {
            degraded = true;
            degradedReason = degradedReason || (result ? result.degradedReason : 'guard_not_installed');
            return null;
        }
        const list = result.hasPii ? (result.entities || []) : [];
        push(list, seg);
        return list;
    };

    const first = absorb(probe, segments[0]);
    stats.fresh += 1;

    const toWrite = [];
    if (usable && first) {
        toWrite.push({
            key: scanKey({ text: segments[0].scanText, categories, threshold, engineFingerprint, scope }),
            entities: first.filter(e => Number.isFinite(e.offset) && Number.isFinite(e.length)).map(_pack),
            charLen: segments[0].scanText.length,
            keyVersion: LEDGER_KEY_VERSION,
        });
    }

    const rest = segments.slice(1);
    if (rest.length > 0) {
        const keys = usable
            ? rest.map(seg => scanKey({ text: seg.scanText, categories, threshold, engineFingerprint, scope }))
            : [];
        // Belt and braces: the store already resolves its own failures to a
        // miss, but a caller that trusts that is one refactor away from letting
        // a storage fault surface as a detection fault. Never.
        let cached = new Map();
        if (usable) {
            try { cached = await ledgerStore.getMany(keys) || new Map(); } catch (err) {
                log.warn(`[ScanLedger] read failed, scanning fresh: ${err.message}`);
            }
        }

        for (let i = 0; i < rest.length; i++) {
            const seg = rest[i];
            const hit = usable ? cached.get(keys[i]) : null;
            // Length is part of the identity check as well as the key: a row whose
            // char_len disagrees cannot be trusted to carry valid offsets.
            if (hit && hit.charLen === seg.scanText.length) {
                for (const r of hit.entities) {
                    const e = _unpack(r, seg.scanStart);
                    if (e.offset >= 0 && e.offset + e.length <= str.length) entities.push(e);
                }
                stats.hits += 1;
                continue;
            }
            const result = await detectPii(seg.scanText, categories, threshold, { priority: 'bulk' });
            stats.fresh += 1;
            const list = absorb(result, seg);
            if (usable && list && result.engineFingerprint === engineFingerprint) {
                toWrite.push({
                    key: keys[i],
                    entities: list.filter(e => Number.isFinite(e.offset) && Number.isFinite(e.length)).map(_pack),
                    charLen: seg.scanText.length,
                    keyVersion: LEDGER_KEY_VERSION,
                });
            }
        }
    }

    if (toWrite.length > 0) ledgerStore.putMany(toWrite).catch(() => { /* memoisation is best-effort */ });

    return { entities, degraded, degradedReason, stats };
}

module.exports = { detectWithLedger, scanKey, LEDGER_KEY_VERSION, _pack, _unpack };
