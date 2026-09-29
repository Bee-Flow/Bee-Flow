// @typecheck
/**
 * Decrypt Anomaly Detection
 * 
 * Tracks decrypt operations per user and alerts on suspicious patterns:
 * - Bulk decrypt (50+ ops/minute = potential data exfiltration)
 * - Rapid conversation scanning
 * 
 * Lightweight in-memory — resets on server restart (acceptable for alerting).
 */
const log = require('../telemetry/log');

const ALERT_THRESHOLD = 50;     // decrypts per minute before alerting
const WINDOW_MS = 60000;        // 1 minute sliding window
const CLEANUP_INTERVAL = 300000; // Clean old entries every 5 min

// Map<userId, { count: number, windowStart: number, alerted: boolean }>
const decryptCounts = new Map();

/**
 * Track a decrypt operation for a user.
 * Call this from decryptMessages or at the route level.
 * 
 * @param {string} userId
 * @param {string} [conversationId] - For logging context
 */
function trackDecrypt(userId, conversationId = null) {
    if (!userId) return;

    const now = Date.now();
    let entry = decryptCounts.get(userId);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
        // New window
        entry = { count: 1, windowStart: now, alerted: false };
        decryptCounts.set(userId, entry);
        return;
    }

    entry.count++;

    if (entry.count >= ALERT_THRESHOLD && !entry.alerted) {
        entry.alerted = true;
        log.error(
            `[ALERT] Bulk decrypt detected: user ${userId} performed ${entry.count} decrypts in ` +
            `${Math.ceil((now - entry.windowStart) / 1000)}s` +
            (conversationId ? ` (last: ${conversationId})` : '')
        );
        // Early GDPR Art-33 signal: creates a draft incident in the compliance
        // registry (deduped there) so a human assesses the 72-hour question.
        //
        // This IS an upward dependency, and layering.test.js counts it as one.
        // The previous comment here claimed the opposite ("auth must never
        // depend on compliance") directly above the require, which read as a
        // rule being kept while it was being broken. A lazy require defers the
        // load; it does not remove the edge.
        //
        // It stays until compliance can subscribe to a platform-owned bus at
        // boot, and not a moment sooner than that is built: with a registry,
        // delivery of the breach signal would depend on whether compliance had
        // been loaded yet, and a silently dropped Art-33 signal is a far worse
        // outcome than an edge in a baseline. The lazy require and the
        // swallowed error below are what keep a compliance failure from
        // undoing the audit write that just happened.
        try {
            const events = require('../compliance/events');
            events.emit(events.EVENTS.BREACH_SIGNAL, {
                userId,
                source: 'bulk_decrypt',
                summary: `Bulk decrypt anomaly: ${entry.count} decrypt operations within a minute`,
            });
        } catch (_) { /* best-effort */ }
    }
}

/**
 * Get current decrypt stats for a user (for monitoring/admin endpoints).
 * @param {string} userId
 * @returns {{ count: number, windowStart: number } | null}
 */
function getDecryptStats(userId) {
    return decryptCounts.get(userId) || null;
}

// Periodic cleanup of stale entries. unref'd: housekeeping must never be the
// thing that keeps a process alive — any script or test that merely requires
// the encryption layer would otherwise hang at exit for up to five minutes.
const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, entry] of decryptCounts) {
        if (now - entry.windowStart > WINDOW_MS * 2) {
            decryptCounts.delete(userId);
        }
    }
}, CLEANUP_INTERVAL);
if (cleanupTimer.unref) cleanupTimer.unref();

module.exports = { trackDecrypt, getDecryptStats };
