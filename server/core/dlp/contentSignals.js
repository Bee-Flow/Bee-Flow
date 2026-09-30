// @typecheck
'use strict';

/**
 * Content signals — a quiet, after-the-fact answer to "does this project
 * document hold personal data?", for the Compliance Center.
 *
 * WHEN IT RUNS. Only when a VERSION CHECKPOINT of a studio document or a
 * notebook is written (the co-editing compaction job, a named version, an AI
 * edit, a restore) — the caller hands over `queueContentScan(...)` and moves
 * on. Never on a keystroke, never on a co-editing update, never inside a save:
 * this module returns before any work is done, always.
 *
 * HOW. Scans are COALESCED per subject: the first checkpoint arms a timer
 * (COALESCE_MS, default 45 s); later checkpoints of the same subject within
 * that window only replace what will be read, they do not restart the clock
 * (a debounce that restarts can be held off forever by someone who keeps
 * typing). When the timer fires, the latest version's text is loaded through
 * the caller's `loadText()` and scanned with `detectWithLedger` on the guard's
 * BULK lane: every segment that did not change since the last scan is a ledger
 * hit and costs no guard call, so re-scanning a long document after a small
 * edit costs about one segment.
 *
 * WHETHER IT RUNS AT ALL. Only when the organisation's Privacy Shield is on —
 * the shield is what promises scanning, and an org that switched it off asked
 * for none. That is decided BEFORE `loadText()` is called, so a switched-off
 * org does not even pay for materialising the text.
 *
 * WHAT IS KEPT. Canonical category ids with a count each, the personal-data
 * kinds they map to, the total mentions, the version id, and `degraded` — see
 * stores/contentPiiSignalStore.js. When the scan could not be completed (guard
 * down, a segment unscannable, the text too long to scan in full) the row says
 * DEGRADED, which every reader treats as "unknown", never as "clean".
 *
 * WHAT IS NEVER KEPT OR LOGGED. The text, any offset, any value. Log lines
 * carry the subject kind and id and counts.
 *
 * Failure is silent to users by design: a background privacy scan that fails
 * is a log line and a degraded row, never an error anywhere a person types.
 */

const log = require('../../telemetry/log');

const COALESCE_MS = parseInt(process.env.CONTENT_SIGNAL_COALESCE_MS || '45000', 10);
// Past this many characters only the first part is scanned, and the row says
// so (degraded): a partial answer must not read as a complete one.
const MAX_SCAN_CHARS = 400_000;
const SUBJECT_KINDS = Object.freeze(['studio_document', 'notebook_document', 'project_chat']);

function _defaults() {
    return {
        resolveShieldFor: (args) => require('../privacy/orgShield').resolveShieldFor(args),
        detectWithLedger: (text, opts) => require('./scanLedger').detectWithLedger(text, opts),
        store: () => require('../../stores/contentPiiSignalStore'),
        normalizeCategory: (c) => require('../privacy/piiCategories').normalizeCategory(c),
        kindOfCategory: (c) => require('../privacy/personalColumns').kindOfCategory(c),
        coalesceMs: COALESCE_MS,
    };
}

function _shieldScans(shield) {
    if (!shield) return false;
    return shield.enabled !== false && shield.privacyScanEnabled !== false;
}

function _categoriesOf(shield) {
    const cats = shield?.piiDetectionCategories;
    return Array.isArray(cats) && cats.length ? cats : null;
}

/**
 * @param {object} [overrides] resolveShieldFor, detectWithLedger, store (object
 *   or thunk), normalizeCategory, kindOfCategory, coalesceMs
 */
function makeContentSignals(overrides = {}) {
    const d = { ..._defaults(), ...overrides };
    const store = () => (typeof d.store === 'function' ? d.store() : d.store);

    // key -> { timer, job } ; a key here has a scan coming.
    const armed = new Map();
    const running = new Set();
    const again = new Map(); // key -> the job that arrived while running

    const keyOf = (job) => `${job.subjectKind}␟${job.subjectId}`;

    /**
     * Scan one subject now. Never throws.
     * @returns {Promise<{ok: boolean, skipped?: string, degraded?: boolean, mentions?: number}>}
     */
    async function scanNow(job) {
        const org = job.orgId ? String(job.orgId) : '';
        const base = {
            organizationId: org || 'default',
            projectId: job.projectId ?? null,
            subjectKind: job.subjectKind,
            subjectId: job.subjectId,
            versionId: job.versionId ?? null,
        };
        let shield = null;
        try {
            shield = await d.resolveShieldFor({ orgId: org || null, userId: null });
        } catch (e) {
            log.warn(`[ContentSignals] shield unreadable for ${job.subjectKind} ${job.subjectId}; not scanned: ${e?.message || e}`);
            return { ok: false, skipped: 'shield_unreadable' };
        }
        if (!_shieldScans(shield)) return { ok: true, skipped: 'shield_off' };

        try {
            const raw = await job.loadText();
            const text = typeof raw === 'string' ? raw : '';
            const truncated = text.length > MAX_SCAN_CHARS;
            const r = await d.detectWithLedger(truncated ? text.slice(0, MAX_SCAN_CHARS) : text, {
                categories: _categoriesOf(shield),
                threshold: Number.isFinite(shield?.piiDetectionConfidenceThreshold) ? shield.piiDetectionConfidenceThreshold : undefined,
                scope: 'g',
            });
            const categories = {};
            const kinds = new Set();
            let mentions = 0;
            for (const e of r?.entities || []) {
                const cat = d.normalizeCategory(e && e.category) || null;
                if (!cat) continue;
                categories[cat] = (categories[cat] || 0) + 1;
                mentions++;
                const kind = d.kindOfCategory(cat);
                if (kind) kinds.add(kind);
            }
            const degraded = !!r?.degraded || truncated;
            await store().upsertSignal({ ...base, categories, kinds: [...kinds], mentionCount: mentions, degraded });
            log.info(`[ContentSignals] ${job.subjectKind} ${job.subjectId}: ${mentions} mention(s) in ${Object.keys(categories).length} categor(ies)${degraded ? ', degraded' : ''}`);
            return { ok: true, degraded, mentions };
        } catch (e) {
            log.warn(`[ContentSignals] scan of ${job.subjectKind} ${job.subjectId} failed, recorded as unknown: ${e?.message || e}`);
            try {
                await store().upsertSignal({ ...base, categories: {}, kinds: [], mentionCount: 0, degraded: true });
            } catch (e2) {
                log.warn(`[ContentSignals] could not record the failed scan of ${job.subjectKind} ${job.subjectId}: ${e2?.message || e2}`);
            }
            return { ok: false, degraded: true };
        }
    }

    async function _fire(key) {
        const entry = armed.get(key);
        armed.delete(key);
        if (!entry) return;
        if (running.has(key)) { again.set(key, entry.job); return; }
        running.add(key);
        try {
            await scanNow(entry.job);
        } finally {
            running.delete(key);
            const next = again.get(key);
            if (next) { again.delete(key); queueContentScan(next); }
        }
    }

    /**
     * Queue a background scan of one subject's latest checkpoint. Returns
     * immediately, always; never throws.
     * @param {{ orgId: string|null, projectId?: string|null, subjectKind: string, subjectId: string,
     *           versionId?: string|null, loadText: () => Promise<string>|string }} job
     * @returns {boolean} true when queued (or merged into a queued scan)
     */
    function queueContentScan(job) {
        try {
            if (!job || !SUBJECT_KINDS.includes(job.subjectKind) || !job.subjectId || typeof job.loadText !== 'function') return false;
            const key = keyOf(job);
            const existing = armed.get(key);
            if (existing) { existing.job = job; return true; }   // latest version wins, the clock does not restart
            if (running.has(key)) { again.set(key, job); return true; }
            const timer = setTimeout(() => { _fire(key).catch(() => { /* scanNow never rejects */ }); }, d.coalesceMs);
            if (timer.unref) timer.unref();
            armed.set(key, { timer, job });
            return true;
        } catch (e) {
            log.warn(`[ContentSignals] could not queue a scan: ${e?.message || e}`);
            return false;
        }
    }

    /** Test-only: fire everything armed now and wait for it. */
    async function _drain() {
        const keys = [...armed.keys()];
        for (const k of keys) {
            clearTimeout(armed.get(k)?.timer);
            await _fire(k);
        }
    }

    function _reset() {
        for (const e of armed.values()) clearTimeout(e.timer);
        armed.clear();
        running.clear();
        again.clear();
    }

    return { queueContentScan, scanNow, _drain, _reset, _pendingCount: () => armed.size };
}

const _default = makeContentSignals();

module.exports = {
    makeContentSignals,
    queueContentScan: _default.queueContentScan,
    scanNow: _default.scanNow,
    SUBJECT_KINDS,
    MAX_SCAN_CHARS,
    COALESCE_MS,
};
