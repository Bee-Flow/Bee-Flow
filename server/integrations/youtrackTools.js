/**
 * YouTrack Tools — Built-in tools for AI to search, read, create, and comment on issues
 * 
 * These tools are injected into the LLM tool set when a YouTrack URL + token are configured,
 * allowing the AI to interact with YouTrack issue tracking.
 * Uses raw REST API — no npm dependencies.
 */

const configStore = require('../stores/configStore');
require('./shared/apiClient');
const log = require('../telemetry/log');

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
                required: []
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

// ─── API Client ────────────────────────────────────────────────
// The transport, the credential resolution and the duplicate prevention all
// live in ./youtrackClient — product code needs them without the prose
// shaping this file does, and one hardened choke point beats two. What stays
// here are thin adapters keeping the (baseUrl, token, …) argument order the
// tool bodies below were written against.

const ytc = require('./youtrackClient');

const youtrackRequest = ytc.youtrackRequest;
const normalizeSummary = ytc.normalizeSummary;
const __setVerifyDelayMs = ytc.__setVerifyDelayMs;

const resolveProjectShortName = (baseUrl, token, projectId) =>
    ytc.resolveProjectShortName({ baseUrl, token }, projectId);

const findRecentIssueBySummary = (baseUrl, token, shortName, summary, opts) =>
    ytc.findRecentIssueBySummary({ baseUrl, token }, shortName, summary, opts);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The commands API query is a mini-language: every value interpolated into it
// must be strictly validated so a crafted argument can't smuggle in extra
// commands (e.g. a "login" of "john state Closed").
const ISSUE_ID_RE = ytc.ISSUE_ID_RE;
const LINK_TYPES = ['relates to', 'duplicates', 'is duplicated by', 'depends on', 'is required for', 'parent for', 'subtask of'];

// ─── Tool Execution ────────────────────────────────────────────

async function executeYouTrackTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for YouTrack.' };
    const baseUrl = await configStore.getSecret(`youtrack_url_user_${userId}`);
    const token = await configStore.getSecret(`youtrack_token_user_${userId}`);

    if (!baseUrl || !token) {
        return { error: 'YouTrack not configured. Add your YouTrack URL and token in Settings.' };
    }

    if (toolName === 'youtrack_search_issues') {
        const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 50);
        const skip = parseInt(args.skip) || 0;
        const query = args.query || '';

        const params = new URLSearchParams({
            query,
            fields: 'idReadable,summary,description,created,updated,resolved,reporter(login,fullName),customFields(name,value(name))',
            $top: String(limit),
            $skip: String(skip),
        });

        log.info(`[YouTrack] Searching issues: "${query}"`);
        const issues = await youtrackRequest(baseUrl, token, 'GET', `/issues?${params}`);

        if (!issues || issues.length === 0) {
            return { results: [], count: 0, message: 'No issues found matching your query.' };
        }

        return {
            results: issues.map(i => {
                // Extract state and assignee from custom fields
                const state = i.customFields?.find(f => f.name === 'State')?.value?.name || null;
                const assignee = i.customFields?.find(f => f.name === 'Assignee')?.value?.name || null;
                const priority = i.customFields?.find(f => f.name === 'Priority')?.value?.name || null;

                return {
                    id: i.idReadable,
                    summary: i.summary,
                    state,
                    assignee,
                    priority,
                    reporter: i.reporter?.fullName || i.reporter?.login || null,
                    created: i.created ? new Date(i.created).toISOString() : null,
                    updated: i.updated ? new Date(i.updated).toISOString() : null,
                };
            }),
            count: issues.length,
            message: `Found ${issues.length} issue(s).`,
        };

    } else if (toolName === 'youtrack_get_issue') {
        const { issueId } = args;
        if (!issueId) return { error: 'issueId is required' };

        const params = new URLSearchParams({
            fields: 'idReadable,summary,description,created,updated,resolved,reporter(login,fullName),comments(id,text,author(login,fullName),created),tags(name),customFields(name,value(name))',
        });

        log.info(`[YouTrack] Getting issue: ${issueId}`);
        const issue = await youtrackRequest(baseUrl, token, 'GET', `/issues/${issueId}?${params}`);

        if (!issue) return { error: `Issue not found: ${issueId}` };

        const state = issue.customFields?.find(f => f.name === 'State')?.value?.name || null;
        const assignee = issue.customFields?.find(f => f.name === 'Assignee')?.value?.name || null;
        const priority = issue.customFields?.find(f => f.name === 'Priority')?.value?.name || null;
        const type = issue.customFields?.find(f => f.name === 'Type')?.value?.name || null;

        return {
            id: issue.idReadable,
            summary: issue.summary,
            description: issue.description || '',
            state,
            assignee,
            priority,
            type,
            reporter: issue.reporter?.fullName || issue.reporter?.login || null,
            created: issue.created ? new Date(issue.created).toISOString() : null,
            updated: issue.updated ? new Date(issue.updated).toISOString() : null,
            tags: (issue.tags || []).map(t => t.name),
            comments: (issue.comments || []).map(c => ({
                author: c.author?.fullName || c.author?.login || 'Unknown',
                text: c.text,
                created: c.created ? new Date(c.created).toISOString() : null,
            })),
        };

    } else if (toolName === 'youtrack_create_issue') {
        const { projectId, summary, description, allowDuplicate } = args;
        if (!projectId) return { error: 'projectId is required' };
        if (!summary) return { error: 'summary is required' };

        log.info(`[YouTrack] Creating issue in ${projectId}: "${summary}"`);

        const requestStart = Date.now();
        const shortName = allowDuplicate === true
            ? null
            : await resolveProjectShortName(baseUrl, token, projectId);

        if (shortName) {
            const existing = await findRecentIssueBySummary(baseUrl, token, shortName, summary);
            if (existing) {
                log.info(`[YouTrack] Create refused — duplicate of ${existing.idReadable}`);
                return {
                    alreadyExists: true,
                    id: existing.idReadable,
                    summary: existing.summary,
                    created: existing.created ? new Date(existing.created).toISOString() : null,
                    message: `NOT CREATED: an issue with this exact summary already exists in this project: ${existing.idReadable} — "${existing.summary}". Reference or update that issue instead (youtrack_add_comment / youtrack_update_issue). Only if the user explicitly wants a second identical issue, call youtrack_create_issue again with allowDuplicate: true.`,
                };
            }
        }

        try {
            const params = new URLSearchParams({
                fields: 'idReadable,summary',
            });

            const issue = await youtrackRequest(baseUrl, token, 'POST', `/issues?${params}`, {
                summary,
                description: description || '',
                project: { id: projectId },
            });

            // If project was provided as shortName, try alternative format
            if (!issue) {
                return { error: 'Failed to create issue. Make sure the project ID is correct (use youtrack_list_projects).' };
            }

            return {
                id: issue.idReadable || issue.id,
                summary: issue.summary,
                message: `Issue created: ${issue.idReadable || issue.id} — "${issue.summary}"`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to create issue: ${err.message}`);

            // Timeouts, network drops and 5xx are ambiguous: YouTrack may have
            // committed the issue even though we saw an error. Verify by search
            // before reporting failure, so the model never re-creates it.
            const ambiguous = err.code === 'ETIMEDOUT' || err.code === 'EREQUEST' || (err.status >= 500);
            if (ambiguous) {
                await sleep(ytc.__verifyDelayMs());
                const verifyShortName = shortName || await resolveProjectShortName(baseUrl, token, projectId);
                const found = await findRecentIssueBySummary(baseUrl, token, verifyShortName, summary, {
                    createdAfterMs: requestStart - 60_000,
                });
                if (found) {
                    log.info(`[YouTrack] Create verified after error — issue exists as ${found.idReadable}`);
                    return {
                        id: found.idReadable,
                        summary: found.summary,
                        verifiedAfterError: true,
                        message: `Issue created: ${found.idReadable} — "${found.summary}". (The create request appeared to fail (${err.message}) but the issue WAS created — verified by search. Do NOT create it again.)`,
                    };
                }
            }

            return {
                error: `Failed to create issue: ${err.message}`,
                guidance: 'The issue MAY still have been created despite this error. Do NOT simply retry youtrack_create_issue — first call youtrack_search_issues for this summary in this project; only create if it is genuinely absent.',
            };
        }

    } else if (toolName === 'youtrack_add_comment') {
        const { issueId, text } = args;
        if (!issueId) return { error: 'issueId is required' };
        if (!text) return { error: 'text is required' };

        log.info(`[YouTrack] Adding comment to ${issueId}`);
        try {
            await youtrackRequest(baseUrl, token, 'POST', `/issues/${issueId}/comments`, { text });
            return { message: `Comment added to ${issueId}.` };
        } catch (err) {
            log.warn(`[YouTrack] Failed to add comment to ${issueId}: ${err.message}`);
            return { error: `Failed to add comment to ${issueId}: ${err.message}` };
        }

    } else if (toolName === 'youtrack_list_projects') {
        const params = new URLSearchParams({
            fields: 'id,name,shortName,description',
            $top: '50',
        });

        log.info('[YouTrack] Listing projects');
        const projects = await youtrackRequest(baseUrl, token, 'GET', `/admin/projects?${params}`);

        if (!projects || projects.length === 0) {
            return { results: [], count: 0, message: 'No projects found.' };
        }

        return {
            results: projects.map(p => ({
                id: p.id,
                shortName: p.shortName,
                name: p.name,
                description: p.description || '',
            })),
            count: projects.length,
            message: `Found ${projects.length} project(s).`,
        };

    } else if (toolName === 'youtrack_update_issue') {
        const { issueId, command, comment } = args;
        if (!issueId) return { error: 'issueId is required' };
        if (!command) return { error: 'command is required' };

        log.info(`[YouTrack] Executing command on ${issueId}: "${command}"`);

        const body = {
            query: command,
            issues: [{ idReadable: issueId }],
        };
        if (comment) body.comment = comment;

        try {
            await youtrackRequest(baseUrl, token, 'POST', '/commands', body);
            return { message: `Command "${command}" executed on ${issueId}.` };
        } catch (err) {
            log.warn(`[YouTrack] Command failed on ${issueId}: ${err.message}`);
            return { error: `Failed to execute command "${command}" on ${issueId}: ${err.message}` };
        }

    } else if (toolName === 'youtrack_link_issues') {
        const { issueId, targetIssueId, linkType } = args;
        if (!issueId || !ISSUE_ID_RE.test(issueId)) return { error: 'issueId is required (format: SHORTNAME-NUMBER)' };
        if (!targetIssueId || !ISSUE_ID_RE.test(targetIssueId)) return { error: 'targetIssueId is required (format: SHORTNAME-NUMBER)' };
        if (!LINK_TYPES.includes(linkType)) return { error: `linkType must be one of: ${LINK_TYPES.join(', ')}` };

        log.info(`[YouTrack] Linking ${issueId} "${linkType}" ${targetIssueId}`);
        try {
            await youtrackRequest(baseUrl, token, 'POST', '/commands', {
                query: `${linkType} ${targetIssueId}`,
                issues: [{ idReadable: issueId }],
            });
            return {
                linked: true,
                issueId,
                targetIssueId,
                linkType,
                message: `Linked: ${issueId} ${linkType} ${targetIssueId}.`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to link ${issueId} → ${targetIssueId}: ${err.message}`);
            return { error: `Failed to link ${issueId} ${linkType} ${targetIssueId}: ${err.message}` };
        }

    } else if (toolName === 'youtrack_get_issue_comments') {
        const { issueId } = args;
        if (!issueId) return { error: 'issueId is required' };
        const limit = Math.min(Math.max(parseInt(args.limit) || 20, 1), 50);

        const params = new URLSearchParams({
            fields: 'id,text,created,author(login,fullName)',
            $top: String(limit),
        });

        log.info(`[YouTrack] Getting comments for ${issueId}`);
        try {
            const comments = await youtrackRequest(baseUrl, token, 'GET', `/issues/${issueId}/comments?${params}`);
            if (!comments || comments.length === 0) {
                return { results: [], count: 0, message: `No comments on ${issueId}.` };
            }
            return {
                results: comments.map(c => ({
                    id: c.id,
                    author: c.author?.fullName || c.author?.login || 'Unknown',
                    text: c.text,
                    created: c.created ? new Date(c.created).toISOString() : null,
                })),
                count: comments.length,
                message: `Found ${comments.length} comment(s) on ${issueId}.`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to get comments for ${issueId}: ${err.message}`);
            return { error: `Failed to get comments for ${issueId}: ${err.message}` };
        }

    } else if (toolName === 'youtrack_find_user') {
        const { query } = args;
        if (!query) return { error: 'query is required' };
        const limit = Math.min(Math.max(parseInt(args.limit) || 10, 1), 25);

        const params = new URLSearchParams({
            query,
            fields: 'id,login,fullName,email',
            $top: String(limit),
        });

        log.info(`[YouTrack] Finding users: "${query}"`);
        try {
            const users = await youtrackRequest(baseUrl, token, 'GET', `/users?${params}`);
            if (!users || users.length === 0) {
                return { results: [], count: 0, message: 'No users found matching your query.' };
            }
            return {
                results: users.map(u => ({
                    login: u.login,
                    fullName: u.fullName || null,
                    email: u.email || null,
                })),
                count: users.length,
                message: `Found ${users.length} user(s). Use the login value for youtrack_change_assignee.`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to find users: ${err.message}`);
            return { error: `Failed to find users: ${err.message}` };
        }

    } else if (toolName === 'youtrack_change_assignee') {
        const { issueId, login } = args;
        if (!issueId || !ISSUE_ID_RE.test(issueId)) return { error: 'issueId is required (format: SHORTNAME-NUMBER)' };
        if (!login || !/^\S+$/.test(login)) return { error: 'login is required and may not contain whitespace (use youtrack_find_user to look it up)' };

        log.info(`[YouTrack] Assigning ${issueId} to "${login}"`);
        try {
            await youtrackRequest(baseUrl, token, 'POST', '/commands', {
                query: `for ${login}`,
                issues: [{ idReadable: issueId }],
            });
            return {
                issueId,
                assignee: login,
                updated: true,
                message: `Assignee of ${issueId} set to ${login}.`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to assign ${issueId}: ${err.message}`);
            return { error: `Failed to set assignee of ${issueId} to "${login}": ${err.message}. Make sure the login is exact (use youtrack_find_user).` };
        }

    } else if (toolName === 'youtrack_log_work') {
        const { issueId, text, date } = args;
        if (!issueId) return { error: 'issueId is required' };
        const minutes = parseInt(args.minutes);
        if (!Number.isInteger(minutes) || minutes < 1) return { error: 'minutes is required (integer >= 1)' };
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date must be in YYYY-MM-DD format' };

        log.info(`[YouTrack] Logging ${minutes}m on ${issueId}`);
        try {
            const body = { duration: { minutes } };
            if (text) body.text = text;
            // Noon UTC keeps the work item on the intended calendar day in
            // every timezone YouTrack might render it in.
            if (date) body.date = Date.parse(`${date}T12:00:00Z`);

            await youtrackRequest(baseUrl, token, 'POST', `/issues/${issueId}/timeTracking/workItems`, body);
            return {
                issueId,
                minutes,
                logged: true,
                message: `Logged ${minutes} minute(s) on ${issueId}.`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to log work on ${issueId}: ${err.message}`);
            if ((err.status === 400 || err.status === 404) && /time.?tracking|not enabled|disabled/i.test(err.message)) {
                return { error: `Time tracking is not enabled for this project. Ask a YouTrack admin to enable it, or add the information as a comment instead (youtrack_add_comment).` };
            }
            return { error: `Failed to log work on ${issueId}: ${err.message}` };
        }

    } else if (toolName === 'youtrack_manage_tags') {
        const { issueId, action, tag } = args;
        if (!issueId || !ISSUE_ID_RE.test(issueId)) return { error: 'issueId is required (format: SHORTNAME-NUMBER)' };
        if (action !== 'add' && action !== 'remove') return { error: 'action must be "add" or "remove"' };
        if (!tag || !/^[^{}"'\n]+$/.test(String(tag).trim())) return { error: 'tag is required and may not contain braces, quotes or newlines' };

        const cleanTag = String(tag).trim();
        // Multi-word tags need braces so the command parser treats them as one value.
        const tagValue = /\s/.test(cleanTag) ? `{${cleanTag}}` : cleanTag;
        const command = action === 'add' ? `tag ${tagValue}` : `untag ${tagValue}`;

        log.info(`[YouTrack] ${action === 'add' ? 'Tagging' : 'Untagging'} ${issueId}: "${cleanTag}"`);
        try {
            await youtrackRequest(baseUrl, token, 'POST', '/commands', {
                query: command,
                issues: [{ idReadable: issueId }],
            });
            return {
                issueId,
                tag: cleanTag,
                action,
                updated: true,
                message: `Tag "${cleanTag}" ${action === 'add' ? 'added to' : 'removed from'} ${issueId}.`,
            };
        } catch (err) {
            log.warn(`[YouTrack] Failed to ${action} tag on ${issueId}: ${err.message}`);
            return { error: `Failed to ${action} tag "${cleanTag}" on ${issueId}: ${err.message}` };
        }

    } else {
        return { error: `Unknown YouTrack tool: ${toolName}` };
    }
}

function isYouTrackTool(toolName) {
    return [
        'youtrack_search_issues',
        'youtrack_get_issue',
        'youtrack_create_issue',
        'youtrack_add_comment',
        'youtrack_update_issue',
        'youtrack_list_projects',
        'youtrack_link_issues',
        'youtrack_get_issue_comments',
        'youtrack_find_user',
        'youtrack_change_assignee',
        'youtrack_log_work',
        'youtrack_manage_tags',
    ].includes(toolName);
}

module.exports = {
    YOUTRACK_TOOLS,
    executeYouTrackTool,
    isYouTrackTool,
    // Exported for tests
    normalizeSummary,
    resolveProjectShortName,
    findRecentIssueBySummary,
    __setVerifyDelayMs,
};
