/**
 * Step Routes — REST API for reusable building blocks ("Steps", kind='block').
 *
 * A Step is a standalone Flowlet: a single layer_input trigger (params) + a
 * layer_output step, built in the same visual builder, then added to any
 * automation via a call_block node or exposed as a chat tool. Steps reuse the
 * automations table; this router keeps their lifecycle (publish-to-apply,
 * sharing, chat exposure) separate from the automation run/schedule surface.
 *
 *   GET    /                 list Steps the user can see (own + shared)
 *   POST   /                 create a Step (draft)
 *   GET    /:id              get one
 *   PUT    /:id              update the draft (title/description/definition)
 *   DELETE /:id              delete (409 if referenced by an automation)
 *   POST   /:id/publish      snapshot the draft → published version
 *   PUT    /:id/sharing      set is_published + shared_groups
 *   PUT    /:id/expose       toggle expose_as_tool (chat/agent tool)
 *   GET    /:id/versions     version history
 *   POST   /:id/test         dry-run the draft with sample inputs
 *
 * Gated by requireBetaFeature('automations') — the same gate as automations.
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Every body is `.strict()`. The routes read their keys one at a time and
 * coerced what they found, and on a Step — a building block other people's
 * automations and chats CALL — the coercions were the wrong way round:
 *
 *   - `PUT /:id/sharing {"isPublished": "false"}` PUBLISHED the Step: the store
 *     writes `!!isPublished`, and the text "false" is true.
 *   - `PUT /:id/sharing {"isPublished": true, "sharedGroups": "grp-sales"}` —
 *     one group, not a list — was read as `[]`, and an empty group list means
 *     the WHOLE organisation. Narrowing to one group shared with everyone; a
 *     misspelled `sharedGroup` did the same.
 *   - `PUT /:id/expose {"exposeAsTool": "false"}` exposed the Step as a chat
 *     tool, and `{}` or a misspelled key quietly withdrew it.
 *   - `POST / {"title": "Normalise VAT", "definition": "{…}"}` — a definition
 *     sent as TEXT — created the Step from the empty skeleton, under a 200.
 *   - `POST /:id/test {"input": {…}}` dry-ran the Step with no inputs at all.
 *
 * `definition` itself stays open: its vocabulary is automation/validate.js,
 * which answers with its own `details`. The schema asks only that it is an
 * object — a null definition used to reach updateAutomation and throw a 500.
 */

const express = require('express');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const automationStore = require('../stores/automationStore');
const userStore = require('../stores/userStore');
const { validateDefinition } = require('../automation/validate');
const { collectPinnedNodes } = require('../automation/portability');
const { summariseDefinition } = require('../automation/summarise');
const { resolveAudienceContext } = require('../auth/audience');
const { syncDatatableUsage, purgeDatatableUsage } = require('../automation/datatableUsageSync');
const { syncKbSources } = require('../core/kb/kbSourceSync');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');
router.use(requireAuth);

const { requireBetaFeature } = require('../core/entitlements/betaFeatures');
router.use(requireBetaFeature('automations'));

const { requireActiveOrgForMutations } = require('../auth');
router.use(requireActiveOrgForMutations());

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });
/** A real boolean, never the text "false" — which is true. */
const bool = (message) => z.boolean({ required_error: message, invalid_type_error: message });

const TITLE_TEXT = 'A Step needs a title.';
const DEFINITION_TEXT = 'A Step definition is a JSON object (the graph the builder saves).';
const CATEGORY_TEXT = 'A Step category is text of at most 60 characters.';

const title = worded(TITLE_TEXT).trim().min(1, TITLE_TEXT);
const definition = z.record(z.unknown(), { required_error: DEFINITION_TEXT, invalid_type_error: DEFINITION_TEXT });
const description = worded('A Step description must be text.').nullish();
const icon = worded('A Step icon must be text.').nullish();
// '' clears the category; the cap used to be applied by slicing, silently.
const category = worded(CATEGORY_TEXT).trim().max(60, CATEGORY_TEXT).nullish();

const CreateBody = z.object({ title, description, definition: definition.optional(), icon, category }).strict();

const UpdateBody = z.object({
    title: title.optional(), description, icon, category, definition: definition.optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Say what to change: title, description, icon, category or definition.');

const GROUPS_TEXT = 'sharedGroups is a list of group ids ([] = the whole organisation).';
const SharingBody = z.object({
    isPublished: bool('isPublished is true or false.'),
    sharedGroups: z.array(worded('Each shared group is a group id.').trim().min(1, 'Each shared group is a group id.'),
        { invalid_type_error: GROUPS_TEXT }).optional(),
}).strict().refine(
    // [] is "the whole organisation", so on publish it has to be SAID — the
    // store reads a missing list as [] too, which is how "one group" became
    // "everyone" without a word.
    (b) => !b.isPublished || b.sharedGroups !== undefined,
    { message: `Publishing needs an audience: ${GROUPS_TEXT}`, path: ['sharedGroups'] },
);

const ExposeBody = z.object({ exposeAsTool: bool('exposeAsTool is true or false.') }).strict();

const TestBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        inputs: z.record(z.unknown(), { invalid_type_error: 'inputs is an object of sample values, keyed by input name.' }).nullish(),
    }).strict(),
);

// A fresh Step's root graph: layer_input trigger + a single layer_output.
function blockSkeleton() {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [{ id: 'out', type: 'layer_output', fields: {} }],
        edges: [],
    };
}

async function activeOrgId(userId) {
    try {
        const user = await userStore.getUser(userId);
        return user?.organizationId || null;
    } catch (_) { return null; }
}

// List Steps visible to the caller (own + shared into their orgs).
router.get('/', async (req, res) => {
    const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdList = orgIds === null ? [] : [...orgIds];
    const isOrgAdmin = orgIds === null; // super admin sees drafts too
    const steps = await automationStore.getStepsForUser(userId, { orgIds: orgIdList, userGroups, isOrgAdmin });
    res.json({ steps });
});

// Create a Step (draft).
router.post('/', validate({ body: CreateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { title, description } = req.body;
    // Absent means "start from the skeleton"; anything else is a definition,
    // validated below — never a string quietly swapped for the skeleton.
    const definition = req.body.definition || blockSkeleton();
    const v = validateDefinition(definition, { scope: 'block' });
    if (!v.ok) return res.status(400).json({ error: 'Invalid Step definition', details: v.errors });
    const organizationId = await activeOrgId(userId);
    const icon = req.body.icon || null;
    const category = req.body.category || null;
    const step = await automationStore.createStep({ userId, organizationId, title, description: description || '', definition, icon, category });
    // A Step is a routine in the same table and its datatable steps run for
    // real, so it belongs in the usage index like any other definition —
    // otherwise a column drop is checked against everything EXCEPT the
    // building blocks half the org's routines call.
    await syncDatatableUsage(step?.id, organizationId, definition, { label: 'step create' });
    await syncKbSources(step?.id, definition, { userId, title: step?.title });
    res.json({ step });
});

// Steps the caller exposed as chat tools — for the chat "Apps" picker so the
// user can see/discover them. Owner-only + published + expose_as_tool (the same
// set the agent actually gets injected). Registered before /:id so the literal
// path wins. Lightweight projection (no definition).
router.get('/chat-tools', async (req, res) => {
    const userId = req.session.user.id;
    const callable = await automationStore.getCallableStepsForUser(userId, { orgIds: [] }).catch(() => []);
    const tools = callable
        .filter(s => s.ownerId === userId && s.exposeAsTool)
        .map(s => ({ id: s.id, title: s.title, description: s.description || '', icon: s.icon || null, category: s.category || null }));
    res.json({ tools });
});

// Helper: load a Step the caller can VIEW (own or shared), or null.
async function loadVisibleStep(req) {
    const row = await automationStore.getAutomation(req.params.id);
    if (!row || row.kind !== 'block') return { row: null };
    const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
    const isOwner = row.userId === userId;
    const orgSet = orgIds === null ? null : orgIds;
    let canView = isOwner || orgIds === null;
    if (!canView && row.isPublished && row.organizationId && orgSet?.has?.(row.organizationId)) {
        const groups = Array.isArray(row.sharedGroups) ? row.sharedGroups : [];
        canView = groups.length === 0 || groups.some(g => userGroups.includes(g));
    }
    return { row, isOwner, canView };
}

router.get('/:id', async (req, res) => {
    const { row, canView } = await loadVisibleStep(req);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canView) return res.status(403).json({ error: 'Forbidden' });
    res.json({ step: row, summary: summariseDefinition(row.definition || {}).summary });
});

router.put('/:id', validate({ body: UpdateBody }), async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const updates = {};
    for (const f of ['title', 'description', 'icon', 'category', 'definition']) if (req.body[f] !== undefined) updates[f] = req.body[f];
    // The schema trimmed and capped it; '' (or null) clears it.
    if (updates.category !== undefined) updates.category = updates.category || null;
    if (updates.definition) {
        const v = validateDefinition(updates.definition, { scope: 'block' });
        if (!v.ok) return res.status(400).json({ error: 'Invalid Step definition', details: v.errors });
    }
    const updated = await automationStore.updateAutomation(req.params.id, updates, userId);
    if (updates.definition !== undefined) {
        await syncDatatableUsage(req.params.id, existing.organizationId || null, updates.definition,
            { label: 'step update' });
        await syncKbSources(req.params.id, updates.definition,
            { userId, title: updates.title || existing.title });
    }
    res.json({ step: updated });
});

router.delete('/:id', async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const consumers = await automationStore.getStepConsumers(req.params.id, {
        userId: existing.userId,
        organizationId: existing.organizationId || null,
    });
    if (consumers.length > 0) {
        return res.status(409).json({ error: 'Step is in use', code: 'step_in_use', consumers });
    }
    await automationStore.deleteAutomation(req.params.id);
    await purgeDatatableUsage(req.params.id, { label: 'step delete' });
    res.json({ success: true });
});

// Publish: snapshot the current draft so consumers pick up the change.
router.post('/:id/publish', async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const v = validateDefinition(existing.definition || {}, { scope: 'block' });
    if (!v.ok) return res.status(400).json({ error: 'Cannot publish an invalid Step', details: v.errors });
    // A published Step is a snapshot served to the whole org (getCallableStepsForUser),
    // and execCallBlock dispatches it through the same pinned-output short-circuit as any
    // other step. Publishing never passes through /activate, so without this gate a pin --
    // captured or hand-authored -- would serve one author's sample data to every caller.
    const pins = collectPinnedNodes(existing.definition || {});
    if (pins.length) {
        return res.status(400).json({
            error: 'Cannot publish a Step that serves pinned data — unpin it first, or every caller gets your sample instead of a real run.',
            code: 'pinned_data_in_published_step',
            details: pins,
        });
    }
    const step = await automationStore.publishStep(req.params.id, userId);
    res.json({ step });
});

router.put('/:id/sharing', validate({ body: SharingBody }), async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const { isPublished, sharedGroups = [] } = req.body;
    const step = await automationStore.setStepSharing(req.params.id, { isPublished, sharedGroups });
    res.json({ step });
});

router.put('/:id/expose', validate({ body: ExposeBody }), async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const step = await automationStore.setStepExpose(req.params.id, req.body.exposeAsTool);
    res.json({ step });
});

router.get('/:id/versions', async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const versions = await automationStore.listVersions(req.params.id);
    res.json({ versions, publishedVersion: existing.publishedVersion });
});

// Test the DRAFT with sample inputs (dry-run, owner-only, runs as the owner).
router.post('/:id/test', validate({ body: TestBody }), async (req, res) => {
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing || existing.kind !== 'block') return res.status(404).json({ error: 'Not found' });
    if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    const v = validateDefinition(existing.definition || {}, { scope: 'block' });
    if (!v.ok) return res.status(400).json({ error: 'Invalid Step definition', details: v.errors });
    const synthetic = {
        id: existing.id, userId: existing.userId, organizationId: existing.organizationId || null,
        title: existing.title, version: existing.version, definition: existing.definition, kind: 'block',
    };
    const runner = require('../core/automationRunner');
    const run = await runner.executeAutomation(synthetic, {
        triggerKind: 'dry_run', triggerPayload: req.body.inputs || {}, mode: 'dry_run',
    });
    const steps = await automationStore.getRunSteps(run.id);
    res.json({ run, steps });
});

module.exports = router;
