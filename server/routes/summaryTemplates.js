/**
 * Summary Templates API
 *
 * Saved "Regenerate" summary prompts at three scopes:
 *   - user  → the caller's own personal templates (any authenticated user)
 *   - org   → visible to the caller's whole organisation (org admins only)
 *   - group → visible to one org group (org admins only)
 *
 * Read: a user sees their own + their org's + their groups' templates.
 * Write: user-scope is self-service; org/group-scope requires org admin, gated
 * by `isOrgAdminForOrg` exactly like routes/houseStyles.js.
 *
 * Routes:
 *   GET    /            — built-ins + templates visible to the caller (+ default)
 *   GET    /org         — all org + group templates for the caller's org (admin)
 *   POST   /            — create { scope, name, prompt, groupId?, isDefault? }
 *   PATCH  /:id         — rename / edit prompt / set-default
 *   DELETE /:id         — remove
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Both bodies are `.strict()`. They were read field by field, with a default
 * for whatever was missing, and the defaults decided WHO sees the template:
 *
 *   - `{"scop": "org", …}` — one letter short — created a PERSONAL template
 *     under a 201, for an admin who meant the whole organisation;
 *   - `{"scope": "org", "groupId": "grp-sales"}` created an ORG-WIDE template
 *     while the caller named one group; the id was simply ignored;
 *   - `{"isDefault": "false"}` made the template everyone's default for
 *     Regenerate (`!!"false"` is true), on create and on PATCH;
 *   - `PATCH {"nmae": "…"}` answered 200 with the unchanged row.
 *
 * A name over 120 or a prompt over 20,000 characters was cut to fit without a
 * word, so the template ended mid-sentence; both are refused now, in words
 * the editor shows. `version` stays the server's: a PATCH that names it is
 * refused, where it used to be dropped.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const store = require('../stores/summaryTemplateStore');
const userStore = require('../stores/userStore');
const { requireAuth } = require('../auth/permissions');
const {
    resolveUserOrgIds,
    isOrgAdminForOrg,
    validateSharedGroupsForOrg,
} = require('../auth/permissions');
const { BUILTIN_TEMPLATES, pickDefaultTemplate } = require('../core/meetingNotes/summaryTemplates');

// The prompt is sent to an LLM; a generous but finite cap avoids abuse.
const MAX_PROMPT_LEN = 20000;
const MAX_NAME_LEN = 120;

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
const isDefault = z.boolean({ invalid_type_error: 'isDefault is true or false.' });

const SCOPE_TEXT = 'scope is "user" (just me), "org" (the whole organisation) or "group".';
const NAME_TEXT = 'A template needs a name.';
const PROMPT_TEXT = 'A template needs a prompt.';
const GROUP_TEXT = 'groupId is the id of one of your organisation\'s groups.';

const name = worded(NAME_TEXT).trim().min(1, NAME_TEXT)
    .max(MAX_NAME_LEN, `A template name is at most ${MAX_NAME_LEN} characters.`);
const prompt = worded(PROMPT_TEXT).trim().min(1, PROMPT_TEXT)
    .max(MAX_PROMPT_LEN, `A template prompt is at most ${MAX_PROMPT_LEN} characters.`);

const CreateBody = z.object({
    // Omitted is "just me", as the API always said; misspelled is a 400.
    scope: z.enum(['user', 'org', 'group'], { errorMap: () => ({ message: SCOPE_TEXT }) }).default('user'),
    name,
    prompt,
    groupId: worded(GROUP_TEXT).trim().min(1, GROUP_TEXT).optional(),
    isDefault: isDefault.optional(),
}).strict().superRefine((b, ctx) => {
    if (b.scope === 'group' && !b.groupId) {
        ctx.addIssue({ code: 'custom', path: ['groupId'], message: 'A group template needs the group it is for (groupId).' });
    }
    if (b.scope !== 'group' && b.groupId !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['groupId'], message: 'groupId only goes with scope "group" — this template would reach everyone in its scope.' });
    }
});

const PatchBody = z.object({
    name: name.optional(),
    prompt: prompt.optional(),
    isDefault: isDefault.optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Say what to change: name, prompt or isDefault.');

/**
 * Resolve the caller's org IDs (array), group IDs (array) and a primary org.
 * Mirrors resolveAccessContext / resolveUserOrgFromReq in routes/transcriptions.js.
 * Super admins get their own org folded in so they still see/manage it.
 */
async function resolveCtx(req) {
    const userId = req.session?.user?.id || null;
    const orgIdsSet = await resolveUserOrgIds(req); // Set | null (super) | empty Set
    const isSuperAdmin = orgIdsSet === null;
    let orgIds = isSuperAdmin ? [] : Array.from(orgIdsSet || []);
    let groupIds = [];
    let primaryOrgId = orgIds[0] || null;
    try {
        const user = await userStore.getUser(userId);
        if (user) {
            if (Array.isArray(user.groups)) groupIds = user.groups;
            else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { /* ignore */ } }
            if (!primaryOrgId && user.organizationId) primaryOrgId = user.organizationId;
        }
    } catch (_) { /* best effort */ }
    if (isSuperAdmin && primaryOrgId && !orgIds.includes(primaryOrgId)) orgIds = [primaryOrgId];
    return { userId, orgIds, groupIds, primaryOrgId, isSuperAdmin };
}

// ── List (Regenerate menu) ─────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    try {
        const ctx = await resolveCtx(req);
        const custom = await store.listVisible({ userId: ctx.userId, orgIds: ctx.orgIds, groupIds: ctx.groupIds });
        const def = pickDefaultTemplate(custom, ctx);
        const canManageOrg = ctx.primaryOrgId ? await isOrgAdminForOrg(req, ctx.primaryOrgId) : false;
        res.json({
            builtins: BUILTIN_TEMPLATES.map(t => ({ id: t.id, name: t.name, nameKey: t.nameKey, prompt: t.prompt })),
            custom,
            defaultTemplateId: def ? def.id : null,
            canManageOrg,
            primaryOrgId: ctx.primaryOrgId,
        });
    } catch (e) {
        log.error('[summaryTemplates] list failed:', e.message);
        res.status(500).json({ error: 'Failed to list templates' });
    }
});

// ── List for org admin panel (all org + group templates in the org) ──
router.get('/org', requireAuth, async (req, res) => {
    try {
        const ctx = await resolveCtx(req);
        const orgId = ctx.primaryOrgId;
        if (!orgId) return res.status(400).json({ error: 'No organisation' });
        if (!(await isOrgAdminForOrg(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
        const templates = await store.listForOrg(orgId);
        const allGroups = await userStore.getAllGroups();
        const groups = allGroups
            .filter(g => g.organizationId === orgId)
            .map(g => ({ id: g.id, name: g.name, description: g.description || '' }));
        res.json({ orgId, templates, groups });
    } catch (e) {
        log.error('[summaryTemplates] org list failed:', e.message);
        res.status(500).json({ error: 'Failed to list org templates' });
    }
});

// ── Create ─────────────────────────────────────────────────────────
router.post('/', requireAuth, validate({ body: CreateBody }), async (req, res) => {
    try {
        const ctx = await resolveCtx(req);
        const { scope, name, prompt } = req.body;
        const isDefault = req.body.isDefault === true;

        if (scope === 'user') {
            const created = await store.create({ scope: 'user', name, prompt, userId: ctx.userId, isDefault, createdBy: ctx.userId });
            return res.status(201).json(created);
        }

        // org / group → org admin of the caller's own org
        const orgId = ctx.primaryOrgId;
        if (!orgId) return res.status(400).json({ error: 'You are not part of an organisation' });
        if (!(await isOrgAdminForOrg(req, orgId))) return res.status(403).json({ error: 'Org admin required' });

        let groupId = null;
        if (scope === 'group') {
            groupId = req.body.groupId;
            try {
                await validateSharedGroupsForOrg(orgId, [groupId]);
            } catch (err) {
                return res.status(err.status || 400).json({ error: err.message });
            }
        }

        const created = await store.create({ scope, name, prompt, organizationId: orgId, groupId, isDefault, createdBy: ctx.userId });
        return res.status(201).json(created);
    } catch (e) {
        log.error('[summaryTemplates] create failed:', e.message);
        res.status(500).json({ error: 'Failed to create template' });
    }
});

/** Owner (user-scope) or org admin (org/group-scope) may write. */
async function authorizeWrite(req, tpl) {
    const ctx = await resolveCtx(req);
    if (tpl.scope === 'user') return tpl.userId === ctx.userId;
    return isOrgAdminForOrg(req, tpl.organizationId);
}

// ── Update ─────────────────────────────────────────────────────────
router.patch('/:id', requireAuth, validate({ body: PatchBody }), async (req, res) => {
    try {
        const tpl = await store.getById(req.params.id);
        if (!tpl) return res.status(404).json({ error: 'Not found' });
        if (!(await authorizeWrite(req, tpl))) return res.status(403).json({ error: 'Not allowed' });

        // The schema trimmed, bounded and refused empties; only what was sent moves.
        const updates = {};
        for (const f of ['name', 'prompt', 'isDefault']) if (req.body[f] !== undefined) updates[f] = req.body[f];

        const updated = await store.update(req.params.id, updates);
        res.json(updated);
    } catch (e) {
        log.error('[summaryTemplates] update failed:', e.message);
        res.status(500).json({ error: 'Failed to update template' });
    }
});

// ── Delete ─────────────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const tpl = await store.getById(req.params.id);
        if (!tpl) return res.status(404).json({ error: 'Not found' });
        if (!(await authorizeWrite(req, tpl))) return res.status(403).json({ error: 'Not allowed' });
        await store.remove(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        log.error('[summaryTemplates] delete failed:', e.message);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

module.exports = router;
