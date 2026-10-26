// @typecheck noImplicitAny
/**
 * Automation Builder — conversational SSE endpoint.
 *
 *   POST /api/automation/builder/stream  (mounted at /api/automation/builder)
 *
 * Body: { message, builderSessionId?, automationId?, modelTier?, history?,
 *         seedMetadata? { title?, description? } — a host's name for a draft
 *         this request CREATES (the playbook stage sends its brief's title);
 *         ignored for an existing draft }
 *
 * The builder owns a per-(userId, builderSessionId) draft kept in-memory
 * and persisted to the `automations` table (is_draft=TRUE) after every
 * mutation, so:
 *
 *   - a page refresh recovers the draft via /api/automation/:id
 *   - the user always sees a saved row in their list
 *
 * SSE events emitted:
 *   round_start    — { iter, modelId, promptChars, effort, local, providerType }
 *                    — a model round is about to start; promptChars sizes the
 *                    prefill wait, `local` says the model runs on a self-hosted
 *                    runtime (providers/localModels.isLocalProviderType)
 *   prompt_progress— { iter, total, cache, processed, timeMs } — llama-server
 *                    prefill progress (return_progress); ≤ ~4/s
 *   tool_draft     — { iter, name, chars, count, steps, inspect } — the steps a
 *                    tool call's still-streaming arguments already describe
 *                    (toolDraft.js); ≤ 1 per 250 ms plus one on every change
 *   message        — assistant text token (streamed delta)
 *   thinking_start — { partId, redacted? } — a reasoning block opened
 *   thinking       — { partId, text } — reasoning delta (live)
 *   thinking_stop  — { partId, redacted? } — a reasoning block closed
 *   tool_call      — { name, arguments, result }
 *   draft          — full updated definition (debounced)
 *   summary       — plain-English summary
 *   dryrun_started — { run: { id, status, startedAt } } — the dry run's row
 *                    exists; the canvas follows it live from here (BuildTab's
 *                    step poller), the same way a manual run is followed
 *   dryrun        — { run, steps } — the finished dry run, every step row
 *   finalized     — { automationId }
 *   metadata      — { automationId, title, description } — the automation's name
 *                    changed: after every accepted builder_set_metadata, and
 *                    after the server named an untitled draft itself
 *                    (builderTools/deriveTitle.js, at finalize / auto-finalize
 *                    / turn end). The header refetches on it.
 *   builder_aborted — { reason, iterations, lastValidation, rejected? } — the
 *                    turn ended without finalizing: 'max_iterations' (budget
 *                    spent), 'repeated_rejection' (one step was refused three
 *                    times running — the repeat ladder in builderTools.js) or
 *                    'no_progress' (four rounds in which every call was
 *                    refused). The last two carry `rejected: { tool, error,
 *                    label }` and are followed by ONE `message` sentence for
 *                    the user.
 *   review_plan    — { plan } — the plan under review: status review | building |
 *                    paused | built, version, steps (a plan the user approves
 *                    with the Build button: body approvedPlanId)
 *   review_questions — { questions, planId } — ONE card of at most 6 questions
 *                    per plan (planId = the approved plan the questions pause,
 *                    null in a planning turn)
 *   plan           — { todos } — the build checklist (emptied in Plan first and
 *                    Discuss, seeded from the approved plan's steps in a build)
 *   done / error
 *
 * LAYOUT: this file is the route's wiring — the pre-stream checks, the SSE
 * shell and the turn object every phase reads and writes. The phases:
 *   ./turnSetup.js       what a turn may send, gate, tiers, draft, session, work mode, catalogues
 *   ./modelSelection.js  auto tier, capability floor, provider, profile, narration model
 *   ./promptAssembly.js  catalogue order, pre-inspected schemas, web research, composed messages
 *   ./toolMenu.js        the tools offered and the Privacy Shield gate for org/web tools
 *   ./buildLoop.js       the rounds (./toolDispatch.js + ./routeTools.js per call,
 *                        ./roundNudges.js for a round without a call, ./turnStop.js)
 *   ./turnClosing.js     auto-finalize, naming, proposal, plan status, session snapshot
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();

const automationStore = require('../../../stores/automationStore');
const { effortForIteration } = require('../../../core/automationModel/builderModelProfiles');
const { openSse } = require('../../../core/http/sseHelpers');
const { systemPrefixFingerprint, toolSetFingerprint, toolBytesFingerprint } = require('../../../core/llm/promptCacheStability');
const { builderRateLimit } = require('./rateLimits');
const { createThoughtNarrator } = require('./thoughtNarrator');
const { TurnBody, TurnQuery, setupTurn } = require('./turnSetup');
const { resolveTurnModel } = require('./modelSelection');
const { assembleTurnPrompt } = require('./promptAssembly');
const { buildToolMenu } = require('./toolMenu');
const { runBuildLoop } = require('./buildLoop');
const { closeTurn } = require('./turnClosing');
const { MAX_ITERATIONS } = require('./turnStop');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');
const { validate } = require('../../../core/http/validate');
const { sessionUser } = require('../../../core/http/sessionUser');

router.post('/stream', requireAuth, builderRateLimit, validate({ query: TurnQuery, body: TurnBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const userId = sessionUser(req).id;
    const {
        message,
        builderSessionId: clientSession,
        automationId,
        modelTier = 'auto',
        workMode = 'build', alwaysPlanLarge = false, pauseAfterStep = false, approvedPlanId = null, selectedStepId = null,
        history = [],
        attachments = [],
        webSearchEnabled = true,
        disabledMedia = {},
        timezone,
        // WS2/WS3 — the canvas scope the user is currently drilled into
        // (a flowlet key, or absent for the root flow). Used purely as a
        // prompt hint so the model defaults its tool calls' `scope` there.
        canvasScope,
        // A host's name for the draft this request creates (see the header).
        seedMetadata = null,
    } = req.body || {};
    // ?resume=1 — caller is reconnecting and wants the latest snapshot
    // re-emitted before the new message is processed. Additive: the regular
    // SSE flow continues exactly as before once the resume event lands.
    const wantsResume = req.query?.resume === '1' || req.query?.resume === 'true';

    // An automation a Solution stage manages is changed in Dev and deployed, so a
    // builder turn on it would be billed and then refused at every write. Said
    // up front, before the stream opens: a clean 409 managed_part.
    if (automationId) {
        const managedParts = require('../../../stores/managedPartsDefault');
        const target = await automationStore.getAutomation(automationId);
        if (target && target.userId === userId && target.projectId) {
            const info = await managedParts.managedInfo(target.projectId);
            if (info) throw managedParts.managedPartError(info);
        }
    }

    // Push the SSE response headers to the wire immediately, then keep the
    // connection warm with 10s pings. A thinking model can go silent for
    // 30–60s (deep reasoning between tool calls); without a heartbeat an
    // upstream gateway (Nextcloud AppAPI proxy / HaRP / ingress, ~30–60s idle
    // timeout) drops the connection and the embedded app sees a false 504
    // while the agent is still building — and never receives the thinking
    // stream. Same class as the chat/notebook fix (BFSF-221). The heartbeat
    // auto-stops on res close/finish/error.
    const { send: sendRaw, stopHeartbeat } = openSse(res, { heartbeat: true, flush: true });
    // The build loop writes through `send`. When an admin has configured a
    // narration model it is swapped for the thought narrator's wrapper right
    // before the loop; `done` / `error` always leave through sendRaw AFTER the
    // narrator has closed, so a late summary can never land on a turn that
    // has already ended.
    //
    // The turn object: the request's fields, then whatever each phase below
    // adds (see LAYOUT in the header). `turn.send` is the build loop's writer.
    const turn = /** @type {import('./turnSetup').BuilderTurn} */ ({
        req, res, userId,
        message, clientSession, automationId, modelTier, workMode, alwaysPlanLarge, pauseAfterStep, approvedPlanId, selectedStepId,
        history, attachments, webSearchEnabled, disabledMedia, timezone, canvasScope, seedMetadata, wantsResume,
        send: sendRaw,
        narrator: null,
    });

    try {
        if (!(await setupTurn(turn))) return;
        if (!(await resolveTurnModel(turn))) return;
        await assembleTurnPrompt(turn);
        await buildToolMenu(turn);
        const { draftWrap, sys, tools, fewShotMessages, windowedHistory, profile, tier, narrationModelId, summary } = turn;

        // One line per turn to SEE prefix stability in the logs: two consecutive
        // turns of a session must print the same sys= / tools= / toolBytes= /
        // fewShots= digests — and on the small band (catalogPlacement
        // 'dynamic') two SESSIONS of two USERS must too, or the local runtime's
        // prompt cache is re-filled on every new build. tools= is the name
        // list, toolBytes= the serialised schemas the model reads.
        log.info(`[AutomationBuilder] prefix sys=${systemPrefixFingerprint(sys)} tools=${toolSetFingerprint(tools)} toolBytes=${toolBytesFingerprint(tools)} fewShots=${systemPrefixFingerprint(JSON.stringify(fewShotMessages))} n=${fewShotMessages.length} history=${windowedHistory.length}`);

        // What the automation is about, for the deterministic title fallback
        // (deriveTitle.js): the FIRST user message of the session — the brief
        // — when there is history, else this message.
        const firstUserTurn = Array.isArray(history) ? history.find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) : null;
        turn.brief = firstUserTurn ? firstUserTurn.content : (message || '');
        /** The `metadata` event: the draft's name as it now stands. */
        turn.sendMetadata = () => turn.send('metadata', { automationId: draftWrap.automationId, title: draftWrap.title, description: draftWrap.description || '' });

        // The profile sets a higher cap than the legacy MAX_ITERATIONS
        // when needed (e.g. small models that take more turns to
        // converge). Clamp to the hard ceiling so a bad profile can't
        // burn unbounded tokens.
        turn.iterationBudget = Math.min(profile.maxIterations || 16, MAX_ITERATIONS);

        // Stop the (multi-iteration, LLM-token-burning) build loop the moment
        // the client disconnects — otherwise a user who closes the tab or
        // navigates away leaves the agent looping, calling the model and tools,
        // running up cost with nowhere to send the output.
        turn.clientGone = false;
        // An AbortController as well as the flag: the flag is only read at the
        // TOP of the next iteration, so without this a closed tab still ran the
        // CURRENT round to the max_tokens cap — on a self-hosted box, on the
        // model's only slot. streamWithRetry forwards the signal to the adapter.
        const clientAbort = new AbortController();
        turn.clientAbort = clientAbort;
        req.on('close', () => {
            turn.clientGone = true;
            try { clientAbort.abort(); } catch (err) { log.debug('already aborted', err); }
        });

        turn.lastFinalized = false;
        turn.lastValidation = null;
        turn.lastSummary = summary || null;
        // Why the loop ended early, when it did: { reason, tool, error, label,
        // position } — see the stop block after the tool loop. Null means the
        // model finished or the budget ran out.
        turn.stopReason = null;
        // Per-turn token accounting (WS1). Purely observational — no budget
        // enforcement — but it makes every optimization below measurable and
        // surfaces regressions in prod logs.
        turn.usageTotals = { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 };
        // ONE reasoning effort for every round of the turn. The per-round
        // schedule (WS7: deeper on iteration 0 and after a failure signal,
        // lighter on continuation rounds) and the one-off "thinking off" retry
        // after a truncated reply are gone: on the local adapter the effort
        // level renders into the chat template's tail (enable_thinking,
        // reasoning_effort, temperature — local.js), so flipping it between
        // rounds re-rendered the template and cost a prefix re-read mid-build.
        // With a fixed level every round of the turn shares one template tail.
        //
        // The trade-off: a thinking tier that runs out of room while reasoning
        // now gets the same effort on its single retry, so it may truncate
        // twice and end with the existing error message instead of being
        // rescued by a thinking-off round. Accepted — on the demo box the Fast
        // tier is 'none' (effortForIteration honours the tier's own setting
        // over the schedule), and cloud tiers rarely hit 8192 tokens of
        // thinking before a tool call.
        turn.turnEffort = effortForIteration(0, false, profile, tier.reasoningEffort);
        // Every event the loop emits from here on passes the narrator, which
        // observes only `thinking` / `thinking_stop` and forwards the rest
        // untouched. The wrap happens here, not at declaration, so the
        // pre-loop events (session, resume, model_selected) stay a plain write.
        if (narrationModelId) {
            const narrator = createThoughtNarrator({ send: sendRaw, modelId: narrationModelId });
            turn.narrator = narrator;
            turn.send = narrator.wrap(sendRaw);
        }
        turn.iter = await runBuildLoop(turn);

        await closeTurn(turn);

        if (turn.narrator) turn.narrator.close();
        sendRaw('done', { automationId: draftWrap.automationId, finalized: turn.lastFinalized, iterations: turn.iter, usage: turn.usageTotals });
        stopHeartbeat();
        res.end();
    } catch (e) {
        log.error('[automationBuilder/stream] error:', e);
        if (turn.narrator) turn.narrator.close();
        sendRaw('error', { error: /** @type {Error} */ (e).message });
        stopHeartbeat();
        res.end();
    }
});

module.exports = router;
