/**
 * Webpage Export — server-side PDF rendering of a webpage via Playwright.
 *
 * POST /api/webpages/:id/export/pdf — composes the same inlined HTML the
 *   in-app preview uses (style + script inlined into the document) and
 *   pipes it through headless Chromium to a PDF.
 *
 * The composition mirrors the frontend `composeWebpageDocument` util — see
 * agent-hub/src/utils/composeWebpageDocument.js. The downloaded zip flow uses
 * a different composition (external <link> + <script> refs); see
 * agent-hub/src/utils/downloadWebpageZip.js.
 *
 * The body is pinned EMPTY. The render has one fixed layout (Letter, no
 * margins, backgrounds on), so `{ format: 'A4' }` or `{ landscape: true }` is
 * a caller that believes it is choosing one — and was answered with a 200 and
 * a Letter-sized PDF.
 *
 * A failed render ends at the terminal error handler like every other route
 * error: logged in full, answered with a generic sentence and a correlation
 * id. It used to answer `'PDF generation failed: ' + err.message`, which put
 * the browser backend's own words — docker socket, endpoint, env var names —
 * in front of whoever pressed Export.
 */

const express = require('express');
const log = require('../telemetry/log');
const { validate } = require('../core/http/validate');
const { z } = require('zod');
const router = express.Router();

const WHY = 'the PDF is rendered from the saved page, in one fixed layout.';

/**
 * No body at all (Express 5 leaves `req.body` undefined then), or an empty
 * one. Every refusal is a sentence that names the keys it would have ignored.
 */
const NoBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({}, {
        errorMap: (issue) => ({
            message: issue.code === 'unrecognized_keys'
                ? `This request takes no body, so ${issue.keys.map((k) => `'${k}'`).join(', ')} would change nothing: ${WHY}`
                : `This request takes no body: ${WHY}`,
        }),
    }).strict(),
);

const webpageStore = require('../stores/webpageStore');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

/**
 * Compose a complete HTML document from the three slots, inlining the CSS
 * and JS. Mirrors the frontend `composeWebpageDocument.js` util.
 */
function composeInlinedHtml({ html, css, js }) {
    const safeHtml = html && html.trim() ? html : '<!DOCTYPE html><html><head></head><body></body></html>';
    const styleTag = css ? `<style>\n${css}\n</style>` : '';
    const scriptTag = js ? `<script>\n${js}\n<\/script>` : '';

    if (/<head[^>]*>/i.test(safeHtml)) {
        let out = safeHtml.replace(/<head([^>]*)>/i, `<head$1>\n${styleTag}`);
        if (/<\/body>/i.test(out)) {
            out = out.replace(/<\/body>/i, `${scriptTag}\n</body>`);
        } else {
            out += scriptTag;
        }
        return out;
    }
    return `<!DOCTYPE html><html><head>${styleTag}</head><body>${safeHtml}${scriptTag}</body></html>`;
}

const browserProvider = require('../services/browserProvider');

router.post('/:id/export/pdf', requireAuth, validate({ body: NoBody }), require('../compliance/dataPortability/stampExport')('ai_webpages'), async (req, res) => {
    const userId = req.session.user.id;
    const id = req.params.id;

    const wp = await webpageStore.getWebpage(id, userId);
    if (!wp) return res.status(404).json({ error: 'Webpage not found' });

    // PDF export inlines only the three primary slots. A react-mui project's
    // app lives in src/*.jsx extras and needs the in-browser esbuild build,
    // so it would render blank here — refuse with a clear message rather
    // than ship an empty PDF. (Supported once the server-side react bundle
    // path lands — see the refactor plan, WS-C/WS-G.)
    const { resolveFramework } = require('../integrations/webpageFramework');
    if (resolveFramework(wp) === 'react-mui') {
        return res.status(400).json({ error: 'PDF export is not available for React + Material UI pages yet. Use Download ZIP to export the app instead.' });
    }

    const files = await webpageStore.readAllSlots(userId, id);
    const exportHTML = composeInlinedHtml(files);
    const title = wp.name || 'Webpage';

    log.info(`[WebpageExport] Starting PDF export for "${title}"`);
    const startTime = Date.now();

    // A rejection here reaches the terminal error handler (Express 5 forwards
    // it): the operator's log gets the whole error, the client a generic 500.
    const pdfBuffer = await browserProvider.withContext({}, async (context) => {
        const page = await context.newPage();
        await page.setContent(exportHTML, { waitUntil: 'networkidle' });
        // Settle JS-driven content (animations, font loads, fetch-driven layouts).
        await page.waitForTimeout(800);
        return page.pdf({
            format: 'Letter',
            margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
            printBackground: true,
        });
    });

    const duration = Date.now() - startTime;
    log.info(`[WebpageExport] PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB in ${duration}ms`);

    const safeFilename = title.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim() || 'webpage';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
});

module.exports = router;
