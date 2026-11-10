// @typecheck
/**
 * Nextcloud Activity Tools — read-only stream of "what happened".
 *
 * The OCS Activity API returns a feed of events (file edits, shares received,
 * comments, mentions, calendar invites, Talk messages, etc.) with type, actor,
 * subject, link, and timestamp. Useful for "what's new since yesterday" or
 * "what happened to this file recently" questions.
 */

const ncClient = require('./nextcloudClient');
const { nextcloudHttpError } = require('./nextcloudHttpError');

const NEXTCLOUD_ACTIVITY_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_activity_list',
            description: 'Read recent Nextcloud activity events (file changes, shares, comments, mentions, calendar invites). Returns subject, actor, type, object, link, timestamp.',
            parameters: {
                type: 'object',
                properties: {
                    filter: { type: 'string', description: 'Filter type: "all" (default), "self" (only your actions), "by" (others\' actions on your data).' },
                    since: { type: 'integer', description: 'Optional unix timestamp — only return activity newer than this.' },
                    limit: { type: 'integer', description: 'Max events (default 50, max 200).' },
                    type: { type: 'string', description: 'Optional activity type filter (e.g. "files", "shared", "comments"); matches the activity type or the object type. It is applied after the limit, so it can return fewer than limit items.' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_activity_list_for_file',
            description: 'List activity events scoped to a specific file or folder (changes, comments, shares).',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer', description: 'Numeric file id (from list_files / search_files).' },
                    limit: { type: 'integer', description: 'Max events (default 50, max 200).' }
                },
                required: ['fileId']
            }
        }
    }
];

const ACTIVITY_FILTERS = ['all', 'self', 'by'];

/**
 * @param {string} baseUrl
 */
function activityApi(baseUrl) {
    // Activity app's OCS API v2. The `cloud/activity` namespace does not exist
    // (404s on every call) — the real endpoint lives under the app's own route,
    // with sub-paths /all|/self|/by and /filter (used below).
    return `${baseUrl}/ocs/v2.php/apps/activity/api/v2/activity`;
}

/**
 * The Activity API has two answers that mean "nothing to list": 304 when the
 * end of the list is reached (nothing newer than `since`, or no activity at
 * all) and 204 when the user has no activity types selected.
 * @param {{ status: number }} res
 */
function isEmptyAnswer(res) {
    return res.status === 304 || res.status === 204;
}

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * The parameter names of the rich subject (`file`, `oldfile`, `newfile`,
 * `actor`, `user`, ...). `subject_rich` is `[template, parameters]`; some
 * serialisers send it as an object with the keys "0" and "1", and empty
 * parameters arrive as an empty array.
 * @param {{ subject_rich?: unknown }} a
 * @returns {string[]}
 */
function richSubjectKeys(a) {
    const rich = /** @type {Record<string, unknown> | null | undefined} */ (a.subject_rich);
    const params = rich && typeof rich === 'object' ? rich[1] : null;
    return params && typeof params === 'object' && !Array.isArray(params) ? Object.keys(params) : [];
}

function mapActivity(a) {
    const richKeys = richSubjectKeys(a);
    return {
        // The poller (triggerBus _ncPollChannel) cursors on this id; tolerate
        // both the OCS v2 `activity_id` and a plain `id` across NC versions.
        id: a.activity_id ?? a.id,
        type: a.type,
        subject: a.subject_prepared || a.subject,
        message: a.message_prepared || a.message,
        actor: a.user,
        objectType: a.object_type,
        objectId: a.object_id,
        objectName: a.object_name,
        link: a.link,
        icon: a.icon,
        datetime: a.datetime,
        affectedUser: a.affecteduser,
        // What the subject is about, in any language: the activity triggers read it.
        ...(richKeys.length ? { richKeys } : {}),
    };
}

/**
 * What is shared with this user right now (Sharing API, incoming shares): per
 * share its path in the user's files, the ids of the file or folder, and when
 * the share was made (unix seconds). The activity triggers use it to tell a
 * received share from a withdrawn one, which the feed describes alike. The
 * answer has the shape of `nextcloud_list_shares`, so the caller runs it under
 * that tool's access policy (core/integrations/ncScopeGuard.guardedNcCall).
 * @param {string} userId
 * @returns {Promise<{ count: number, shares: Array<{ path: string | null, fileIds: string[], sharedAt: number | null }> } | null>}  null when the list cannot be read
 */
async function incomingShares(userId, session) {
    const { baseUrl, fetch: ncFetch } = await ncClient.resolveAuth(session, userId);
    const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json&shared_with_me=true`, {
        headers: { 'Accept': 'application/json', 'OCS-APIRequest': 'true' },
    });
    if (!res.ok) return null;
    const data = await readJsonSafe(res);
    if (!Array.isArray(data?.ocs?.data)) return null;
    const shares = [];
    for (const share of data.ocs.data) {
        if (!share || typeof share !== 'object') continue;
        const fileIds = [...new Set([share.file_source, share.item_source].filter((v) => v != null).map(String))];
        const at = Number(share.stime);
        const path = typeof share.path === 'string' && share.path ? share.path
            : (typeof share.file_target === 'string' && share.file_target ? share.file_target : null);
        shares.push({ path, fileIds, sharedAt: Number.isFinite(at) && at > 0 ? at : null });
    }
    return { count: shares.length, shares };
}

/**
 * @param {string} toolName
 * @param {string} userId
 */
async function executeNextcloudActivityTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const headers = { 'Accept': 'application/json', 'OCS-APIRequest': 'true' };

    switch (toolName) {
        case 'nextcloud_activity_list': {
            const filter = args.filter || 'all';
            if (!ACTIVITY_FILTERS.includes(filter)) {
                return { error: `filter must be one of: ${ACTIVITY_FILTERS.join(', ')} (got "${String(filter).slice(0, 40)}").` };
            }
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const params = new URLSearchParams();
            params.set('format', 'json');
            params.set('limit', String(limit));
            if (args.since) params.set('since', String(args.since));
            const url = `${activityApi(baseUrl)}/${encodeURIComponent(filter)}?${params.toString()}`;
            const res = await ncFetch(url, { headers });
            if (isEmptyAnswer(res)) return { count: 0, activities: [] };
            if (!res.ok) return nextcloudHttpError(res, { authError, what: `activity fetch for filter "${filter}"`, app: 'Activity' });
            const data = await readJsonSafe(res);
            let items = Array.isArray(data?.ocs?.data) ? data.ocs.data : [];
            // The v2 API has no `type` parameter and "by" also lists the user's own
            // actions, so both are applied here.
            if (filter === 'by' && ctx.uid) items = items.filter(a => a.user !== ctx.uid);
            if (args.type) {
                const wanted = String(args.type).toLowerCase();
                items = items.filter(a => String(a.type || '').toLowerCase().includes(wanted)
                    || String(a.object_type || '').toLowerCase() === wanted);
            }
            return { count: items.length, activities: items.map(mapActivity) };
        }

        case 'nextcloud_activity_list_for_file': {
            if (!args.fileId) return { error: 'fileId is required' };
            const limit = Math.min(Math.max(args.limit || 50, 1), 200);
            const url = `${activityApi(baseUrl)}/filter?format=json&limit=${limit}&object_type=files&object_id=${encodeURIComponent(args.fileId)}`;
            const res = await ncFetch(url, { headers });
            if (isEmptyAnswer(res)) return { fileId: args.fileId, count: 0, activities: [] };
            if (!res.ok) return nextcloudHttpError(res, { authError, what: 'activity fetch for this file', app: 'Activity' });
            const data = await readJsonSafe(res);
            const items = Array.isArray(data?.ocs?.data) ? data.ocs.data : [];
            return { fileId: args.fileId, count: items.length, activities: items.map(mapActivity) };
        }

        default:
            return { error: `Unknown Nextcloud activity tool: ${toolName}` };
    }
}

/**
 * @param {string} toolName
 */
function isNextcloudActivityTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_activity_');
}

module.exports = {
    NEXTCLOUD_ACTIVITY_TOOLS,
    executeNextcloudActivityTool,
    isNextcloudActivityTool,
    incomingShares,
};

/**
 * One entry of the Activity OCS v2 answer.
 * @typedef {{ activity_id?: number, id?: number, type?: string, subject?: string, subject_prepared?: string, message?: string, message_prepared?: string, user?: string, object_type?: string, object_id?: number, object_name?: string, link?: string, icon?: string, datetime?: string, affecteduser?: string }} NcActivity
 */
