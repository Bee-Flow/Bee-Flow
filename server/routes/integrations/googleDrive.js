/**
 * Google Drive Integration Routes
 * 
 * Provides endpoints for browsing and exporting Google Drive files
 * (Docs, Sheets, Slides) for use as chat attachments.
 * 
 * Uses the official `googleapis` SDK with per-user OAuth2 tokens.
 *
 * /status reads nothing but the session, so it carries no schema.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
require('googleapis');
const { loadConfig, requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// `?query=` is spliced into a Drive search expression, so it is escaped
// rather than merely interpolated — see driveLiteral below, whose escape had
// a hole. `pageSize` was `Math.min(parseInt(pageSize) || 20, 50)`: a ceiling
// with no floor, so `?pageSize=-5` went to the Drive API as a negative page
// size and `?pageSize=abc` silently meant 20. The ceiling stays a clamp.
//
// The picker (agent-hub hooks/useGoogleWorkspacePicker.ts) sends exactly
// query/pageToken/pageSize, which is why the key set is `.strict()`.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const FILE_ID_TEXT = 'That is not a Google Drive file id.';

const FilesQuery = z.object({
    query: worded('query must be text.').optional(),
    pageToken: worded('pageToken must be text.').optional(),
    pageSize: z.coerce.number({ invalid_type_error: 'pageSize must be a number.' })
        .int('pageSize must be a whole number.')
        .min(1, 'pageSize must be at least 1.')
        .optional(),
}).strict();

const ExportParams = z.object({
    fileId: worded(FILE_ID_TEXT).regex(/^[A-Za-z0-9_-]{1,128}$/, FILE_ID_TEXT),
}).strict();

/**
 * Escape a caller's search text for a Drive `name contains '…'` literal.
 *
 * The BACKSLASH has to be escaped first. The old expression escaped only the
 * quote, so a search text ending in a backslash kept it, and the quote this
 * route appends then read as an ESCAPED quote. The literal closed early and
 * everything after it in the caller's text was read as Drive query syntax,
 * which is enough to step outside the
 * `(<workspace mime types>) and trashed=false` prefix the listing is pinned
 * to.
 */
const driveLiteral = (text) => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// MIME types for Google Workspace files
const WORKSPACE_MIME_TYPES = {
    'application/vnd.google-apps.document': { name: 'Google Doc', icon: '📄', exportMime: 'text/plain' },
    'application/vnd.google-apps.spreadsheet': { name: 'Google Sheet', icon: '📊', exportMime: 'text/csv' },
    'application/vnd.google-apps.presentation': { name: 'Google Slides', icon: '📽️', exportMime: 'text/plain' },
};

const WORKSPACE_QUERY = Object.keys(WORKSPACE_MIME_TYPES)
    .map(m => `mimeType='${m}'`)
    .join(' or ');

/**
 * Create an authenticated Google Drive client from session tokens.
 */
async function createDriveClient(req) {
    const { createGoogleApiClient } = require('../../integrations/googleClient');
    return createGoogleApiClient(req.session, {
        api: 'drive', version: 'v3',
        notConnectedError: 'NOT_CONNECTED',
        notConfiguredError: 'Google OAuth not configured. Set up Google SSO in Admin → Security.',
    });
}

// ─── Status Check ────────────────────────────────────────────────

// requireAuth — see the note on gmail.js's /status.
router.get('/status', requireAuth, async (req, res) => {
    const isConnected = !!(req.session?.accessToken && req.session?.oauthProvider === 'google');
    const config = await loadConfig();
    const isConfigured = !!(config.providers?.google?.clientId && config.providers?.google?.clientSecret);

    log.info('[GoogleDrive] Status check — hasAccessToken:', !!req.session?.accessToken, 'oauthProvider:', req.session?.oauthProvider, 'connected:', isConnected);

    res.json({
        connected: isConnected,
        configured: isConfigured,
        user: isConnected ? req.session.user : null,
    });
});

// ─── List / Search Files ─────────────────────────────────────────

router.get('/files', validate({ query: FilesQuery }), async (req, res, next) => {
    try {
        const drive = await createDriveClient(req);
        const { query, pageToken, pageSize = 20 } = req.query;

        // Build the query
        let q = `(${WORKSPACE_QUERY}) and trashed=false`;
        if (query) {
            q += ` and name contains '${driveLiteral(query)}'`;
        }

        const response = await drive.files.list({
            q,
            pageSize: Math.min(pageSize, 50),
            pageToken: pageToken || undefined,
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, iconLink, owners, size)',
            orderBy: 'modifiedTime desc',
        });

        const files = (response.data.files || []).map(f => ({
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            type: WORKSPACE_MIME_TYPES[f.mimeType]?.name || 'File',
            icon: WORKSPACE_MIME_TYPES[f.mimeType]?.icon || '📄',
            modifiedTime: f.modifiedTime,
            owner: f.owners?.[0]?.displayName || '',
        }));

        res.json({
            files,
            nextPageToken: response.data.nextPageToken || null,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Google Drive', code: 'NOT_CONNECTED' });
        }
        log.error('[GoogleDrive] List files error:', err.message);
        next(err);
    }
});

// ─── Export File Content ─────────────────────────────────────────

router.get('/export/:fileId', validate({ params: ExportParams }), async (req, res, next) => {
    try {
        const drive = await createDriveClient(req);
        const { fileId } = req.params;

        // Get file metadata first
        const meta = await drive.files.get({
            fileId,
            fields: 'id, name, mimeType',
        });

        const mimeType = meta.data.mimeType;
        const exportConfig = WORKSPACE_MIME_TYPES[mimeType];

        if (!exportConfig) {
            return res.status(400).json({ error: `Unsupported file type: ${mimeType}` });
        }

        // Export the file content
        const exported = await drive.files.export({
            fileId,
            mimeType: exportConfig.exportMime,
        }, { responseType: 'text' });

        const content = typeof exported.data === 'string'
            ? exported.data
            : JSON.stringify(exported.data);

        // Truncate very large files
        const MAX_CHARS = 100000; // ~100k chars
        const truncated = content.length > MAX_CHARS;
        const finalContent = truncated
            ? content.substring(0, MAX_CHARS) + '\n\n[... truncated, file too large ...]'
            : content;

        res.json({
            id: meta.data.id,
            name: meta.data.name,
            mimeType: mimeType,
            type: exportConfig.name,
            content: finalContent,
            truncated,
            charCount: content.length,
        });
    } catch (err) {
        if (err.message === 'NOT_CONNECTED') {
            return res.status(401).json({ error: 'Not connected to Google Drive', code: 'NOT_CONNECTED' });
        }
        log.error('[GoogleDrive] Export error:', err.message);
        next(err);
    }
});

module.exports = router;
