'use strict';
/**
 * The media CMS-over-MCP tools (./dispatch.js maps tool names to them): the
 * asset library, one-time upload tickets, and budgeted screenshots.
 */

const { maxBytesFor } = require('../../core/cms/uploadPolicy');
const { EXT_BY_TYPE, assetUrlFor } = require('./uploadReceiver');
const { err } = require('./handlerKit');

const SHOT_WINDOW_MS = 10 * 60 * 1000;
const SHOT_MAX_PER_WINDOW = 24;
const UPLOAD_PATH = '/mcp/cms/upload';
const ASSET_LIST_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|vtt)$/i;

/** The asset library and upload tickets. */
function createAssetHandlers({ deps, resolveSite }) {
    async function listAssets(args, ctx) {
        const limit = Math.min(200, Math.max(1, Number.isInteger(args.limit) ? args.limit : 100));
        const search = typeof args.search === 'string' ? args.search.toLowerCase() : '';
        try {
            const keys = await deps.storage.listKeys('cms/');
            const assets = keys
                .filter((k) => ASSET_LIST_EXT_RE.test(k) && (!search || k.toLowerCase().includes(search)))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
                .slice(0, limit)
                .map((key) => ({ key, url: assetUrlFor(key), ...(ctx.baseUrl ? { absoluteUrl: `${ctx.baseUrl}${assetUrlFor(key)}` } : {}) }));
            return { result: { assets } };
        } catch (_) {
            return { result: { assets: [], unavailable: true, note: 'The asset library cannot be listed on this installation (no object storage).' } };
        }
    }

    async function requestUpload(args, ctx) {
        // A legacy token cannot be re-checked as finely when the PUT arrives (no id,
        // no scopes of its own), so it gets no upload URLs at all.
        if (ctx.token?.legacy === true) {
            return err('Uploads need a named MCP token. Create one in Settings → Security → MCP tokens (with the cms server at write level) and connect with it.');
        }
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const contentType = String(args.contentType || '').split(';')[0].trim().toLowerCase();
        const cap = maxBytesFor(contentType);
        if (cap === null) {
            return err(`${contentType || 'That content type'} is not accepted.`, { _fixHint: `Allowed: ${Object.keys(EXT_BY_TYPE).join(', ')}.` });
        }
        if (!Number.isInteger(args.size) || args.size < 1) return err('size must be the file size in bytes (a positive whole number).');
        if (args.size > cap) {
            return err(`${contentType} files can be at most ${Math.round(cap / 1048576)} MB here; this one is ${(args.size / 1048576).toFixed(1)} MB.`, {
                _fixHint: contentType.startsWith('image/') ? 'Downscale or recompress the image before uploading.' : 'Shorten or recompress the file before uploading.',
            });
        }
        const filename = String(args.filename || '').trim();
        if (!filename || filename.length > 200) return err('filename must be the name of the file (1-200 characters).');
        if (!deps.storage.isAvailable()) return err('Asset storage is not available on this server, so nothing can be uploaded.');

        let issued;
        try {
            issued = await deps.tickets.issue({
                userId: ctx.userId, orgId: ctx.orgId, tokenId: ctx.token.id || null, legacy: false, siteId: site.siteId, contentType, maxSize: args.size, filename,
            });
        } catch (e) {
            if (e?.code === 'too_many_open_tickets') return err(e.message);
            throw e;
        }
        const { ticketId, secret, expiresAt } = issued;
        // The URL carries only the public ticket id; the secret travels in a header
        // so it never lands in a proxy access log or a trace URL.
        const path = `${UPLOAD_PATH}/${ticketId}`;
        const url = ctx.baseUrl ? `${ctx.baseUrl}${path}` : path;
        const shownName = filename.replace(/[^A-Za-z0-9._-]/g, '_');
        return {
            result: {
                ticketId,
                uploadUrl: url,
                expiresAt,
                contentType,
                maxBytes: args.size,
                uploadHeaders: { 'Content-Type': contentType, 'X-Upload-Ticket': secret },
                curl: `curl -fS -T '<path/to/${shownName}>' -H 'Content-Type: ${contentType}' -H 'X-Upload-Ticket: ${secret}' '${url}'`,
                next: 'Run the curl command in a shell with the real path of the file. It prints JSON with the asset `url`; put that url in the block. The URL works once; if it fails, call cms_request_upload again.',
                ...(ctx.baseUrl ? {} : { note: 'The public address of this server is not configured, so the URL above is relative: prefix it with the address you reach this MCP endpoint on.' }),
            },
        };
    }

    async function uploadStatus(args, ctx) {
        const status = await deps.tickets.status(String(args.ticketId || ''), ctx.userId);
        if (!status) return err('No upload with that ticketId for this user. Check the id from cms_request_upload.');
        return { result: status };
    }

    return { listAssets, requestUpload, uploadStatus };
}

/** Screenshots of a draft or published page, under a per-user budget. */
function createScreenshotHandler({ deps, resolveSite, takeBudget, shotBudget }) {
    const takeScreenshotBudget = (userId) => takeBudget(shotBudget, userId, SHOT_MAX_PER_WINDOW, SHOT_WINDOW_MS);

    async function screenshot(args, ctx) {
        if (!takeScreenshotBudget(ctx.userId)) {
            return { result: { note: 'Screenshot budget spent' }, text: `Screenshot budget spent (${SHOT_MAX_PER_WINDOW} per ${SHOT_WINDOW_MS / 60000} minutes); each one is a headless browser page. Keep editing and take the next one when the budget refills.` };
        }
        const site = await resolveSite(args);
        if (site.error) return err(site.error);
        const shot = await deps.screenshots.render({
            siteId: site.siteId,
            pageId: args.pageId,
            slug: args.slug,
            postSlug: typeof args.postSlug === 'string' ? args.postSlug : undefined,
            blog: args.blog === true,
            state: args.state,
            locale: args.locale,
            viewport: args.viewport,
            fullPage: args.fullPage === true,
            offsetY: Number.isInteger(args.offsetY) ? args.offsetY : 0,
        });
        if (!shot.ok) {
            const text = `Screenshot unavailable: ${shot.reason}`;
            return { result: { unavailable: true, reason: shot.reason }, text };
        }
        return {
            result: { siteId: site.siteId, rendering: shot.rendering, path: shot.path, pageHeight: shot.pageHeight },
            text: shot.text,
            image: { data: shot.image.data, mimeType: shot.image.mimeType },
        };
    }

    return { screenshot };
}

module.exports = { createAssetHandlers, createScreenshotHandler, SHOT_WINDOW_MS, SHOT_MAX_PER_WINDOW };
