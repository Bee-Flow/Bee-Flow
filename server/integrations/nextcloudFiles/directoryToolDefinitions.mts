/**
 * Tool definitions of the Nextcloud directory lookups: the group list, one
 * user's profile and one file or folder by id or path. Split out of
 * ./toolDefinitions.js, which spreads them in at the same place (the order the
 * model sees the tools in is unchanged).
 */

export const DIRECTORY_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_list_groups',
            description: 'List the Nextcloud user groups on this instance. Needed before sharing with a group — nextcloud_share_with_group takes a group id, not a display name.',
            parameters: {
                type: 'object',
                properties: {
                    search: { type: 'string', description: 'Optional substring to filter group ids by.' },
                    limit: { type: 'integer', description: 'Max groups (default 100, max 500).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_get_user',
            description: 'Look up one Nextcloud user by user id: display name, e-mail address, groups, manager(s) and language. Nextcloud decides what is visible: everyone can read their own account, admins and group admins the accounts they manage; for anyone else this answers that the profile is not visible (use nextcloud_contacts_search on the system address book for an e-mail address).',
            parameters: {
                type: 'object',
                properties: {
                    uid: { type: 'string', description: 'The Nextcloud user id (e.g. the submittedBy of a Forms answer), not the display name.' }
                },
                required: ['uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_file_info',
            description: 'Look up one file or folder by its numeric file id or by its path: path, name, MIME type, size, owner, last-modified time and whether it is a folder. Use it to turn a file id (from a trigger, a Forms upload or another tool) into a path. Pass fileId or path, not both.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: { type: 'integer', description: 'Numeric file id (from a file trigger, a Forms file answer, list_files or search).' },
                    path: { type: 'string', description: 'Path relative to the user\'s files root (e.g. "/Invoices/2026/invoice.pdf").' }
                }
            }
        }
    },
];
