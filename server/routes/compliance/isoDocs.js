/**
 * Compliance — the ISO 27001 ISMS documents: member-facing published policies
 * and acknowledgements, plus the admin draft/publish CRUD.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `DocPatch` is `.strict()`, and on the policy drawer that matters twice. The
 * drawer sends exactly four keys; anything outside them used to be dropped on
 * the way through, so `owner_id` instead of `owner_user_id` answered 200 with
 * the document unchanged and nothing on screen to explain it.
 *
 * The second one was in ismsDocStore.setMeta, which merged with COALESCE and
 * so could not tell "key absent" from "explicitly null": the drawer's own way
 * of unassigning an owner (`owner_user_id: null`) left the owner in place, and
 * clause 5 of the conformity statement went on reading the document as owned.
 * setMeta now writes only the keys the body actually carries.
 *
 * The two seed/acknowledge/publish routes read nothing from the body — the
 * buttons post `{}` — so a key there is a mistake and is answered as one.
 */

const express = require('express');
const router = express.Router();

const complianceStore = require('../../stores/complianceStore');
const ismsDocStore = require('../../stores/ismsDocStore');
const { requireAuth, requirePermission } = require('../../auth/permissions');
const { resolveOrgId } = require('./shared');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const TITLE_TEXT = 'A policy needs a title.';
const DocPatch = bodyOf({
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).max(200, 'A policy title is at most 200 characters.').optional(),
    // The draft body of a controlled document — free text, capped where the
    // published version is hashed. An explicit '' empties the draft; publish
    // then refuses it, which is the intended way to retract a draft.
    body: worded('The policy text must be text.').max(200000, 'A policy is at most 200 000 characters.').optional(),
    // `null` unassigns — see setMeta.
    owner_user_id: worded('owner_user_id must be a user id.').trim().max(120, 'owner_user_id is at most 120 characters.').nullable().optional(),
    review_due_at: worded('review_due_at must be a date.')
        .refine((v) => !Number.isNaN(new Date(v).getTime()), 'review_due_at must be a date.')
        .nullable().optional(),
});

/** The seed, acknowledge and publish buttons post `{}` and read nothing back out of it. */
const NoBody = bodyOf({});

// ───────────────── ISO 27001 — ISMS documents (policies) ─────────────────
//
// Org-scoped controlled documents (clause 7.5 / A.5.1 / clause 7.3): drafts on
// the document row, publishing freezes an immutable sha256'd version that the
// acknowledgement ledger binds to. Admin CRUD sits behind admin_compliance;
// reading published policies and acknowledging them is open to every signed-in
// member of the org — awareness is org-wide by definition.

function _policySeeds() {
    // Lazy: keeps the router loadable in stripped test harnesses.
    try { return require('../../compliance/iso/policySeeds').POLICY_SEEDS || []; }
    catch { return []; }
}

// Member-facing routes FIRST — '/iso/docs/published/…' would otherwise be
// swallowed by the '/iso/docs/:slug' admin route (slug = 'published').
router.get('/iso/docs/published/me', requireAuth, async (req, res) => {
    const orgId = await resolveOrgId(req);
    const userId = req.session?.user?.id;
    res.json(await ismsDocStore.listPublishedForUser(orgId, userId));
});

router.get('/iso/docs/published/:slug/body', requireAuth, async (req, res) => {
    const orgId = await resolveOrgId(req);
    const v = await ismsDocStore.getPublishedBody(orgId, String(req.params.slug));
    if (!v) return res.status(404).json({ error: 'not_published' });
    res.json(v);
});

router.post('/iso/docs/:slug/acknowledge', requireAuth, validate({ body: NoBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const userId = req.session?.user?.id;
    const slug = String(req.params.slug);
    const doc = await ismsDocStore.getDoc(orgId, slug);
    if (!doc || doc.status !== 'published' || !doc.current_version) {
        return res.status(404).json({ error: 'not_published' });
    }
    await ismsDocStore.acknowledge(orgId, slug, doc.current_version, userId, {
        ip: req.ip || null,
        userAgent: req.get('user-agent') || null,
    });
    res.json({ acknowledged: true, slug, version: doc.current_version });
});

router.get('/iso/docs', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const docs = await ismsDocStore.listDocs(orgId);
    const have = new Set(docs.map(d => d.slug));
    res.json({
        documents: docs,
        missing_seeds: _policySeeds().filter(s => !have.has(s.slug)).map(s => ({ slug: s.slug, title: s.title })),
    });
});

router.post('/iso/docs/seed', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const inserted = await ismsDocStore.seedMissing(orgId, _policySeeds());
    res.json({ inserted });
});

router.get('/iso/docs/:slug', requireAuth, requirePermission('admin_compliance'), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const doc = await ismsDocStore.getDoc(orgId, String(req.params.slug));
    if (!doc) return res.status(404).json({ error: 'not_found' });
    res.json(doc);
});

router.put('/iso/docs/:slug', requireAuth, requirePermission('admin_compliance'), validate({ body: DocPatch }), async (req, res) => {
    const orgId = await resolveOrgId(req);
    const actorId = req.session?.user?.id || null;
    const slug = String(req.params.slug);
    const body = req.body;
    const seed = _policySeeds().find(s => s.slug === slug) || null;
    let doc = await ismsDocStore.saveDraft(orgId, slug, { title: body.title, body: body.body }, actorId, { seedBody: seed?.body ?? null });
    if (!doc) return res.status(404).json({ error: 'not_found' });
    if (body.owner_user_id !== undefined || body.review_due_at !== undefined) {
        doc = await ismsDocStore.setMeta(orgId, slug, {
            owner_user_id: body.owner_user_id,
            review_due_at: body.review_due_at,
        });
    }
    res.json(doc);
});

router.post('/iso/docs/:slug/publish', requireAuth, requirePermission('admin_compliance'), validate({ body: NoBody }), async (req, res) => {
    try {
        const orgId = await resolveOrgId(req);
        const actorId = req.session?.user?.id || null;
        const slug = String(req.params.slug);
        const doc = await ismsDocStore.publish(orgId, slug, actorId);
        if (!doc) return res.status(404).json({ error: 'not_found' });
        await complianceStore.addEvidence({
            organization_id: orgId,
            check_id: null,
            subject_type: 'isms_doc',
            subject_id: slug,
            hash: doc.published_hash,
            payload: {
                action: 'policy_published', slug, version: doc.current_version,
                sha256: doc.published_hash, edited_from_seed: !!doc.edited,
                by: actorId, at: new Date().toISOString(),
            },
        });
        res.json(doc);
    } catch (e) {
        res.status(e.message?.includes('empty') ? 400 : 500).json({ error: e.message });
    }
});

module.exports = router;
