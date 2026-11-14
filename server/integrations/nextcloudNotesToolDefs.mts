/**
 * Tool definitions (OpenAI function-calling format) of the Nextcloud Notes tools.
 * Pure data: the executor is nextcloudNotesTools.js.
 */

export const NEXTCLOUD_NOTES_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_list',
            description: 'List the user\'s Nextcloud notes (id, title, category, modified time). Use nextcloud_notes_get for the content.',
            parameters: {
                type: 'object',
                properties: {
                    category: { type: 'string', description: 'Filter by category (folder).' },
                    favorite: { type: 'boolean', description: 'Only favorites.' },
                    limit: { type: 'integer', description: 'Max notes (default 100, max 500).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_search',
            description: 'Search notes by case-insensitive substring match on title and content.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    limit: { type: 'integer', description: 'Max results (default 25, max 100).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_get',
            description: 'Fetch a single note (full content). Long content is truncated to ~200 KB.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer', description: 'Note id (from list).' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_create',
            description: 'Create a new note. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    content: { type: 'string', description: 'Full note body (plain text or markdown).' },
                    category: { type: 'string', description: 'Folder/category. Use "/" or omit for the root.' },
                    favorite: { type: 'boolean' }
                },
                required: ['title', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_append',
            description: 'Append text to the note with the given title, creating it if none exists. Idempotent across repeated runs — use this (not nextcloud_notes_create) for running logs like mention digests or audit trails, so each run adds a line instead of spawning a new note.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Title of the note to append to (created if missing).' },
                    content: { type: 'string', description: 'Text to append.' },
                    category: { type: 'string', description: 'Folder/category — used only when the note is first created.' },
                    separator: { type: 'string', description: 'Inserted between existing and new content. Defaults to a newline.' }
                },
                required: ['title', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_update',
            description: 'Update fields on a note. Only provided fields change. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' },
                    title: { type: 'string' },
                    content: { type: 'string' },
                    category: { type: 'string' },
                    favorite: { type: 'boolean' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_delete',
            description: 'Delete a note. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'integer' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_notes_list_categories',
            description: 'List the distinct note categories (folders) the user has.',
            parameters: { type: 'object', properties: {} }
        }
    }
];
