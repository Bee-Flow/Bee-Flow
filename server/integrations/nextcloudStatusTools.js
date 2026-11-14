// @typecheck strict
/**
 * Nextcloud User Status Tools — get / set / clear the current user's status.
 *
 * Endpoint: /ocs/v2.php/apps/user_status/api/v1/user_status
 *
 * The status combines:
 *   • availability — online | away | dnd | invisible | offline | busy
 *   • predefinedStatus — short label like "meeting", "vacationing"
 *   • custom emoji + message + clearAt timeout
 *
 * Useful for "I'm in a meeting until 15:00" auto-status from a calendar event.
 */

const ncClient = require('./nextcloudClient');
const { nextcloudHttpError } = require('./nextcloudHttpError');

const NEXTCLOUD_STATUS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_get',
            description: 'Get the current user\'s Nextcloud status (availability, custom message, emoji, clear-at).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_set',
            description: 'Set the user\'s Nextcloud status. The user has approved this. Provide one or more of: availability, message, emoji, clearAt.',
            parameters: {
                type: 'object',
                properties: {
                    availability: { type: 'string', enum: ['online', 'away', 'dnd', 'invisible', 'offline', 'busy'], description: 'Presence state.' },
                    message: { type: 'string', description: 'Free-text status message.' },
                    emoji: { type: 'string', description: 'Single emoji to display next to the status.' },
                    clearAt: { type: ['string', 'null'], description: 'ISO 8601 datetime when the status should auto-clear (e.g. "2026-04-30T15:00:00Z"). Omit to leave the current auto-clear time as it is; pass null to make the status permanent.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_clear',
            description: 'Clear the user\'s custom status message and emoji (availability is preserved).',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_status_set_predefined',
            description: 'Set a predefined status (meeting, commuting, sick, vacationing, remote-work). The Nextcloud server defines the allowed list.',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'string', description: 'Predefined status id (e.g. "meeting", "commuting", "sick-leave", "vacationing", "remote-work").' },
                    clearAt: { type: 'string', description: 'Optional ISO 8601 auto-clear time.' }
                },
                required: ['messageId']
            }
        }
    }
];

/**
 * @param {string} baseUrl
 */
function statusApi(baseUrl) {
    return `${baseUrl}/ocs/v2.php/apps/user_status/api/v1/user_status`;
}

/** @param {Response} res */
async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

function commonHeaders() {
    return { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };
}

/**
 * @param {{ userId?: string, status?: string, message?: string | null, messageId?: string | null, icon?: string | null, clearAt?: number | null, statusIsUserDefined?: boolean, messageIsPredefined?: boolean }} s
 */
function mapStatus(s) {
    return {
        userId: s.userId,
        status: s.status,
        message: s.message,
        messageId: s.messageId,
        icon: s.icon,
        clearAt: s.clearAt,
        statusIsUserDefined: s.statusIsUserDefined,
        messageIsPredefined: s.messageIsPredefined,
    };
}

/**
 * `clearAt` as epoch seconds. Unparsable and past values are refused here:
 * Nextcloud answers a past time with a 400 that must not be reported as an
 * unknown status, and an unparsable one must not be dropped silently.
 * @param {string | number | null | undefined} raw
 * @param {number} [now]
 */
function parseClearAt(raw, now = Date.now()) {
    if (raw === undefined || raw === '') return { given: false, seconds: null };
    // An explicit null means "no auto-clear".
    if (raw === null) return { given: true, seconds: null };
    const ms = typeof raw === 'number' ? raw * 1000 : Date.parse(String(raw));
    if (!Number.isFinite(ms)) return { error: `Could not parse clearAt "${String(raw)}" as a date-time (use ISO 8601, e.g. 2026-12-01T17:00:00Z).` };
    if (ms <= now) return { error: `clearAt ${String(raw)} is in the past; pick a time in the future.` };
    return { given: true, seconds: Math.floor(ms / 1000) };
}

/**
 * @typedef {{ availability?: string, clearAt?: string | number | null, emoji?: string, message?: string, messageId?: string }} StatusArgs
 * @typedef {{ api: string, ncFetch: import('./nextcloudClient.types').NcAuth['fetch'], authError: string,
 *   jsonHeaders: Record<string, string> }} StatusCtx
 * @typedef {(args: StatusArgs, c: StatusCtx) => Promise<Record<string, any>>} StatusHandler
 * @typedef {[string, string, Record<string, unknown>]} StatusCall
 */

/** @type {StatusHandler} */
async function getStatus(_args, { api, ncFetch, authError }) {
    const res = await ncFetch(`${api}?format=json`, { headers: commonHeaders() });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: 'User status app is not installed/enabled on this Nextcloud server.' };
    if (!res.ok) return { error: `Status fetch failed (${res.status})` };
    const data = await readJsonSafe(res);
    return data?.ocs?.data ? mapStatus(data.ocs.data) : data;
}

/**
 * The custom-message call. It replaces all of message, icon and clearAt, so
 * what the caller did not pass is carried over from now. Answers the call, or
 * the error of a status read that failed.
 * @param {StatusArgs} args @param {{ given: boolean, seconds: number | null }} clear @param {StatusCtx} c
 * @returns {Promise<{ call: StatusCall } | { error: string }>}
 */
async function messageCall(args, clear, { api, ncFetch, authError }) {
    const curRes = await ncFetch(`${api}?format=json`, { headers: commonHeaders() });
    // Only 404 means "no status yet"; any other failure must not turn into a wipe.
    if (!curRes.ok && curRes.status !== 404) {
        return nextcloudHttpError(curRes, { authError, what: 'status read', app: 'User status' });
    }
    const cur = curRes.ok ? ((await readJsonSafe(curRes))?.ocs?.data || {}) : {};
    const message = args.message !== undefined ? args.message : cur.message;
    const icon = args.emoji !== undefined ? args.emoji : cur.icon;
    return { call: ['/message/custom', 'PUT', {
        statusIcon: icon || null,
        message: message || null,
        clearAt: clear.given ? clear.seconds : (cur.clearAt ?? null),
    }] };
}

/**
 * Send the calls in order. Answers null, or the first failure with what was already applied.
 * @param {StatusCall[]} calls @param {StatusCtx} c
 */
async function applyCalls(calls, { api, ncFetch, authError, jsonHeaders }) {
    /** @type {string[]} */
    const applied = [];
    for (const [path, method, body] of calls) {
        const res = await ncFetch(`${api}${path}?format=json`, {
            method,
            headers: jsonHeaders,
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const failed = await nextcloudHttpError(res, { authError, what: 'status set', app: 'User status' });
            const note = applied.length ? ` Already applied: ${applied.join(', ')}.` : '';
            return { error: `${failed.error}${note}`, applied };
        }
        applied.push(path === '/status' ? 'availability' : 'message');
    }
    return null;
}

/** @type {StatusHandler} */
async function setStatus(args, c) {
    const { api, ncFetch } = c;
    // Everything is checked before the first write, so a bad input can
    // never leave the status half-changed.
    const clear = parseClearAt(args.clearAt);
    if ('error' in clear) return clear;
    const touchesMessage = args.message !== undefined || args.emoji !== undefined || clear.given;
    if (!args.availability && !touchesMessage) {
        return { error: 'no fields provided (availability, message, emoji, or clearAt required)' };
    }
    /** @type {StatusCall[]} */
    const calls = [];
    if (args.availability) calls.push(['/status', 'PUT', { statusType: args.availability }]);
    if (touchesMessage) {
        const msg = await messageCall(args, clear, c);
        if ('error' in msg) return msg;
        calls.push(msg.call);
    }
    const failed = await applyCalls(calls, c);
    if (failed) return failed;
    // Return the merged result.
    const finalRes = await ncFetch(`${api}?format=json`, { headers: commonHeaders() });
    const data = await readJsonSafe(finalRes);
    return { success: true, status: data?.ocs?.data ? mapStatus(data.ocs.data) : null };
}

/** @type {StatusHandler} */
async function clearStatus(_args, { api, ncFetch, authError }) {
    const res = await ncFetch(`${api}/message?format=json`, {
        method: 'DELETE',
        headers: commonHeaders(),
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) return { error: `Status clear failed (${res.status})` };
    return { success: true };
}

/** @type {StatusHandler} */
async function setPredefined(args, { api, ncFetch, authError, jsonHeaders }) {
    if (!args.messageId) return { error: 'messageId is required' };
    const clear = parseClearAt(args.clearAt);
    if ('error' in clear) return clear;
    const clearAtSec = clear.given ? clear.seconds : null;
    const res = await ncFetch(`${api}/message/predefined?format=json`, {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify({ messageId: args.messageId, clearAt: clearAtSec }),
    });
    if (res.status === 400) return { error: `Unknown predefined status: ${args.messageId}` };
    if (!res.ok) return nextcloudHttpError(res, { authError, what: 'predefined status set', app: 'User status' });
    const data = await readJsonSafe(res);
    return { success: true, status: data?.ocs?.data ? mapStatus(data.ocs.data) : null };
}

/** @type {Record<string, StatusHandler>} */
const HANDLERS = {
    nextcloud_status_get: getStatus,
    nextcloud_status_set: setStatus,
    nextcloud_status_clear: clearStatus,
    nextcloud_status_set_predefined: setPredefined,
};

/**
 * @param {string} toolName
 * @param {StatusArgs} args
 * @param {string} userId
 * @param {Partial<Express.Session>} session
 */
async function executeNextcloudStatusTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud status tool: ${toolName}` };
    const jsonHeaders = { ...commonHeaders(), 'Content-Type': 'application/json' };
    return handler(args, { api: statusApi(ctx.baseUrl), ncFetch: ctx.fetch, authError: ctx.authError, jsonHeaders });
}

/** @param {unknown} toolName */
function isNextcloudStatusTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_status_');
}

module.exports = {
    NEXTCLOUD_STATUS_TOOLS,
    executeNextcloudStatusTool,
    isNextcloudStatusTool,
};
