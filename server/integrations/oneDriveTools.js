/**
 * OneDrive Tools — Built-in tools for AI to search and manage OneDrive files
 * 
 * Mirror of driveTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const ONEDRIVE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'onedrive_search',
            description: 'Search for files in the user\'s OneDrive by name or content. Returns file name, type, size, and last modified date.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query to match against file names and content'
                    },
                    maxResults: {
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
            name: 'onedrive_list_files',
            description: 'List files and folders in a OneDrive folder. If no folderId is provided, lists the root of OneDrive.',
            parameters: {
                type: 'object',
                properties: {
                    folderId: {
                        type: 'string',
                        description: 'Optional: The folder ID to list contents of. Omit for root folder.'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of items to return (1-50, default 25)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'onedrive_list_recent',
            description: 'List files in the user\'s OneDrive modified since a date, newest first. Returns name, parent folder, modified and created time (no file content).',
            parameters: {
                type: 'object',
                properties: {
                    since: {
                        type: 'string',
                        description: 'ISO date/time: only files modified at or after this moment (default: 30 days ago)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of files to return (1-200, default 50)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'onedrive_get_file',
            description: 'Get detailed metadata about a specific file in OneDrive, including name, size, last modified, download URL, and sharing info.',
            parameters: {
                type: 'object',
                properties: {
                    fileId: {
                        type: 'string',
                        description: 'The file ID to get details for (from onedrive_search or onedrive_list_files)'
                    }
                },
                required: ['fileId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'onedrive_create_folder',
            description: 'Create a new folder in OneDrive.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name of the new folder'
                    },
                    parentFolderId: {
                        type: 'string',
                        description: 'Optional: Parent folder ID. Omit to create in root.'
                    }
                },
                required: ['name']
            }
        }
    }
];

/**
 * Format a file size into human-readable string.
 */
function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Format a Graph API drive item into a consistent shape.
 */
function formatItem(item) {
    const isFolder = !!item.folder;
    return {
        id: item.id,
        name: item.name,
        type: isFolder ? 'folder' : (item.file?.mimeType || 'file'),
        size: isFolder ? null : formatSize(item.size),
        sizeBytes: item.size || 0,
        lastModified: item.lastModifiedDateTime || '',
        createdBy: item.createdBy?.user?.displayName || '',
        webUrl: item.webUrl || '',
        isFolder,
        childCount: isFolder ? (item.folder?.childCount || 0) : undefined,
    };
}

const RECENT_DEFAULT_DAYS = 30;
const RECENT_MAX_RESULTS = 200;
const RECENT_MAX_PAGES = 5;
const RECENT_SELECT = 'id,name,file,folder,deleted,lastModifiedDateTime,createdDateTime,parentReference,lastModifiedBy';
const GRAPH_NEXT_LINK_PREFIX = 'https://graph.microsoft.com/';

/** Parse `since` (ISO) into an ISO string; default RECENT_DEFAULT_DAYS ago. */
function resolveSince(since, now = Date.now()) {
    if (since === undefined || since === null || since === '') {
        return new Date(now - RECENT_DEFAULT_DAYS * 86400000).toISOString();
    }
    const ms = Date.parse(String(since));
    if (!Number.isFinite(ms)) throw new Error('since must be an ISO date/time');
    return new Date(ms).toISOString();
}

/**
 * @param {object} item - a Graph driveItem
 * @param {string|null} [meId] - the signed-in user's Graph id, when known
 */
function formatRecentItem(item, meId = null) {
    const parent = item.parentReference || {};
    const out = {
        id: item.id,
        name: item.name,
        mimeType: item.file?.mimeType || '',
        parentId: parent.id || null,
        // delta leaves parentReference.path out; /recent and children carry it.
        parentPath: parent.path ? String(parent.path).replace(/^\/drive\/root:?/, '') || '/' : null,
        lastModified: item.lastModifiedDateTime || '',
        created: item.createdDateTime || '',
    };
    // Who made the last change, as a yes/no only: the editor's id, name and
    // address are compared here and never passed on. Absent when unknown.
    const by = item.lastModifiedBy?.user?.id;
    if (meId && by) out.modifiedByMe = String(by).toLowerCase() === String(meId).toLowerCase();
    return out;
}

/**
 * onedrive_list_recent: files (never folders, never content) modified since a
 * date. Primary source is the drive delta feed with a timestamp token, which
 * OneDrive for Business and SharePoint accept; a personal OneDrive refuses
 * that token, and then the drive's "recent" view is used and filtered here.
 * Paging follows @odata.nextLink on the Graph host only, up to a page cap.
 *
 * @param {object} args - { since?, maxResults? }
 * @param {(path: string) => Promise<any>} fetchPage - Graph GET (path or absolute nextLink URL)
 */
async function listRecentDriveItems(args, fetchPage, { now = Date.now() } = {}) {
    const sinceIso = resolveSince(args?.since, now);
    const want = Math.min(Math.max(parseInt(args?.maxResults) || 50, 1), RECENT_MAX_RESULTS);
    const sinceMs = Date.parse(sinceIso);

    const collect = async (firstPath) => {
        const items = [];
        let next = firstPath;
        let pages = 0;
        while (next && pages < RECENT_MAX_PAGES) {
            const data = await fetchPage(next);
            pages++;
            for (const it of (data?.value || [])) items.push(it);
            const link = data?.['@odata.nextLink'];
            next = typeof link === 'string' && link.startsWith(GRAPH_NEXT_LINK_PREFIX) ? link : null;
        }
        return { items, truncated: !!next };
    };

    let source = 'delta';
    let raw;
    try {
        raw = await collect(`/me/drive/root/delta?token=${encodeURIComponent(sinceIso)}&$select=${RECENT_SELECT}`);
    } catch {
        source = 'recent';
        raw = await collect(`/me/drive/recent?$select=${RECENT_SELECT}`);
    }

    const files = raw.items
        .filter(it => it && it.file && !it.folder && !it.deleted)
        .filter(it => {
            const ms = Date.parse(it.lastModifiedDateTime || '');
            return Number.isFinite(ms) && ms >= sinceMs;
        })
        .sort((a, b) => Date.parse(b.lastModifiedDateTime) - Date.parse(a.lastModifiedDateTime));

    // A colleague's edit to a shared file in this drive is their work, not the
    // user's: one /me read lets each item say whether the user made it.
    let meId = null;
    if (files.some(it => it.lastModifiedBy?.user?.id)) {
        try { meId = (await fetchPage('/me?$select=id'))?.id || null; } catch { meId = null; }
    }

    return {
        items: files.slice(0, want).map(it => formatRecentItem(it, meId)),
        total: Math.min(files.length, want),
        since: sinceIso,
        hasMore: files.length > want || raw.truncated,
        source,
    };
}

/**
 * Execute a OneDrive tool call.
 */
async function executeOneDriveTool(toolName, args, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to OneDrive — user must log in with Microsoft');
    }

    if (toolName === 'onedrive_search') {
        const { query, maxResults = 10 } = args;
        if (!query) throw new Error('query is required');
        const top = Math.min(Math.max(parseInt(maxResults) || 10, 1), 25);

        const data = await graphFetch(
            `/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${top}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl`,
            session
        );

        return {
            results: (data.value || []).map(formatItem),
            total: (data.value || []).length,
            query,
        };

    } else if (toolName === 'onedrive_list_files') {
        const { folderId, maxResults = 25 } = args;
        const top = Math.min(Math.max(parseInt(maxResults) || 25, 1), 50);

        const path = folderId
            ? `/me/drive/items/${folderId}/children`
            : '/me/drive/root/children';

        const data = await graphFetch(
            `${path}?$top=${top}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl&$orderby=name`,
            session
        );

        return {
            items: (data.value || []).map(formatItem),
            total: (data.value || []).length,
            folderId: folderId || 'root',
        };

    } else if (toolName === 'onedrive_list_recent') {
        return listRecentDriveItems(args, (path) => graphFetch(path, session));

    } else if (toolName === 'onedrive_get_file') {
        const { fileId } = args;
        if (!fileId) throw new Error('fileId is required');

        const item = await graphFetch(
            `/me/drive/items/${fileId}?$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl,parentReference,@microsoft.graph.downloadUrl`,
            session
        );

        const result = formatItem(item);
        result.parentPath = item.parentReference?.path || '';
        result.downloadUrl = item['@microsoft.graph.downloadUrl'] || null;

        return result;

    } else if (toolName === 'onedrive_create_folder') {
        const { name, parentFolderId } = args;
        if (!name) throw new Error('name is required');

        const parentPath = parentFolderId
            ? `/me/drive/items/${parentFolderId}/children`
            : '/me/drive/root/children';

        const result = await graphFetch(parentPath, session, {
            method: 'POST',
            body: JSON.stringify({
                name,
                folder: {},
                '@microsoft.graph.conflictBehavior': 'rename',
            }),
        });

        return {
            success: true,
            folderId: result.id,
            name: result.name,
            webUrl: result.webUrl,
            message: `Folder "${result.name}" created successfully.`,
        };

    } else {
        throw new Error(`Unknown OneDrive tool: ${toolName}`);
    }
}

/**
 * Check if a tool name is a OneDrive tool.
 */
function isOneDriveTool(toolName) {
    return ['onedrive_search', 'onedrive_list_files', 'onedrive_list_recent', 'onedrive_get_file', 'onedrive_create_folder'].includes(toolName);
}

module.exports = {
    ONEDRIVE_TOOLS,
    executeOneDriveTool,
    isOneDriveTool,
    // exposed for tests
    listRecentDriveItems,
};
