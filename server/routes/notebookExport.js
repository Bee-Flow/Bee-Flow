/**
 * Notebook Export Routes — server-side PDF (Playwright) & DOCX generation.
 *
 * POST /api/notebooks/:id/export/pdf   — render HTML → PDF via headless Chromium
 * POST /api/notebooks/:id/export/docx  — convert HTML → native .docx
 *
 * Both endpoints expect { content: "<html>", title: "..." } in the request body.
 * Images should already be embedded as base64 data URIs by the client.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * One `.strict()` zod schema per route, checked after the ownership check (a
 * notebook that is not yours is a 404 whatever the body says). What it closed:
 *
 *   - A `title` that was not text (`null` from a notebook without a name, a
 *     number) passed straight to `title.replace` AFTER the Chromium render:
 *     the PDF was built, then thrown away with a 500. A missing, empty or
 *     null title is "Notebook" now, and anything else that is not text is a
 *     400 before any rendering.
 *   - A signer's misspelled key (`frist_name`) was dropped, and SignRequest
 *     mailed the signer without a name under a 200; `signers: "a@b.nl"` has a
 *     length, passed the "at least one" check, and failed after the render.
 *     Each signer is now `{ email, first_name?, last_name?, order? }`, the
 *     address trimmed and checked. The web form sends the address untrimmed.
 *   - `houseStyleId` naming a style that does not exist (deleted, or another
 *     organisation's) exported the document with NO style, not even the
 *     org's default, under a 200. It is a 404 now. No client sends the key
 *     today; `'none'` still means "no style" and leaving it out still means
 *     "the org's default".
 *   - A Nextcloud `folder` with a `.` or `..` segment was walked as given:
 *     the URL parser folded it into a path outside the user's files, and the
 *     answer was a 502 "Upload failed" (or a `path` in the answer that was
 *     not where anything went). Refused by name now.
 */

const express = require('express');
const { z } = require('zod');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { buildExportHTML, cleanContentForExport } = require('../templates/exportTemplate');
const { resolveHouseStyle, buildDocxStylingFromHouseStyle, applyInlineStyles, NO_SUCH_STYLE } = require('../core/documents/docxHouseStyle');
const notebookStore = require('../stores/notebookStore');
const userStore = require('../stores/userStore');
const browserProvider = require('../services/browserProvider');
const { HttpError } = require('../core/http/errors');
const NOTEBOOK_TEXT = require('../i18n/defaults/en/notebooks');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

/**
 * Every export route must own the notebook in `:id`.
 *
 * These routes previously used `:id` only in a log line — the HTML came from
 * the request body — so any authenticated user could drive a server-side
 * Chromium render, a DOCX build, a SignRequest send or a Nextcloud upload
 * against an arbitrary id. The content is still supplied by the client (it
 * pre-renders mermaid to PNG and inlines images before sending), so this check
 * is what ties an export to a real, owned document.
 */
async function requireNotebookOwner(req, res, next) {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const nb = await notebookStore.getNotebook(req.params.id, userId);
        if (!nb) {
            log.warn('[Export] refused export for a notebook the caller does not own:', { notebookId: req.params.id, userId });
            return res.status(404).json({ error: 'Notebook not found' });
        }
        req.notebook = nb;
        next();
    } catch (err) {
        log.error('[Export] ownership check failed:', err);
        res.status(500).json({ error: 'Export failed' });
    }
}

// ── Request schemas (see the header) ────────────────────────────────

/** A string whose every refusal, including "you left it out", is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const CONTENT_TEXT = 'An export needs the notebook content as HTML.';
const TITLE_TEXT = 'A title must be text.';
const exportFields = {
    content: worded(CONTENT_TEXT).min(1, CONTENT_TEXT),
    // A notebook without a name sends no title (or null): that is "Notebook".
    title: worded(TITLE_TEXT).max(300, 'A title is at most 300 characters.').nullish()
        .transform((v) => (v && v.trim()) || 'Notebook'),
};

const PdfBody = z.object(exportFields).strict();

const DocxBody = z.object({
    ...exportFields,
    // 'none' = no style; absent = the org's default; anything else = that style.
    houseStyleId: worded('houseStyleId names a house style, or none.').trim().min(1, 'houseStyleId names a house style, or none.').optional(),
}).strict();

const EMAIL_TEXT = 'Each signer needs a valid email address.';
const Signer = z.object({
    email: worded(EMAIL_TEXT).trim().email(EMAIL_TEXT),
    first_name: worded('A first name must be text.').trim().max(100, 'A first name is at most 100 characters.').optional(),
    last_name: worded('A last name must be text.').trim().max(100, 'A last name is at most 100 characters.').optional(),
    order: z.number({ invalid_type_error: 'A signing order is a whole number.' }).int('A signing order is a whole number.').min(0).optional(),
}, { invalid_type_error: 'Each signer is an object with an email address.' }).strict();

const SIGNERS_TEXT = 'At least one signer is required.';
const SignRequestBody = z.object({
    ...exportFields,
    signers: z.array(Signer, { required_error: SIGNERS_TEXT, invalid_type_error: SIGNERS_TEXT }).min(1, SIGNERS_TEXT),
    // The web form sends '' for an untouched field; that means "SignRequest's default".
    subject: worded('An email subject must be text.').max(500, 'An email subject is at most 500 characters.').optional(),
    message: worded('A message must be text.').max(5000, 'A message is at most 5000 characters.').optional(),
}).strict();

const FOLDER_TEXT = 'A folder is a path like /BeeFlow/Notebooks, without . or .. in it.';
const NextcloudBody = z.object({
    ...exportFields,
    folder: worded(FOLDER_TEXT).max(500, 'A folder path is at most 500 characters.')
        .refine((v) => v.split('/').every((seg) => seg !== '.' && seg !== '..'), FOLDER_TEXT)
        .nullish(),
}).strict();

// Pull the user's org id from session/user record. Returns null when unknown.
async function userOrgId(req) {
    const u = req.session?.user;
    if (u?.organizationId) return u.organizationId;
    if (!u?.id) return null;
    try {
        const full = await userStore.getUser(u.id);
        return full?.organizationId || null;
    } catch (_) {
        return null;
    }
}

// ── PDF Export (remote headless Chromium via browserProvider) ────────────────

/**
 * What an export route does with a failure. The backend's own words (docker
 * socket paths, ENOENT, env var names) are for the operator and go to the log
 * only; they used to be concatenated into the answer the end user saw. A
 * missing or unreachable browser is a 503 with a sentence the user can act on
 * (the client translates it by its code); anything else is the terminal
 * handler's generic 500 with a correlation id.
 */
function exportFailure(what, err, next) {
    log.error(`[Export] ${what} failed:`, err);
    if (err instanceof HttpError) return next(err);
    if (browserProvider.isBackendUnavailable(err)) {
        return next(new HttpError(503, 'pdf_renderer_unavailable', NOTEBOOK_TEXT['notebooks.pdf_renderer_unavailable']));
    }
    return next(err);
}

/**
 * Render fully-inlined export HTML (base64 images already embedded) to a Letter
 * PDF on the shared remote browser. Waits for Google Fonts + Mermaid diagrams to
 * settle before printing. Shared by the pdf / signrequest / nextcloud routes.
 */
async function renderNotebookPdf(exportHTML, { title = 'Notebook' } = {}) {
    const safeTitle = String(title).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    return browserProvider.withContext({}, async (context) => {
        const page = await context.newPage();
        // Set content (base64 images are already embedded)
        await page.setContent(exportHTML, { waitUntil: 'networkidle' });
        // Wait for Google Fonts + Mermaid diagrams to render
        await page.waitForTimeout(1500);
        // Wait for mermaid diagrams to finish rendering (if any exist)
        try {
            await page.waitForFunction(
                () => document.querySelectorAll('div[data-type="mermaid-diagram"]').length === 0,
                { timeout: 10000 });
        } catch {
            // If mermaid rendering takes too long, continue with PDF anyway
            log.warn('[Export] Mermaid rendering timed out, proceeding with PDF');
        }
        return page.pdf({
            format: 'Letter',
            margin: { top: '0.75in', right: '0.85in', bottom: '0.9in', left: '0.85in' },
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: `<div style="font-size: 8px; color: #999; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;"><span>${safeTitle}</span><span></span></div>`,
            footerTemplate: `<div style="font-size: 8px; color: #bbb; width: 100%; padding: 0 0.85in; display: flex; justify-content: space-between;"><span>Generated by Bee Flow</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
        });
    });
}

router.post('/:id/export/pdf', requireAuth, requireNotebookOwner, validate({ body: PdfBody }), async (req, res, next) => {
    const { content, title } = req.body;

    const author = req.session.user.name || req.session.user.email || '';

    try {
        log.info(`[Export] Starting PDF export for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        // Clean and wrap content in professional template
        const cleanedContent = cleanContentForExport(content);
        const exportHTML = buildExportHTML(cleanedContent, { title, author });

        const pdfBuffer = await renderNotebookPdf(exportHTML, { title });

        const duration = Date.now() - startTime;
        log.info(`[Export] PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

        // Send PDF response
        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

    } catch (err) {
        exportFailure('PDF generation', err, next);
    }
});

// ── DOCX Export (html-to-docx) ──────────────────────────────────────────────

router.post('/:id/export/docx', requireAuth, requireNotebookOwner, validate({ body: DocxBody }), async (req, res, next) => {
    const { content, title, houseStyleId } = req.body;

    try {
        log.info(`[Export] Starting DOCX export for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        let HTMLtoDOCX;
        try {
            HTMLtoDOCX = require('html-to-docx');
            // Handle both default and named exports
            if (HTMLtoDOCX.default) HTMLtoDOCX = HTMLtoDOCX.default;
        } catch (e) {
            return res.status(500).json({ error: 'html-to-docx not installed. Run: npm install html-to-docx' });
        }

        // Resolve which house style to apply (explicit id, org default, or none).
        const houseStyle = await resolveHouseStyle(await userOrgId(req), houseStyleId);
        if (houseStyle === NO_SUCH_STYLE) {
            return res.status(404).json({ error: 'That house style does not exist in your organisation.' });
        }
        const { css, opts: styleOpts, inline: inlineStyles } = buildDocxStylingFromHouseStyle(houseStyle);
        if (houseStyle) log.info(`[Export] Applying house style "${houseStyle.name}" (${houseStyle.id})`);

        // Clean content for Word export
        const cleanedContent = cleanContentForExport(content);

        // Debug: log font-family spans in input vs cleaned
        const inputFontMatches = (content.match(/font-family/gi) || []).length;
        const cleanedFontMatches = (cleanedContent.match(/font-family/gi) || []).length;
        log.info(`[Export] DOCX font-family spans: input=${inputFontMatches}, afterClean=${cleanedFontMatches}`);
        if (inputFontMatches > 0) {
            // Log a sample span for debugging
            const sampleMatch = content.match(/<span[^>]*style="[^"]*font-family[^"]*"[^>]*>[^<]{0,50}/i);
            log.info(`[Export] Sample font span:`, sampleMatch?.[0] || 'none found');
        }

        // Wrap in a minimal HTML structure that html-to-docx expects. It does
        // not read the <style> block: the heading fonts, sizes and colours go
        // onto the tags inline (applyInlineStyles).
        const htmlForDocx = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
    ${applyInlineStyles(cleanedContent, inlineStyles)}
</body>
</html>`;

        // html-to-docx takes the header and footer HTML as POSITIONAL
        // arguments (html, header, options, footer); passed as option keys
        // they were silently ignored and the house style's header and footer
        // text never reached the file.
        const { headerHTML = null, footerHTML = null, ...docxStyleOpts } = styleOpts;
        const docxBuffer = await HTMLtoDOCX(htmlForDocx, headerHTML, {
            table: { row: { cantSplit: true } },
            footer: true,
            pageNumber: true,
            title: title,
            ...docxStyleOpts,
        }, footerHTML);

        const duration = Date.now() - startTime;
        const buffer = Buffer.from(docxBuffer);
        log.info(`[Export] DOCX generated: ${(buffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.docx"`);
        res.setHeader('Content-Length', buffer.length);
        res.send(buffer);

    } catch (err) {
        exportFailure('DOCX generation', err, next);
    }
});

// ── SignRequest Export (PDF → e-Signature) ──────────────────────────────────

router.post('/:id/export/signrequest', requireAuth, requireNotebookOwner, validate({ body: SignRequestBody }), async (req, res, next) => {
    const { content, title, signers, subject, message } = req.body;

    const userId = req.session.user.id;
    const author = req.session.user.name || req.session.user.email || '';

    try {
        log.info(`[Export] Starting SignRequest PDF export for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        // Clean and wrap content in professional template
        const cleanedContent = cleanContentForExport(content);
        const exportHTML = buildExportHTML(cleanedContent, { title, author });

        const pdfBuffer = await renderNotebookPdf(exportHTML, { title });

        const pdfDuration = Date.now() - startTime;
        log.info(`[Export] PDF for SignRequest: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${pdfDuration}ms`);

        // Convert to base64 and send to SignRequest
        const pdfBase64 = pdfBuffer.toString('base64');
        const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';

        const { sendPdfForSigning } = require('../integrations/signrequestTools');
        const result = await sendPdfForSigning(userId, {
            pdfBase64,
            fileName: `${safeFilename}.pdf`,
            signers,
            subject,
            message,
        });

        log.info(`[Export] SignRequest sent successfully for notebook ${req.params.id}`);

        res.json({
            success: true,
            message: `Document sent for signing to ${signers.length} signer(s).`,
            documentUuid: result?.document?.uuid,
            signrequestUuid: result?.uuid,
            status: result?.document?.status,
            signers: result?.signers?.map(s => ({
                email: s.email,
                name: [s.first_name, s.last_name].filter(Boolean).join(' '),
                status: s.status_display || s.status,
            })),
        });

    } catch (err) {
        if (err && err.code === 'signrequest_not_configured') {
            log.warn('[Export] SignRequest export refused: not configured for this user');
            return next(new HttpError(400, err.code, err.message));
        }
        exportFailure('SignRequest export', err, next);
    }
});

// ── Nextcloud Export (PDF → WebDAV upload) ──────────────────────────────────

router.post('/:id/export/nextcloud', requireAuth, requireNotebookOwner, validate({ body: NextcloudBody }), async (req, res, next) => {
    const { content, title, folder } = req.body;

    const userId = req.session.user.id;
    const author = req.session.user.name || req.session.user.email || '';

    // Resolve Nextcloud credentials up front so we don't burn time rendering a
    // PDF only to fail at upload.
    const configStore = require('../stores/configStore');
    const userStore = require('../stores/userStore');

    const oauth = (await configStore.getConfig('oauth')) || {};
    const nextcloudUrl = (oauth.nextcloudUrl || '').replace(/\/+$/, '');
    if (!nextcloudUrl) return res.status(400).json({ error: 'Nextcloud URL not configured (admin → authentication).' });

    const creds = await userStore.getAppPassword(userId);
    if (!creds?.username || !creds?.password) {
        return res.status(400).json({ error: 'Nextcloud not connected. Add your username and app password in Settings → Connections.' });
    }

    try {
        log.info(`[Export] Starting Nextcloud upload for notebook ${req.params.id}: "${title}"`);
        const startTime = Date.now();

        const cleanedContent = cleanContentForExport(content);
        const exportHTML = buildExportHTML(cleanedContent, { title, author });

        const pdfBuffer = await renderNotebookPdf(exportHTML, { title });

        log.info(`[Export] PDF rendered for Nextcloud upload: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${Date.now() - startTime}ms`);

        // ── Upload via WebDAV ──
        const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
        const davRoot = `${nextcloudUrl}/remote.php/dav/files/${encodeURIComponent(creds.username)}`;

        // Ensure parent folder(s) exist. Nextcloud MKCOL only creates one level
        // at a time, so we walk the path and ignore "already exists" (405).
        const targetFolderRaw = (folder || '/BeeFlow/Notebooks').replace(/^\/+|\/+$/g, '');
        const folderSegments = targetFolderRaw.split('/').filter(Boolean);
        let walked = '';
        for (const seg of folderSegments) {
            walked += '/' + encodeURIComponent(seg);
            const mkRes = await fetch(`${davRoot}${walked}`, {
                method: 'MKCOL',
                headers: { 'Authorization': auth },
                signal: AbortSignal.timeout(15000),
            });
            if (mkRes.status === 401) return res.status(502).json({ error: 'Nextcloud rejected credentials. Re-save your app password.' });
            if (mkRes.status !== 201 && mkRes.status !== 405 /* already exists */) {
                const text = await mkRes.text().catch(() => '');
                log.warn(`[Export/Nextcloud] MKCOL ${walked} returned ${mkRes.status}: ${text.slice(0, 200)}`);
            }
        }

        // Avoid clobbering: if a file with the same name already exists, append a
        // timestamp suffix so users can keep multiple revisions.
        const safeBase = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'notebook';
        const fileName = `${safeBase}.pdf`;
        const targetUrl = `${davRoot}${walked}/${encodeURIComponent(fileName)}`;

        const headRes = await fetch(targetUrl, { method: 'HEAD', headers: { 'Authorization': auth }, signal: AbortSignal.timeout(10000) });
        let finalUrl = targetUrl;
        let finalName = fileName;
        if (headRes.status === 200) {
            const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
            finalName = `${safeBase} (${stamp}).pdf`;
            finalUrl = `${davRoot}${walked}/${encodeURIComponent(finalName)}`;
        }

        const putRes = await fetch(finalUrl, {
            method: 'PUT',
            headers: { 'Authorization': auth, 'Content-Type': 'application/pdf' },
            body: pdfBuffer,
            signal: AbortSignal.timeout(60000),
        });

        if (putRes.status === 401) return res.status(502).json({ error: 'Nextcloud rejected credentials.' });
        if (putRes.status !== 201 && putRes.status !== 204) {
            const text = await putRes.text().catch(() => '');
            return res.status(502).json({ error: `Upload failed (${putRes.status}): ${text.slice(0, 200)}` });
        }

        const relativePath = `/${targetFolderRaw}/${finalName}`;
        const browserUrl = `${nextcloudUrl}/apps/files/?dir=${encodeURIComponent('/' + targetFolderRaw)}`;
        log.info(`[Export] Uploaded to Nextcloud: ${relativePath}`);

        return res.json({
            success: true,
            path: relativePath,
            fileName: finalName,
            size: pdfBuffer.length,
            folderUrl: browserUrl,
        });

    } catch (err) {
        exportFailure('Nextcloud upload', err, next);
    }
});

module.exports = router;
