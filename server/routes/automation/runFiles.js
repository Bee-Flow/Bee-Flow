// @typecheck
/**
 * The files a run produced, as the run page shows them:
 *
 *   GET /runs/:runId/files                   the list (the whole journey)
 *   GET /runs/:runId/files/:fileId           the bytes, as an attachment
 *   GET /runs/:runId/files/:fileId/preview   one page of a PDF as a PNG
 *
 * It reads the ledger `generate_document` steps write
 * (stores/automationStore/generatedFiles.js) and nothing else: no new bearer
 * path, no signed URL. The credential is the same one every other run read
 * uses (`runGuard(..., 'read')` plus `assertCanReadRunData`), and a file is only
 * ever looked up THROUGH the runs of the journey the caller may read, so an id
 * from another run, another automation or another organisation resolves to
 * nothing.
 *
 * Answers:
 *   404  the run does not exist, the caller has no role on its automation at
 *        all (another organisation, or nobody they were given), the file is not
 *        one of this journey's, it expired, or its bytes are gone. The reaper
 *        deletes blobs before rows, so a live row without bytes is a normal race.
 *   403  the caller is on the automation but may not read this run (a run-only
 *        caller looking at somebody else's run), or the run used the starter's
 *        own connections (`caller_run_private`).
 *
 * Downloads are attachments with `X-Content-Type-Options: nosniff`. `?inline=1`
 * is honoured for application/pdf and raster images only; anything else, and
 * SVG in particular (it can carry script), stays an attachment.
 *
 * Built by a factory so a test hands in its own store, storage and renderer.
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { sendStream } = require('../../core/http/sendStream');
const { contentDisposition } = require('../../core/http/contentDisposition');
const { makeAutomationAccess } = require('../../automation/access');
const { makeJourneyReader } = require('./runJourney');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');

/** Env cap: a positive number, with 0 meaning unlimited and unset/garbage meaning `fallback`. */
function capFromEnv(name, fallback) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Pages a preview may render (page N costs N renders: the renderer walks from
// page 1), and the largest PDF it will load into memory. 0 = unlimited.
const previewMaxPages = () => capFromEnv('AUTOMATION_RUN_FILE_PREVIEW_MAX_PAGES', 50);
const previewMaxBytes = () => capFromEnv('AUTOMATION_RUN_FILE_PREVIEW_MAX_BYTES', 50 * 1024 * 1024);
// Previews per user per minute. 0 = no limit.
const previewRpm = () => capFromEnv('AUTOMATION_RUN_FILE_PREVIEW_RPM', 120);

const baseType = (mime) => String(mime || '').split(';')[0].trim().toLowerCase();
const isPdf = (mime) => baseType(mime) === 'application/pdf';
/** Raster images only: an SVG opened on our origin could run script. */
const isInlineImage = (mime) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(baseType(mime));
const mayInline = (mime) => isPdf(mime) || isInlineImage(mime);

/** The list entry for one file: an explicit allow-list, never the row. */
function describeFile(f) {
    return {
        fileId: f.id,
        name: f.filename,
        mime: f.mimeType || 'application/octet-stream',
        size: f.size,
        stepId: f.stepId ?? null,
        createdAt: f.createdAt,
        expiresAt: f.expiresAt,
        previewable: isPdf(f.mimeType),
    };
}

/** Read a stream into a Buffer, refusing to hold more than `maxBytes` (0 = no limit). */
async function readCapped(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        total += chunk.length;
        if (maxBytes > 0 && total > maxBytes) {
            stream.destroy?.();
            throw new HttpError(413, 'run_file_too_large_to_preview', 'This file is too large to preview. Download it instead.');
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

/**
 * @param {object} [overrides]
 * @param {any}   [overrides.store]         automationStore surface (getRun, getRunsInChain, getAutomation, list/getGeneratedFile...)
 * @param {any}   [overrides.storage]       storageStore surface (streamFile)
 * @param {(id: string) => Promise<any>} [overrides.getUser]  user row
 * @param {(userId: string, permission: string, session?: any) => Promise<boolean>} [overrides.hasPermission]
 * @param {Function} [overrides.renderPdfPages] (buffer, opts) => { images, totalPages, truncated } | null
 */
function makeRunFilesRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const storage = () => overrides.storage || require('../../stores/storageStore');
    const renderPdfPages = (...args) => (overrides.renderPdfPages
        || require('../../core/documents/pdfToImages').renderPdfPagesToImages)(...args);
    const access = makeAutomationAccess({
        store: overrides.store,
        ...(overrides.getUser ? { getUser: overrides.getUser } : {}),
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });

    // The run, plus the journey legs the caller may read (routes/automation/runJourney.js).
    const journeyReader = makeJourneyReader({ store, access });
    const readableJourney = (req, res) => journeyReader(req, res, req.params.runId);

    /** The file row and its bytes, or a 404 for every way of not having them. */
    async function openFile(req, res) {
        const journey = await readableJourney(req, res);
        if (!journey) return null;
        const file = await store().getGeneratedFileForRuns(req.params.fileId, journey.runIds);
        if (!file || file.automationId !== journey.run.automationId) {
            throw new HttpError(404, 'run_file_not_found', 'Not found');
        }
        let streamed;
        try {
            streamed = await storage().streamFile(file.storageKey);
        } catch (e) {
            log.warn(`[automation/runFiles] generated file ${file.id} has no bytes: ${e.message}`);
            throw new HttpError(404, 'run_file_not_found', 'Not found');
        }
        return { file, streamed };
    }

    router.get('/runs/:runId/files', async (req, res) => {
        const journey = await readableJourney(req, res);
        if (!journey) return undefined;
        const files = await store().listGeneratedFilesForRuns(journey.runIds);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ files: files.filter(f => f.automationId === journey.run.automationId).map(describeFile) });
    });

    router.get('/runs/:runId/files/:fileId', async (req, res, next) => {
        const opened = await openFile(req, res);
        if (!opened) return undefined;
        const { file, streamed } = opened;

        const inline = req.query.inline === '1' && mayInline(file.mimeType);
        res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        const disposition = contentDisposition(file.filename);
        res.setHeader('Content-Disposition', inline ? disposition.replace(/^attachment/, 'inline') : disposition);
        // An inline image gets no script, no frames and no sub-resources; a PDF
        // keeps the browser's own viewer, which a sandbox directive would break.
        if (inline && !isPdf(file.mimeType)) res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        if (streamed.contentLength != null) res.setHeader('Content-Length', streamed.contentLength);
        return sendStream(streamed.stream, res, (e) => {
            log.error(`[automation/runFiles] download stream failed: ${e.message}`);
            next(e);
        });
    });

    const previewLimiter = previewRpm() > 0
        ? perUserRateLimit({ windowMs: 60_000, max: previewRpm() })
        : (_req, _res, next) => next();

    router.get('/runs/:runId/files/:fileId/preview', previewLimiter, async (req, res) => {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored with a bounded repeat {1,6}: linear
        const raw = req.query.page == null ? '1' : String(req.query.page);
        const page = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
        if (page < 1) throw new HttpError(400, 'invalid_page', 'page must be a positive whole number');
        const maxPages = previewMaxPages();
        if (maxPages > 0 && page > maxPages) {
            throw new HttpError(400, 'preview_page_out_of_range', `Only the first ${maxPages} pages can be previewed. Download the file to read the rest.`);
        }

        const opened = await openFile(req, res);
        if (!opened) return undefined;
        const { file, streamed } = opened;
        if (!isPdf(file.mimeType)) {
            streamed.stream.destroy?.();
            throw new HttpError(404, 'run_file_not_previewable', 'Not found');
        }
        const bytes = await readCapped(streamed.stream, previewMaxBytes());

        // The renderer walks pages 1..maxPages, so asking for N renders N
        // and keeps the last one.
        const rendered = await renderPdfPages(bytes, { maxPages: page, targetLongEdge: 1400, filename: file.filename });
        if (!rendered) throw new HttpError(503, 'preview_unavailable', 'A preview cannot be made right now. Download the file instead.');
        if (page > rendered.totalPages) throw new HttpError(404, 'preview_page_not_found', 'Not found');
        const image = rendered.images[page - 1];
        if (!image) throw new HttpError(404, 'preview_page_not_found', 'Not found');

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Preview-Total-Pages', String(rendered.totalPages));
        // The pager must not offer pages the cap refuses (0 = no cap, no header).
        if (maxPages > 0) res.setHeader('X-Preview-Max-Pages', String(maxPages));
        return res.send(Buffer.from(image.base64, 'base64'));
    });

    return router;
}

module.exports = { makeRunFilesRouter, describeFile, mayInline };
