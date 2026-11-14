// @typecheck strict
/**
 * Nextcloud Teams Tools — the org chart Nextcloud actually shares against.
 *
 * "Teams" is the current name for what the API still calls Circles (the app id
 * is `circles`, every route says `circles`, and the OCS payload uses circle
 * vocabulary). Nextcloud renamed the user-facing feature in Hub 8 without
 * renaming the API, so this module speaks Teams to the agent and circles to
 * the wire.
 *
 * Why it matters for automation: a Team is the unit people actually share with.
 * Sharing a folder with fourteen named users is what an admin does by hand; a
 * automation shares it with the "Onboarding 2026" team once. Without these tools
 * `nextcloud_share_with_group` is the only grouping primitive available, and
 * groups are admin-managed — users cannot create them, so an automation cannot
 * assemble an ad-hoc audience.
 *
 * API: `/ocs/v2.php/apps/circles/circles[...]`. Requires the Circles/Teams app,
 * which ships with Nextcloud but can be disabled; a 404 says so plainly rather
 * than surfacing as a generic failure.
 */

const ncClient = require('./nextcloudClient');
const { addMembers } = require('./nextcloudTeamsMembers');
const { deleteTeam } = require('./nextcloudTeamsDelete');
const { nextcloudHttpError } = require('./nextcloudHttpError');
const { toShareId } = require('./nextcloudFiles/sharing');
const { CIRCLES_API, MEMBER_LEVELS, NEXTCLOUD_TEAMS_TOOLS } = require('./nextcloudTeamsToolsCirclesApi');

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'OCS-APIRequest': 'true',
};

/** @param {Response} res */
async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

/**
 * @param {Response} res
 * @param {string} authError
 * @param {string} what
 * @returns {Promise<{ error?: string, ok?: boolean, data?: any, ocs?: any }>}
 */
async function handle(res, authError, what) {
    if (!res.ok) return nextcloudHttpError(res, { authError, what: `Teams ${what}`, app: 'Teams' });
    const body = await readJsonSafe(res);
    return { ok: true, data: body?.ocs?.data ?? body, ocs: body?.ocs };
}

/** @param {unknown} level */
function levelName(level) {
    const found = Object.entries(MEMBER_LEVELS).find(([, v]) => v === Number(level));
    return found ? found[0] : String(level ?? '');
}

/**
 * @param {{ id?: string, displayName?: string, name?: string, sanitizedName?: string, description?: string,
 *   population?: number, initiator?: { level?: number }, config?: number }} c
 */
function mapTeam(c) {
    return {
        id: c.id,
        name: c.displayName || c.name || c.sanitizedName || '',
        description: c.description || '',
        // `population` is the member count; the raw payload also carries an
        // `initiator` block describing the caller's own membership.
        memberCount: c.population ?? null,
        myLevel: c.initiator ? levelName(c.initiator.level) : null,
        personal: !!((c.config ?? 0) & 2),
    };
}

/**
 * @param {{ id?: string, userId?: string, singleId?: string, displayName?: string, level?: number,
 *   userType?: number }} m
 */
function mapMember(m) {
    return {
        // The member id is a circles-internal handle, NOT the Nextcloud uid —
        // removal and level changes address this, which is an automation footgun
        // worth surfacing in the output.
        id: m.id,
        userId: m.userId || m.singleId || null,
        displayName: m.displayName || m.userId || '',
        level: levelName(m.level),
        type: m.userType ?? null,
    };
}

/**
 * @typedef {{ baseUrl: string, api: string, ncFetch: import('./nextcloudClient.types').NcAuth['fetch'], authError: string }} TeamsCtx
 * @typedef {(args: Record<string, any>, c: TeamsCtx) => Promise<Record<string, any>>} TeamsHandler
 */

/** @type {TeamsHandler} */
async function listTeams(_args, { api, ncFetch, authError }) {
    const out = await handle(await ncFetch(api, { headers: HEADERS }), authError, 'team list');
    if (out.error) return out;
    const teams = (Array.isArray(out.data) ? out.data : []).map(mapTeam);
    return { count: teams.length, teams };
}

/** @type {TeamsHandler} */
async function getTeam(args, { api, ncFetch, authError }) {
    if (!args.teamId) return { error: 'teamId is required' };
    const out = await handle(
        await ncFetch(`${api}/${encodeURIComponent(args.teamId)}`, { headers: HEADERS }),
        authError, 'team fetch',
    );
    if (out.error) return out;
    return { team: mapTeam(out.data || {}) };
}

/** @type {TeamsHandler} */
async function listMembers(args, { api, ncFetch, authError }) {
    if (!args.teamId) return { error: 'teamId is required' };
    const out = await handle(
        await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/members`, { headers: HEADERS }),
        authError, 'member list',
    );
    if (out.error) return out;
    const members = (Array.isArray(out.data) ? out.data : []).map(mapMember);
    return { teamId: args.teamId, count: members.length, members };
}

/** @type {TeamsHandler} */
async function createTeam(args, { api, ncFetch, authError }) {
    if (!args.name) return { error: 'name is required' };
    const out = await handle(
        await ncFetch(api, {
            method: 'POST', headers: HEADERS,
            body: JSON.stringify({
                name: args.name,
                personal: !!args.personal,
                local: !!args.local,
            }),
        }),
        authError, 'team create',
    );
    if (out.error) return out;
    // `population` is stale at create time; the creator is already the owner.
    const team = mapTeam(out.data || {});
    return { success: true, team: { ...team, memberCount: Math.max(1, team.memberCount || 0) } };
}

/** @type {TeamsHandler} */
async function removeMember(args, { api, ncFetch, authError }) {
    if (!args.teamId) return { error: 'teamId is required' };
    if (!args.memberId) return { error: 'memberId is required (from nextcloud_teams_list_members — not the Nextcloud user id)' };
    const out = await handle(
        await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/members/${encodeURIComponent(args.memberId)}`, {
            method: 'DELETE', headers: HEADERS,
        }),
        authError, 'member remove',
    );
    if (out.error) return out;
    return { success: true, teamId: args.teamId, memberId: args.memberId };
}

/** @type {TeamsHandler} */
async function setMemberLevel(args, { api, ncFetch, authError }) {
    if (!args.teamId) return { error: 'teamId is required' };
    if (!args.memberId) return { error: 'memberId is required' };
    const level = MEMBER_LEVELS[String(args.level || '').toLowerCase()];
    if (!level) return { error: `level must be one of: ${Object.keys(MEMBER_LEVELS).filter(l => l !== 'owner').join(', ')}` };
    const out = await handle(
        await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/members/${encodeURIComponent(args.memberId)}/level`, {
            method: 'PUT', headers: HEADERS, body: JSON.stringify({ level }),
        }),
        authError, 'level change',
    );
    if (out.error) return out;
    return { success: true, teamId: args.teamId, memberId: args.memberId, level: args.level };
}

/** @type {TeamsHandler} */
async function updateTeam(args, { api, ncFetch, authError }) {
    if (!args.teamId) return { error: 'teamId is required' };
    if (args.name === undefined && args.description === undefined) {
        return { error: 'Nothing to update — pass a name and/or a description.' };
    }
    // Name and description are separate endpoints upstream.
    /** @type {[string, string, string][]} */
    const steps = [['name', 'name', 'rename'], ['description', 'description', 'description change']];
    /** @type {string[]} */
    const updated = [];
    for (const [field, endpoint, what] of steps) {
        if (args[field] === undefined) continue;
        const out = await handle(
            await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/${endpoint}`, {
                method: 'PUT', headers: HEADERS, body: JSON.stringify({ value: args[field] }),
            }),
            authError, what,
        );
        if (out.error) return out;
        updated.push(field);
    }
    return { success: true, teamId: args.teamId, updated };
}

/** @type {TeamsHandler} */
async function shareWithTeam(args, { baseUrl, ncFetch, authError }) {
    if (!args.path) return { error: 'path is required' };
    if (!args.teamId) return { error: 'teamId is required' };
    // shareType 7 is a circle/team share in the files_sharing API.
    const params = new URLSearchParams({
        path: args.path,
        shareType: '7',
        shareWith: String(args.teamId),
        permissions: String(args.permissions || 1),
    });
    if (args.expireDate) params.set('expireDate', args.expireDate);
    if (args.note) params.set('note', args.note);
    const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json`, {
        method: 'POST',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
    });
    const out = await handle(res, authError, 'team share');
    if (out.error) return out;
    const share = out.data || {};
    return {
        success: true,
        id: toShareId(share.id),
        shareId: toShareId(share.id),
        path: args.path,
        teamId: args.teamId,
        permissions: share.permissions ?? Number(args.permissions || 1),
    };
}

/** @type {Record<string, TeamsHandler>} */
const HANDLERS = {
    nextcloud_teams_list: listTeams,
    nextcloud_teams_get: getTeam,
    nextcloud_teams_list_members: listMembers,
    nextcloud_teams_create: createTeam,
    nextcloud_teams_add_members: (args, { api, ncFetch, authError }) => addMembers({ api, ncFetch, authError, handle, HEADERS }, args),
    nextcloud_teams_remove_member: removeMember,
    nextcloud_teams_set_member_level: setMemberLevel,
    nextcloud_teams_update: updateTeam,
    nextcloud_teams_delete: (args, { api, ncFetch, authError }) => deleteTeam({ api, ncFetch, authError, handle, HEADERS }, args),
    nextcloud_share_with_team: shareWithTeam,
};

/**
 * @param {string} toolName
 * @param {Record<string, any>} args tool arguments as the model sent them
 * @param {string} userId
 * @param {Partial<Express.Session> | null | undefined} session
 */
async function executeNextcloudTeamsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud Teams tool: ${toolName}` };
    return handler(args, { baseUrl: ctx.baseUrl, api: `${ctx.baseUrl}${CIRCLES_API}`, ncFetch: ctx.fetch, authError: ctx.authError });
}

/** @param {unknown} toolName */
function isNextcloudTeamsTool(toolName) {
    return typeof toolName === 'string'
        && (toolName.startsWith('nextcloud_teams_') || toolName === 'nextcloud_share_with_team');
}

module.exports = {
    NEXTCLOUD_TEAMS_TOOLS,
    executeNextcloudTeamsTool,
    isNextcloudTeamsTool,
    // exported for tests
    MEMBER_LEVELS,
    mapTeam,
    mapMember,
};
