// @typecheck noImplicitAny
/**
 * House Styles API
 *
 * Per-organization Word/DOCX style templates that drive Notebook exports.
 * Read access: any org member. Write access: org admins (or platform admin).
 *
 * Routes:
 *   GET    /:orgId                        — list (no blob)
 *   GET    /:orgId/default                — current default (or null)
 *   GET    /:orgId/:id                    — single style meta
 *   GET    /:orgId/:id/source.docx        — download original .docx
 *   POST   /:orgId                        — upload .docx (multipart, field "file")
 *   PATCH  /:orgId/:id                    — rename / set-default / re-extract
 *   DELETE /:orgId/:id                    — remove
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const houseStyleStore = require('../stores/houseStyleStore');
const houseStyleExtractor = require('../core/text/houseStyleExtractor');
require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');

const { validate } = require('../core/http/validate');
const { z, typeError } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
});

// ── What a caller may send ──────────────────────────────────────────
//
// PATCH read four keys and let the rest fall away, so every mistake was a
// 200 with the style unchanged — or changed into something else:
//
//   - `isDefault: "false"` is truthy: the style BECAME the organisation's
//     default, replacing the one the admin meant to keep;
//   - `name: null` renamed the style to the word "null" (String(null)), and
//     `name: ""` saved a nameless style — the upload refuses both;
//   - `reExtract: "true"` is not `=== true`, so nothing was re-extracted;
//   - a misspelled `isdefault` changed nothing and answered with the row.
//
// The upload is multipart, so its schema sits BEHIND multer, which fills
// `req.body` with the text fields only after reading the stream; the file
// itself is `req.file`, checked in the handler. FormData carries only text,
// and `isDefault` was `=== 'true'`: an HTML checkbox's "on" meant NO.

/**
 * A body that also accepts no body: Express 5 leaves `req.body` undefined then.
 * @template {import('zod').ZodRawShape} T
 * @param {T} shape
 */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { error: typeError({ invalid: 'Send the changes as a JSON object.' }) }).strict(),
);

const NAME_TEXT = 'A house style needs a name.';
const DESCRIPTION_TEXT = 'description is text.';

const PatchBody = bodyOf({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).optional(),
    // null clears it; it used to be saved as the word "null".
    description: worded(DESCRIPTION_TEXT).nullable().optional().transform((v) => (v === null ? '' : v)),
    isDefault: z.boolean({ error: typeError({ invalid: 'isDefault is true or false.' }) }).optional(),
    reExtract: z.boolean({ error: typeError({ invalid: 'reExtract is true or false.' }) }).optional(),
});

const UploadBody = bodyOf({
    // Empty falls back to the file's name, as before.
    name: worded(NAME_TEXT).trim().optional(),
    description: worded(DESCRIPTION_TEXT).optional(),
    isDefault: z.enum(['true', 'false'], { error: () => "isDefault is 'true' or 'false'." }).optional(),
});

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

/**
 * @param {import('express').Request<{ orgId: string }>} req
 * @param {string} orgId
 */
async function isOrgMember(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const ids = await resolveUserOrgIds(req);
    if (ids === null) return true; // legacy: no orgs scoped
    return !!(ids && ids.has(orgId));
}

const { isOrgAdminForOrg: isOrgAdmin } = require('../auth/permissions');

// ── List ───────────────────────────────────────────────────────────
router.get('/:orgId', requireAuth, async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
    const styles = await houseStyleStore.listForOrg(orgId);
    res.json(styles);
});

// ── Default ────────────────────────────────────────────────────────
router.get('/:orgId/default', requireAuth, async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
    const style = await houseStyleStore.getDefaultForOrg(orgId);
    res.json(style || null);
});

// ── Single ─────────────────────────────────────────────────────────
router.get('/:orgId/:id', requireAuth, async (/** @type {import('express').Request<{ orgId: string, id: string }>} */ req, res) => {
    const { orgId, id } = req.params;
    if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
    const style = await houseStyleStore.getById(id, orgId);
    if (!style) return res.status(404).json({ error: 'Not found' });
    res.json(style);
});

// ── Source DOCX download ──────────────────────────────────────────
router.get('/:orgId/:id/source.docx', requireAuth, async (/** @type {import('express').Request<{ orgId: string, id: string }>} */ req, res) => {
    const { orgId, id } = req.params;
    if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
    const style = await houseStyleStore.getById(id, orgId, { includeBlob: true });
    if (!style) return res.status(404).json({ error: 'Not found' });
    const safeName = (style.name || 'house-style').replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
    res.send(style.docxBlob);
});

// ── Upload ─────────────────────────────────────────────────────────
router.post('/:orgId', requireAuth, upload.single('file'), validate({ body: UploadBody }), async (/** @type {import('express').Request<{ orgId: string }>} */ req, res) => {
    const { orgId } = req.params;
    if (!(await isOrgAdmin(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file" required)' });
    const lower = (req.file.originalname || '').toLowerCase();
    if (!lower.endsWith('.docx')) return res.status(400).json({ error: 'Only .docx files are supported' });

    const name = (req.body.name || req.file.originalname.replace(/\.docx$/i, '')).trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const description = (req.body.description || '').trim();
    const makeDefault = req.body.isDefault === 'true';

    const styleMeta = await houseStyleExtractor.extract(req.file.buffer);
    const created = await houseStyleStore.create({
        orgId,
        name,
        description,
        docxBuffer: req.file.buffer,
        styleMeta,
        createdBy: req.session.user.id,
        makeDefault,
    });
    res.status(201).json(created);
});

// ── Update (rename, set-default, re-extract) ──────────────────────
router.patch('/:orgId/:id', requireAuth, validate({ body: PatchBody }), async (/** @type {import('express').Request<{ orgId: string, id: string }>} */ req, res) => {
    const { orgId, id } = req.params;
    if (!(await isOrgAdmin(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.description !== undefined) updates.description = req.body.description;
    if (req.body.isDefault !== undefined) updates.isDefault = req.body.isDefault;

    // Re-run extraction on the stored blob — useful when the extractor
    // improves and we want existing styles to pick up new fields.
    if (req.body.reExtract === true) {
        const full = await houseStyleStore.getById(id, orgId, { includeBlob: true });
        if (full?.docxBlob) {
            updates.styleMeta = await houseStyleExtractor.extract(full.docxBlob);
        }
    }

    const updated = await houseStyleStore.update(id, orgId, updates);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
});

// ── Delete ─────────────────────────────────────────────────────────
router.delete('/:orgId/:id', requireAuth, async (/** @type {import('express').Request<{ orgId: string, id: string }>} */ req, res) => {
    const { orgId, id } = req.params;
    if (!(await isOrgAdmin(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
    await houseStyleStore.remove(id, orgId);
    res.json({ ok: true });
});

module.exports = router;
