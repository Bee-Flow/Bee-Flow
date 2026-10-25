// @typecheck
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');

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
            fallback('integrations/officeFileDelivery:uploadToOneDrive', e); // [OfficeFileDelivery] OneDrive error body not readable:
        }
        return { error: `OneDrive refused the upload (${res.status}${reason ? `: ${reason}` : ''})` };
    }
    const item = await res.json();
    const folder = segments.slice(0, -1).join('/');
    return { success: true, path: `/${folder ? `${folder}/` : ''}${item.name}`, name: item.name, fileId: item.id || null, webUrl: item.webUrl || null };
}

module.exports = { destinationPath, uploadToOneDrive };
