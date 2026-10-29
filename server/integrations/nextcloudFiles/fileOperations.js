// @typecheck noImplicitAny
/**
 * Files and folders over WebDAV — listing, reading, uploading, creating,
 * deleting and server-side move/copy — plus the OCS endpoints that act on a
 * file id: Office conversion, the folder tree and direct download links.
 */

const { PROPFIND_BODY, joinDavPath, parsePropfind } = require('./webdav');
const { readNextcloudFile } = require('./readFile');
const { uploadNextcloudFile } = require('./uploadFile');

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

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
/**
 * @param {string} toolName
 * @param {FileOpArgs} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function executeFileOperationTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError, uid, root } = ctx;

    switch (toolName) {
        case 'nextcloud_list_files': {
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

        case 'nextcloud_convert_file': {
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

        case 'nextcloud_folder_tree': {
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
                // The route answers 404 for a missing PATH too. Probe the root once:
                // if that works the endpoint exists and the path is what is missing.
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

        case 'nextcloud_direct_link': {
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

        case 'nextcloud_read_file':
            return readNextcloudFile(args, ctx);

        case 'nextcloud_upload_file':
            return uploadNextcloudFile(args, ctx);

        case 'nextcloud_create_folder': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, { method: 'MKCOL' });
            if (res.status === 401) return { error: authError };
            if (res.status === 405) return { error: `Folder already exists: ${args.path}` };
            if (res.status === 409) return { error: `Parent folder for ${args.path} does not exist.` };
            if (!res.ok) return { error: `Folder creation failed (${res.status})` };
            return { success: true, path: args.path };
        }

        case 'nextcloud_delete': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, { method: 'DELETE' });
            if (res.status === 404) return { error: `Not found: ${args.path}` };
            if (res.status === 401) return { error: authError };
            if (!res.ok && res.status !== 204) return { error: `Delete failed (${res.status})` };
            return { success: true, path: args.path };
        }

        case 'nextcloud_move':
        case 'nextcloud_copy': {
            if (!args.source || !args.destination) return { error: 'source and destination are required' };
            const method = toolName === 'nextcloud_move' ? 'MOVE' : 'COPY';
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
        }

        default:
            return undefined;
    }
}

module.exports = { executeFileOperationTool };
