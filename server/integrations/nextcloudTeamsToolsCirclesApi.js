// @typecheck strict

const CIRCLES_API = '/ocs/v2.php/apps/circles/circles';

// Circles member levels. The API takes integers; agents should not have to
// know them, so the tools take names and translate.
/** @type {Record<string, number>} */
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

module.exports = { CIRCLES_API, MEMBER_LEVELS, NEXTCLOUD_TEAMS_TOOLS };
