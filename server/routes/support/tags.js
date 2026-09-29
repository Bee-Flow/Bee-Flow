/**
 * Tag taxonomy CRUD for staff — the named tags threads can be labelled with,
 * scoped to the acting org (system-wide for super-admins).
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `TagBody` is `.strict()`: a misspelled `colour` used to be dropped on the
 * way through, so the tag arrived with no colour under a 200 and nothing on
 * screen explained why. The two length caps the route already answered with
 * ("name too long (max 50)") now come from the schema, and `description`
 * finally has one of its own.
 */

const supportStore = require('../../stores/supportStore');

const { _hasAdminSupport, requireStaffSupport, _actingOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const NAME_TEXT = 'A tag needs a name.';
const TagBody = z.object({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(50, 'A tag name is at most 50 characters.'),
    color: worded('A tag colour must be text.').trim().max(32, 'A tag colour is at most 32 characters.').nullish(),
    description: worded('A tag description must be text.').trim().max(500, 'A tag description is at most 500 characters.').nullish(),
}).strict();

function register(router) {
    // ──────────────────────────────────────────────────────────────────────────
    // Tag taxonomy CRUD (staff)
    // ──────────────────────────────────────────────────────────────────────────
    router.get('/tags', async (req, res) => {
        try {
            if (!(await _hasAdminSupport(req))) {
                return res.status(403).json({ error: 'admin_support permission required' });
            }
            const orgId = await _actingOrgId(req);
            const tags = await supportStore.listTags(orgId);
            res.json({ tags });
        } catch (err) {
            log.error('[Support] GET /tags error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.post('/tags', requireStaffSupport, validate({ body: TagBody }), async (req, res) => {
        try {
            const { name, color, description } = req.body;
            const orgId = await _actingOrgId(req);
            const tag = await supportStore.createTag({
                organizationId: orgId,
                name,
                color: color || null,
                description: description || null,
            });
            res.json({ ok: true, tag });
        } catch (err) {
            if (/duplicate key/i.test(err.message)) return res.status(409).json({ error: 'tag already exists' });
            log.error('[Support] POST /tags error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    router.delete('/tags/:id', async (req, res) => {
        try {
            if (!(await _hasAdminSupport(req))) {
                return res.status(403).json({ error: 'admin_support permission required' });
            }
            const orgId = await _actingOrgId(req);
            const ok = await supportStore.deleteTag(req.params.id, orgId);
            if (!ok) return res.status(404).json({ error: 'not found' });
            res.json({ ok: true });
        } catch (err) {
            log.error('[Support] DELETE /tags/:id error:', err.message);
            res.status(500).json({ error: 'Internal error' });
        }
    });
}

module.exports = { register, TagBody };
