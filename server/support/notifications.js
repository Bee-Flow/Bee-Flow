/**
 * Telling the staff something happened, and filling a canned reply in.
 *
 * WHY THESE LIVE HERE AND NOT IN routes/. Both were defined in
 * `routes/support/shared.js`, and four background services reached up into the
 * route module to get at them: the SLA enforcer, the two mailbox engines and
 * the outbound-email fallback. A service requiring a route is an upward edge
 * `layering.test.js` counts as debt, and it was never an HTTP dependency —
 * `notifyStaff` writes notification rows, and the renderer substitutes
 * variables in a string. The same reasoning already moved the SSE bus to
 * ./events.js.
 *
 * `routes/support/shared` re-exports both, so the route code is unchanged.
 */

const userStore = require('../stores/userStore');
const notificationStore = require('../stores/notificationStore');
const log = require('../telemetry/log');

/**
 * One notification per admin. Best-effort by design: this is told TO the
 * staff about something that already happened, so a failure to reach them
 * must not undo it — hence the per-user catch and the outer one.
 */
async function notifyStaff({ title, message, threadId, category = 'heads_up' }) {
    try {
        const users = await userStore.getAllUsers();
        const admins = (users || []).filter(u => u.role === 'admin');
        for (const u of admins) {
            try {
                await notificationStore.createNotification({
                    userId: u.id,
                    taskId: threadId,
                    category,
                    title,
                    message,
                });
            } catch (e) {
                log.warn('[Support] notifyStaff createNotification error:', e.message);
            }
        }
    } catch (e) {
        log.warn('[Support] notifyStaff lookup failed:', e.message);
    }
}

/**
 * Fill `{{ variable }}` placeholders in a canned reply.
 *
 * Takes the staff member rather than the request: the only thing the request
 * was ever read for is the name that signs the reply, and a background sender
 * has no request to offer. An unknown placeholder is left as it was written,
 * so a typo shows up in the draft instead of silently becoming an empty gap.
 */
function renderCannedBody(body, thread, staff) {
    const vars = {
        requester_name: thread?.requester_name || 'there',
        requester_email: thread?.requester_email || '',
        org_name: thread?.requester_org_name || '',
        thread_subject: thread?.subject || '',
        staff_first_name: (staff?.displayName || staff?.name || staff?.username || '').split(' ')[0] || '',
    };
    return String(body || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) => {
        const k = key.toLowerCase();
        return Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : match;
    });
}

module.exports = { notifyStaff, renderCannedBody };
