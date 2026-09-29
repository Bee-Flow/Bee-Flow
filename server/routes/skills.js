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
const { requirePermission, validateSharedGroupsForOrg, requireActiveOrgForMutations } = require('../auth');
const { sanitizeEnabledIntegrations } = require('../core/tools/skillInjection');
const { SkillStructureError } = require('../core/skills/skillStructure');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** Express 5 leaves `req.body` undefined without a body; read that as `{}`. */
const orEmpty = (schema) => z.preprocess((v) => (v === undefined || v === null ? {} : v), schema);
const NoQuery = orEmpty(z.object({}).strict());

const NAME_TEXT = 'A skill needs a name.';
const GROUP_TEXT = 'Each shared group is the id of a group.';
const INTEGRATION_TEXT = 'Each enabled integration is the id of an app.';
const skillName = worded(NAME_TEXT).trim().min(1, NAME_TEXT);

/** The writable fields of a skill, shared by POST / and PUT /:id. All optional here. */
const SKILL_FIELDS = {
    description: worded('A description must be text.'),
    // Checked untrimmed, as it always was: the editor caps at exactly 4000
    // (SkillDetail's INSTRUCTION_LIMIT), and the two limits must be one limit.
    instructions: worded('Instructions must be text.').max(4000, 'Instructions too long (max 4000 characters)'),
    workflow: worded('The workflow must be text.'),
    rules: worded('The rules must be text.'),
    examples: worded('The examples must be text.'),
    icon: worded('An icon must be text.'),
    isShared: z.boolean({ invalid_type_error: 'isShared is true or false.' }),
    dynamicActivation: z.boolean({ invalid_type_error: 'dynamicActivation is true or false.' }),
    // `[]` is "the whole organisation" (with isShared); a blank entry is
    // refused rather than dropped, because dropping the only one is `[]` too.
    // null leaves the groups as they are.
    sharedGroups: z.array(worded(GROUP_TEXT).trim().min(1, GROUP_TEXT),
        { invalid_type_error: 'sharedGroups is a list of group ids.' }).nullable(),
    automationId: worded('automationId is the id of a routine, or null for none.').nullable(),
    // Not narrowed to KNOWN apps: a stored skill may carry one that has since
    // left the registry, and the autosave resends the whole list every time.
    // The sanitiser drops those, as before; the schema refuses the wrong shape.
    enabledIntegrations: z.array(worded(INTEGRATION_TEXT),
        { invalid_type_error: 'enabledIntegrations is a list of app ids.' }).nullable(),
    steps: z.unknown(),
    rulesV2: z.unknown(),
    examplesV2: z.unknown(),
    outputSchema: z.unknown(),
    knowledgeBaseIds: z.unknown(),
    allowedAutomationIds: z.unknown(),
};
const optionalFields = Object.fromEntries(Object.entries(SKILL_FIELDS).map(([k, s]) => [k, s.optional()]));

const CreateSkillBody = orEmpty(z.object({ name: skillName, ...optionalFields }).strict());
const UpdateSkillBody = orEmpty(z.object({ name: skillName.optional(), ...optionalFields }).strict());

const CONFIRM_TEXT = 'confirmBreaking is true once the list of what breaks has been seen.';
const DeleteBody = orEmpty(z.object({
    confirmBreaking: z.boolean({ invalid_type_error: CONFIRM_TEXT }).optional(),
}).strict());
const DeleteQuery = orEmpty(z.object({
    confirmBreaking: z.enum(['true', 'false'], { errorMap: () => ({ message: CONFIRM_TEXT }) }).optional(),
}).strict());

// The bodies of the handlers in ./skills/*.js. Types and keys only: a blank
// sentence or question is the handler's refusal, with its own code.
const DraftBody = orEmpty(z.object({
    sentence: worded('The sentence must be text.').optional(),
}).strict());
const ImproveBody = orEmpty(z.object({
    note: worded('The note must be text.').optional(),
}).strict());
const TestBody = orEmpty(z.object({
    agentId: worded('agentId is the id of an agent, or null to test without one.').nullable().optional(),
    question: worded('The question must be text.').optional(),
}).strict());
const MESSAGE_TEXT = 'messageIndex is the position of the message in the conversation, from 0.';
const CONVERSATION_TEXT = 'conversationId is the id of one of your conversations.';
const FromMessageBody = orEmpty(z.object({
    conversationId: worded(CONVERSATION_TEXT).trim().min(1, CONVERSATION_TEXT),
    messageIndex: z.number({ required_error: MESSAGE_TEXT, invalid_type_error: MESSAGE_TEXT }).int(MESSAGE_TEXT).min(0, MESSAGE_TEXT),
    question: worded('The question must be text.').optional(),
}).strict());

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
router.get('/examples/conversations/:conversationId/messages', requirePermission('manage_skills'), validate({ query: NoQuery }), (req, res) => examples().listMessages(req, res));

// ── S3: drafting with AI, and the Test tab ─────────────────────────
// Same lazy-require rule as the examples handlers above, and it matters more
// here: these files reach the LLM client, the provider adapters and the
// knowledge search. Their rate limiters live in those modules (one per
// module, created once) and are reached through the same deferred require,
// so registering a route never loads them either.
const ai = () => require('./skills/ai');
const tests = () => require('./skills/test');
const aiLimit = (req, res, next) => ai().limiter(req, res, next);
const testLimit = (req, res, next) => tests().limiter(req, res, next);

// Before `/:id`, the same reason `/usage-summary` is: the literal strings
// would otherwise be read as skill ids.
router.post('/ai/draft', requirePermission('manage_skills'), validate({ body: DraftBody }), aiLimit, (req, res) => ai().draft(req, res));
// `manage_skills` for the same reason `/examples/conversations` carries it:
// this picker exists only to feed the Test tab, which lives behind that
// permission, so the refusal belongs at the moment the picker opens.
router.get('/test-agents', requirePermission('manage_skills'), validate({ query: NoQuery }), (req, res) => tests().listAgents(req, res));

// Helper: resolve the user's org ID
async function getOrgId(req) {
    const userStore = require('../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

// The viewer context the store uses for per-row `canEdit`.
async function viewerOf(req) {
    let canManage = false;
    try { canManage = await hasPermission(req.session.user.id, 'manage_skills', req.session); } catch (_) { canManage = false; }
    return { canManage: canManage === true };
}

// A malformed structured field is the caller's mistake, not a 500.
function answerStructureError(res, err) {
    if (err instanceof SkillStructureError || err?.name === 'SkillStructureError') {
        res.status(err.status || 400).json({ error: err.message, code: err.code || 'invalid_structure', field: err.field || null });
        return true;
    }
    return false;
}

function confirmedBreaking(req) {
    return req.body?.confirmBreaking === true || req.query?.confirmBreaking === 'true';
}

// The structured fields a body may carry; `undefined` = not sent = leave as-is.
function pickStructured(body) {
    const { steps, rulesV2, examplesV2, outputSchema, knowledgeBaseIds, allowedAutomationIds } = body || {};
    return { steps, rulesV2, examplesV2, outputSchema, knowledgeBaseIds, allowedAutomationIds };
}

// ── GET /api/skills — list available skills ──────────────────
router.get('/', validate({ query: NoQuery }), async (req, res) => {
    try {
        // orgId may be null — getAvailableSkills then returns the user's personal
        // (org-less) skills.
        const orgId = await getOrgId(req);
        const viewer = await viewerOf(req);
        const skills = await skillStore.getAvailableSkills(orgId, req.session.user.id, { ...viewer, withLastTest: true });
        res.json(skills);
    } catch (err) {
        log.error('[Skills] GET / error:', err);
        res.status(500).json({ error: 'Failed to load skills' });
    }
});

// ── GET /api/skills/usage-summary — counts per skill (before /:id) ──
router.get('/usage-summary', validate({ query: NoQuery }), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        const skills = await skillStore.getAvailableSkills(orgId, req.session.user.id);
        const summary = await skillStore.getUsageSummary(orgId, skills.map(s => s.id));
        res.json({ summary });
    } catch (err) {
        log.error('[Skills] GET /usage-summary error:', err);
        res.status(500).json({ error: 'Failed to load skill usage' });
    }
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
        const { name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups, automationId, enabledIntegrations } = req.body;

        let cleanedGroups;
        try {
            cleanedGroups = await validateSharedGroupsForOrg(orgId, sharedGroups);
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }
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
            ...pickStructured(req.body),
        });
        res.status(201).json({ ...skill, canEdit: true });
    } catch (err) {
        if (answerStructureError(res, err)) return;
        log.error('[Skills] POST / error:', err);
        res.status(500).json({ error: 'Failed to create skill' });
    }
});

// ── GET /api/skills/:id — get skill details ──────────────────
router.get('/:id', validate({ query: NoQuery }), async (req, res) => {
    try {
        // orgId may be null → getSkill resolves the caller's personal skill.
        const orgId = await getOrgId(req);
        const viewer = await viewerOf(req);
        const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, viewer);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        res.json(skill);
    } catch (err) {
        log.error('[Skills] GET /:id error:', err);
        res.status(500).json({ error: 'Failed to load skill' });
    }
});

// ── GET /api/skills/:id/usage — who uses this skill ──────────
router.get('/:id/usage', validate({ query: NoQuery }), async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[Skills] GET /:id/usage error:', err);
        res.status(500).json({ error: 'Failed to load skill usage' });
    }
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
router.get('/:id/test-runs', requirePermission('manage_skills'), validate({ query: NoQuery }), async (req, res) => {
    try {
        const orgId = await getOrgId(req);
        const viewer = await viewerOf(req);
        const skill = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, viewer);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        if (!skill.canEdit) return res.status(403).json({ error: 'You cannot see the test history of this skill', code: 'not_editable' });
        const runs = await skillStore.listTestRuns(skill.id);
        res.json({ runs });
    } catch (err) {
        log.error('[Skills] GET /:id/test-runs error:', err);
        res.status(500).json({ error: 'Failed to load test runs' });
    }
});

// ── POST /api/skills/:id/examples/from-message ───────────────
// Turn one message of the caller's OWN conversation into an example. Same
// `manage_skills` gate as every other skill write; the handler re-checks
// `canEdit` on the row and reads the conversation owner-scoped.
router.post('/:id/examples/from-message', requirePermission('manage_skills'), validate({ body: FromMessageBody }), (req, res) => examples().fromMessage(req, res));

// ── POST /api/skills/:id/ai/improve — rewrite this skill with AI ─────
// A WRITE: it persists through updateSkill and answers with the stored row.
// Same gate as every other skill write; the handler re-checks `canEdit`.
router.post('/:id/ai/improve', requirePermission('manage_skills'), validate({ body: ImproveBody }), aiLimit, (req, res) => ai().improve(req, res));

// ── POST /api/skills/:id/test — one question through the steps (SSE) ──
// Writes a `skill_test_runs` row that the overview reads as a verdict, and
// spends tokens, so it carries the same gate as the other skill writes.
// The body is checked before the stream opens, so a refusal is still JSON.
router.post('/:id/test', requirePermission('manage_skills'), validate({ body: TestBody }), testLimit, (req, res) => tests().run(req, res));

// ── PUT /api/skills/:id — update a skill ─────────────────────
router.put('/:id', requirePermission('manage_skills'), validate({ body: UpdateSkillBody }), async (req, res) => {
    try {
        // Instructions over 4000 characters are the schema's refusal, before
        // anything is read or written.
        const { name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups, automationId, enabledIntegrations } = req.body;

        // Owner OR manage_skills in the skill's own org (the design's "a
        // change here applies everywhere at once"). The middleware proved
        // manage_skills; the store widens only to the CALLER'S org, so a
        // manager of another org never matches. Visible-but-not-editable is
        // a 403, not a 404 — the 350ms autosave must not retry a 404 forever.
        const orgId = await getOrgId(req);
        const existing = await skillStore.getSkill(req.params.id, orgId, req.session.user.id, { canManage: true });
        if (!existing) return res.status(404).json({ error: 'Skill not found' });
        if (!existing.canEdit) return res.status(403).json({ error: 'You cannot edit this skill', code: 'not_editable' });

        // Validate sharedGroups belong to the skill's org. `undefined` means
        // "leave as-is" — the store preserves the existing value.
        let cleanedGroups;
        if (sharedGroups !== undefined) {
            try {
                cleanedGroups = await validateSharedGroupsForOrg(orgId, sharedGroups);
            } catch (e) {
                return res.status(e.status || 500).json({ error: e.message });
            }
        }
        const updated = await skillStore.updateSkill(req.params.id, req.session.user.id, {
            name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation,
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
        log.error('[Skills] PUT /:id error:', err);
        res.status(500).json({ error: 'Failed to update skill' });
    }
});

// ── DELETE /api/skills/:id — delete a skill ──────────────────
router.delete('/:id', validate({ query: DeleteQuery, body: DeleteBody }), async (req, res) => {
    try {
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
            log.warn('[Skills] Scrub after delete failed:', scrubErr.message);
        }

        res.json({ success: true });
    } catch (err) {
        log.error('[Skills] DELETE /:id error:', err);
        res.status(500).json({ error: 'Failed to delete skill' });
    }
});

module.exports = router;
// The one place a SkillStructureError becomes an HTTP answer. `./skills/
// examples.js` reaches it through this property (a lazy require inside its
// catch — this module is always loaded by then, since it is the only thing
// that loads that file), so the from-message write refuses with the same
// `400 {code}` the PUT does instead of a bare 500.
module.exports.answerStructureError = answerStructureError;
