// @typecheck strict
/**
 * YouTrack tool definitions (OpenAI function-calling format), kept apart from
 * the executor in youtrackTools.js: pure data, no requires.
 */

/**
 * Tool definitions in OpenAI function-calling format.
 */
const YOUTRACK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'youtrack_search_issues',
            description: 'Search YouTrack issues using YouTrack query syntax. IMPORTANT: Always call youtrack_list_projects first to discover available project short names before searching. Also use this tool to check whether an issue already exists BEFORE calling youtrack_create_issue. Common query patterns: "project: {shortName}" to list issues in a project, "project: {shortName} state: Open" for open issues, "project: {shortName} sort by: updated desc" for recent activity, "#Unresolved" for all unresolved issues. You can combine filters like "project: {shortName} assignee: {name} state: Open".',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'YouTrack search query. Use project short names from youtrack_list_projects. Examples: "project: ABC", "project: ABC state: Open", "#Unresolved sort by: updated desc"'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of results (1-50, default 20)'
                    },
                    skip: {
                        type: 'integer',
                        description: 'Pagination offset (default 0)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_get_issue',
            description: 'Get full details of a specific YouTrack issue by its readable ID. Returns summary, description, state, assignee, reporter, comments, tags, and custom fields. Use issue IDs obtained from youtrack_search_issues results.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID from search results (format: SHORTNAME-NUMBER)'
                    }
                },
                required: ['issueId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_create_issue',
            description: 'Create a new issue in YouTrack. DUPLICATE PREVENTION: ALWAYS call youtrack_search_issues first to check whether an issue for this problem already exists — reference or update the existing issue instead of creating a second one. If a create call returns an error, NEVER retry it immediately: the issue may have been created anyway; search for it first and only create if it is genuinely absent. IMPORTANT: First call youtrack_list_projects to get the project database ID (the "id" field, not the shortName). Pass that ID as projectId.',
            parameters: {
                type: 'object',
                properties: {
                    projectId: {
                        type: 'string',
                        description: 'The project database ID from youtrack_list_projects results (the "id" field)'
                    },
                    summary: {
                        type: 'string',
                        description: 'Short title of the issue'
                    },
                    description: {
                        type: 'string',
                        description: 'Detailed description of the issue (Markdown supported)'
                    },
                    allowDuplicate: {
                        type: 'boolean',
                        description: 'Set true ONLY when the user explicitly wants a second issue with an identical summary. Default false — creation is refused when an issue with the same summary already exists in the project.'
                    }
                },
                required: ['projectId', 'summary']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_add_comment',
            description: 'Add a comment to an existing YouTrack issue. Use issue IDs obtained from youtrack_search_issues results.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID from search results (format: SHORTNAME-NUMBER)'
                    },
                    text: {
                        type: 'string',
                        description: 'Comment text (Markdown supported)'
                    }
                },
                required: ['issueId', 'text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_update_issue',
            description: 'Update a YouTrack issue by executing a command. Use this to change state, priority, assignee, type, or other fields. IMPORTANT: State names are project-specific — do NOT guess uncommon state names. Common state values that usually work: "Open", "In Progress", "Fixed", "Closed", "Verified". Common priority values: "Show-stopper", "Critical", "Major", "Normal", "Minor". If a command fails, try a simpler state name. You can combine commands: "state Fixed priority Normal".',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID (format: SHORTNAME-NUMBER)'
                    },
                    command: {
                        type: 'string',
                        description: 'YouTrack command. Use simple state names: "state Open", "state In Progress", "state Fixed", "state Closed". For priority: "priority Critical". For assignee: "assignee John". Combine: "state Fixed priority Normal".'
                    },
                    comment: {
                        type: 'string',
                        description: 'Optional comment to add along with the command'
                    }
                },
                required: ['issueId', 'command']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_list_projects',
            description: 'List all available YouTrack projects with their database IDs, short names, and full names. ALWAYS call this first before using any other YouTrack tool — you need project short names for searching and project IDs for creating issues.',
            parameters: {
                type: 'object',
                properties: {},
                required: /** @type {string[]} */ ([])
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_link_issues',
            description: 'Link two YouTrack issues with a typed relation. Use linkType "duplicates" to mark issueId as a duplicate of targetIssueId (e.g. after an accidental duplicate was created), "relates to" for a general relation, "subtask of" to nest issueId under targetIssueId.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable ID of the issue to link FROM (format: SHORTNAME-NUMBER)'
                    },
                    targetIssueId: {
                        type: 'string',
                        description: 'The readable ID of the issue to link TO (format: SHORTNAME-NUMBER)'
                    },
                    linkType: {
                        type: 'string',
                        enum: ['relates to', 'duplicates', 'is duplicated by', 'depends on', 'is required for', 'parent for', 'subtask of'],
                        description: 'Relation type. "duplicates" means issueId is the duplicate of targetIssueId.'
                    }
                },
                required: ['issueId', 'targetIssueId', 'linkType']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_get_issue_comments',
            description: 'Get the comments of a YouTrack issue (author, text, date). Use this to read the discussion before replying or updating an issue.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID (format: SHORTNAME-NUMBER)'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of comments to return (1-50, default 20)'
                    }
                },
                required: ['issueId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_find_user',
            description: 'Find YouTrack users by name, login or email. Returns login, full name and email. Use the login value with youtrack_change_assignee.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Name, login or email (or a part of it) to search for'
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of results (1-25, default 10)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_change_assignee',
            description: 'Assign a YouTrack issue to a user. IMPORTANT: pass the exact login (use youtrack_find_user to look it up). Pass "Unassigned" to clear the assignee.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID (format: SHORTNAME-NUMBER)'
                    },
                    login: {
                        type: 'string',
                        description: 'Exact login of the user (from youtrack_find_user), or "Unassigned" to clear'
                    }
                },
                required: ['issueId', 'login']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_log_work',
            description: 'Log spent time (a work item) on a YouTrack issue. Requires time tracking to be enabled for the project.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID (format: SHORTNAME-NUMBER)'
                    },
                    minutes: {
                        type: 'integer',
                        description: 'Time spent in minutes (minimum 1)'
                    },
                    text: {
                        type: 'string',
                        description: 'Optional description of the work done'
                    },
                    date: {
                        type: 'string',
                        description: 'Optional date of the work in YYYY-MM-DD format (default: today)'
                    }
                },
                required: ['issueId', 'minutes']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'youtrack_manage_tags',
            description: 'Add or remove a tag on a YouTrack issue.',
            parameters: {
                type: 'object',
                properties: {
                    issueId: {
                        type: 'string',
                        description: 'The readable issue ID (format: SHORTNAME-NUMBER)'
                    },
                    action: {
                        type: 'string',
                        enum: ['add', 'remove'],
                        description: 'Whether to add or remove the tag'
                    },
                    tag: {
                        type: 'string',
                        description: 'The tag name'
                    }
                },
                required: ['issueId', 'action', 'tag']
            }
        }
    }
];

module.exports = { YOUTRACK_TOOLS };
