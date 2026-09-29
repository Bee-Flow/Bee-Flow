// @typecheck
/**
 * Request shaping — the window/in-flight/breaker constants, the two-queue
 * admission gate that bounds what this client has in flight, the short circuit
 * breaker in front of a failing guard, and the test seam that resets them.
 */

const { cache, _inflightScans } = require('./scanCache');
const log = require('../../../telemetry/log');

// ── Request shaping: windows, an in-flight gate, and a short breaker ──────
//
// All three exist because of one production incident: users intermittently saw
// "Privacy protection is temporarily unavailable, so your message was not sent"
// after a bulk paste or upload (BFSF-322 — the reporter's own note was that it
// showed up with large amounts of text and not with small ones, which is the
// SIZE cause below). Two of the three causes lived on this side of the wire.
//
//  * SIZE. Text was sent WHOLE. The guard scanned it all — 52,990 chars took
//    278s — and httpPost gave up at 90s, which detectPii reports as
//    `guard_unreachable`, which a fail-closed org turns into a blocked message.
//    Nothing was broken; the request was simply larger than the deadline. So
//    bound the request instead of the deadline. The windowing constants mirror
//    core/automationRunner/safety.js, which has done this for automations all
//    along — this path just never adopted it.
//
//  * CONCURRENCY. Nothing here bounded in-flight calls. attachmentScanner
//    (3 lanes) and chatStream's tool scan (3 lanes) each fan out per request,
//    against a guard that serialises inference — so on a busy pod the queueing
//    all happened SERVER-side of the 90s timeout, where this client cannot see
//    it, cannot tell "queued" from "hung", and cannot shed load.
//
//  * REPEAT COST. Degraded results are deliberately never cached, so every
//    retry of the same oversized paste re-paid the full round trip. Three users
//    retrying a broken guard is 3x the load at the worst possible moment.
const MAX_REQUEST_CHARS = Math.max(1000, Number(process.env.PII_GUARD_WINDOW_CHARS || 8000));
const WINDOW_OVERLAP_CHARS = 256;
// 40 windows x 8000 chars ≈ 320k chars of coverage. Past that the scan is
// reported as partial rather than run forever; a coverage-aware caller decides.
const MAX_WINDOWS = 40;
// Matches the guard's own admission limit. Above it the extra calls only queue
// inside the guard, invisibly.
const MAX_INFLIGHT = Math.max(1, Number(process.env.PII_GUARD_MAX_INFLIGHT || 2));
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 10_000;

let _inflight = 0;
// Two queues, not one.
//
// This used to be a single FIFO shared by every caller. Attachment scanning
// fans a document out over several lanes, so one user uploading a 16-page PDF
// enqueued 16 page-scans ahead of everyone else — and with MAX_INFLIGHT at 2,
// every other user's chat message waited behind the whole document. Making the
// per-page budget generous (see dlp/attachmentScanner.js) would have made that
// worse, so the queue has to distinguish the two kinds of work.
//
// 'interactive' = someone is watching a spinner (chat input, tool results).
// 'bulk'        = document/background work (attachments, notebook ingestion).
const _slotWaiters = { interactive: [], bulk: [] };
let _bulkInflight = 0;
// Bulk may never occupy every slot: one is always kept free for interactive
// work. At MAX_INFLIGHT 1 there is nothing to reserve, so bulk may use it.
const MAX_BULK_INFLIGHT = Math.max(1, MAX_INFLIGHT - 1);
// Anti-starvation: after this many consecutive interactive handoffs, the next
// free slot goes to bulk. Without it a busy chat workload could keep a document
// waiting indefinitely.
const BULK_STARVATION_LIMIT = 4;
let _interactiveStreak = 0;

function _bulkMayStart() {
    return _bulkInflight < MAX_BULK_INFLIGHT;
}

function acquireSlot(priority = 'interactive') {
    const bulk = priority === 'bulk';
    if (_inflight < MAX_INFLIGHT && (!bulk || _bulkMayStart())) {
        _inflight += 1;
        if (bulk) _bulkInflight += 1;
        return Promise.resolve();
    }
    return new Promise((resolve) => _slotWaiters[bulk ? 'bulk' : 'interactive'].push(resolve));
}

function releaseSlot(priority = 'interactive') {
    if (priority === 'bulk') _bulkInflight = Math.max(0, _bulkInflight - 1);

    // Interactive first, except when bulk has been starved for a while.
    const preferBulk = _interactiveStreak >= BULK_STARVATION_LIMIT;
    const order = preferBulk ? ['bulk', 'interactive'] : ['interactive', 'bulk'];
    for (const lane of order) {
        if (lane === 'bulk' && !_bulkMayStart()) continue;
        const next = _slotWaiters[lane].shift();
        if (!next) continue;
        if (lane === 'bulk') { _bulkInflight += 1; _interactiveStreak = 0; }
        else _interactiveStreak += 1;
        // Hand the slot straight over rather than decrementing and racing —
        // otherwise a burst can push _inflight over MAX_INFLIGHT.
        next();
        return;
    }
    _inflight = Math.max(0, _inflight - 1);
}

let _consecutiveFailures = 0;
let _circuitOpenUntil = 0;

function circuitIsOpen() {
    return Date.now() < _circuitOpenUntil;
}

function noteGuardFailure() {
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= BREAKER_THRESHOLD && !circuitIsOpen()) {
        _circuitOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
        log.warn(`[PiiDetection] guard failed ${_consecutiveFailures}x in a row — short-circuiting for ${BREAKER_COOLDOWN_MS}ms`);
    }
}

function noteGuardSuccess() {
    // One success closes it. The cooldown expiring lets exactly one request
    // through to find out (half-open), which is what makes this self-healing
    // rather than a fixed outage window.
    _consecutiveFailures = 0;
    _circuitOpenUntil = 0;
}

/** Test seam — the breaker is module state and would leak between cases. */
function _resetGuardCircuit() {
    _consecutiveFailures = 0;
    _circuitOpenUntil = 0;
    _inflight = 0;
    // Two queues since admission control split interactive from bulk, so the
    // old `_slotWaiters.length = 0` reset nothing at all — it set a `length`
    // property on the holder object and left both arrays intact. A waiter
    // stranded by one test then held a slot for every test after it.
    _bulkInflight = 0;
    _interactiveStreak = 0;
    _slotWaiters.interactive.length = 0;
    _slotWaiters.bulk.length = 0;
    // The scan cache and single-flight table are module state too — a test
    // that scanned "text A" must not hand its result to the next test.
    cache.clear();
    _inflightScans.clear();
}

module.exports = {
    MAX_REQUEST_CHARS,
    WINDOW_OVERLAP_CHARS,
    MAX_WINDOWS,
    MAX_INFLIGHT,
    acquireSlot,
    releaseSlot,
    circuitIsOpen,
    noteGuardFailure,
    noteGuardSuccess,
    _resetGuardCircuit,
};
