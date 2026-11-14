// @typecheck strict
/**
 * Files and folders over WebDAV — listing, reading, uploading, creating,
 * deleting and server-side move/copy — plus the OCS endpoints that act on a
 * file id: Office conversion, the folder tree and direct download links.
 */

const { PROPFIND_BODY, joinDavPath, parsePropfind } = require('./webdav');
const { readNextcloudFile } = require('./readFile');
const { uploadNextcloudFile } = require('./uploadFile');
const { davStatusError } = require('./davStatusError.mts');

/**
 * The arguments of the file tools, as the model sent them.
 * @typedef {{ path?: string, fileId?: string | number, targetMimeType?: string, destination?: string, depth?: number,
 *   withParents?: boolean, sourceHandle?: { kind: string, messageId?: string, attachmentId?: string, fileId?: string,
 *   mimeType?: string }, content?: string, isBase64?: boolean, contentType?: string, source?: string,
 *   overwrite?: boolean }} FileOpArgs
 */

/**
 * A node of the folder-tree OCS answer (bare JSON, keys vary by version).
 * @typedef {{ basename?: string, name?: string, displayName?: string, path?: string, href?: string, children?: FolderTreeNode[], entries?: FolderTreeNode[] }} FolderTreeNode
 */

/**
 * Compose each node's absolute path from its parent's and write it onto the node.
 * @param {unknown} nodes
 * @param {string} parentPath
 * @returns {FolderTreeNode[]}
 */
function withFullPaths(nodes, parentPath) {
    if (!Array.isArray(nodes)) return [];
    return nodes.map((node) => {
        if (!node || typeof node !== 'object') return node;
        const name = node.basename ?? node.name ?? node.displayName ?? null;
        const own = node.path ?? node.href ?? null;
        const leaf = name ?? (own ? String(own).split('/').filter(Boolean).pop() : null);
        if (!leaf) return node;
        const base = parentPath === '/' ? '' : parentPath;
        const full = `${base}/${leaf}`;
        const childKey = Array.isArray(node.children) ? 'children' : (Array.isArray(node.entries) ? 'entries' : null);
        return childKey ? { ...node, path: full, [childKey]: withFullPaths(node[childKey], full) } : { ...node, path: full };
    });
}

/** @typedef {(args: FileOpArgs, ctx: import('./webdav').FilesToolCtx) => Promise<Record<string, any>>} FileOpHandler */

/** @type {FileOpHandler} */
async function listFiles(args, { baseUrl, ncFetch, authError, uid, root }) {
    const davPath = joinDavPath(root, args.path);
    const url = davPath.endsWith('/') ? davPath : `${davPath}/`;
    const res = await ncFetch(url, {
        method: 'PROPFIND',
        headers: {
            'Depth': '1',
            'Content-Type': 'application/xml; charset=utf-8',
            'Accept': 'application/xml',
        },
        body: PROPFIND_BODY,
    });
    if (res.status === 404) return { error: `Folder not found: ${args.path}` };
    if (res.status === 401) return { error: authError };
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { error: `Nextcloud PROPFIND failed (${res.status}): ${text.slice(0, 200)}` };
    }
    const xml = await res.text();
    const all = parsePropfind(xml, baseUrl, uid);
    // First entry is the folder itself — drop it. parsePropfind emits
    // leading-slash paths, so normalise the caller's argument the same
    // way: `Documents` and `/Documents/` must both match `/Documents`,
    // otherwise the folder comes back as a child of itself.
    const folderPath = ('/' + String(args.path || '')).replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
    const items = all.filter(item => item.path !== folderPath);
    return { path: folderPath, count: items.length, items };
}

/** @type {FileOpHandler} */
async function convertFile(args, { baseUrl, ncFetch, authError }) {
    if (!args.fileId) return { error: 'fileId is required' };
    /** @type {{ fileId: number, targetMimeType: string, destination?: string }} */
    const payload = {
        fileId: Number(args.fileId),
        targetMimeType: args.targetMimeType || 'application/pdf',
    };
    // The API treats `destination` as a path within the user's files
    // root. Omitting it writes the result next to the source.
    if (args.destination) payload.destination = args.destination;
    const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files/api/v1/convert`, {
        method: 'POST',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) {
        return { error: 'File conversion is unavailable — it needs Nextcloud 30+ with the Nextcloud Office (richdocuments) app installed and a Collabora/CODE server configured.' };
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { error: `Nextcloud file conversion failed (${res.status}): ${text.slice(0, 200)}` };
    }
    const data = await res.json().catch(/** @returns {null} */ () => null);
    const out = data?.ocs?.data || {};
    return {
        success: true,
        sourceFileId: Number(args.fileId),
        targetMimeType: payload.targetMimeType,
        path: out.path || args.destination || null,
        fileId: out.fileId ?? null,
    };
}

/**
 * The folder-tree route answers 404 for a missing PATH too. Probe the root
 * once: if that works the endpoint exists and the path is what is missing.
 * @param {FileOpArgs} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function folderTreeNotFound(args, { baseUrl, ncFetch, authError }) {
    if (args.path) {
        const probe = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files/api/v1/folder-tree?depth=1`, {
            headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
        });
        await probe.text().catch(() => '');
        if (probe.status === 401) return { error: authError };
        if (probe.ok) return { error: `Folder not found: ${args.path}` };
    }
    return { error: 'The folder-tree endpoint is unavailable on this Nextcloud (needs 31+). Use nextcloud_list_files instead.' };
}

/** @type {FileOpHandler} */
async function folderTree(args, ctx) {
    const { baseUrl, ncFetch, authError } = ctx;
    const depth = Math.min(Math.max(args.depth || 3, 1), 10);
    // An OCS ApiRoute whose body is a bare JSON array (not the usual OCS envelope).
    const params = new URLSearchParams({ depth: String(depth) });
    if (args.path) params.set('path', String(args.path));
    if (args.withParents) params.set('withParents', 'true');
    const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files/api/v1/folder-tree?${params.toString()}`, {
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) {
        await res.text().catch(() => '');
        return folderTreeNotFound(args, ctx);
    }
    if (!res.ok) return { error: `Nextcloud folder tree failed (${res.status})` };
    const data = await res.json().catch(/** @returns {null} */ () => null);
    const raw = Array.isArray(data) ? data : (data?.ocs?.data ?? []);
    // Nodes are relative to the requested start folder (unless the
    // parents came along). Write the FULL path on every node so the
    // scope guard prunes against real paths, not "/Secret" for
    // "/Shared/Secret".
    const start = args.withParents ? '/' : `/${String(args.path || '').split('/').filter(Boolean).join('/')}`;
    return { depth, tree: withFullPaths(raw, start) };
}

/** @type {FileOpHandler} */
async function directLink(args, { baseUrl, ncFetch, authError }) {
    if (!args.fileId) return { error: 'fileId is required' };
    const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/dav/api/v1/direct`, {
        method: 'POST',
        headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: Number(args.fileId) }),
    });
    if (res.status === 401) return { error: authError };
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { error: `Could not mint a direct link (${res.status}): ${text.slice(0, 200)}` };
    }
    const data = await res.json().catch(/** @returns {null} */ () => null);
    const url = data?.ocs?.data?.url || null;
    if (!url) return { error: 'Nextcloud did not return a direct link URL' };
    // Nextcloud expires these after 24h. Say so, so an automation does not
    // persist the URL somewhere long-lived and expect it to keep working.
    return { fileId: Number(args.fileId), url, expiresInHours: 24 };
}

/** @type {FileOpHandler} */
async function createFolder(args, { ncFetch, authError, root }) {
    if (!args.path) return { error: 'path is required' };
    const url = joinDavPath(root, args.path);
    const res = await ncFetch(url, { method: 'MKCOL' });
    if (res.status === 401) return { error: authError };
    if (res.status === 405) return { error: `Folder already exists: ${args.path}` };
    if (res.status === 409) return { error: `Parent folder for ${args.path} does not exist.` };
    if (!res.ok) return { error: davStatusError(res.status, args.path) || `Folder creation failed (${res.status})` };
    return { success: true, path: args.path };
}

/** @type {FileOpHandler} */
async function deletePath(args, { ncFetch, authError, root }) {
    if (!args.path) return { error: 'path is required' };
    const url = joinDavPath(root, args.path);
    const res = await ncFetch(url, { method: 'DELETE' });
    if (res.status === 404) return { error: `Not found: ${args.path}` };
    if (res.status === 401) return { error: authError };
    if (!res.ok && res.status !== 204) return { error: davStatusError(res.status, args.path) || `Delete failed (${res.status})` };
    return { success: true, path: args.path };
}

/**
 * A server-side MOVE or COPY.
 * @param {'MOVE' | 'COPY'} method
 * @returns {FileOpHandler}
 */
const transfer = (method) => async (args, { ncFetch, authError, root }) => {
    if (!args.source || !args.destination) return { error: 'source and destination are required' };
    const sourceUrl = joinDavPath(root, args.source);
    const destinationUrl = joinDavPath(root, args.destination);
    const res = await ncFetch(sourceUrl, {
        method,
        headers: {
            'Destination': destinationUrl,
            'Overwrite': args.overwrite ? 'T' : 'F',
        },
    });
    if (res.status === 401) return { error: authError };
    if (res.status === 404) return { error: `Source not found: ${args.source}` };
    if (res.status === 409) return { error: `Destination parent folder doesn't exist: ${args.destination}. Create it first.` };
    if (res.status === 412) return { error: `Destination already exists: ${args.destination}. Pass overwrite=true to replace it.` };
    if (!res.ok && res.status !== 201 && res.status !== 204) {
        // A lock or a denial can sit on either end; a full quota is the destination's.
        const plain = davStatusError(res.status, res.status === 507 ? args.destination : `${args.source} or ${args.destination}`);
        if (plain) return { error: plain };
        const text = await res.text().catch(() => '');
        return { error: `${method} failed (${res.status}): ${text.slice(0, 200)}` };
    }
    return {
        success: true,
        operation: method.toLowerCase(),
        source: args.source,
        destination: args.destination,
        overwritten: res.status === 204,
    };
};

/** @type {Record<string, FileOpHandler>} */
const HANDLERS = {
    nextcloud_list_files: listFiles,
    nextcloud_convert_file: convertFile,
    nextcloud_folder_tree: folderTree,
    nextcloud_direct_link: directLink,
    nextcloud_read_file: (args, ctx) => readNextcloudFile(args, ctx),
    nextcloud_upload_file: (args, ctx) => uploadNextcloudFile(args, ctx),
    nextcloud_create_folder: createFolder,
    nextcloud_delete: deletePath,
    nextcloud_move: transfer('MOVE'),
    nextcloud_copy: transfer('COPY'),
};

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
/**
 * @param {string} toolName
 * @param {FileOpArgs} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function executeFileOperationTool(toolName, args, ctx) {
    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    return handler ? handler(args, ctx) : undefined;
}

module.exports = { executeFileOperationTool };
