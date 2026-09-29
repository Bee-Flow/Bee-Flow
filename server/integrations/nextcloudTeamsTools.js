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
 * routine shares it with the "Onboarding 2026" team once. Without these tools
 * `nextcloud_share_with_group` is the only grouping primitive available, and
 * groups are admin-managed — users cannot create them, so a routine cannot
 * assemble an ad-hoc audience.
 *
 * API: `/ocs/v2.php/apps/circles/circles[...]`. Requires the Circles/Teams app,
 * which ships with Nextcloud but can be disabled; a 404 says so plainly rather
 * than surfacing as a generic failure.
 */

const ncClient = require('./nextcloudClient');

const CIRCLES_API = '/ocs/v2.php/apps/circles/circles';

// Circles member levels. The API takes integers; agents should not have to
// know them, so the tools take names and translate.
const MEMBER_LEVELS = { member: 1, moderator: 4, admin: 8, owner: 9 };

const NEXTCLOUD_TEAMS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_list',
            description: 'List the Nextcloud Teams (Circles) the user belongs to or can see. Call this first to get a team id.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_get',
            description: 'Get one team\'s details, including its settings and the caller\'s membership level.',
            parameters: {
                type: 'object',
                properties: { teamId: { type: 'string', description: 'Team (circle) id from nextcloud_teams_list.' } },
                required: ['teamId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_list_members',
            description: 'List the members of a team, with their user ids, display names and levels.',
            parameters: {
                type: 'object',
                properties: { teamId: { type: 'string', description: 'Team id.' } },
                required: ['teamId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_create',
            description: 'Create a new team. The caller becomes its owner.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Team name.' },
                    personal: { type: 'boolean', description: 'A personal team is visible only to its owner. Defaults to false.' },
                    local: { type: 'boolean', description: 'Restrict the team to this instance (no federation). Defaults to false.' }
                },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_add_members',
            description: 'Add one or more Nextcloud users to a team.',
            parameters: {
                type: 'object',
                properties: {
                    teamId: { type: 'string', description: 'Team id.' },
                    userIds: { type: 'array', items: { type: 'string' }, description: 'Nextcloud user ids to add. Use nextcloud_contacts_search or nextcloud_list_groups to find them.' }
                },
                required: ['teamId', 'userIds']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_remove_member',
            description: 'Remove a member from a team.',
            parameters: {
                type: 'object',
                properties: {
                    teamId: { type: 'string', description: 'Team id.' },
                    memberId: { type: 'string', description: 'Member id (the "id" field from nextcloud_teams_list_members — NOT the Nextcloud user id).' }
                },
                required: ['teamId', 'memberId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_set_member_level',
            description: 'Change a member\'s level in a team (member, moderator or admin).',
            parameters: {
                type: 'object',
                properties: {
                    teamId: { type: 'string', description: 'Team id.' },
                    memberId: { type: 'string', description: 'Member id from nextcloud_teams_list_members.' },
                    level: { type: 'string', enum: ['member', 'moderator', 'admin'], description: 'New level.' }
                },
                required: ['teamId', 'memberId', 'level']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_update',
            description: 'Rename a team or change its description.',
            parameters: {
                type: 'object',
                properties: {
                    teamId: { type: 'string', description: 'Team id.' },
                    name: { type: 'string', description: 'New name.' },
                    description: { type: 'string', description: 'New description.' }
                },
                required: ['teamId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_teams_delete',
            description: 'Delete a team. Destructive — every share made to the team stops working.',
            parameters: {
                type: 'object',
                properties: { teamId: { type: 'string', description: 'Team id to delete.' } },
                required: ['teamId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_share_with_team',
            description: 'Share a file or folder with a whole team at once.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Path of the file or folder to share.' },
                    teamId: { type: 'string', description: 'Team id to share with.' },
                    permissions: { type: 'integer', description: 'Permission bitmask: 1 read, 2 update, 4 create, 8 delete, 16 share. Default 1 (read-only). 31 is full access.' },
                    expireDate: { type: 'string', description: 'Optional expiry as YYYY-MM-DD.' },
                    note: { type: 'string', description: 'Optional note shown to recipients.' }
                },
                required: ['path', 'teamId']
            }
        }
    }
];

const HEADERS = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'OCS-APIRequest': 'true',
};

async function readJsonSafe(res) {
    const text = await res.text().catch(() => '');
    try { return JSON.parse(text); } catch { return text; }
}

async function handle(res, authError, what) {
    if (res.status === 401 || res.status === 403) return { error: authError };
    if (res.status === 404) {
        return { error: `Nextcloud Teams did not answer the ${what} call — enable the "Circles"/"Teams" app in Nextcloud, or check the team id.` };
    }
    if (!res.ok) {
        const body = await readJsonSafe(res);
        const detail = typeof body === 'string' ? body.slice(0, 200) : (body?.ocs?.meta?.message || '');
        return { error: `Nextcloud Teams ${what} failed (${res.status})${detail ? `: ${detail}` : ''}` };
    }
    const body = await readJsonSafe(res);
    return { ok: true, data: body?.ocs?.data ?? body };
}

function levelName(level) {
    const found = Object.entries(MEMBER_LEVELS).find(([, v]) => v === Number(level));
    return found ? found[0] : String(level ?? '');
}

function mapTeam(c) {
    return {
        id: c.id,
        name: c.displayName || c.name || c.sanitizedName || '',
        description: c.description || '',
        // `population` is the member count; the raw payload also carries an
        // `initiator` block describing the caller's own membership.
        memberCount: c.population ?? null,
        myLevel: c.initiator ? levelName(c.initiator.level) : null,
        personal: !!(c.config & 2),
    };
}

function mapMember(m) {
    return {
        // The member id is a circles-internal handle, NOT the Nextcloud uid —
        // removal and level changes address this, which is a routine footgun
        // worth surfacing in the output.
        id: m.id,
        userId: m.userId || m.singleId || null,
        displayName: m.displayName || m.userId || '',
        level: levelName(m.level),
        type: m.userType ?? null,
    };
}

async function executeNextcloudTeamsTool(toolName, args, userId, session) {
    const ctx = await ncClient.resolveAuth(session, userId);
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = `${baseUrl}${CIRCLES_API}`;

    switch (toolName) {
        case 'nextcloud_teams_list': {
            const out = await handle(await ncFetch(api, { headers: HEADERS }), authError, 'team list');
            if (out.error) return out;
            const teams = (Array.isArray(out.data) ? out.data : []).map(mapTeam);
            return { count: teams.length, teams };
        }

        case 'nextcloud_teams_get': {
            if (!args.teamId) return { error: 'teamId is required' };
            const out = await handle(
                await ncFetch(`${api}/${encodeURIComponent(args.teamId)}`, { headers: HEADERS }),
                authError, 'team fetch',
            );
            if (out.error) return out;
            return { team: mapTeam(out.data || {}) };
        }

        case 'nextcloud_teams_list_members': {
            if (!args.teamId) return { error: 'teamId is required' };
            const out = await handle(
                await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/members`, { headers: HEADERS }),
                authError, 'member list',
            );
            if (out.error) return out;
            const members = (Array.isArray(out.data) ? out.data : []).map(mapMember);
            return { teamId: args.teamId, count: members.length, members };
        }

        case 'nextcloud_teams_create': {
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
            return { success: true, team: mapTeam(out.data || {}) };
        }

        case 'nextcloud_teams_add_members': {
            if (!args.teamId) return { error: 'teamId is required' };
            const ids = Array.isArray(args.userIds) ? args.userIds.filter(Boolean) : [];
            if (!ids.length) return { error: 'userIds must be a non-empty array of Nextcloud user ids' };
            // The /members/multi endpoint takes [{id, type}] with type 1 = user.
            const out = await handle(
                await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/members/multi`, {
                    method: 'POST', headers: HEADERS,
                    body: JSON.stringify({ members: ids.map(id => ({ id: String(id), type: 1 })) }),
                }),
                authError, 'member add',
            );
            if (out.error) return out;
            return { success: true, teamId: args.teamId, added: ids };
        }

        case 'nextcloud_teams_remove_member': {
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

        case 'nextcloud_teams_set_member_level': {
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

        case 'nextcloud_teams_update': {
            if (!args.teamId) return { error: 'teamId is required' };
            if (args.name === undefined && args.description === undefined) {
                return { error: 'Nothing to update — pass a name and/or a description.' };
            }
            // Name and description are separate endpoints upstream.
            const updated = [];
            if (args.name !== undefined) {
                const out = await handle(
                    await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/name`, {
                        method: 'PUT', headers: HEADERS, body: JSON.stringify({ value: args.name }),
                    }),
                    authError, 'rename',
                );
                if (out.error) return out;
                updated.push('name');
            }
            if (args.description !== undefined) {
                const out = await handle(
                    await ncFetch(`${api}/${encodeURIComponent(args.teamId)}/description`, {
                        method: 'PUT', headers: HEADERS, body: JSON.stringify({ value: args.description }),
                    }),
                    authError, 'description change',
                );
                if (out.error) return out;
                updated.push('description');
            }
            return { success: true, teamId: args.teamId, updated };
        }

        case 'nextcloud_teams_delete': {
            if (!args.teamId) return { error: 'teamId is required' };
            const out = await handle(
                await ncFetch(`${api}/${encodeURIComponent(args.teamId)}`, { method: 'DELETE', headers: HEADERS }),
                authError, 'team delete',
            );
            if (out.error) return out;
            return { success: true, teamId: args.teamId };
        }

        case 'nextcloud_share_with_team': {
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
                shareId: share.id ?? null,
                path: args.path,
                teamId: args.teamId,
                permissions: share.permissions ?? Number(args.permissions || 1),
            };
        }

        default:
            return { error: `Unknown Nextcloud Teams tool: ${toolName}` };
    }
}

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
