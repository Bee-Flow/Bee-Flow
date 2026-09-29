/**
 * "Test" — one question through the steps of ONE skill (Skills artboard 1c).
 * (Bee Flow Builder redesign, Sep 2026, Track S3.)
 *
 *   GET  /api/skills/test-agents      → { agents: [{ id, name, description }] }
 *   POST /api/skills/:id/test         → SSE
 *
 * Wired into `routes/skills.js`, which owns the router, `requireAuth`, the
 * `manage_skills` gate and the suspended-org block. Plain `(req, res)`
 * functions, required LAZILY there — the reason is in `examples.js`: an
 * eager require would drag the LLM client, the provider adapters, the
 * knowledge search and a real database into a DB-free test suite.
 *
 * ── THE SANDBOX IS THE POINT, NOT THE SCREEN ────────────────────────
 * This endpoint runs an agent turn because somebody pressed "Run" in an
 * editor. The tools that turn may call are BUILT from a closed list
 * (`core/skills/skillSandbox.js`), never filtered out of the agent's real
 * stack: a deny-list would admit every integration added after today.
 * Nothing here widens that list, and the executor refuses any name that is
 * not in it even if a tool definition somehow got past.
 *
 * ── WHICH AGENT, AND WHOSE ─────────────────────────────────────────
 * `agentId` comes from the client, and `agentStore.getAgent` has no access
 * control whatsoever — hand it an id and it returns the agent, system prompt
 * and all. So the id is authorised against ONE list, `testableAgents`, which
 * is also the list the picker is filled from: the picker and the check
 * cannot drift because they are the same function. The list is the canonical
 * `getPublishedAgentsForUser` (the org/group predicate the whole product
 * uses) plus the caller's own agents. A failure to build it REFUSES the run;
 * an empty list from an error would be an open door.
 *
 * ── A VERDICT IS A CLAIM ────────────────────────────────────────────
 * The run writes a `skill_test_runs` row, and that row feeds the overview's
 * Test column. So the endpoint refuses, visibly, rather than grading
 * nothing: a skill with no body (`empty_skill`), a skill with no steps
 * (`no_steps` — "a test grades one step at a time"), an unusable grading
 * pass (`grading_failed`). A step the grader stayed silent about comes back
 * `warning`, never `ok` (`core/skills/skillTest.js`).
 *
 * No request schema here, and none belongs here: routes/skills.js mounts these
 * handlers behind its own validate() schemas (FromMessageBody, TestBody,
 * DraftBody, ImproveBody), so every body read below has already been checked.
 */

'use strict';

const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { refIdsOf } = require('../../core/skills/skillStructure');
const {
    buildTestAddendum,
    buildTestSystemPrompt,
    gradableSteps,
    GRADE_TOOL,
    buildGradingMessages,
    parseGrading,
    MAX_QUESTION_CHARS,
    MAX_TOOL_ROUNDS,
} = require('../../core/skills/skillTest');
const { buildSandboxTools, executeSandboxTool } = require('../../core/skills/skillSandbox');
const log = require('../../telemetry/log');

/** One test run is two model calls. Six a minute is a person pressing Run, not a script. */
const limiter = perUserRateLimit({ windowMs: 60_000, max: 6 });

const MAX_ANSWER_TOKENS = 1200;
const MAX_GRADE_TOKENS = 1200;

const SSE_HEADERS = Object.freeze({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // nginx buffers a streamed response into uselessness without this.
    'X-Accel-Buffering': 'no',
});

async function orgIdOf(req) {
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

/**
 * The agents this caller may run a test as.
 *
 * ONE list, used by the picker AND by the authorisation of `agentId`. The
 * published half is `getPublishedAgentsForUser` — the canonical org/group
 * predicate, not a re-implementation of it (`routes/agents/chat.js` keeps a
 * private copy of that logic and does not export it; a second copy here
 * would be a third). The other half is the caller's own agents, published or
 * not: an owner always has access to their own.
 *
 * THROWS on failure. A caller that swallowed it into `[]` would turn a
 * database hiccup into "no agent is yours", and the run refuses — which is
 * the correct direction for an authorisation list.
 */
async function testableAgents(req) {
    const userId = req.session?.user?.id;
    if (!userId) return [];
    const agentStore = require('../../stores/agentStore');
    const userStore = require('../../stores/userStore');
    const { resolveUserOrgIds } = require('../../auth');

    const user = await userStore.getUser(userId);
    let userGroups = [];
    if (Array.isArray(user?.groups)) userGroups = user.groups;
    else { try { userGroups = JSON.parse(user?.groups || '[]'); } catch (_) { userGroups = []; } }
    const orgIds = await resolveUserOrgIds(req);

    const published = await agentStore.getPublishedAgentsForUser(userGroups, user?.organizationId || null, orgIds);
    const own = await agentStore.getAgents(userId);

    const byId = new Map();
    for (const a of [...(published || []), ...(own || [])]) {
        // 'system' and 'swarm' agents are internal machinery (title
        // generation, sub-agents). They are not something a person tests a
        // skill "as", and `getAgents` returns them alongside your own.
        if (!a?.id || a.owner_id === 'system' || a.owner_id === 'swarm') continue;
        if (!byId.has(a.id)) byId.set(a.id, a);
    }
    return [...byId.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

// ── GET /api/skills/test-agents ──────────────────────────────────────
async function listAgents(req, res) {
    try {
        const agents = await testableAgents(req);
        return res.json({
            agents: agents.map(a => ({
                id: a.id,
                name: a.name || a.id,
                description: a.description || '',
            })),
        });
    } catch (err) {
        log.error('[Skills] GET /test-agents error:', err);
        // Not `{ agents: [] }`: an empty picker would read as "you have no
        // agents", which is a claim this read cannot make.
        return res.status(500).json({ error: 'Could not load the agents you can test with' });
    }
}

/**
 * The knowledge bases this skill declares, narrowed to what the caller may
 * actually have SEARCHED — and a count of what fell away, because "none
 * declared" and "declared but not yours" are different sentences.
 *
 * ── THE RETRIEVAL CHECK, NOT THE MANAGEMENT ONE ─────────────────────
 * `usableKbIdsForRequest`, never `partitionAccessibleKBIds`. The doctrine is
 * written out in `support/kbAccess.js`: the management check lets an ORG
 * ADMIN reach every base in their org (drafts and group-restricted ones
 * included) and reads a super admin's `null` org set as "everything, every
 * tenant". Right for a picker; wrong the moment a passage becomes text a
 * person READS — which is exactly what happens here, since the answer this
 * turn writes streams straight to the tester's screen with an audit trail
 * that says "the AI said it". The retrieval check pins `isOrgAdmin` to false,
 * coerces `null` to an empty set, and asks the SURFACE question
 * (`usage_contexts`) the management check does not, so a base its owner
 * limited to one routine does not answer here either.
 *
 * The surface is the one being rehearsed: a run "as agent X" is an agent
 * turn, a run without one is a chat turn.
 *
 * @returns {Promise<{ ids: string[], declared: number, failed: boolean }>}
 */
async function allowedKbIds(req, skill, { surface = 'direct_chat' } = {}) {
    const declared = [
        ...(Array.isArray(skill?.knowledgeBaseIds) ? skill.knowledgeBaseIds : []),
        ...refIdsOf(skill?.steps, 'kb'),
    ];
    const unique = [...new Set(declared.filter(id => typeof id === 'string' && id))];
    if (unique.length === 0) return { ids: [], declared: 0, failed: false };
    try {
        const { usableKbIdsForRequest } = require('../../support/kbAccess');
        const ids = await usableKbIdsForRequest(req, unique, { surface });
        return { ids: Array.isArray(ids) ? ids : [], declared: unique.length, failed: false };
    } catch (err) {
        // Could not check ⇒ none. `quickKBSearch` does no tenant filtering of
        // its own, so an unchecked id list IS the access boundary. But the
        // caller is TOLD, because an empty list here used to be indistinguish-
        // able from "this skill links no knowledge base" — see the refusal
        // the run makes with this flag.
        log.warn('[Skills/test] KB authorisation failed, searching nothing:', err.message);
        return { ids: [], declared: unique.length, failed: true };
    }
}

/** The fast tier, with the global default behind it. */
async function resolveModel(rawModel, { userId, userOrgId }) {
    const { resolveModelForTier, resolveModelWithGlobalFallback } = require('../../core/llm/modelResolver');
    try {
        const resolved = await resolveModelForTier(rawModel || 'tier:fast', { userOrgId, userId, fallbackTier: 'fast' });
        if (resolved) return resolved;
    } catch (_) { /* fall through */ }
    try {
        return await resolveModelWithGlobalFallback('tier:fast', { userOrgId, userId });
    } catch (_) {
        return null;
    }
}

/** One usage row per model call. `runToolLoop`/`chatForcedTool` log nothing themselves. */
async function logTestUsage({ userId, userOrgId, modelId, usage, startMs, source }) {
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: 'skill-test',
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
        log.warn('[Skills/test] failed to log usage:', e.message);
    }
}

// ── POST /api/skills/:id/test ────────────────────────────────────────
async function run(req, res) {
    let headersSent = false;
    const send = (event, data) => {
        if (!headersSent || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const skillStore = require('../../stores/skillStore');
        const { hasPermission } = require('../../auth/permissions');
        const userId = req.session.user.id;

        const question = String(req.body?.question || '').trim().slice(0, MAX_QUESTION_CHARS);
        if (!question) return res.status(400).json({ error: 'Ask something this skill should handle.', code: 'no_question' });

        const orgId = await orgIdOf(req);
        let canManage = false;
        try { canManage = await hasPermission(userId, 'manage_skills', req.session); } catch (_) { canManage = false; }

        const skill = await skillStore.getSkill(req.params.id, orgId, userId, { canManage: canManage === true });
        if (!skill) return res.status(404).json({ error: 'Skill not found' });
        // Visible-but-not-editable is a 403, the same answer `POST /:id/ai/improve`
        // gives. A test run is a WRITE, not a read: it spends two model calls on
        // the workspace's bill and stores a `skill_test_runs` row that the OWNER
        // reads back as a verdict on their skill — carrying the question a
        // stranger typed. A skill shared through groups is visible to another
        // org but not editable (`skillStore.canEditSkill`), so without this the
        // two write paths of the Test tab would disagree. Before `resolveModel`
        // and `allowedKbIds`, so a refusal costs nothing.
        if (!skill.canEdit) return res.status(403).json({ error: 'You cannot test this skill', code: 'not_editable' });

        // ── The prompt, and the refusals that keep a verdict honest ──
        const { addendum, hasBody } = buildTestAddendum(skill);
        if (!hasBody) {
            return res.status(400).json({
                error: 'This skill has nothing to follow yet — write the steps first.',
                code: 'empty_skill',
            });
        }
        const steps = gradableSteps(skill.steps);
        if (steps.length === 0) {
            return res.status(400).json({
                error: 'Add steps first — a test grades one step at a time.',
                code: 'no_steps',
            });
        }

        // ── The agent, if one was named ──────────────────────────────
        const wantedAgentId = typeof req.body?.agentId === 'string' && req.body.agentId.trim()
            ? req.body.agentId.trim()
            : null;
        let agent = null;
        if (wantedAgentId) {
            let permitted;
            try {
                permitted = await testableAgents(req);
            } catch (err) {
                log.error('[Skills/test] could not resolve testable agents:', err.message);
                return res.status(503).json({ error: 'Could not check which agents you may use. Try again.', code: 'agent_check_failed' });
            }
            // "Not yours" and "not there" answer the same: a 403 would confirm
            // that an id exists in somebody else's account.
            if (!permitted.some(a => a.id === wantedAgentId)) {
                return res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
            }
            const agentStore = require('../../stores/agentStore');
            agent = await agentStore.getForRuntime(wantedAgentId);
            if (!agent) return res.status(404).json({ error: 'Agent not found', code: 'agent_not_found' });
        }

        const modelId = await resolveModel(agent?.model, { userId, userOrgId: orgId });
        if (!modelId) {
            return res.status(503).json({ error: 'No AI model is configured for this workspace.', code: 'no_model' });
        }
        const gradeModelId = await resolveModel('tier:fast', { userId, userOrgId: orgId });

        // The surface being rehearsed, so the test answers with the same
        // bases the real turn would.
        const kb = await allowedKbIds(req, skill, { surface: agent ? 'agent' : 'direct_chat' });
        if (kb.failed) {
            // REFUSED, not "searched nothing". A run with the check down
            // reaches the model as "this skill has no knowledge base linked",
            // it answers from the skill text, the grader finds no evidence for
            // the step that says "look it up", and `recordTestRun` stores that
            // as the verdict the overview shows — a claim about the SKILL
            // built out of a failure of the check. Same shape as
            // `agent_check_failed`, and no row is written.
            return res.status(503).json({
                error: 'Could not check which knowledge bases this skill may use. Try again.',
                code: 'kb_check_failed',
            });
        }

        // ── Stream ──────────────────────────────────────────────────
        res.writeHead(200, SSE_HEADERS);
        headersSent = true;

        // Partial refusal is not silence either: the answer and the verdict
        // would both be built on fewer sources than the skill declares, and
        // neither would say so.
        if (kb.declared > kb.ids.length) {
            send('notice', { code: 'kb_dropped', declared: kb.declared, used: kb.ids.length });
        }

        const llmClient = require('../../core/llm/llmClient');
        const messages = [
            { role: 'system', content: buildTestSystemPrompt({ agentPrompt: agent?.system_prompt || '', addendum }) },
            { role: 'user', content: question },
        ];

        // The Privacy Shield tool block lists ("Outside tools" / "Own server")
        // hold in a test turn as in the real turn it rehearses (BFSF-354): a
        // refused call never runs, and what the model reads of a passage has
        // the forbidden categories stripped. A failed lookup leaves the lists
        // unapplied, as a missing shield does in every other tool loop.
        const toolPiiGate = require('../../core/privacy/toolPiiGate');
        const shieldGate = toolPiiGate.toolLoopGate({
            shield: await toolPiiGate.resolveToolShield(
                () => require('../../core/privacy/orgShield').resolveShieldFor({ orgId: orgId || null, userId }), 'Skills/test'),
            tag: 'Skills/test',
            audit: (fields) => require('../../stores/guardrailEventStore').logGuardrailEvent({
                organization_id: orgId || null, user_id: userId, agent_id: agent?.id || null,
                ...fields, source: 'skill_test', model: modelId, is_dry_run: true,
            }),
        });
        const runSandboxTool = async (name, args) => {
            const refusal = await shieldGate.refuse(name, args);
            if (refusal) return JSON.stringify({ error: refusal.modelError });
            // `kbDeclared` so the tool can tell "no knowledge base linked"
            // from "linked, but not yours" instead of stating the first.
            const out = await executeSandboxTool(name, args, {
                userId, kbIds: kb.ids, kbDeclared: kb.declared, session: req.session,
            });
            return shieldGate.forModel(out, name);
        };

        const turnStart = Date.now();
        const turn = await llmClient.runToolLoop(
            modelId,
            messages,
            buildSandboxTools(),
            { maxTokens: MAX_ANSWER_TOKENS, temperature: 0.2 },
            runSandboxTool,
            MAX_TOOL_ROUNDS,
        );
        await logTestUsage({ userId, userOrgId: orgId, modelId, usage: turn?.usage, startMs: turnStart, source: 'skill_test' });

        const answer = typeof turn?.content === 'string' ? turn.content : '';
        send('answer', { text: answer });

        if (!answer.trim()) {
            send('error', { error: 'The model returned no answer, so there is nothing to grade.', code: 'no_answer' });
            return res.end();
        }

        // ── Grade ───────────────────────────────────────────────────
        const gradeStart = Date.now();
        const graded = await llmClient.chatForcedTool(
            gradeModelId || modelId,
            buildGradingMessages({ skill, steps, question, answer }),
            GRADE_TOOL,
            { maxTokens: MAX_GRADE_TOKENS, temperature: 0 },
        );
        await logTestUsage({
            userId, userOrgId: orgId, modelId: gradeModelId || modelId,
            usage: graded?.usage, startMs: gradeStart, source: 'skill_test_grade',
        });

        // The SKILL's steps, not the capped prompt list: a step beyond the
        // grading cap must appear in the verdict as unassessed, not vanish
        // from it and leave the run green.
        const verdict = parseGrading(graded?.structured, skill.steps);
        if (!verdict) {
            // No row is written. "The grading failed" is not a verdict, and a
            // stored run is read later as one.
            send('error', { error: 'The answer came back, but it could not be graded. Try again.', code: 'grading_failed' });
            return res.end();
        }

        let stored = null;
        try {
            stored = await skillStore.recordTestRun({
                skillId: skill.id,
                agentId: agent?.id || null,
                question,
                results: verdict.results,
                status: verdict.status,
                advice: verdict.advice,
            });
        } catch (e) {
            log.error('[Skills/test] recordTestRun failed:', e.message);
            send('error', { error: 'The test ran, but the result could not be saved.', code: 'not_saved' });
            return res.end();
        }

        send('done', { run: stored });
        return res.end();
    } catch (err) {
        log.error('[Skills] POST /:id/test error:', err.message);
        if (headersSent) {
            // The headers are out; a 500 is no longer available, so the error
            // travels as an event or the client waits for ever.
            send('error', { error: err.message, code: 'test_failed' });
            return res.end();
        }
        return res.status(500).json({ error: 'Could not run this test' });
    }
}

module.exports = {
    run,
    listAgents,
    limiter,
    // Exported for the colocated test.
    testableAgents,
    allowedKbIds,
    orgIdOf,
};
