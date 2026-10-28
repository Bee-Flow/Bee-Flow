/**
 * Agent tests: running the set (POST /:id/tests/run). One real, sandboxed
 * turn per test, the facts it produced, the grader only where the facts
 * left something open, streamed to whoever watches and stored as a run.
 * The route is registered in routes/agents/tests.js. Split out of it;
 * behaviour unchanged.
 */

const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const agentStore = require('../../stores/agentStore');
const { getUserAuth } = require('../../utils/routeHelpers');
const { setupSSE, startSseHeartbeat } = require('../../core/http/sseHelpers');
const sandbox = require('../../core/agentRuntime/testSandbox');
const testAsMod = require('../../core/agentRuntime/testAs');
const {
    requireEditableAgent, versionInfo, resolveOrgOrRefuse, checkPlanOrRefuse, resolveFastTierOrRefuse,
    GRADER_MODEL, logGradeUsage,
} = require('./testsGuards');

const MAX_ANSWER_STREAMED = 8000;
const MAX_GRADE_TOKENS = 400;

/**
 * @typedef {Object} BuildTestResultRecordArgs
 * @property {number} index
 */
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
 * @param {BuildTestResultRecordArgs} param0
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
 * @typedef {Object} RunOneTestArgs
 * @property {string} userId
 * @property {string | null} [orgId]
 * @property {AbortSignal} signal
 */
/**
 * One test: a real turn, then the facts, then — only if the facts left
 * anything open — the grader.
 * @param {RunOneTestArgs} param0
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
                // sent one for headless automations.
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
        log.warn(`[agents/tests] turn failed for test "${test.name}":`, /** @type {Error} */ (err).message);
        return { answer: '', toolsUsed, withheld, error: /** @type {Error} */ (err).message };
    }
}

async function runTests(/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) {
    let headersSent = false;
    let sendEvent = () => {};
    /** @type {() => void | null} */
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

        const workspace = await resolveOrgOrRefuse(req);
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
        const gradeModelId = await resolveFastTierOrRefuse({ orgId, userId, what: GRADER_MODEL });
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
                /** @type {{ pass: boolean; reason: string; decidedBy: string | undefined; } | null} */
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
                    log.warn('[agents/tests] grading failed:', /** @type {Error} */ (e).message);
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
            log.error('[agents/tests] recordTestRun failed:', /** @type {Error} */ (e).message);
            sendEvent('error', { error: 'The tests ran, but the result could not be saved.', code: 'not_saved' });
        }

        sendEvent('done', { run: stored, passed, total: items.length, ...info });
        if (stopHeartbeat) stopHeartbeat();
        return res.end();
    } catch (err) {
        if (!(err instanceof HttpError)) log.error('[agents/tests] run error:', err);
        if (stopHeartbeat) stopHeartbeat();
        if (headersSent) {
            sendEvent('error', { error: /** @type {Error} */ (err).message, code: 'run_failed' });
            return res.end();
        }
        if (err instanceof HttpError) throw err;
        throw new HttpError(500, 'run_failed', 'Could not run these tests');
    }
}

module.exports = { buildTestResultRecord, runOneTest, runTests };
