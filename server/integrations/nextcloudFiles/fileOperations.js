/**
 * Files and folders over WebDAV — listing, reading, uploading, creating,
 * deleting and server-side move/copy — plus the OCS endpoints that act on a
 * file id: Office conversion, the folder tree and direct download links.
 */

const { MAX_TEXT_BYTES, PROPFIND_BODY, joinDavPath, parsePropfind } = require('./webdav');

// Returns undefined when the tool belongs to another Nextcloud file family, so
// the facade can hand it to the next handler.
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
            const data = await res.json().catch(() => null);
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
            const res = await ncFetch(`${baseUrl}/ocs/v2.php/apps/files/api/v1/folder-tree?depth=${depth}&format=json`, {
                headers: { 'OCS-APIRequest': 'true', 'Accept': 'application/json' },
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 404) {
                return { error: 'The folder-tree endpoint is unavailable on this Nextcloud (needs 31+). Use nextcloud_list_files instead.' };
            }
            if (!res.ok) return { error: `Nextcloud folder tree failed (${res.status})` };
            const data = await res.json().catch(() => null);
            return { depth, tree: data?.ocs?.data ?? [] };
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
            const data = await res.json().catch(() => null);
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
            const buf = Buffer.from(await res.arrayBuffer());
            const filename = args.path.split('/').pop() || args.path;
            const att = { name: filename, type: contentType };

            // Rich-document extraction — PDF, DOCX, PPTX, XLSX/CSV go through
            // the same pipeline used for chat uploads (pdfjs → Azure DI →
            // Mistral OCR for PDFs; Azure DI → mammoth/pptxExtractor/xlsx for
            // Office docs).
            const { extractAttachment, isPdf, isDocx, isSpreadsheet, isPptx } = require('../../core/documents/attachmentExtractor');
            if (isPdf(att) || isDocx(att) || isSpreadsheet(att) || isPptx(att)) {
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
            const content = buf.slice(0, MAX_TEXT_BYTES).toString('utf-8');
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

            // Resolve to bytes. Handles stay opaque to the model — this is what
            // keeps a PDF attachment out of the conversation entirely, and it is
            // why binding base64 into `content` was never a real option: the
            // PUT below is byte-exact, so a base64 string would land as a
            // base64 *text file* rather than the document.
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
                    handleMime = args.sourceHandle.mimeType || fetched.mimeType || null;
                } else if (kind === 'generated_file') {
                    // A file a document/presentation step kept for THIS run —
                    // resolved against the journey's run ids, never by id alone.
                    const { readGeneratedFile } = require('../../core/automationRunner/generatedFileHandle');
                    let file;
                    try {
                        file = await readGeneratedFile(args.sourceHandle, ctx.runScope || null);
                    } catch (e) {
                        return { error: e.message };
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
                body = Buffer.from(args.content, 'base64');
            } else {
                body = args.content;
            }

            const url = joinDavPath(root, args.path);
            const res = await ncFetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': args.contentType
                        || handleMime
                        || (Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/plain; charset=utf-8'),
                },
                body,
            });
            if (res.status === 401) return { error: authError };
            if (res.status === 409) return { error: `Parent folder for ${args.path} does not exist. Create it first with nextcloud_create_folder.` };
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
