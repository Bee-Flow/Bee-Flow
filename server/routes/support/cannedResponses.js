/**
 * Canned responses: the saved reply snippets staff insert into a thread,
 * plus the server-side render that substitutes the thread variables.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both bodies are `.strict()`. A misspelled `shortcut` was dropped on create,
 * so the snippet arrived without the `/` trigger staff pick it by, under a
 * 200. On update the route called `.toString()` on whatever arrived, so
 * `title: null` was a TypeError and came back as a 500 "Internal error" — a
 * refusal dressed as a server fault. Both are now named 400s.
 */

const supportStore = require('../../stores/supportStore');

const { getUserId, requireStaffSupport, _actingOrgId, renderCannedBody } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const TITLE_TEXT = 'A canned response needs a title.';
const BODY_TEXT = 'A canned response needs a body.';
const TITLE = worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(200, 'A title is at most 200 characters.');
const BODY = worded(BODY_TEXT).min(1, BODY_TEXT).max(5000, 'A canned response is at most 5000 characters.')
    .refine((v) => v.trim().length > 0, BODY_TEXT);
const SHORTCUT = worded('A shortcut must be text.').trim().max(50, 'A shortcut is at most 50 characters.');

const CreateCanned = z.object({
    title: TITLE,
    body: BODY,
    shortcut: SHORTCUT.nullish(),
}).strict();

const UpdateCanned = z.object({
    title: TITLE.optional(),
    body: BODY.optional(),
    shortcut: SHORTCUT.nullish(),
}).strict();

const RenderBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    threadId: worded('threadId must be a thread id.').trim().min(1, 'threadId must be a thread id.').optional(),
}).strict());

function register(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // Canned responses CRUD + render (staff)
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/canned', requireStaffSupport, async (req, res) => {
        try {
            const orgId = await _actingOrgId(req);
            const responses = await supportStore.listCannedResponses(orgId);
            res.json({ responses });
        } catch (err) {
            log.error('[Support] GET /canned error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.post('/canned', requireStaffSupport, validate({ body: CreateCanned }), async (req, res) => {
        try {
            const { title, body, shortcut } = req.body;
            const orgId = await _actingOrgId(req);
            const created = await supportStore.createCannedResponse({
                organizationId: orgId,
                title,
                body,
                shortcut: shortcut || null,
                createdBy: getUserId(req),
            });
            res.json({ ok: true, response: created });
        } catch (err) {
            if (/duplicate key/i.test(err.message)) return res.status(409).json({ error: 'shortcut already in use' });
            log.error('[Support] POST /canned error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.put('/canned/:id', requireStaffSupport, validate({ body: UpdateCanned }), async (req, res) => {
        try {
            const orgId = await _actingOrgId(req);
            const patch = {};
            for (const key of ['title', 'body', 'shortcut']) {
                if (req.body[key] !== undefined) patch[key] = req.body[key];
            }
            const updated = await supportStore.updateCannedResponse(req.params.id, patch, orgId);
            if (!updated) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true, response: updated });
        } catch (err) {
            log.error('[Support] PUT /canned/:id error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.delete('/canned/:id', requireStaffSupport, async (req, res) => {
        try {
            const orgId = await _actingOrgId(req);
            const ok = await supportStore.deleteCannedResponse(req.params.id, orgId);
            if (!ok) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true });
        } catch (err) {
            log.error('[Support] DELETE /canned/:id error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // POST /canned/:id/render — substitute thread variables server-side.
    // One-pass, plaintext, known keys only — no nested templates, no eval.
    router.post('/canned/:id/render', requireStaffSupport, validate({ body: RenderBody }), async (req, res) => {
        try {
            const canned = await supportStore.getCannedResponse(req.params.id);
            if (!canned) return res.status(404).json({ error: 'not found' });
            const thread = req.body.threadId ? await supportStore.getThread(req.body.threadId) : null;
            const rendered = renderCannedBody(canned.body, thread, req.session?.user);
            res.json({ rendered });
        } catch (err) {
            log.error('[Support] POST /canned/:id/render error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });
}

module.exports = { register, CreateCanned, UpdateCanned };
