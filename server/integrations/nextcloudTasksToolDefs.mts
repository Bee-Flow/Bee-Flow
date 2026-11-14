/**
 * Tool definitions (OpenAI function-calling format) of the Nextcloud Tasks tools.
 * Pure data: the executor is nextcloudTasksTools.js.
 */

export const NEXTCLOUD_TASKS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_list_lists',
            description: 'List the user\'s Nextcloud task lists (CalDAV calendars). Each has supportsTasks (can hold tasks) and writable; create tasks only in lists where both are true.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_list',
            description: 'List tasks in a list. Filter by status: "open" (not completed), "completed", or omit for all.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string', description: 'Task list slug (see nextcloud_tasks_list_lists). Defaults to the first writable list that supports tasks.' },
                    status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'Filter (default "open").' },
                    limit: { type: 'integer', description: 'Max tasks (default 200, max 1000).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_search',
            description: 'Search tasks by case-insensitive substring match against summary, description, location.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    list: { type: 'string', description: 'Optional list slug to limit search.' },
                    status: { type: 'string', enum: ['open', 'completed', 'all'] },
                    limit: { type: 'integer', description: 'Max results (default 50, max 200).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_get',
            description: 'Fetch a single task by uid.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' }
                },
                required: ['list', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_create',
            description: 'Create a new task. The user has approved this — go ahead. priority: 1 (highest) – 9 (lowest), 0 = none.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string', description: 'Task list slug from nextcloud_tasks_list_lists (supportsTasks and writable true).' },
                    summary: { type: 'string', description: 'Task title.' },
                    description: { type: 'string' },
                    due: { type: 'string', description: 'ISO 8601 due date (optional).' },
                    priority: { type: 'integer', description: '1 (highest) - 9 (lowest), 0 = none.' },
                    categories: { type: 'array', items: { type: 'string' } }
                },
                required: ['list', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_update',
            description: 'Update fields on an existing task. Only provided fields change. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' },
                    summary: { type: 'string' },
                    description: { type: 'string' },
                    due: { type: 'string', description: 'ISO 8601, or empty string to clear.' },
                    priority: { type: 'integer' },
                    categories: { type: 'array', items: { type: 'string' } }
                },
                required: ['list', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_complete',
            description: 'Mark a task as completed (or reopen it).',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' },
                    completed: { type: 'boolean', description: 'true = mark complete (default), false = reopen.' }
                },
                required: ['list', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_tasks_delete',
            description: 'Delete a task. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    list: { type: 'string' },
                    uid: { type: 'string' }
                },
                required: ['list', 'uid']
            }
        }
    }
];
