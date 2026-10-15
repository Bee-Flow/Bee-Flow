/**
 * Office file delivery — where a file the chat built ends up.
 *
 * Two first-party tools build an Office file in-process:
 * create_word_document (.docx, integrations/wordDocumentTools.js) and
 * create_spreadsheet (.xlsx, integrations/spreadsheetTools.js). Both builders
 * are pure; this module is the one place that hands the bytes over, so the
 * two offer the same destinations with the same fallbacks:
 *
 *  - DOWNLOAD (the default): under the caller's own storage prefix
 *    (`users/<id>/documents/`), served by the storage proxy, which enforces
 *    the session, the prefix and a traversal guard and sends the bytes as an
 *    attachment. No ledger row and no expiry: the link lives in the chat.
 *  - NEXTCLOUD (`nextcloudPath`): after the Nextcloud scope guard of the
 *    matching nextcloud_create_* tool, as a direct call would.
 *  - ONEDRIVE (`oneDrivePath`): the signed-in Microsoft user's own drive,
 *    through Microsoft Graph with the session's token. An existing file is
 *    never overwritten: Graph renames the new one.
 *
 * A destination that refuses (not connected, denied, unreachable) never loses
 * the file: it is kept in storage behind a download link, with the reason
 * alongside so the model tells the user. Where the file goes is the user's
 * call; the system prompt has the model ask when the request does not say.
 */

const crypto = require('crypto');
const log = require('../telemetry/log');

const FILE_TOOLS = {
    create_word_document: {
        ext: 'docx', kind: 'word', noun: 'Word document', ncTool: 'nextcloud_create_document',
        build: (args, ctx) => require('./wordDocumentTools').buildWordDocument(args, ctx),
    },
    create_spreadsheet: {
        ext: 'xlsx', kind: 'spreadsheet', noun: 'Excel workbook', ncTool: 'nextcloud_create_spreadsheet',
        build: (args) => require('./spreadsheetTools').buildSpreadsheetFile(args),
    },
};

/**
 * The Office file tools' definitions (deck, Word, Excel), for
 * core/integrations/integrationTools.js to inject. Without the OneDrive app
 * the `oneDrivePath` parameter is left out, so an org or user that switched
 * OneDrive off is not offered it.
 */
function officeFileToolDefinitions({ oneDrive = true } = {}) {
    const defs = [
        ...require('./presentationTools').PRESENTATION_TOOLS,
        ...require('./wordDocumentTools').WORD_DOCUMENT_TOOLS,
        ...require('./spreadsheetTools').SPREADSHEET_TOOLS,
    ];
    if (oneDrive) return defs;
    return defs.map((d) => {
        const { oneDrivePath: _omit, ...properties } = d.function.parameters.properties;
        return { ...d, function: { ...d.function, parameters: { ...d.function.parameters, properties } } };
    });
}

function isOfficeFileTool(toolName) {
    return Object.prototype.hasOwnProperty.call(FILE_TOOLS, toolName);
}

/**
 * The destination file path for a `nextcloudPath` / `oneDrivePath`: a path
 * ending in `.<ext>` is the file itself, anything else is the folder the file
 * (named `fileName`) goes into. Only a string is a path: `true` from the model
 * must not become the folder "true".
 */
function destinationPath(raw, ext, fileName) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (!p) return '';
    if (p.toLowerCase().endsWith(`.${ext}`)) return p;
    return `${p.replace(/\/+$/, '')}/${fileName}`;
}

/**
 * Put a built file in the user's Nextcloud at `path` (parent folders are
 * created). The caller has already run the Nextcloud scope guard for `path`.
 * Returns the upload result plus a `/f/<id>` deep link when one can be built,
 * or { error }.
 */
async function uploadToNextcloud(built, ctx, path) {
    const ncClient = require('./nextcloudClient');
    const { uploadBinaryFile } = require('./nextcloudFiles/webdav');
    let auth;
    try {
        auth = await ncClient.resolveAuth(ctx.session, ctx.userId);
    } catch (e) {
        return { error: e.message || 'Nextcloud is not connected.' };
    }
    const { baseUrl, fetch: ncFetch, authError, uid } = auth;
    const root = ncClient.webdavRoot(baseUrl, uid);
    let up;
    try {
        up = await uploadBinaryFile(ncFetch, root, path, built.buffer, built.contentType, authError, { wantFileId: true, baseUrl, uid });
    } catch (e) {
        // An unreachable host throws instead of answering { error }.
        log.warn(`[OfficeFileDelivery] Nextcloud upload failed: ${e.message}`);
        return { error: 'Nextcloud upload failed' };
    }
    if (up.error) return up;

    // The deep link a person can open. In connector mode `baseUrl` is the
    // ExApp proxy, so only the org's public URL qualifies (as for a deck).
    const linkBase = auth.publicBaseUrl || (auth.mode !== 'connector' ? String(baseUrl || '').replace(/\/+$/, '') : null);
    const fileId = up.fileId || null;
    return { ...up, fileId, webUrl: linkBase && fileId ? `${linkBase}/f/${fileId}` : null };
}

const ONEDRIVE_NOT_CONNECTED = 'OneDrive is not connected: the user has to sign in with Microsoft first';

/**
 * Put a built file in the signed-in user's OneDrive at `path`. Graph creates
 * missing folders and, with conflictBehavior=rename, never replaces a file
 * that is already there. Returns { success, path, name, fileId, webUrl } or { error }.
 */
async function uploadToOneDrive(built, ctx, path) {
    const { graphRequest, isMicrosoftConnected } = require('./msGraphClient');
    if (!isMicrosoftConnected(ctx.session)) return { error: ONEDRIVE_NOT_CONNECTED };
    const segments = path.split('/').filter(Boolean);
    if (!segments.length || segments.some((s) => s === '.' || s === '..')) return { error: `Not a usable OneDrive path: ${path}` };
    const target = segments.map(encodeURIComponent).join('/');
    let res;
    try {
        res = await graphRequest(`/me/drive/root:/${target}:/content?@microsoft.graph.conflictBehavior=rename`, ctx.session, {
            method: 'PUT', headers: { 'Content-Type': built.contentType }, body: built.buffer,
        });
    } catch (e) {
        if (e.message === 'NOT_CONNECTED') return { error: ONEDRIVE_NOT_CONNECTED };
        log.warn(`[OfficeFileDelivery] OneDrive upload failed: ${e.message}`);
        return { error: 'OneDrive upload failed' };
    }
    if (!res.ok) {
        let reason = '';
        try {
            reason = JSON.parse(await res.text()).error?.message || '';
        } catch (e) {
            // No JSON body: the status says enough.
            log.debug(`[OfficeFileDelivery] OneDrive error body not readable: ${e.message}`);
        }
        return { error: `OneDrive refused the upload (${res.status}${reason ? `: ${reason}` : ''})` };
    }
    const item = await res.json();
    const folder = segments.slice(0, -1).join('/');
    return { success: true, path: `/${folder ? `${folder}/` : ''}${item.name}`, name: item.name, fileId: item.id || null, webUrl: item.webUrl || null };
}

/**
 * Where the tool call asked the file to go, after the Nextcloud scope guard.
 * Returns { nextcloudPath?, nextcloudError?, oneDrivePath? } for buildAndDeliver.
 */
async function resolveDestinations(toolName, args, ctx, fileName) {
    const spec = FILE_TOOLS[toolName];
    const out = {};
    const ncPath = destinationPath(args.nextcloudPath, spec.ext, fileName);
    if (ncPath) {
        const ncScopeGuard = require('../core/integrations/ncScopeGuard');
        const denied = await ncScopeGuard.checkToolCall({ toolName: spec.ncTool, toolArgs: { path: ncPath }, userId: ctx.userId, orgId: ctx.orgId || null });
        if (denied) out.nextcloudError = denied.error || 'Nextcloud access was denied';
        else out.nextcloudPath = ncPath;
    }
    const odPath = destinationPath(args.oneDrivePath, spec.ext, fileName);
    if (odPath) out.oneDrivePath = odPath;
    return out;
}

/**
 * Build the file and hand it over. `ctx.nextcloudPath` / `ctx.oneDrivePath`
 * are resolved destinations (resolveDestinations); `ctx.nextcloudError` is a
 * scope-guard refusal to report. Whatever no destination took is kept in
 * storage behind a download link.
 *
 * @param {string} toolName  create_word_document | create_spreadsheet
 * @param {object} args      tool arguments
 * @param {{ userId: string, orgId?: string|null, session?: object, provider?: string,
 *   nextcloudPath?: string, nextcloudError?: string, oneDrivePath?: string }} ctx
 */
async function buildAndDeliver(toolName, args = {}, ctx = {}) {
    const spec = FILE_TOOLS[toolName];
    if (!spec) return { error: `Unknown file tool ${toolName}` };
    const userId = ctx.userId;
    if (!userId) return { error: `No user context for the ${spec.noun} tool.` };

    const built = await spec.build(args, ctx);
    if (built.error) return built;
    const extra = built.extra || {};
    const note = built.note || '';
    const fileCard = (fields) => ({ kind: spec.kind, mimeType: built.contentType, size: built.buffer.length, source: toolName, ...fields });

    const failures = [];
    if (ctx.nextcloudError) failures.push(`Nextcloud (${ctx.nextcloudError})`);
    if (ctx.nextcloudPath && !ctx.nextcloudError) {
        const path = ctx.nextcloudPath;
        const up = await uploadToNextcloud(built, ctx, path);
        if (!up.error) {
            const name = path.split('/').pop();
            return {
                ...up, filename: name, ...extra,
                file: fileCard({ name, path, webUrl: up.webUrl }),
                message: up.webUrl
                    ? `Saved ${path}${note}. Tell the user: [Open in Nextcloud Office](${up.webUrl}).`
                    : `Saved ${path}${note} to Nextcloud.`,
            };
        }
        failures.push(`Nextcloud (${up.error})`);
    }
    if (ctx.oneDrivePath) {
        const up = await uploadToOneDrive(built, ctx, ctx.oneDrivePath);
        if (!up.error) {
            return {
                ...up, filename: up.name, onedrive: true, ...extra,
                file: fileCard({ name: up.name, path: up.path, webUrl: up.webUrl }),
                message: `Saved ${up.path} to OneDrive${note}.` + (up.webUrl ? ` Tell the user: [Open in OneDrive](${up.webUrl}).` : ''),
            };
        }
        failures.push(`OneDrive (${up.error})`);
    }

    const storageStore = require('../stores/storageStore');
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) {
        return { error: failures.length
            ? `The ${spec.noun} could not be saved to ${failures.join(' or ')}, and file storage is not available on this server either.`
            : `File storage is not available on this server, so the ${spec.noun} cannot be kept. Ask an administrator to configure storage, or save it into OneDrive (oneDrivePath) or Nextcloud (nextcloudPath).` };
    }

    const stamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const key = storageStore.buildKey(userId, 'documents', `${stamp}_${built.filename}`);
    await storageStore.uploadFile(key, built.buffer, built.contentType);
    const downloadUrl = storageStore.buildProxyUrl(key);
    const ncFailure = failures.find((f) => f.startsWith('Nextcloud'));

    return {
        success: true,
        downloadUrl,
        filename: built.filename,
        size: built.buffer.length,
        ...extra,
        ...(ncFailure ? { nextcloud: { error: ncFailure.slice('Nextcloud ('.length, -1) } } : {}),
        // The card the chat shows under the reply, whatever the model writes.
        file: fileCard({ name: built.filename, url: downloadUrl }),
        message: `${spec.noun} "${built.title || built.filename}" built${note}.`
            + (failures.length ? ` It could NOT be saved to ${failures.join(' or ')} — tell the user.` : '')
            + ` Reply with the download link [${built.filename}](${downloadUrl}).`,
    };
}

/** The dispatcher's entry: resolve where the file goes, then build and deliver it. */
async function executeOfficeFileTool(toolName, args = {}, ctx = {}) {
    const spec = FILE_TOOLS[toolName];
    if (!spec) return { error: `Unknown file tool ${toolName}` };
    const fileName = toolName === 'create_word_document'
        ? require('./wordDocumentTools').safeWordFileName(args.fileName || args.title)
        : require('./spreadsheetTools').safeSpreadsheetFileName(args.fileName || args.title);
    const dest = await resolveDestinations(toolName, args || {}, ctx, fileName);
    return buildAndDeliver(toolName, args || {}, { ...ctx, ...dest });
}

module.exports = {
    officeFileToolDefinitions,
    isOfficeFileTool,
    executeOfficeFileTool,
    buildAndDeliver,
    destinationPath,
    uploadToOneDrive,
};
