/**
 * Support SLA enforcer — computes first-response / resolution due dates from
 * the configured policies and flags breaches on a 60s tick.
 *
 * Invariants:
 *   • computeSlaDueAt is pure-ish (one DB read for the policy) — safe to call
 *     on thread create and on every priority change.
 *   • slaTick is idempotent: the flag UPDATEs exclude already-flagged rows, so
 *     running twice never double-fires notifications.
 *   • The SLA clock pauses while a thread waits on the customer
 *     (status = awaiting_user) — see sla_paused handling in the route layer.
 */

const supportStore = require('../stores/supportStore');
const notificationStore = require('../stores/notificationStore');
const log = require('../telemetry/log');

let _timer = null;

/**
 * Compute SLA due timestamps for a thread from its org+priority policy.
 * Returns { first, resolution } as ISO strings (or null when no policy/disabled).
 */
async function computeSlaDueAt(thread) {
    if (!thread) return { first: null, resolution: null };
    const policy = await supportStore.getSlaPolicy(thread.organization_id || null, thread.priority);
    if (!policy || !policy.enabled) return { first: null, resolution: null };
    const base = new Date(thread.created_at || Date.now()).getTime();
    return {
        first: new Date(base + policy.first_response_minutes * 60_000).toISOString(),
        resolution: new Date(base + policy.resolution_minutes * 60_000).toISOString(),
    };
}

async function _notifyBreach(row, which) {
    // Lazy-require to avoid a circular dependency (routes/support requires this).
    let notifyStaff;
    try { notifyStaff = require('../support/notifications').notifyStaff; } catch { /* noop */ }
    const label = which === 'first' ? 'First-response' : 'Resolution';
    try {
        await supportStore.recordThreadEvent({
            threadId: row.id, actorUserId: null, actorKind: 'automation',
            action: 'sla_breach', payload: { which },
        });
    } catch (e) { log.warn('[SupportSLA] recordThreadEvent failed:', e.message); }

    if (typeof notifyStaff === 'function') {
        notifyStaff({
            title: `SLA breach (${label}): ${row.subject}`,
            message: `${label} SLA missed for ${row.requester_email}`,
            threadId: row.id,
            category: 'urgent',
        });
    }
    if (row.assignee_user_id) {
        notificationStore.createNotification({
            userId: row.assignee_user_id,
            taskId: row.id,
            category: 'urgent',
            title: `SLA breach: ${row.subject}`,
            message: `${label} SLA missed`,
        }).catch(() => {});
    }
    // The team chat channel, when an admin ticked "An SLA is breached". Company
    // inbox only: this sweep covers every organisation's inbox, and a customer
    // organisation's tickets are not Bee Flow's to post. The card is built
    // from the full thread row, so read it; the breach row is a narrow RETURNING.
    if (row.inbox_id == null) {
        try {
            const thread = await supportStore.getThread(row.id);
            if (thread) {
                require('./outboundChatNotifier')
                    .notify({ thread, event: 'sla_breach', detail: `${label} SLA missed` })
                    .catch(() => {});
            }
        } catch (e) { log.warn('[SupportSLA] chat notification skipped:', e.message); }
    }
    try {
        require('../support/events').supportEvents.emit('event', {
            event: 'thread_updated', data: { threadId: row.id },
        });
    } catch { /* noop */ }
}

async function slaTick() {
    try {
        const firstBreaches = await supportStore.flagFirstResponseBreaches();
        for (const row of firstBreaches) await _notifyBreach(row, 'first');
        const resBreaches = await supportStore.flagResolutionBreaches();
        for (const row of resBreaches) await _notifyBreach(row, 'resolution');
    } catch (e) {
        log.warn('[SupportSLA] tick error:', e.message);
    }
}

/**
 * Mount the SLA tick behind the runtime module gate, so removing Support in
 * the admin Modules panel stops breach flagging on a running pod (BFSF-438).
 * `gate` is a test seam; the exported slaTick stays ungated.
 */
function start({ intervalMs = 60_000, gate } = {}) {
    if (_timer) return;
    const moduleGatedTick = gate || require('../modules').moduleGatedTick;
    const gatedTick = moduleGatedTick('support', slaTick, 'supportSla');
    _timer = setInterval(() => {
        gatedTick().catch(e => log.warn('[SupportSLA] tick error:', e.message));
    }, intervalMs);
    if (_timer.unref) _timer.unref();
    log.info('[SupportSLA] enforcer started (tick every', intervalMs / 1000, 's)');
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { computeSlaDueAt, slaTick, start, stop };
