/**
 * Test sets — the Testen tab (A1c).
 *
 *   GET    /agents/:id/tests            the questions + the last run
 *   GET    /agents/:id/tests/runs       the run history behind "Bekijk" (view)
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
 *                       automation, and everything that would ask for approval;
 *   `unattended: true`  the existing headless rule, so a curated agent's
 *                       confirm-tools are dropped by the policy as well.
 * `autoSend` is passed as an explicit `false`. It is the flag that turns a
 * draft into a real send for headless automations, and `unattended` alone is
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
 * ── "TEST ALS · GROEP X" ("TEST AS · GROUP X") ─────────────────────────────────
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
 * ── "+ DIT GESPREK ALS TEST" ("+ THIS CONVERSATION AS A TEST") IS A PROPOSAL, NOT A TEST ─────────────
 * `POST /:id/tests/suggest` lets the fast tier write down what a good answer to this question must
 * convey in any case, and returns it. It writes nothing. The builder edits it and his own `POST /:id/tests`
 * creates the row — because a test that guards something other than what someone thought becomes green,
 * and then nobody believes the whole set any more. What a model may and may not propose is set out in
 * `core/agentRuntime/testSuggest`; that it was a MODEL travels along (`suggestedBy`, and per field `wrote`)
 * because the screen must be able to say so.
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
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

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

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/**
 * @param {string} name
 */
const whole = (name) => z.coerce.number({ error: typeError({ invalid: `${name} must be a number.` }) })
    .int(`${name} must be a whole number.`).optional();
const RunsQuery = z.object({ limit: whole('limit') }).strict();

const QUESTION_TEXT = 'Write the question this agent should answer.';
/**
 * @param {string} name
 */
const listOf = (name) => z.array(worded(`${name} is a list of phrases.`), { error: typeError({ invalid: `${name} is a list of phrases.` }) }).optional();

/** The five things a test may check. Anything else is a typo, not a check. */
const Expect = z.object({
    mustMention: listOf('mustMention'),
    mustNotMention: listOf('mustNotMention'),
    toolsExpected: listOf('toolsExpected'),
    rulesExpected: listOf('rulesExpected'),
    notes: worded('notes must be text.').nullish(),
}).strict();

const SOURCE_TEXT = 'writtenBy names, per field, one of: ai, observed, human, empty.';
const FieldSource = z.enum(['ai', 'observed', 'human', 'empty'], { error: () => SOURCE_TEXT });
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
    toolsUsed: z.array(z.unknown(), { error: typeError({ invalid: 'toolsUsed is a list.' }) }).optional(),
});

const RunBody = bodyOf({
    testIds: z.array(worded('testIds is a list of test ids.'), { error: typeError({ invalid: 'testIds is a list of test ids.' }) }).optional(),
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
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const sandbox = require('../../core/agentRuntime/testSandbox');
const suggest = require('../../core/agentRuntime/testSuggest');
const testAsMod = require('../../core/agentRuntime/testAs');
// The shared gate, preflights and usage rows (./testsGuards.js), and the run
// itself (./testsRun.js). This file keeps the schemas, the question routes,
// the suggestion and the route table.
const {
    requireEditableAgent, versionInfo, resolveOrgOrRefuse, checkPlanOrRefuse, resolveFastTierOrRefuse,
    SUGGEST_MODEL, logSuggestUsage,
} = require('./testsGuards');
const { buildTestResultRecord, runOneTest, runTests } = require('./testsRun');

// Editing a test is a form submit; running one is N model calls. The second
// number is the one that matters — 4 runs a minute is a person pressing Run,
// not a script grinding through somebody's inference budget.
const editLimiter = perUserRateLimit({ windowMs: 60_000, max: 60 });
const runLimiter = perUserRateLimit({ windowMs: 60_000, max: 4 });
// Suggesting is ONE model call, so it sits between the two: more room than a
// run, far less than a form submit.
const suggestLimiter = perUserRateLimit({ windowMs: 60_000, max: 12 });

const MAX_SUGGEST_TOKENS = 300;

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
router.get('/:id/tests/runs', requirePermission('manage_agents'), editLimiter, validate({ query: RunsQuery }), async (/** @type {import('express').Request<{ id: string }, any, any, import('zod').infer<typeof RunsQuery>>} */ req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;
    const asked = req.query.limit;
    let runs;
    try {
        runs = await agentStore.listAgentTestRuns(gate.agent.id, {
            limit: Number.isFinite(asked) && asked > 0 ? asked : undefined,
        });
    } catch (e) {
        log.warn('[agents/tests] run history unreadable:', /** @type {Error} */ (e).message);
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
            log.warn('[agents/tests] conversation check failed, dropping the link:', /** @type {Error} */ (e).message);
        }
    }

    // Provenance. The form sends back what it showed: which field a
    // model wrote, which field came from the turn and which field the human typed
    // himself. Without this an expectation that a model wrote after saving cannot be
    // told apart from one that somebody typed — and precisely that expectation decides
    // later whether a run is green or red.
    // Read in narrowly (`normaliseWrittenBy`): unknown falls away, and
    // nothing ⇒ null ⇒ "a human typed this".
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

router.put('/:id/tests/:testId', requirePermission('manage_agents'), editLimiter, validate({ body: PatchBody }), async (/** @type {import('express').Request<{ id: string, testId: string }, any, import('zod').infer<typeof PatchBody>, import('qs').ParsedQs>} */ req, res) => {
    const gate = await requireEditableAgent(req, res);
    if (!gate) return;

    /** @type {{ name?: string; question?: string; expect?: { mustMention: string[]; mustNotMention: string[]; toolsExpected: string[]; rulesExpected: string[]; notes: string; } }} */
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

    const workspace = await resolveOrgOrRefuse(req);
    if (!workspace) return;
    const { orgId } = workspace;
    // One model call, but it is still inference on somebody's plan.
    if (!(await checkPlanOrRefuse(res, { orgId, userId: gate.userId }))) return;

    const modelId = await resolveFastTierOrRefuse({ orgId, userId: gate.userId, what: SUGGEST_MODEL });
    if (!modelId) return;

    const startMs = Date.now();
    /** @type {{ mustMention: string[]; notes: string; } | null} */
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
        log.warn('[agents/tests] suggestion call failed:', /** @type {Error} */ (e).message);
        parsed = null;
    }

    const suggestion = suggest.suggestionFrom({ parsed, toolsUsed });
    if (!suggestion) {
        // A half-read proposal presented as "the AI suggests this" is the
        // one outcome this route may not produce: the test would then
        // guard something neither a person nor a model wrote down. The tab
        // opens an empty form instead — the person writes it themselves.
        throw new HttpError(503, 'suggestion_unreadable', 'Could not write a suggestion for this answer.');
    }

    res.json({ suggestion, suggestedBy: suggestion.suggestedBy, model: modelId });
});

// ── The run (./testsRun.js) ──────────────────────────────────────────

router.post('/:id/tests/run', requirePermission('manage_agents'), runLimiter, validate({ body: RunBody }), runTests);

// Exported for the colocated test.
module.exports = Object.assign(router, {
    requireEditableAgent,
    versionInfo,
    runOneTest,
    buildTestResultRecord,
});

/** @typedef {import('express').Router & { requireEditableAgent: typeof requireEditableAgent, versionInfo: typeof versionInfo, runOneTest: typeof runOneTest, buildTestResultRecord: typeof buildTestResultRecord }} TestsRouter */
