/**
 * Test sets — the Testen tab (A1c).
 *
 *   GET    /agents/:id/tests            the questions + the last run
 *   GET    /agents/:id/tests/runs       the run history behind "Bekijk"
 *   POST   /agents/:id/tests            add one
 *   POST   /agents/:id/tests/suggest    propose an `expect` from one chat turn
 *   PUT    /agents/:id/tests/:testId    edit one
 *   DELETE /agents/:id/tests/:testId    remove one
 *   POST   /agents/:id/tests/run        play them back (SSE)
 *
 * ── THE EDITOR'S RIGHT, NOT THE AUDIENCE'S ──────────────────────────
 * Every route here asks for the same right `PUT /agents/:id` does: someone who
 * cannot read the agent gets the 404 `GET /:id` gives them, someone who can
 * chat with it but not edit it gets 403 `agent_not_editable`. A test set is
 * part of the agent's definition — its questions say what the agent is
 * supposed to know — and running one spends inference on somebody's key.
 *
 * ── A RUN IS A REAL TURN, IN A SANDBOX THAT ONLY NARROWS ────────────
 * Each test goes through `chatWithAgentStream` — the real prompt, the real
 * knowledge, the real tools — because a test against a mock proves nothing
 * about the agent people talk to. Three flags shape it, and all three take
 * things away:
 *   `ephemeral: true`   nothing is written to a conversation;
 *   `testSandbox: true` toolStackAssembly drops everything that sends, every
 *                       routine, and everything that would ask for approval;
 *   `unattended: true`  the existing headless rule, so a curated agent's
 *                       confirm-tools are dropped by the policy as well.
 * `autoSend` is passed as an explicit `false`. It is the flag that turns a
 * draft into a real send for headless routines, and `unattended` alone is
 * enough to get the drop — writing it out means nobody can add it here by
 * reflex later.
 *
 * ── WHICH AGENT DID THIS VERDICT DESCRIBE ───────────────────────────
 * `chatWithAgentStream` runs `getForRuntime`, so a published agent is tested
 * as PUBLISHED — not as the draft in the editor. That is not hidden: the run
 * records (and streams) the `version` it exercised, its `source`, and the
 * concept `rev` at the time, so the publish dialog can say "these results are
 * about v3, and you have 5 unpublished changes" instead of presenting a stale
 * pass as a verdict on what you are about to ship. Testing the draft would
 * mean a config override through the whole runtime; that is A2's problem, and
 * claiming it silently here would be the worse half.
 *
 * ── A RUN THAT DID NOT FINISH IS NOT A RUN ──────────────────────────
 * If the client disconnects half way, nothing is stored. "3 of 3 green" out of
 * nine tests is the single most misleading row this table could hold, and the
 * publish dialog reads exactly that row.
 *
 * ── WHAT A RUN COSTS, AND WHO SEES THE ANSWER ──────────────────────
 * One press is up to `MAX_TESTS_PER_RUN` agent turns plus at most one grading
 * call each; the limiter below allows four presses a minute, the plan ceiling
 * is checked once per press, and a check that could not run refuses. The
 * grading call sends the agent's ANSWER to the workspace's fast tier, which
 * may be a different provider than the one that produced it — the same
 * exposure the skill test makes, and the reason nothing but the answer, the
 * expectations and the tool NAMES goes: never tool arguments, never tool
 * results.
 *
 * ── "TEST ALS · GROEP X" ────────────────────────────────────────────
 * `asGroup` on the run replays the questions with the knowledge a member of
 * ONE group would have had (`core/agentRuntime/testAs`). Three consequences
 * live here rather than in that module:
 *
 *   • the request is REFUSED when the group cannot be resolved — never
 *     downgraded to an ordinary run, which would hand back the editor's own
 *     answers under somebody else's name;
 *   • the run reports whether that group could open the agent at all
 *     (`start.audience`), because nine green answers from an agent they cannot
 *     reach is a fact worth knowing. It does not stop the run;
 *   • the result is NOT STORED. `agent_test_runs` is what the publish dialog
 *     reads as a verdict on the agent, and a deliberately narrowed score is
 *     not that. The tab still sees every result on the stream.
 *
 * `GET /:id/tests` carries the picker for it, because the admin groups
 * endpoint needs `manage_users`/`org_admin` and an agent editor need not have
 * either.
 *
 * ── "+ DIT GESPREK ALS TEST" IS EEN VOORSTEL, GEEN TEST ─────────────
 * `POST /:id/tests/suggest` laat de snelle tier opschrijven wat een goed
 * antwoord op deze vraag hoe dan ook moet overbrengen, en geeft dat TERUG. Het
 * schrijft niets. De bouwer bewerkt het en zijn eigen `POST /:id/tests` maakt
 * de rij — want een test die iets anders bewaakt dan iemand dacht wordt groen,
 * en dan gelooft niemand de hele set meer. Wat een model wel en niet mag
 * voorstellen staat in `core/agentRuntime/testSuggest`; dat het een MODEL was,
 * reist mee (`suggestedBy`, en per veld `wrote`) omdat het scherm dat moet
 * kunnen zeggen.
 *
 * Nothing here blocks publishing. `POST /:id/publish-version` does not consult
 * these tables and must not start to: the plan's own words are "you see it, it
 * does not stop you".
 *
 * Run: cd server && node --test --test-force-exit routes/agents/tests.test.js
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// The normalisers under this router are allow-lists that never throw, and
// four of their silences changed what a test MEANS:
//
//   - `expect: { mustMension: [...] }` -- one letter off -- was dropped by
//     `normaliseExpect`, so the test was stored checking NOTHING and ran
//     green for ever after, answered 201;
//   - a misspelled key on PUT left the patch empty, so the row came back
//     unchanged with a 200 while the editor said the expectation was saved;
//   - `writtenBy: 'modl'` was dropped by `normaliseWrittenBy`, and nothing
//     is exactly how this router records "a human typed this" -- a
//     provenance claim about the field that decides green or red;
//   - `testIds: 'abc'` (one id, not a list) was read as "no selection" and
//     RAN EVERY TEST, which is up to 25 agent turns on somebody's plan.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const whole = (name) => z.coerce.number({ invalid_type_error: `${name} must be a number.` })
    .int(`${name} must be a whole number.`).optional();
const RunsQuery = z.object({ limit: whole('limit') }).strict();

const QUESTION_TEXT = 'Write the question this agent should answer.';
const listOf = (name) => z.array(worded(`${name} is a list of phrases.`), { invalid_type_error: `${name} is a list of phrases.` }).optional();

/** The five things a test may check. Anything else is a typo, not a check. */
const Expect = z.object({
    mustMention: listOf('mustMention'),
    mustNotMention: listOf('mustNotMention'),
    toolsExpected: listOf('toolsExpected'),
    rulesExpected: listOf('rulesExpected'),
    notes: worded('notes must be text.').nullish(),
}).strict();

const SOURCE_TEXT = 'writtenBy names, per field, one of: ai, observed, human, empty.';
const FieldSource = z.enum(['ai', 'observed', 'human', 'empty'], { errorMap: () => ({ message: SOURCE_TEXT }) });
const WrittenBy = z.object({
    mustMention: FieldSource.optional(),
    mustNotMention: FieldSource.optional(),
    toolsExpected: FieldSource.optional(),
    rulesExpected: FieldSource.optional(),
    notes: FieldSource.optional(),
}).strict();

const CreateBody = bodyOf({
    name: worded('name must be text.').nullish(),
    question: worded(QUESTION_TEXT).min(1, QUESTION_TEXT),
    expect: Expect.nullish(),
    fromConversationId: worded('fromConversationId is the id of a conversation.').nullish(),
    writtenBy: WrittenBy.nullish(),
    suggestedBy: worded('suggestedBy must be text.').nullish(),
});

const PatchBody = bodyOf({
    name: worded('name must be text.').nullish(),
    question: worded('question must be text.').optional(),
    expect: Expect.nullish(),
});

const SuggestBody = bodyOf({
    question: worded('question must be text.').optional(),
    answer: worded('answer must be text.').optional(),
    toolsUsed: z.array(z.unknown(), { invalid_type_error: 'toolsUsed is a list.' }).optional(),
});

const RunBody = bodyOf({
    testIds: z.array(worded('testIds is a list of test ids.'), { invalid_type_error: 'testIds is a list of test ids.' }).optional(),
    // LEFT OPEN on purpose: `gateTestAsRequest` already refuses a group that
    // is not a usable id, and it refuses it with its OWN codes
    // (`test_as_invalid_group`, `test_as_group_not_found`) that the tab reads.
    // A shape check here would answer `invalid_request` first and take those
    // codes away.
    asGroup: z.unknown().optional(),
    timezone: worded('timezone must be a time zone.').nullish(),
});

const agentStore = require('../../stores/agentStore');
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId, getUserAuth } = require('../../utils/routeHelpers');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { setupSSE, startSseHeartbeat } = require('../../core/http/sseHelpers');
const sandbox = require('../../core/agentRuntime/testSandbox');
const suggest = require('../../core/agentRuntime/testSuggest');
const testAsMod = require('../../core/agentRuntime/testAs');

// Editing a test is a form submit; running one is N model calls. The second
// number is the one that matters — 4 runs a minute is a person pressing Run,
// not a script grinding through somebody's inference budget.
const editLimiter = perUserRateLimit({ windowMs: 60_000, max: 60 });
const runLimiter = perUserRateLimit({ windowMs: 60_000, max: 4 });
// Suggesting is ONE model call, so it sits between the two: more room than a
// run, far less than a form submit.
const suggestLimiter = perUserRateLimit({ windowMs: 60_000, max: 12 });

const MAX_ANSWER_STREAMED = 8000;
const MAX_GRADE_TOKENS = 400;
const MAX_SUGGEST_TOKENS = 300;

/**
 * The gate every route here shares.
 *
 * Returns `{ agent, views }` or null after answering the request. Unreadable
 * is 404 and unreadable-but-not-editable is 403, in that order — the reverse
 * would confirm that an agent exists to someone who may not know it does.
 */
async function requireEditableAgent(req, res) {
    const userId = getEffectiveUserId(req);
    const views = await agentStore.getAgentViews(req.params.id);
    if (!views || !views.draft) {
        res.status(404).json({ error: 'Agent not found' });
        return null;
    }
    const agent = views.draft;
    const { canReadAgent, canModifyAgent } = require('./crud');
    if (!(await canReadAgent(agent, userId, req))) {
        res.status(404).json({ error: 'Agent not found' });
        return null;
    }
    if (!(await canModifyAgent(agent, userId, req))) {
        res.status(403).json({
            error: 'You do not have permission to edit this agent.',
            code: 'agent_not_editable',
        });
        return null;
    }
    return { agent, views, userId };
}

/** What the run reports about the agent it actually exercised. */
function versionInfo(views) {
    const agent = views.draft || {};
    const publishedVersion = Number(agent.published_version) || 0;
    const runtimeSource = views.runtime && views.runtime.runtimeSource;
    const known = runtimeSource === 'published' || runtimeSource === 'live';
    // An unreadable projection with a published version behind it counts as
    // PUBLISHED. The other way round is the reassuring answer: recording 0
    // means "the concept ran", which tells the publish dialog these results
    // describe exactly what you are about to ship — the one claim this route
    // must never make by accident.
    const source = (runtimeSource === 'published' || (!known && publishedVersion > 0))
        ? 'published' : 'live';
    return {
        source,
        version: source === 'published' ? publishedVersion : 0,
        agentRev: Number(agent.rev) || 0,
        unpublishedChanges: publishedVersion > 0
            ? Math.max(0, (Number(agent.rev) || 1) - (Number(agent.published_rev) || 0))
            : 0,
    };
}

// ── The questions ────────────────────────────────────────────────────

router.get('/:id/tests', requirePermission('manage_agents'), editLimiter, async (req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;
    // The "Test als · groep …" picker rides along on the tab's own load.
    // It lives here rather than on the admin groups endpoint because that
    // one needs manage_users/org_admin, which an agent editor need not
    // have — and a parameter nobody can supply is not a feature.
    const orgIds = await resolveUserOrgIds(req).catch((e) => {
        log.warn('[agents/tests] workspace unresolved for the group picker:', e.message);
        return undefined;
    });
    const [tests, lastRun, groups] = await Promise.all([
        agentStore.listAgentTests(gate.agent.id),
        agentStore.getLastAgentTestRun(gate.agent.id).catch((e) => {
            // A run nobody can read is not "never tested" — say so rather
            // than rendering a green-free tab as a clean one.
            log.warn('[agents/tests] last run unreadable:', e.message);
            return undefined;
        }),
        // An org that could not be resolved is NOT "no org": that would be
        // read as super admin one line later and list every workspace's
        // groups. No answer at all is the only safe one.
        orgIds === undefined
            ? Promise.resolve({ groups: [], unknown: true })
            : testAsMod.listSimulatableGroups({ userId: gate.userId, orgIds }),
    ]);
    res.json({
        tests,
        lastRun: lastRun === undefined ? null : lastRun,
        lastRunUnknown: lastRun === undefined,
        testAsGroups: groups.groups,
        testAsGroupsUnknown: groups.unknown,
        limits: { maxTests: sandbox.MAX_TESTS_PER_AGENT, maxPerRun: sandbox.MAX_TESTS_PER_RUN },
    });
});

/**
 * The run history behind "Bekijk".
 *
 * `runsUnknown` rather than an empty list on a failed read, the same split
 * `lastRunUnknown` makes one route up: "this agent has never been tested" and
 * "I could not read what happened" are different sentences, and only the first
 * one is safe to render as a clean slate.
 */
router.get('/:id/tests/runs', requirePermission('manage_agents'), editLimiter, validate({ query: RunsQuery }), async (req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;
    const asked = req.query.limit;
    let runs;
    try {
        runs = await agentStore.listAgentTestRuns(gate.agent.id, {
            limit: Number.isFinite(asked) && asked > 0 ? asked : undefined,
        });
    } catch (e) {
        log.warn('[agents/tests] run history unreadable:', e.message);
        return res.json({ runs: [], runsUnknown: true, keep: sandbox.TEST_RUNS_KEEP });
    }
    res.json({
        runs: Array.isArray(runs) ? runs : [],
        runsUnknown: !Array.isArray(runs),
        // What the tab may claim about completeness: older runs are pruned,
        // so "this is everything" is only true up to this number.
        keep: sandbox.TEST_RUNS_KEEP,
    });
});

router.post('/:id/tests', requirePermission('manage_agents'), editLimiter, validate({ body: CreateBody }), async (req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;

    const { test, error } = sandbox.normaliseTest(req.body);
    if (error) return res.status(400).json({ error: 'Write the question this agent should answer.', code: error });

    const count = await agentStore.countAgentTests(gate.agent.id);
    if (count >= sandbox.MAX_TESTS_PER_AGENT) {
        return res.status(409).json({
            error: `This agent already has ${sandbox.MAX_TESTS_PER_AGENT} tests.`,
            code: 'too_many_tests',
        });
    }

    // Provenance, and only when the caller may actually read the thread it
    // claims to come from. An id that cannot be checked is dropped rather
    // than refused: the test itself is fine, only the link is not.
    let fromConversationId = null;
    const wanted = (req.body.fromConversationId || '').trim();
    if (wanted) {
        try {
            const { resolveConversationAccess } = require('../../stores/agent/conversationAccess');
            const access = await resolveConversationAccess(wanted, gate.userId, 'agent');
            if (access && access.canRead) fromConversationId = wanted;
        } catch (e) {
            log.warn('[agents/tests] conversation check failed, dropping the link:', e.message);
        }
    }

    // Herkomst. Het formulier stuurt terug wat het toonde: welk veld een
    // model schreef, welk veld uit de beurt kwam en welk veld de mens zelf
    // tikte. Zonder dit is een verwachting die een model opschreef na het
    // opslaan niet meer te onderscheiden van een die iemand zelf typte —
    // en juist die verwachting bepaalt straks of een run groen of rood is.
    // Smal ingelezen (`normaliseWrittenBy`): onbekend valt weg, en niets
    // ⇒ null ⇒ "een mens tikte dit".
    const suggest = require('../../core/agentRuntime/testSuggest');
    const writtenBy = suggest.normaliseWrittenBy(req.body.writtenBy);
    const suggestedBy = writtenBy && typeof req.body.suggestedBy === 'string'
        ? req.body.suggestedBy.trim().slice(0, 120) || null
        : null;

    const created = await agentStore.createAgentTest(gate.agent.id, {
        ...test, fromConversationId, writtenBy, suggestedBy,
    });
    res.status(201).json({ test: created });
});

router.put('/:id/tests/:testId', requirePermission('manage_agents'), editLimiter, validate({ body: PatchBody }), async (req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;

    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name || '').trim().slice(0, sandbox.LIMITS.name);
    if (req.body.question !== undefined) {
        const q = String(req.body.question || '').trim().slice(0, sandbox.LIMITS.question);
        if (!q) return res.status(400).json({ error: 'Write the question this agent should answer.', code: 'no_question' });
        patch.question = q;
    }
    if (req.body.expect !== undefined) patch.expect = sandbox.normaliseExpect(req.body.expect);

    const updated = await agentStore.updateAgentTest(gate.agent.id, req.params.testId, patch);
    if (!updated) return res.status(404).json({ error: 'Test not found' });
    res.json({ test: updated });
});

router.delete('/:id/tests/:testId', requirePermission('manage_agents'), editLimiter, async (req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;
    const gone = await agentStore.deleteAgentTest(gate.agent.id, req.params.testId);
    if (!gone) return res.status(404).json({ error: 'Test not found' });
    res.json({ success: true });
});

// ── The three preflights a model call shares ─────────────────────────
// Running the set and asking for a suggestion both spend inference on
// somebody's plan, and both need the same three answers first. They are one
// function each rather than one per route because the interesting half is the
// REFUSAL: each of these fails closed, and a second copy is where the second
// copy quietly stops doing that.

/**
 * The workspace this call is billed against.
 *
 * Not `.catch(() => null)`: this org id is what the plan ceiling is checked
 * AGAINST, and an org that could not be resolved would be checked as "no org
 * at all" — the widest possible reading of the question "how much of your plan
 * is left". `strict`: without that flag `resolveUserOrgIds` never throws and
 * the catch is a dead gate — an unreadable read arrived as an empty Set and
 * became "no org".
 *
 * @returns {{orgId: string|null, orgIdSet: Set|null}|null} null once answered.
 *          `orgId: null` after a SUCCESSFUL resolve means super admin; a failed
 *          resolve never gets here, so the two cannot be confused.
 */
async function resolveOrgOrRefuse(req, res) {
    try {
        const orgIds = await resolveUserOrgIds(req, { strict: true });
        return {
            orgIdSet: orgIds instanceof Set ? orgIds : null,
            orgId: orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null,
        };
    } catch (e) {
        log.error('[agents/tests] could not resolve the workspace:', e.message);
        res.status(503).json({
            error: 'Could not check your workspace right now. Try again.',
            code: 'org_check_failed',
        });
        return null;
    }
}

/**
 * The plan ceiling the chat stream enforces, enforced here too.
 *
 * A check that could not RUN refuses: "I could not read the plan" is not
 * headroom.
 *
 * @returns {boolean} false once answered.
 */
async function checkPlanOrRefuse(res, { orgId, userId }) {
    try {
        const { checkSubscriptionLimits } = require('../../core/entitlements/limits');
        const limitError = await checkSubscriptionLimits(orgId, 'chat', userId);
        if (limitError) {
            res.status(429).json({ error: limitError, code: 'limit_reached' });
            return false;
        }
        return true;
    } catch (e) {
        log.error('[agents/tests] subscription check failed:', e.message);
        res.status(503).json({
            error: 'Could not check your plan limits right now. Try again.',
            code: 'limit_check_failed',
        });
        return false;
    }
}

/**
 * The fast tier that reads an agent's answers — for grading, or for proposing
 * what a test should expect.
 *
 * No `fallback:` is passed on purpose: `resolveModelForTierName`'s fallback is
 * opt-in, and picking a model here would mean sending a privacy product's
 * answers to a provider this workspace never chose. Both ways of not having
 * one refuse, and they refuse DIFFERENTLY: "you have not configured one" is
 * something the user can fix, "we could not read your config" is something
 * they should retry. That difference is the whole reason this returns a code
 * per case instead of a null the caller has to interpret.
 *
 * @returns {Promise<string|null>} null once answered.
 */
async function resolveFastTierOrRefuse(res, { orgId, userId, what }) {
    let modelId = null;
    try {
        const { resolveModelForTierName } = require('../../core/llm/modelResolver');
        modelId = await resolveModelForTierName('fast', { userOrgId: orgId, userId });
    } catch (e) {
        log.error(`[agents/tests] ${what.label} model unreadable:`, e.message);
        res.status(503).json({ error: what.unreadableError, code: what.unreadableCode });
        return null;
    }
    if (!modelId) {
        res.status(503).json({ error: what.missingError, code: what.missingCode });
        return null;
    }
    return modelId;
}

/** What `resolveFastTierOrRefuse` says when the grader is the missing one. */
const GRADER_MODEL = Object.freeze({
    label: 'grading',
    unreadableError: 'Could not look up which model grades these answers. Try again.',
    unreadableCode: 'grading_model_unavailable',
    // Without a grader every test comes back `error`. Spending N turns to say
    // so is worse than saying it now.
    missingError: 'No AI model is configured to grade these answers.',
    missingCode: 'no_grading_model',
});

/** And when it is the one that writes the suggestion. */
const SUGGEST_MODEL = Object.freeze({
    label: 'suggestion',
    unreadableError: 'Could not look up which model writes this suggestion. Try again.',
    unreadableCode: 'suggestion_model_unavailable',
    missingError: 'No AI model is configured to suggest what a test should expect.',
    missingCode: 'no_suggestion_model',
});

// ── "+ Dit gesprek als test" ─────────────────────────────────────────

/**
 * Propose what a test made from ONE chat turn should expect.
 *
 * Writes nothing. The answer is `{ suggestion: { expect, wrote }, suggestedBy,
 * model }` and the tab renders it in an editable form that says an AI wrote
 * it; the row only exists once the person presses Save and their own
 * `POST /:id/tests` runs.
 *
 * The question and the answer come from the client because a test chat is
 * EPHEMERAL by construction (`core/agentRuntime/testChat`): there is no
 * conversation row to read them back from, by design. That is not a hole —
 * this route grants nothing and stores nothing, so the worst a made-up pair
 * can produce is a suggestion the same person then has to look at.
 */
router.post('/:id/tests/suggest', requirePermission('manage_agents'), suggestLimiter, validate({ body: SuggestBody }), async (req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;

    const question = (req.body.question || '').trim().slice(0, sandbox.LIMITS.question);
    const answer = (req.body.answer || '').trim();
    if (!question || !answer) {
        // Half a turn is not a turn: without the question there is nothing
        // to test, and without the answer there is nothing to propose.
        return res.status(400).json({
            error: 'Pick a turn with both a question and an answer.',
            code: 'no_turn',
        });
    }
    const toolsUsed = req.body.toolsUsed || [];

    const workspace = await resolveOrgOrRefuse(req, res);
    if (!workspace) return;
    const { orgId } = workspace;
    // One model call, but it is still inference on somebody's plan.
    if (!(await checkPlanOrRefuse(res, { orgId, userId: gate.userId }))) return;

    const modelId = await resolveFastTierOrRefuse(res, { orgId, userId: gate.userId, what: SUGGEST_MODEL });
    if (!modelId) return;

    const startMs = Date.now();
    let parsed = null;
    try {
        const llmClient = require('../../core/llm/llmClient');
        const out = await llmClient.chatForcedTool(
            modelId,
            suggest.buildSuggestionMessages({ question, answer, toolsUsed }),
            suggest.SUGGEST_TOOL,
            { maxTokens: MAX_SUGGEST_TOKENS, temperature: 0, reasoningEffort: 'none', budgetTokens: 0 },
        );
        parsed = suggest.parseSuggestion(out?.structured);
        await logSuggestUsage({ userId: gate.userId, userOrgId: orgId, modelId, usage: out?.usage, startMs });
    } catch (e) {
        log.warn('[agents/tests] suggestion call failed:', e.message);
        parsed = null;
    }

    const suggestion = suggest.suggestionFrom({ parsed, toolsUsed });
    if (!suggestion) {
        // A half-read proposal presented as "the AI suggests this" is the
        // one outcome this route may not produce: the test would then
        // guard something neither a person nor a model wrote down. The tab
        // opens an empty form instead — the person writes it themselves.
        return res.status(503).json({
            error: 'Could not write a suggestion for this answer.',
            code: 'suggestion_unreadable',
        });
    }

    res.json({ suggestion, suggestedBy: suggestion.suggestedBy, model: modelId });
});

// ── The run ──────────────────────────────────────────────────────────

/**
 * One usage row per model call this file makes; `chatForcedTool` logs nothing
 * itself.
 *
 * Grading and suggesting are the two, and they carry DIFFERENT sources on
 * purpose: both spend somebody's inference on a test set, but one is "I ran my
 * tests" and the other is "I asked what to test", and a cost report that
 * cannot tell them apart cannot answer either question.
 */
async function logTestModelUsage({ userId, userOrgId, modelId, usage, startMs, agentName, source }) {
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: agentName,
            agent_type: 'system',
            model: modelId,
            prompt_tokens: usage?.prompt_tokens || 0,
            completion_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)),
            cached_tokens: usage?.cached_tokens || 0,
            cache_creation_tokens: usage?.cache_creation_tokens || 0,
            source,
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn(`[agents/tests] failed to log ${source} usage:`, e.message);
    }
}

/** The grading call's row. */
const logGradeUsage = (row) => logTestModelUsage({ ...row, agentName: 'agent-test-grade', source: 'agent_test_grade' });
/** The suggestion call's row — a different source, see above. */
const logSuggestUsage = (row) => logTestModelUsage({ ...row, agentName: 'agent-test-suggest', source: 'agent_test_suggest' });

/**
 * Split one graded turn into what is STORED (`item`, written to
 * `agent_test_runs.results`, not an encrypted column) and what is only
 * STREAMED to whoever is watching the run live (`event`).
 *
 * The answer travels to the watcher; it is NOT stored. `graderNote` rides in
 * the same boat, and used to ride in the other one: it is the grader's own
 * sentence, written AFTER it read that answer, so it can quote the same
 * customer the answer did — bounding its length bounded how MUCH of a name
 * landed in that column, not whether one did. `item` must never carry either;
 * `event` is what gives the watcher the fuller picture.
 */
function buildTestResultRecord({ verdict, test, facts, index, turn }) {
    // What is STORED. `verdict.reason` is written by testSandbox from a
    // closed value, never by the grader; `decidedBy` is that value.
    const item = {
        testId: test.id,
        name: test.name,
        status: verdict.status,
        reason: verdict.reason,
        decidedBy: verdict.decidedBy || null,
        toolsUsed: facts.toolsUsed,
        toolsMissing: facts.toolsMissing,
        toolsWithheld: facts.toolsWithheld,
        forbiddenHits: facts.forbiddenHits,
    };
    const event = {
        ...item,
        index,
        pass: verdict.pass,
        graderNote: verdict.graderNote || null,
        answer: String(turn.answer || '').slice(0, MAX_ANSWER_STREAMED),
        withheld: turn.withheld,
    };
    return { item, event };
}

/**
 * One test: a real turn, then the facts, then — only if the facts left
 * anything open — the grader.
 */
async function runOneTest({ agentId, test, userId, userAuth, orgId, timezone, signal, testAs = null }) {
    const agentRuntime = require('../../core/agentRuntime');

    let collected = '';
    let replaced = null;
    const toolsUsed = [];
    let withheld = [];

    try {
        const result = await agentRuntime.chatWithAgentStream(
            agentId,
            userId,
            test.question,
            userAuth,
            (type, data) => {
                if (type === 'content' && data?.text) collected += data.text;
                else if (type === 'content_replace' && typeof data?.text === 'string') replaced = data.text;
                else if (type === 'tool_start' && typeof data?.name === 'string') toolsUsed.push(data.name);
                else if (type === 'test_sandbox' && Array.isArray(data?.withheld)) withheld = data.withheld;
            },
            null,
            {
                ephemeral: true,
                testSandbox: true,
                unattended: true,
                // Never. This is the flag that turns a composed mail into a
                // sent one for headless routines.
                autoSend: false,
                userOrgId: userAuth?.userOrgId || null,
                orgId: orgId || null,
                timezone: timezone || undefined,
                // "Test as · group X" — narrows this turn's knowledge to what
                // a member of that group would see, and nothing else. Absent
                // on an ordinary run, and the runtime shows NO knowledge for
                // one it cannot read (never the editor's own).
                testAs,
                signal,
            },
        );
        const answer = (result?.message && result.message.length > 0)
            ? result.message
            : ((replaced && replaced.trim()) ? replaced : collected);
        return { answer: answer || '', toolsUsed, withheld, error: null };
    } catch (err) {
        log.warn(`[agents/tests] turn failed for test "${test.name}":`, err.message);
        return { answer: '', toolsUsed, withheld, error: err.message };
    }
}

router.post('/:id/tests/run', requirePermission('manage_agents'), runLimiter, validate({ body: RunBody }), async (req, res) => {
    let headersSent = false;
    let sendEvent = () => {};
    let stopHeartbeat = null;

    try {
        const gate = await requireEditableAgent(req, res);
        if (!gate) return;
        const agentId = gate.agent.id;
        const userId = gate.userId;

        const all = await agentStore.listAgentTests(agentId);
        const wanted = req.body.testIds ? new Set(req.body.testIds) : null;
        const tests = (wanted ? all.filter(t => wanted.has(t.id)) : all).slice(0, sandbox.MAX_TESTS_PER_RUN);
        if (tests.length === 0) {
            return res.status(400).json({ error: 'There is nothing to run yet — add a question first.', code: 'no_tests' });
        }

        const workspace = await resolveOrgOrRefuse(req, res);
        if (!workspace) return;
        const { orgId, orgIdSet } = workspace;

        // ── "Test als · groep X" ────────────────────────────────
        // Refused, never downgraded: a run labelled "as a member of Sales"
        // that quietly ran as the editor is a worse answer than no answer.
        // `canEdit` is already true here — `requireEditableAgent` said so.
        const gated = await testAsMod.gateTestAsRequest({
            asGroup: req.body.asGroup, userId, orgIds: orgIdSet, canEdit: true,
        });
        if (!gated.ok) return res.status(gated.status).json({ error: gated.error, code: gated.code });
        const testAs = gated.testAs;

        // One press of this button is up to MAX_TESTS_PER_RUN turns.
        if (!(await checkPlanOrRefuse(res, { orgId, userId }))) return;

        const userAuth = await getUserAuth(req);
        // The grading call sends the agent's ANSWER to this model, so "which
        // model" is the whole question.
        const gradeModelId = await resolveFastTierOrRefuse(res, { orgId, userId, what: GRADER_MODEL });
        if (!gradeModelId) return;

        const info = versionInfo(gate.views);

        // ── Stream ──────────────────────────────────────────────
        const sse = setupSSE(res);
        sendEvent = sse.sendEvent;
        headersSent = true;
        stopHeartbeat = startSseHeartbeat(res, 10_000);
        const signal = sse.abortController.signal;

        sendEvent('start', {
            total: tests.length,
            ...info,
            testAs: testAsMod.testAsLabelParts(testAs),
            // Reported, not enforced. An agent this group cannot even open can
            // still answer nine questions here, and knowing that is the point
            // of asking.
            audience: testAs
                ? testAsMod.audienceForTestAs(gate.agent, testAs, { orgIds: orgIdSet })
                : null,
            tests: tests.map(t => ({ id: t.id, name: t.name })),
        });

        const items = [];
        let passed = 0;
        let aborted = false;

        for (let i = 0; i < tests.length; i++) {
            if (signal.aborted) { aborted = true; break; }
            const test = tests[i];
            sendEvent('test_start', { testId: test.id, name: test.name, index: i });

            const turn = await runOneTest({
                agentId, test, userId, userAuth, orgId, testAs,
                timezone: req.body?.timezone, signal,
            });
            if (signal.aborted) { aborted = true; break; }

            const withheldNames = (turn.withheld || [])
                .map(w => (w && typeof w === 'object' ? w.name : w))
                .filter(n => typeof n === 'string' && n);
            const facts = sandbox.factsFor({
                expect: test.expect,
                answer: turn.answer,
                toolsUsed: turn.toolsUsed,
                withheldNames,
            });

            let verdict;
            if (turn.error) {
                verdict = { status: 'error', pass: false, reason: ('The agent could not answer: ' + turn.error).slice(0, sandbox.LIMITS.reason) };
            } else if (!turn.answer.trim()) {
                // Not a fail: an empty turn is as likely to be the runtime as
                // the agent, and neither of those is "the test passed".
                verdict = { status: 'error', pass: false, reason: 'The agent returned no answer, so there was nothing to grade.' };
            } else if (sandbox.decidedByFacts(facts)) {
                verdict = sandbox.verdictFor(facts, null);
            } else {
                let graded = null;
                const startMs = Date.now();
                try {
                    const llmClient = require('../../core/llm/llmClient');
                    const out = await llmClient.chatForcedTool(
                        gradeModelId,
                        sandbox.buildGradingMessages({ test, answer: turn.answer, facts, withheld: turn.withheld }),
                        sandbox.GRADE_TOOL,
                        { maxTokens: MAX_GRADE_TOKENS, temperature: 0, reasoningEffort: 'none', budgetTokens: 0 },
                    );
                    graded = sandbox.parseGrading(out?.structured);
                    await logGradeUsage({ userId, userOrgId: orgId, modelId: gradeModelId, usage: out?.usage, startMs });
                } catch (e) {
                    log.warn('[agents/tests] grading failed:', e.message);
                    graded = null;
                }
                verdict = sandbox.verdictFor(facts, graded);
            }

            if (verdict.status === 'pass') passed++;
            const { item, event } = buildTestResultRecord({ verdict, test, facts, index: i, turn });
            items.push(item);
            sendEvent('test_result', event);
        }

        if (aborted) {
            // Nothing stored — see the module header.
            log.info(`[agents/tests] run for agent ${agentId} aborted after ${items.length} of ${tests.length}`);
            if (stopHeartbeat) stopHeartbeat();
            return res.end();
        }

        let stored = null;
        // A "Test as" run is deliberately narrowed, so its score is not a
        // verdict on the agent — and `agent_test_runs` is what the publish
        // dialog reads as one. Storing it with a marker and trusting every
        // future reader to notice is the same bet as a green number nobody
        // qualified; not storing it makes the row mean one thing.
        if (testAs) {
            log.info(`[agents/tests] run for agent ${agentId} not stored — simulated as group ${testAs.groupId}`);
            sendEvent('done', {
                run: null, notStored: 'test_as', passed, total: items.length, ...info,
                testAs: testAsMod.testAsLabelParts(testAs),
            });
            if (stopHeartbeat) stopHeartbeat();
            return res.end();
        }
        try {
            stored = await agentStore.recordAgentTestRun({
                agentId,
                version: info.version,
                results: {
                    items,
                    source: info.source,
                    agentRev: info.agentRev,
                    unpublishedChanges: info.unpublishedChanges,
                    // How many questions the agent HAD when this ran. `total`
                    // is how many were played back, and the two differ on a
                    // re-run of one test or a set above MAX_TESTS_PER_RUN. The
                    // card needs both to say "11 of 12 green" without implying
                    // the other seven were asked.
                    testCount: all.length,
                },
                passed,
                total: items.length,
            });
        } catch (e) {
            log.error('[agents/tests] recordTestRun failed:', e.message);
            sendEvent('error', { error: 'The tests ran, but the result could not be saved.', code: 'not_saved' });
        }

        sendEvent('done', { run: stored, passed, total: items.length, ...info });
        if (stopHeartbeat) stopHeartbeat();
        return res.end();
    } catch (err) {
        log.error('[agents/tests] run error:', err);
        if (stopHeartbeat) stopHeartbeat();
        if (headersSent) {
            sendEvent('error', { error: err.message, code: 'run_failed' });
            return res.end();
        }
        return res.status(500).json({ error: 'Could not run these tests' });
    }
});

module.exports = router;
// Exported for the colocated test.
module.exports.requireEditableAgent = requireEditableAgent;
module.exports.versionInfo = versionInfo;
module.exports.runOneTest = runOneTest;
module.exports.buildTestResultRecord = buildTestResultRecord;
