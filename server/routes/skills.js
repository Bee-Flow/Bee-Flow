// @typecheck
/**
 * Skills API — CRUD routes for reusable instruction packs.
 *
 * Mounted at /api/skills (server/index.js: `requireCapability('skills')`).
 *
 * ── S1 additions (Bee Flow Builder redesign, Sep 2026) ──────────────
 *   GET  /               rows carry `canEdit` and `lastTest {status, adviceCount, ranAt}|null`
 *   GET  /usage-summary  { summary: { [skillId]: { agents, automations, lastUsedAt } } }
 *   GET  /:id/usage      { usage: [ UsedByTab rows ] }  — agents that attach it, AI steps that apply it
 *   GET  /:id/test-runs  { runs: [ last 20 ] }          — written by S3's test endpoint;
 *                        `manage_skills` + editable-only (see the route)
 *
 * ── S3 additions ────────────────────────────────────────────────────
 *   POST /ai/draft       { sentence } → { draft }       — a whole skill, not stored
 *   POST /:id/ai/improve { note? }    → { skill }       — rewrites AND persists
 *   GET  /test-agents    { agents }                     — who you may test as
 *   POST /:id/test       { agentId?, question } → SSE   — one sandboxed turn,
 *                        graded per step, one `skill_test_runs` row
 *
 * ── The Skill store (2026-11) ───────────────────────────────────────
 *   GET  /store-stats    { stats: { [skillId]: { uses, lastUsedByMeAt } } }
 *   POST /:id/copy       { name? } → 201 the caller's private copy of a visible skill
 *   POST / and PUT /:id accept `agentOnly` (boolean) and `category` (text or null)
 *
 *   POST / and PUT /:id accept the structured fields next to the text ones:
 *     steps, rulesV2, examplesV2, outputSchema, knowledgeBaseIds, allowedAutomationIds
 *     (precedence rule in stores/skillStore.js; a string in a structured field → 400 `invalid_structure`)
 *   PUT  /:id  owner OR manage_skills in the skill's own org; 403 `not_editable` otherwise
 *   DELETE /:id  409 `in_use` with the usage list unless `confirmBreaking=true`
 *
 * ── PERMISSIONS ─────────────────────────────────────────────────────
 * `requireAuth` is the only router-wide middleware; every route carries its
 * own gate. Every route that reaches the skill EDITOR carries `manage_skills`
 * — a read-only one too — so the refusal is honest the moment the screen
 * opens. That is: the two example reads, `POST /`, `/:id/examples/
 * from-message`, `/ai/draft`, `/:id/ai/improve`, `/test-agents`, `/:id/test`,
 * `/:id/test-runs` and `PUT /:id`. Ungated are only the reads that show what
 * the caller can already see — `GET /`, `/usage-summary`, `/:id`, `/:id/usage`
 * — and `DELETE /:id`, which settles on owner (or admin) in the store.
 * `PUT /:id`, `/:id/ai/improve` and `/:id/test-runs` additionally refuse a
 * visible-but-not-editable skill with 403 `not_editable`: the permission says
 * this account edits skills SOMEWHERE, the row says whether it edits THIS one.
 *
 * Mobile (mobile/src/features/skills) sends the six text fields only and
 * reads `{ success: true }` back from PUT — both unchanged.
 *
 * ── WHAT A CALLER MAY SEND ──────────────────────────────────────────
 * Every body and query is `.strict()`, including the ones whose handlers
 * live in ./skills/*.js — those are plain functions, so this file is where
 * their door is. What that closed, every one of it under a 2xx:
 *
 *   - a misspelled `sharedGroup` next to `isShared: true` shared the skill
 *     with the WHOLE organisation (no groups = everyone), and
 *     `sharedGroups: [""]` got there too, its one entry lost to
 *     filter(Boolean);
 *   - `enabledIntegrations: "gmail"` (a string, not a list) CLEARED every
 *     integration the skill had: the sanitiser reads a non-list as `[]`;
 *   - `isShared: "true"` was stored as FALSE (the store's `=== true`), so a
 *     PUT meant to share a skill unshared it; `dynamicActivation: "true"`
 *     likewise stored a static skill;
 *   - `POST /:id/ai/improve {"notes": …}` rewrote and STORED the skill
 *     without the instruction the person typed;
 *   - `POST /:id/examples/from-message` read `messageIndex: null` (or "")
 *     as message 0 — `Number(null) === 0` — and filed the wrong example;
 *   - `PUT /:id {"name": ""}` blanked the name that `POST /` requires.
 *
 * The six structured facets (steps, rulesV2, examplesV2, outputSchema,
 * knowledgeBaseIds, allowedAutomationIds) stay open HERE on purpose: the
 * store's skillStructure checks them, and its 400 carries
 * `code: 'invalid_structure'` plus the `field`, which is what the Studio's
 * autosave toasts on. A schema here would answer first, without either.
 * Required-but-blank checks with their own codes (`no_sentence`,
 * `no_question`) likewise stay in the handlers; the schema only refuses the
 * wrong TYPE and the unknown key.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const skillStore = require('../stores/skillStore');
const managedParts = require('../stores/managedPartsDefault');
const solutionStageStore = require('../stores/solutionStageStore');
const { requirePermission, validateSharedGroupsForOrg, requireActiveOrgForMutations } = require('../auth');
const { sanitizeEnabledIntegrations } = require('../core/tools/skillInjection');
const { SkillStructureError } = require('../core/skills/skillStructure');
const { validate } = require('../core/http/validate');

// What a caller may send (every body and query `.strict()`, see the header): ./skills/skillSchemas.mts.
const {
    NoQuery, CreateSkillBody, UpdateSkillBody, CopyBody, DeleteBody, DeleteQuery,
    DraftBody, ImproveBody, TestBody, FromMessageBody,
} = require('./skills/skillSchemas.mts');

// Block all writes when the caller's org is suspended/archived.
router.use(requireActiveOrgForMutations());

// ── Auth guard (same pattern as other routes) ────────────────
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth, hasPermission } = require('../auth/permissions');

router.use(requireAuth);

// ── S2: examples taken from one of the caller's OWN conversations ──
// The handlers live in ./skills/examples.js (owner-scoped conversation read
// + detectPii/tokenizeText before anything is shown or stored) and are
// required LAZILY, on first request: skills.test.js stubs this file's
// dependencies through a parent-keyed resolve hook, so an eager require
// would drag a real database and a real PII guard into a DB-free suite.
// Registered before `/:id`, the same reason `/usage-summary` is.
//
// Both reads carry `manage_skills` as well, even though they only ever return
// the CALLER'S OWN conversations and so leak nothing across accounts. They
// exist for one purpose — feeding the write below, which requires that
// permission — and every route that reaches the skill editor at all requires
// it (PUT /:id does). Gating them makes the refusal honest at the moment the
// picker opens instead of after someone has chosen a message, and leaves no
// "read my chats through the skills API" surface for an account that could
// not have created the example anyway.
const examples = () => require('./skills/examples');
router.get('/examples/conversations', requirePermission('manage_skills'), validate({ query: NoQuery }), (req, res) => examples().listConversations(req, res));
router.get('/examples/conversations/:conversationId/messages', requirePermission('manage_skills'), validate({ query: NoQuery }), /** @param {import('express').Request<{ conversationId: string }>} req */ (req, res) => examples().listMessages(req, res));

// ── S3: drafting with AI, and the Test tab ─────────────────────────
// Same lazy-require rule as the examples handlers above, and it matters more
// here: these files reach the LLM client, the provider adapters and the
// knowledge search. Their rate limiters live in those modules (one per
// module, created once) and are reached through the same deferred require,
// so registering a route never loads them either.
const ai = () => require('./skills/ai');
const tests = () => require('./skills/test');
/** @type {import('express').RequestHandler} */
const aiLimit = (req, res, next) => ai().limiter(req, res, next);
/** @type {import('express').RequestHandler} */
const testLimit = (req, res, next) => tests().limiter(req, res, next);

// Before `/:id`, the same reason `/usage-summary` is: the literal strings
// would otherwise be read as skill ids.
router.post('/ai/draft', requirePermission('manage_skills'), validate({ body: DraftBody }), aiLimit, (req, res) => ai().draft(req, res));
// `manage_skills` for the same reason `/examples/conversations` carries it:
// this picker exists only to feed the Test tab, which lives behind that
// permission, so the refusal belongs at the moment the picker opens.
router.get('/test-agents', requirePermission('manage_skills'), validate({ query: NoQuery }), (req, res) => tests().listAgents(req, res));

// Helper: resolve the user's org ID
/** @param {import('express').Request} req */
async function getOrgId(req) {
    const userStore = require('../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

// The viewer context the store uses for per-row `canEdit`.
/** @param {import('express').Request} req */
async function viewerOf(req) {
    let canManage = false;
    try { canManage = await hasPermission(req.session.user.id, 'manage_skills', req.session); } catch (_) { canManage = false; }
    return { canManage: canManage === true };
}

// A malformed structured field is the caller's mistake, not a 500.
/**
 * @param {import('express').Response} res
 * @param {Error & { status?: number, code?: string, field?: string | null }} err
 */
function answerStructureError(res, err) {
    if (err instanceof SkillStructureError || err?.name === 'SkillStructureError') {
        res.status(err.status || 400).json({ error: err.message, code: err.code || 'invalid_structure', field: err.field || null });
        return true;
    }
    return false;
}

/** @param {import('express').Request} req */
function confirmedBreaking(req) {
    return req.body?.confirmBreaking === true || req.query?.confirmBreaking === 'true';
}

// The structured fields a body may carry; `undefined` = not sent = leave as-is.
/** @param {Record<string, unknown>} body the validated request body */
function pickStructured(body) {
    const { steps, rulesV2, examplesV2, outputSchema, knowledgeBaseIds, allowedAutomationIds } = body || {};
    return { steps, rulesV2, examplesV2, outputSchema, knowledgeBaseIds, allowedAutomationIds };
}

// ── GET /api/skills — list available skills ──────────────────
router.get('/', validate({ query: NoQuery }), async (req, res) => {
    // orgId may be null — getAvailableSkills then returns the user's personal
    // (org-less) skills.
    const orgId = await getOrgId(req);
    const viewer = await viewerOf(req);
    const skills = await skillStore.getAvailableSkills(orgId, req.session.user.id, { ...viewer, withLastTest: true });
    res.json(skills);
});

// ── GET /api/skills/usage-summary — counts per skill (before /:id) ──
router.get('/usage-summary', validate({ query: NoQuery }), async (req, res) => {
    const orgId = await getOrgId(req);
    const skills = await skillStore.getAvailableSkills(orgId, req.session.user.id);
    const summary = await skillStore.getUsageSummary(orgId, skills.map(s => s.id));
    res.json({ summary });
});

// ── GET /api/skills/store-stats — the Skill store's sort keys (before /:id) ──
// `{ stats: { [skillId]: { uses, lastUsedByMeAt } } }` for the skills the
// caller can see: how often a skill was used (Popular) and when THIS account
// last used it (Recently used). Nobody else's use time leaves the server.
router.get('/store-stats', validate({ query: NoQuery }), async (req, res) => {
    const orgId = await getOrgId(req);
    const skills = await skillStore.getAvailableSkills(orgId, req.session.user.id);
    const stats = await skillStore.getStoreStats(skills.map(s => s.id), req.session.user.id);
    res.json({ stats });
});

// ── POST /api/skills — create a new skill ────────────────────
router.post('/', requirePermission('manage_skills'), validate({ body: CreateSkillBody }), async (req, res) => {
    try {
        // orgId may be null — the skill is then created as a personal skill
        // (org_id NULL, owned by the creator). Sharing to groups still requires
        // an org (validateSharedGroupsForOrg rejects non-empty groups when null).
        const orgId = await getOrgId(req);

        // The schema has refused a blank name and instructions over 4000
        // characters (the cap that keeps the system prompt bounded).
        const { name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups, automationId, enabledIntegrations, agentOnly, category } = /** @type {Record<string, any>} */ (req.body);

        const cleanedGroups = await validateSharedGroupsForOrg(orgId, sharedGroups);
        await require('../usecases/skills/automationLink').assertMayLinkAutomation(automationId, req.session.user.id);
        const skill = await skillStore.createSkill({
            orgId,
            userId: req.session.user.id,
            name,
            description,
            instructions,
            workflow,
            rules,
            examples,
            icon,
            isShared,
            dynamicActivation,
            sharedGroups: cleanedGroups || [],
            automationId: automationId || null,
            enabledIntegrations: sanitizeEnabledIntegrations(enabledIntegrations),
            agentOnly,
            category,
            ...pickStructured(req.body),
        });
        res.status(201).json({ ...skill, canEdit: true });
    } catch (err) {
        if (answerStructureError(res, err)) return;
        throw err;
    }
});

/**
 * `managed: null | {solutionId, solutionName, stage, releaseSeq, devRef}`: the
 * Solution stage that owns this skill (design 5.3). The client never derives
 * it; a skill outside a stage project answers null without a stage read.
 * @param {{ id: string, projectId?: string | null }} skill
 */
async function managedOf(skill) {
    if (!skill?.projectId || !(await managedParts.managedInfo(skill.projectId))) return null;
    return solutionStageStore.managedPayloadFor({ projectId: skill.projectId, kind: 'skill', entityId: skill.id });
}

// ── GET /api/skills/:id — get skill details ──────────────────
router.get('/:id', validate({ query: NoQuery }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    // orgId may be null → getSkill resolves the caller's personal skill.
    const orgId = await getOrgId(req);
    const viewer = await viewerOf(req);
    const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, viewer);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    res.json({ ...skill, managed: await managedOf(skill) });
});

// ── GET /api/skills/:id/usage — who uses this skill ──────────
router.get('/:id/usage', validate({ query: NoQuery }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    const orgId = await getOrgId(req);
    const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    // `unchecked` names the kinds the scan could NOT look at (an install
    // with no automations table). The client already reads it — useUsage's
    // `normaliseUnchecked`, UsedByTab's narrower empty line, DangerZone's
    // narrower delete line — and answering `{usage}` alone was the reason
    // none of that could ever fire: the tab said "nothing uses this" for a
    // kind nobody had scanned.
    const { rows, unchecked } = await skillStore.listSkillUsage(skill.id, skill.orgId);
    res.json({ usage: rows, unchecked });
});

// ── GET /api/skills/:id/test-runs — the last 20 Test-tab runs ──
// The rows are NOT metadata: every one carries the free-text question a
// colleague typed into the Test tab, and in this product those questions
// routinely name a customer, a person or a case. Seeing a skill is therefore
// not enough to read them — a skill shared through a group is visible to
// people who may not edit it (skillStore.canEditSkill keeps "visible" and
// "editable" deliberately apart), and their test history is not part of what
// that share hands over. So: `manage_skills` on the route, and the row is
// fetched WITH the viewer so `canEdit` is real.
// 403, not 404: the skill itself is visible, so a 404 would lie about it —
// the same answer POST /:id/ai/improve gives (routes/skills/ai.js).
router.get('/:id/test-runs', requirePermission('manage_skills'), validate({ query: NoQuery }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    const orgId = await getOrgId(req);
    const viewer = await viewerOf(req);
    const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, viewer);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    if (!skill.canEdit) return res.status(403).json({ error: 'You cannot see the test history of this skill', code: 'not_editable' });
    const runs = await skillStore.listTestRuns(skill.id);
    res.json({ runs });
});

/**
 * A skill in a Solution stage changes only through a deploy (design 5.2). The
 * from-message and AI-improve handlers write through updateSkill inside their
 * own catch-all, which would turn the store's 409 managed_part into a 500 (and
 * the AI rewrite would spend a model call first). So the refusal is asked here,
 * before the handler, and goes to the terminal handler with its status, code
 * and details. Only for a caller who may edit the skill: anyone else still
 * reads the handler's own 404/403, never which Solution holds it.
 *
 * @param {string[]} changedKeys  what the handler would change
 */
function refuseStageSkill(changedKeys) {
    return /** @param {import('express').Request<{ id: string }>} req @param {import('express').Response} res @param {import('express').NextFunction} next */ async (req, res, next) => {
        const orgId = await getOrgId(req);
        const viewer = await viewerOf(req);
        const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, viewer);
        if (skill?.projectId && skill.canEdit) {
            await managedParts.assertManagedWrite({ kind: 'skill', projectId: skill.projectId, changedKeys, managedWrite: null });
        }
        next();
    };
}

// ── POST /api/skills/:id/examples/from-message ───────────────
// Turn one message of the caller's OWN conversation into an example. Same
// `manage_skills` gate as every other skill write; the handler re-checks
// `canEdit` on the row and reads the conversation owner-scoped.
router.post('/:id/examples/from-message', requirePermission('manage_skills'), validate({ body: FromMessageBody }), refuseStageSkill(['examplesV2']), /** @param {import('express').Request<{ id: string }>} req */ (req, res) => examples().fromMessage(req, res));

// ── POST /api/skills/:id/ai/improve — rewrite this skill with AI ─────
// A WRITE: it persists through updateSkill and answers with the stored row.
// Same gate as every other skill write; the handler re-checks `canEdit`.
router.post('/:id/ai/improve', requirePermission('manage_skills'), validate({ body: ImproveBody }), refuseStageSkill(['instructions']), aiLimit, /** @param {import('express').Request<{ id: string }>} req */ (req, res) => ai().improve(req, res));

// ── POST /api/skills/:id/test — one question through the steps (SSE) ──
// Writes a `skill_test_runs` row that the overview reads as a verdict, and
// spends tokens, so it carries the same gate as the other skill writes.
// The body is checked before the stream opens, so a refusal is still JSON.
router.post('/:id/test', requirePermission('manage_skills'), validate({ body: TestBody }), testLimit, /** @param {import('express').Request<{ id: string }>} req */ (req, res) => tests().run(req, res));

// ── POST /api/skills/:id/copy — your own copy of a skill you can see ──
// The Skill store's "Make a copy": change it without changing the original.
// No new right: what the caller can SEE (getSkill's visibility) is what it may
// copy, and creating a skill is `manage_skills`, the gate of POST /. The copy
// is the caller's, private, in the caller's organisation and in no project; a
// link to an automation the caller may not start is left off rather than
// refused, the same rule POST / applies (usecases/skills/automationLink).
router.post('/:id/copy', requirePermission('manage_skills'), validate({ body: CopyBody }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    const orgId = await getOrgId(req);
    const userId = req.session.user.id;
    const source = await skillStore.getSkill(req.params.id, orgId, userId);
    if (!source) return res.status(404).json({ error: 'Skill not found' });
    let automationId = source.automationId || null;
    try {
        await require('../usecases/skills/automationLink').assertMayLinkAutomation(automationId, userId);
    } catch (_) {
        automationId = null;
    }
    const name = String(req.body?.name || '').trim() || source.name;
    const copy = await skillStore.createSkill({
        orgId, userId, name,
        description: source.description, instructions: source.instructions,
        workflow: source.workflow, rules: source.rules, examples: source.examples,
        icon: source.icon, isShared: false, sharedGroups: [],
        dynamicActivation: source.dynamicActivation === true,
        agentOnly: source.agentOnly === true, category: source.category ?? null,
        automationId,
        enabledIntegrations: sanitizeEnabledIntegrations(source.enabledIntegrations),
        steps: source.steps, rulesV2: source.rulesV2, examplesV2: source.examplesV2,
        outputSchema: source.outputSchema, knowledgeBaseIds: source.knowledgeBaseIds,
        allowedAutomationIds: source.allowedAutomationIds,
    });
    res.status(201).json({ ...copy, canEdit: true });
});

// ── PUT /api/skills/:id — update a skill ─────────────────────
router.put('/:id', requirePermission('manage_skills'), validate({ body: UpdateSkillBody }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    try {
        // Instructions over 4000 characters are the schema's refusal, before
        // anything is read or written.
        const { name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups, automationId, enabledIntegrations, agentOnly, category } = req.body;

        // Owner OR manage_skills in the skill's own org (the design's "a
        // change here applies everywhere at once"). The middleware proved
        // manage_skills; the store widens only to the CALLER'S org, so a
        // manager of another org never matches. Visible-but-not-editable is
        // a 403, not a 404 — the 350ms autosave must not retry a 404 forever.
        const orgId = await getOrgId(req);
        const existing = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, { canManage: true });
        if (!existing) return res.status(404).json({ error: 'Skill not found' });
        if (!existing.canEdit) return res.status(403).json({ error: 'You cannot edit this skill', code: 'not_editable' });
        await require('../usecases/skills/automationLink').assertMayLinkAutomation(automationId, req.session.user.id, existing.automationId);

        // Validate sharedGroups belong to the skill's org. `undefined` means
        // "leave as-is" — the store preserves the existing value.
        const cleanedGroups = sharedGroups !== undefined ? await validateSharedGroupsForOrg(orgId, sharedGroups) : undefined;
        const updated = await skillStore.updateSkill(req.params.id, req.session.user.id, {
            name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation,
            agentOnly, category,
            sharedGroups: cleanedGroups,
            automationId,
            // undefined = leave as-is (same semantics as sharedGroups)
            enabledIntegrations: enabledIntegrations !== undefined ? sanitizeEnabledIntegrations(enabledIntegrations) : undefined,
            ...pickStructured(req.body),
        }, { managerOrgId: existing.orgId && existing.orgId === orgId ? orgId : null });
        if (!updated) return res.status(404).json({ error: 'Skill not found or not owner' });
        res.json({ success: true });
    } catch (err) {
        if (answerStructureError(res, err)) return;
        throw err;
    }
});

// ── DELETE /api/skills/:id — delete a skill ──────────────────
router.delete('/:id', validate({ query: DeleteQuery, body: DeleteBody }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
    const isAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';
    const orgId = await getOrgId(req);

    // Anything that attaches or applies this skill stops working the
    // moment it is gone. Ask once (same contract as datatables): 409 with
    // the list, unless the caller confirmed the breakage.
    if (!confirmedBreaking(req)) {
        const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id);
        if (skill) {
            const { rows, unchecked } = await skillStore.listSkillUsage(skill.id, skill.orgId);
            if (rows.length > 0) {
                return res.status(409).json({ error: 'This skill is still in use', code: 'in_use', usage: rows, unchecked });
            }
        }
    }

    const deleted = await skillStore.deleteSkill(req.params.id, req.session.user.id, isAdmin);
    if (!deleted) return res.status(404).json({ error: 'Skill not found or not owner' });

    // Scrub the deleted skill id from every agent in this org that had it attached.
    // Non-fatal: a failure here leaves a dangling id that the runtime simply ignores.
    try {
        const agentStore = require('../stores/agentStore');
        const scrubbed = await agentStore.scrubSkillFromAllAgents(orgId, req.params.id);
        if (scrubbed > 0) log.info(`[Skills] Scrubbed deleted skill ${req.params.id} from ${scrubbed} agent(s)`);
    } catch (scrubErr) {
        log.warn('[Skills] Scrub after delete failed:', /** @type {Error} */ (scrubErr).message);
    }

    res.json({ success: true });
});

module.exports = router;
// The one place a SkillStructureError becomes an HTTP answer. `./skills/
// examples.js` reaches it through this property (a lazy require inside its
// catch — this module is always loaded by then, since it is the only thing
// that loads that file), so the from-message write refuses with the same
// `400 {code}` the PUT does instead of a bare 500.
/** @type {import('express').Router & Record<string, unknown>} */ (module.exports).answerStructureError = answerStructureError;
