/**
 * Document Routes — PDF downloads from the document-renderer component
 *
 * Serves whatever sits in the shared document-renderer temp directory. The only
 * live client is the mobile app's Documents → "Generated" tab
 * (mobile/src/features/library/api.ts → listRenderedDocuments, and
 * shareServerFile over /view), which sends the session cookie with every call.
 * Nothing in the current server writes to this directory anymore — automation
 * documents go to automationStore and are served session-scoped by their own
 * routes (core/automationRunner/execDocument.js) — so on a current deployment
 * /list answers an empty array; the routes stay because the mobile tab is a
 * shipped contract and a legacy writer may still populate the directory.
 *
 * Access (U4b, 2026-09-05): requireAuth on the router. Before that gate these
 * routes never read the session at all, which made every user's rendered PDFs
 * anonymously listable (/list, download URLs included — voiding the random
 * filename as protection) and fetchable (/download, /view).
 *
 * KNOWN LIMIT (follow-up, deliberate): the directory carries no ownership
 * metadata — a filename is `<random>_<name>.pdf` and fs stat is all there is —
 * so /list cannot be narrowed to the caller's own files without inventing a
 * ledger that no writer maintains. Signed-in users therefore still see each
 * other's files wherever a legacy writer fills the directory. Reducing /list
 * to an existence check is not an option either: the mobile tab renders the
 * listing (id/name/size/date/viewUrl). The real fix is an ownership ledger at
 * the writer — or retiring these routes together with the mobile tab.
 *
 * What a caller may name: a PDF, by the id /list gave it. The file name on the
 * path is checked by a schema instead of being cleaned. The cleaning (drop
 * every character outside [A-Za-z0-9._-]) answered a request for one name
 * with a DIFFERENT file whenever the cleaned name existed, and answered a
 * listed file whose name held a space with "It may have expired". /list now
 * offers only the names these routes serve, so every link it hands out works.
 * The routes take no query and no body; there is nothing else to narrow.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { requireAuth } = require('../auth');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const OUTPUT_DIR = path.join(os.tmpdir(), 'document-renderer');

// A plain file name — no separator, so no way out of OUTPUT_DIR — ending in
// .pdf. The same test decides what /list offers and what the two file routes
// serve.
const DOCUMENT_NAME = /^[A-Za-z0-9._-]+\.pdf$/;
const NAME_TEXT = 'Name a document by its id from /api/documents/list: letters, digits, dots, dashes or underscores, ending in .pdf.';
const FileParams = z.object({
    filename: z.string({ required_error: NAME_TEXT, invalid_type_error: NAME_TEXT }).regex(DOCUMENT_NAME, NAME_TEXT),
});

// Anonymous callers stop here with a 401 (the routes/versions.js idiom). The
// only client — the mobile Generated tab — always sends the session cookie.
router.use(requireAuth);

// GET /api/documents/download/:filename — serve a rendered PDF
router.get('/download/:filename', validate({ params: FileParams }), (req, res) => {
    const safe = req.params.filename;
    const filePath = path.join(OUTPUT_DIR, safe);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Document not found. It may have expired.' });
    }

    // Derive a clean download name (strip the random prefix)
    const parts = safe.split('_');
    const downloadName = parts.length > 1 ? parts.slice(1).join('_') : safe;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.sendFile(filePath);
});

// GET /api/documents/view/:filename — serve inline (browser preview)
router.get('/view/:filename', validate({ params: FileParams }), (req, res) => {
    const safe = req.params.filename;
    const filePath = path.join(OUTPUT_DIR, safe);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Document not found. It may have expired.' });
    }

    const parts = safe.split('_');
    const downloadName = parts.length > 1 ? parts.slice(1).join('_') : safe;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
    res.sendFile(filePath);
});

// GET /api/documents/list — list available documents (mobile "Generated" tab).
// NOT per-user scoped — see the KNOWN LIMIT note in the header.
router.get('/list', (req, res) => {
    if (!fs.existsSync(OUTPUT_DIR)) {
        return res.json({ documents: [] });
    }

    const files = fs.readdirSync(OUTPUT_DIR)
        .filter(f => DOCUMENT_NAME.test(f))
        .map(f => {
            const stat = fs.statSync(path.join(OUTPUT_DIR, f));
            const parts = f.split('_');
            return {
                id: f,
                name: parts.length > 1 ? parts.slice(1).join('_') : f,
                sizeBytes: stat.size,
                createdAt: stat.birthtime,
                downloadUrl: `/api/documents/download/${f}`,
                viewUrl: `/api/documents/view/${f}`
            };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ documents: files });
});

module.exports = router;
