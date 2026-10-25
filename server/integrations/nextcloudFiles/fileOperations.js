// @typecheck noImplicitAny
/**
 * Files and folders over WebDAV — listing, reading, uploading, creating,
 * deleting and server-side move/copy — plus the OCS endpoints that act on a
 * file id: Office conversion, the folder tree and direct download links.
 */

const { MAX_TEXT_BYTES, PROPFIND_BODY, joinDavPath, parsePropfind, ensureParentFolders } = require('./webdav');
const { toolFileMaxBytes, readBytesBounded, fileTooLargeMessage } = require('../../core/http/httpResponseLimits');

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
 * @param {{ path?: string, fileId?: string | number, targetMimeType?: string, destination?: string, depth?: number, withParents?: boolean, sourceHandle?: { kind: string, messageId?: string, attachmentId?: string, fileId?: string, mimeType?: string }, content?: string, isBase64?: boolean, contentType?: string, source?: string, overwrite?: boolean }} args
 * @param {import('./webdav').FilesToolCtx} ctx
 */
async function executeFileOperationTool(toolName, args, ctx) {
    const { baseUrl, ncFetch, authError, uid, root, session } = ctx;

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

        case 'nextcloud_read_file': {
            if (!args.path) return { error: 'path is required' };
            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, {});
            if (res.status === 404) return { error: `File not found: ${args.path}` };
            if (res.status === 401) return { error: authError };
            if (!res.ok) return { error: `Nextcloud read failed (${res.status})` };
            const contentType = res.headers.get('content-type') || '';
            const cap = toolFileMaxBytes();
            const { buffer: buf, truncated: tooBig, declaredBytes } = await readBytesBounded(res, { byteCap: cap });
            if (tooBig || !buf) return { error: fileTooLargeMessage(args.path, declaredBytes, cap) };
            // A GET on a collection answers 200 with Sabre's HTML banner, which
            // would otherwise come back as the "content" of the file.
            const isWebdavBanner = /html/i.test(contentType)
                && /This is the WebDAV interface/i.test(buf.slice(0, 2048).toString('utf-8'));
            if (/\/$/.test(args.path) || isWebdavBanner) {
                return { error: `path "${args.path}" is a folder, not a file. Use nextcloud_list_files to see what is in it.` };
            }
            const filename = args.path.split('/').pop() || args.path;
            const att = { name: filename, type: contentType };

            // Rich-document extraction — PDF, DOCX, PPTX, XLSX/CSV go through
            // the same pipeline used for chat uploads (pdfjs → Azure DI →
            // Mistral OCR for PDFs; Azure DI → mammoth/pptxExtractor/xlsx for
            // Office docs).
            const { extractAttachment, isPdf, isDocx, isSpreadsheet, isPptx } = require('../../core/documents/attachmentExtractor');
            if (isPdf(att) || isDocx(att) || isSpreadsheet(att) || isPptx(att)) {
                /** @type {{ kind: string, text?: string, source?: string, meta?: any, reason?: string, images?: any }} */
                const result = await extractAttachment({
                    name: filename,
                    type: contentType,
                    content: buf.toString('base64'),
                });
                if (result.kind === 'text') {
                    const truncated = result.text.length > MAX_TEXT_BYTES;
                    const text = truncated
                        ? result.text.slice(0, MAX_TEXT_BYTES) + '\n\n... [truncated — extracted text too large]'
                        : result.text;
                    return {
                        path: args.path,
                        size: buf.length,
                        contentType,
                        extractedVia: result.source,
                        truncated,
                        content: text,
                        meta: result.meta,
                    };
                }
                if (result.kind === 'images') {
                    return {
                        error: `${filename} appears to be an image-only document (${result.meta?.numPages || '?'} pages) with no extractable text. Configure Azure Document Intelligence or Mistral OCR to read scanned PDFs from Nextcloud.`,
                        size: buf.length,
                        contentType,
                    };
                }
                return {
                    error: `Could not extract text from ${filename}: ${result.reason}.`,
                    size: buf.length,
                    contentType,
                };
            }

            // Plain text path — UTF-8 decode with binary-safety probe.
            const isText = /^(text\/|application\/(json|xml|x-yaml|x-sh|javascript))/i.test(contentType) || buf.slice(0, 1024).every(b => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
            if (!isText) {
                return { error: `File appears to be binary (${contentType || 'unknown type'}). Reading binary files of this type is not supported.`, size: buf.length, contentType };
            }
            const truncated = buf.length > MAX_TEXT_BYTES;
            // Cut on a character boundary: a continuation byte (10xxxxxx) at the
            // cut means the last character is split, so drop its start too.
            let end = Math.min(buf.length, MAX_TEXT_BYTES);
            while (truncated && end > 0 && (buf[end] & 0xC0) === 0x80) end--;
            const content = buf.slice(0, end).toString('utf-8');
            return {
                path: args.path,
                size: buf.length,
                contentType: contentType || 'text/plain',
                truncated,
                content: truncated ? content + '\n\n... [truncated — file too large]' : content,
            };
        }

        case 'nextcloud_upload_file': {
            if (!args.path) return { error: 'path is required' };
            const hasHandle = args.sourceHandle && typeof args.sourceHandle === 'object';
            const hasContent = typeof args.content === 'string';
            if (hasHandle && hasContent) return { error: 'Pass either sourceHandle or content, not both.' };
            if (!hasHandle && !hasContent) {
                return { error: 'Either sourceHandle (preferred for binary) or content (for inline text) is required.' };
            }

            // A folder path is only fine for a generated file, which takes its own name.
            if (/\/$/.test(String(args.path)) && !(hasHandle && args.sourceHandle.kind === 'generated_file')) {
                return { error: `path "${args.path}" is a folder. Give a file name, e.g. "${args.path}report.txt".` };
            }

            // Resolve to bytes. Handles stay opaque to the model — this is what
            // keeps a PDF attachment out of the conversation entirely, and it is
            // why binding base64 into `content` was never a real option: the
            // PUT below is byte-exact, so a base64 string would land as a
            // base64 *text file* rather than the document.
            /** @type {Buffer<ArrayBuffer> | Buffer<ArrayBufferLike> | string} */
            let body;
            let handleMime = null;
            if (hasHandle) {
                const kind = args.sourceHandle.kind;
                if (kind === 'gmail_attachment') {
                    const { fetchAttachmentBuffer } = require('../gmailTools');
                    const fetched = await fetchAttachmentBuffer(session, {
                        messageId: args.sourceHandle.messageId,
                        attachmentId: args.sourceHandle.attachmentId,
                    });
                    body = fetched.buffer;
                    handleMime = args.sourceHandle.mimeType || null;
                } else if (kind === 'generated_file') {
                    // A file a document/presentation step kept for THIS run —
                    // resolved against the journey's run ids, never by id alone.
                    const { readGeneratedFile } = require('../../core/automationRunner/generatedFileHandle');
                    /** @type {{ buffer: Buffer; filename: string; mimeType: string; size: number; } | null} */
                    let file;
                    try {
                        file = await readGeneratedFile(/** @type {{ kind: 'generated_file', fileId: string }} */ (args.sourceHandle), ctx.runScope || null);
                    } catch (e) {
                        return { error: /** @type {Error} */ (e).message };
                    }
                    if (!file) return { error: 'That fileId is not a live file of this run (expired, or produced by another automation).' };
                    body = file.buffer;
                    handleMime = args.sourceHandle.mimeType || file.mimeType || null;
                    // A folder path takes the file's own name.
                    if (/\/$/.test(String(args.path || ''))) args = { ...args, path: `${args.path}${file.filename}` };
                } else {
                    return { error: `Unsupported sourceHandle.kind: ${kind}` };
                }
            } else if (args.isBase64) {
                // Buffer.from(..., 'base64') never throws: it skips what it
                // cannot read and stores the rest, so check the text first.
                const b64 = args.content.replace(/\s+/g, '');
                if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64) || b64.length % 4 === 1) {
                    return { error: 'content is not valid base64. Send base64 text, or set isBase64 to false for plain text.' };
                }
                body = Buffer.from(b64, 'base64');
            } else {
                body = args.content;
            }

            // joinDavPath drops a trailing slash, so "/Docs/" would PUT a file
            // named "Docs" and fail on its missing parent. A folder is not a file.
            if (/\/$/.test(String(args.path))) {
                return { error: `path "${args.path}" is a folder. Give a file name, e.g. "${args.path}report.txt".` };
            }
            const url = joinDavPath(root, args.path);
            const put = () => ncFetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': args.contentType
                        || handleMime
                        || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/plain; charset=utf-8'),
                },
                body,
            });
            let res = await put();
            let retried = false;
            // 409 or 404 = a parent folder is missing (Nextcloud answers 404 for
            // a PUT into a missing folder, 409 on older servers). Create the chain once and retry,
            // so an automation saving into "/Invoices/Vendor/" needs no create-folder
            // steps (which fail with "already exists" on every later run). The
            // happy path still costs a single PUT.
            if (res.status === 409 || res.status === 404) {
                await ensureParentFolders(ncFetch, root, args.path);
                res = await put();
                retried = true;
            }
            if (res.status === 401) return { error: authError };
            if (res.status === 409 || (retried && res.status === 404)) return { error: `Parent folder for ${args.path} does not exist and could not be created.` };
            if (!res.ok && res.status !== 201 && res.status !== 204) {
                const text = await res.text().catch(() => '');
                return { error: `Upload failed (${res.status}): ${text.slice(0, 200)}` };
            }
            return {
                success: true,
                path: args.path,
                bytes: Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body),
                created: res.status === 201,
                updated: res.status === 204,
            };
        }

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
