/**
 * OneDrive Routes — REST API for OneDrive integration UI
 *
 * Mirror of googleDrive.js for Microsoft 365 users.
 * Provides endpoints for the frontend file picker and browsing.
 *
 * /status reads nothing but the session, so it carries no schema.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requireAuth } = require('../../auth/permissions');
const { isMicrosoftConnected, graphFetch } = require('../../integrations/msGraphClient');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// `folderId` and `fileId` are CONCATENATED into the Graph path
// (`/me/drive/items/${folderId}/children?$top=…`), and both arrived
// unchecked: a value carrying a `/` or a `?` appended its own path segments
// and query parameters to the request this server makes on the caller's
// behalf. Both are pinned to the opaque id shape Graph actually mints.
//
// `top` was `Math.min(Math.max(parseInt(top) || 25, 1), 50)`, which already
// had both ends; the change is only that `?top=abc` now says so instead of
// quietly meaning 25. The ceiling stays a clamp.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

// Graph drive item ids are opaque and base64url-ish, sometimes with a `!`.
const ITEM_ID_RE = /^[A-Za-z0-9_!=.-]{1,512}$/;
const ITEM_ID_TEXT = 'That is not a OneDrive item id.';

const FilesQuery = z.object({
    folderId: worded(ITEM_ID_TEXT).regex(ITEM_ID_RE, ITEM_ID_TEXT).optional(),
    search: worded('search must be text.').optional(),
    top: z.coerce.number({ invalid_type_error: 'top must be a number.' })
        .int('top must be a whole number.')
        .min(1, 'top must be at least 1.')
        .optional(),
}).strict();

const ExportParams = z.object({
    fileId: worded(ITEM_ID_TEXT).regex(ITEM_ID_RE, ITEM_ID_TEXT),
}).strict();

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
    const isConnected = isMicrosoftConnected(req.session);
    log.info('[OneDrive] Status check — hasAccessToken:', !!req.session?.accessToken, 'oauthProvider:', req.session?.oauthProvider, 'connected:', isConnected);
    res.json({ connected: isConnected });
});

// ── List / Browse Files ─────────────────────────────────────────────────────
router.get('/files', requireAuth, validate({ query: FilesQuery }), async (req, res, next) => {
    if (!isMicrosoftConnected(req.session)) {
        return res.status(401).json({ error: 'Not connected to OneDrive' });
    }

    try {
        const { folderId, search, top = 25 } = req.query;
        const limit = Math.min(top, 50);

        let path;
        if (search) {
            path = `/me/drive/root/search(q='${encodeURIComponent(search)}')?$top=${limit}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl`;
        } else if (folderId) {
            path = `/me/drive/items/${folderId}/children?$top=${limit}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl&$orderby=name`;
        } else {
            path = `/me/drive/root/children?$top=${limit}&$select=id,name,file,folder,size,lastModifiedDateTime,createdBy,webUrl&$orderby=name`;
        }

        const data = await graphFetch(path, req.session);

        const items = (data.value || []).map(item => ({
            id: item.id,
            name: item.name,
            type: item.folder ? 'folder' : (item.file?.mimeType || 'file'),
            size: item.size || 0,
            lastModified: item.lastModifiedDateTime || '',
            createdBy: item.createdBy?.user?.displayName || '',
            webUrl: item.webUrl || '',
            isFolder: !!item.folder,
            childCount: item.folder?.childCount || 0,
        }));

        res.json({ items, total: items.length });

    } catch (err) {
        log.error('[OneDrive] Error listing files:', err.message);
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Microsoft session expired' });
        }
        next(err);
    }
});

// ── Get File Content / Download ─────────────────────────────────────────────
router.get('/export/:fileId', requireAuth, validate({ params: ExportParams }), async (req, res) => {
    if (!isMicrosoftConnected(req.session)) {
        return res.status(401).json({ error: 'Not connected to OneDrive' });
    }

    const { fileId } = req.params;

    // Get file metadata with download URL
    const item = await graphFetch(
        `/me/drive/items/${fileId}?$select=id,name,file,size,@microsoft.graph.downloadUrl`,
        req.session
    );

    if (!item['@microsoft.graph.downloadUrl']) {
        return res.status(400).json({ error: 'No download URL available for this item' });
    }

    // For text-based files, download and return content
    const textMimeTypes = [
        'text/plain', 'text/csv', 'text/html', 'text/markdown',
        'application/json', 'application/xml',
        'application/javascript',
    ];

    const mimeType = item.file?.mimeType || '';
    const isText = textMimeTypes.some(t => mimeType.startsWith(t));

    if (isText && item.size < 500000) {
        // Download and return text content
        const contentResponse = await fetch(item['@microsoft.graph.downloadUrl']);
        const text = await contentResponse.text();
        return res.json({
            id: item.id,
            name: item.name,
            mimeType,
            content: text,
            size: item.size,
        });
    }

    // For other files, return the download URL
    res.json({
        id: item.id,
        name: item.name,
        mimeType,
        downloadUrl: item['@microsoft.graph.downloadUrl'],
        size: item.size,
        message: 'Use the downloadUrl to access the file content',
    });
});

module.exports = router;
