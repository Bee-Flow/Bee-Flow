/**
 * App Studio Builder — POST /stream, the conversational build turn.
 *
 * The route's own wiring: validate + load pre-SSE (./turnSetup), pick the
 * model (./modelSelection), open the stream, assemble the prompt
 * (./promptAssembly), run the rounds (./buildLoop) and close the turn
 * (./turnClosing, ./usageAccounting). Everything before `res.writeHead` is
 * deliberately still plain JSON, so a refusal carries a status the client can
 * branch on instead of an `error` event inside a 200.
 *
 * WHAT A CALLER MAY SEND: the body is a zod schema, `TurnBody` in
 * ./turnSetup.js — `.strict()`, parsed there rather than mounted here with
 * validate(), because readTurnRequest's refusals are answered verbatim below
 * (the `error`, `code: 'invalid_request'` and pathed `details` validate()
 * gives), before the allowance check and before the stream opens
 * (chatStream.validation.test.js). readTurnRequest has refusals of its own
 * beside the schema's — "Message required" and the image gate's
 * `invalid_image` — and the route answers all of them in the one place. It
 * reads no query string and no path parameters, so there is nothing there
 * to schema.
 *
 * SSE EVENT CONTRACT (the frontend is built against exactly these):
 *   builder_session   { sessionId, appId }
 *   model_selected    { modelId, tier }
 *   round_start       { iter, modelId, promptChars, effort, local, providerType }
 *       — emitted before every model call; `local` says the request stays on
 *       this machine, `promptChars` is what the model is about to read.
 *   prompt_progress   { iter, total, cache, processed, timeMs } — llama.cpp
 *       prefill progress (return_progress), ≤ 4/s; `cache` = tokens already held.
 *   tool_draft        { iter, name, chars, count, items:[{kind,type,label,partial}], parentId }
 *       — the card being TYPED: what the streaming tool arguments already
 *       describe (≤ 1 per 250 ms, plus one at once when an item appears or
 *       closes). A visualisation only; never fed back to the model.
 *   thinking_start { partId } / thinking { delta, partId } / thinking_stop { partId }
 *   message           { content }            — assistant prose (streamed deltas)
 *   tool_call         { name, label, ok, summary, added:[{id,type,label}], error?,
 *       hint?, arguments, result, recovered? } — `summary` is the one-line copy the
 *       first clients read; `added` names what landed (typed activity rows, ghost
 *       clearing); `arguments`/`result` are the model-facing payloads, 8 KB
 *       each, with the screenshot side channel stripped. `recovered` ('thinking' |
 *       'content') marks a call the model WROTE as text and the server parsed
 *       and ran (core/llm/leakedToolCalls) instead of ending the turn on it.
 *   draft             { appId, definition, version }
 *   data_model        { modelVersion, tables:[{id,key,name,fieldCount,rowCount,linked?:{kind,mode}}], datasets:[{id,name}] }
 *   plan              EITHER the plan-first artifact { planId, plan } (app_propose_plan,
 *       awaiting approval) OR the live checklist { todos:[{text,done}] } (app_set_plan
 *       and the route's own progress inference) — a client branches on which key is
 *       present; the checklist never touches the pending artifact.
 *   image             { data, mimeType, caption }  — a screenshot the AI took of the
 *       draft via app_screenshot (base64 PNG, no data: prefix); shown in the transcript
 *   validation_errors { errors, warnings }
 *   usage             { inputTokens, outputTokens, iter, effort, prompt_tokens,
 *       completion_tokens, cached_tokens?, timings?, totals } — the cumulative
 *       pair the first clients read, plus this round's adapter payload verbatim
 *       (llama.cpp `timings` carry prompt_n/cache_n/predicted_per_second).
 *   done              { appId, finalized }
 *   error             { message, code }         — code ∈ subscription_limit |
 *       rate_limited | model_unavailable | transient_upstream | model_rejected |
 *       model_truncated | model_empty_reply | budget_exhausted | validation_failed |
 *       save_conflict | internal (Wave 6c error taxonomy). model_rejected = the
 *       provider refused the request itself (a 4xx other than 408/429): resending
 *       cannot help. model_truncated = two rounds hit max_tokens without a tool
 *       call. model_empty_reply = two rounds ended with neither a tool call nor
 *       text (typically a call written as text the server could not parse).
 *
 * OBSERVABILITY (Wave 6c): every turn logs ONE usageStore.logUsage row
 * (agent_type 'studio_app_builder'); ai_usage_log has no metadata column so the
 * identifying fields fold into columns (agent_id=appId, conversation_id=session,
 * stop_reason=outcome) and the full per-turn metadata ships as a structured
 * stdout line ("[AppStudioBuilder] usage {...}") → OpenObserve. Each SSE `error`
 * additionally emits a structured stderr line keyed by its taxonomy code.
 *
 * PROMPT-CACHE DISCIPLINE (mirrors automationBuilder.js): the system prompt
 * (instructions + catalog + owner's automations) is byte-stable across turns;
 * few-shots ride every turn on the small profile; history is a head-anchored
 * window evicted in whole blocks; and the live draft state + every other
 * machine note travel INSIDE the single user message each turn (see
 * ./appStudioBuilder/turnMessages.js) so provider prefix caches keep hitting
 * while the user iterates. One log line per turn prints the prefix digests.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();

const studioAppStore = require('../../../stores/studioAppStore');
const { getAdapter } = require('../../../core/providers');
const { perUserRateLimit } = require('../../../utils/perUserRateLimit');
const { startSseHeartbeat } = require('../../../core/http/sseHelpers');
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');
const { readTurnRequest, loadDraftWrap, loadTurnDataModel, attachCrossTurnState } = require('./turnSetup');
const { resolveBuilderModel } = require('./modelSelection');
const { assembleTurnPrompt } = require('./promptAssembly');
const { makeTurnUsageLogger } = require('./usageAccounting');
const { runBuildLoop } = require('./buildLoop');
const { handleProposedPlan, runAutoFinalizeNet, persistTurnSnapshot, classifyTurnOutcome } = require('./turnClosing');

// Each builder turn is a multi-iteration LLM conversation chaining many tool
// calls — expensive. Same ceiling as the automation builder: 12/min/user.
const builderRateLimit = perUserRateLimit({ windowMs: 60_000, max: 12 });

// Hard ceiling on iterations per turn regardless of profile. 24 matches the
// automation builder — data-backed builds (tables + seed + bindings) need the
// extra rounds.
const MAX_ITERATIONS = 24;

// Checkpoints (studio_app_versions snapshots) written per turn — plan approval
// + each phase boundary. Capped so a phase-heavy build can't churn the shared
// 20-snapshot publish history.
const MAX_CHECKPOINTS_PER_TURN = 5;

router.post('/stream', requireAuth, builderRateLimit, async (req, res) => {
    const userId = req.session.user.id;
    // Wall-clock start of the turn — feeds the usage row's duration_ms and the
    // structured observability line (Wave 6c). Set before any SSE so a turn that
    // dies mid-stream still reports a real duration from the outer catch.
    const turnStartedAt = Date.now();

    // ── The request contract (body → this turn's inputs). Its refusals are
    //    pre-SSE and stay clean JSON. ──
    const turnRequest = readTurnRequest(req);
    if (turnRequest.failed) return res.status(turnRequest.failed.status).json(turnRequest.failed.body);
    const {
        message, requestedAppId, clientSession, modelTier, editorContext,
        planMode, planApproval, isApproval, continueToken, inboundImages, effectiveMessage,
    } = turnRequest;

    // ── Subscription limit enforcement — BEFORE switching to SSE, so the
    //    402 stays clean JSON (same shape as routes/ai/webpageChat.js). ──
    let limitOrgId = null;
    const { checkSubscriptionLimits } = require('../../../core/entitlements/limits');
    const { resolveUserOrgIds } = require('../../../auth');
    const orgIds = await resolveUserOrgIds(req);
    limitOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    // Pre-SSE, so this stays clean JSON — but carry the taxonomy code too
    // (Wave 6c) so a non-streamed client can branch the same way as an
    // in-stream subscription_limit error.
    if (limitError) return res.status(402).json({ error: limitError, code: 'subscription_limit' });

    // ── Load the draft (owner-only) — a bad appId 404s pre-SSE. ──
    let draftWrap;
    let priorSnapshot = null;
    const loaded = await loadDraftWrap(req, { userId, requestedAppId, clientSession });
    if (loaded.notFound) return res.status(404).json({ error: 'App not found' });
    ({ draftWrap, priorSnapshot } = loaded);

    // ── Data model + dataset ids — loaded once per turn. Feeds the
    //    draft-state data block, the data-reference validation (finalize +
    //    feedback loop) AND the data tools (app_upsert_table & co mutate the
    //    model through persistDataModel's CAS against dataModelVersion).
    //    Best-effort: on a store error the fields stay undefined and the
    //    data-reference checks are skipped for this turn (never a 500). ──
    try {
        await loadTurnDataModel(draftWrap, userId);
    } catch (e) {
        log.error('[AppStudioBuilder] data-model load failed (checks skipped this turn):', e.message);
    }

    // The agent's own checklist, the brief and the screen constraint — the
    // state that survives between turns, back onto the draftWrap.
    attachCrossTurnState(draftWrap, { priorSnapshot, message });

    // ── Model resolution (pre-SSE, like webpageChat — clean JSON errors). ──
    const userOrgForTiers = req.session?.user?.organizationId || limitOrgId || null;
    let resolvedTier;
    let modelId;
    let tier = {};
    let cfg;
    let adapter;
    try {
        const picked = await resolveBuilderModel({ userOrgForTiers, userId, session: req.session, continueToken, priorSnapshot, modelTier });
        if (picked.error) return res.status(picked.status || 400).json({ error: picked.error, code: picked.code });
        ({ resolvedTier, modelId, tier, cfg } = picked);
        adapter = getAdapter(cfg.providerType, cfg.url);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }

    // Vision plumbing for app_screenshot: whether THIS model can be shown the
    // screenshots it takes. Rides on draftWrap so the tool can word its result
    // for a blind model without changing the applyToolCall signature.
    const modelSupportsVision = typeof adapter?.supportsVision === 'function'
        ? !!adapter.supportsVision(modelId) : false;
    draftWrap.modelSupportsVision = modelSupportsVision;

    // ── SSE from here on. flushHeaders + 10s heartbeat are REQUIRED: a
    //    thinking model can go silent for 30–60s and an idle gateway would
    //    otherwise drop the stream into a false 504 (same class as the
    //    automation-builder incident / BFSF-221). ──
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const stopHeartbeat = startSseHeartbeat(res);
    const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) { /* stream gone */ }
    };

    // ── Wave 6c error taxonomy: an SSE `error` carries a machine `code` AND
    //    leaves a structured stderr line (shipped to OpenObserve via stdout —
    //    no monitoring tables). Codes: subscription_limit | rate_limited |
    //    model_unavailable | transient_upstream | budget_exhausted |
    //    validation_failed | save_conflict | internal. ──
    const sendError = (code, userMessage) => {
        send('error', { message: userMessage, code });
        log.error(`[AppStudioBuilder] code=${code} appId=${draftWrap.appId || '-'} session=${draftWrap.builderSessionId || '-'} model=${modelId || '-'}`);
    };

    // ── Wave 6c per-turn usage metrics + outcome. Declared out here (not inside
    //    the try) so the outer catch can still log a turn that blew up. ──
    const usageTotals = { inputTokens: 0, outputTokens: 0 };
    const proseParts = [];
    // What the build loop records and the rest of the turn reads back. An
    // object rather than let-bindings, because ./buildLoop.js writes to it and
    // the outer catch has to be able to log a turn that died inside the loop.
    const turn = {
        iter: 0,
        lastFinalized: false,
        toolCallCount: 0,      // every tool call the model made this turn
        mutatingToolCalls: 0,  // successful definition/data mutations
        validationErrorCount: 0,
        // The two facts the auto-finalize net reads. The MODEL closed the turn
        // — a final message with no tool call — is the one exit where "the app
        // is done" is the model's own reading; every other exit (a stop, a
        // failure, a closed tab) is ours. And something LANDED this turn: a
        // prose-only answer to a question is not a build.
        modelEndedTurn: false,
        builtThisTurn: false,
        proposedPlan: null,    // { planId, plan } once app_propose_plan fires
        lastPhaseIndex: null,  // highest phase index marked this turn
        lastValidation: null,
        persistBroken: false,
        // Stop the loop the moment the client disconnects — no point burning
        // tokens with nowhere to send the output.
        clientGone: false,
    };
    const logTurnUsage = makeTurnUsageLogger({ userId, draftWrap, modelId, resolvedTier, usageTotals, turnStartedAt, turn });

    try {
        send('builder_session', { sessionId: draftWrap.builderSessionId, appId: draftWrap.appId });
        send('model_selected', { modelId, tier: resolvedTier });
        if (draftWrap._todos.length) send('plan', { todos: draftWrap._todos });

        // The system prompt, the tool menu and this turn's folded user message.
        const { profile, tools, toolNameSet, history, approvedPlanForTurn, messages } = await assembleTurnPrompt({
            send, userId, modelId, resolvedTier, draftWrap, priorSnapshot, isApproval, planApproval, planMode,
            editorContext, inboundImages, modelSupportsVision, effectiveMessage,
        });

        // Per-turn checkpoint bookkeeping.
        let checkpointsThisTurn = 0;     // capped at MAX_CHECKPOINTS_PER_TURN
        const writeCheckpoint = async (summary) => {
            if (!draftWrap.appId || checkpointsThisTurn >= MAX_CHECKPOINTS_PER_TURN) return;
            try {
                const versionId = await studioAppStore.createVersionSnapshot(draftWrap.appId, userId, draftWrap.def, summary);
                checkpointsThisTurn += 1;
                send('checkpoint', { versionId, summary });
            } catch (e) {
                log.error('[AppStudioBuilder] checkpoint failed (non-fatal):', e.message);
            }
        };
        // Snapshot the state BEFORE the approved build begins, so the user can
        // revert the whole plan in one click.
        if (isApproval) await writeCheckpoint('AI checkpoint — before plan');

        const iterationBudget = Math.min(profile.maxIterations || MAX_ITERATIONS, MAX_ITERATIONS);

        // An AbortController as well as the flag: the flag is only read at the
        // TOP of the next iteration, so without this a closed tab still ran the
        // CURRENT round to the max_tokens cap — on a self-hosted box, on the
        // model's only slot. streamWithRetry forwards the signal to the adapter.
        const clientAbort = new AbortController();
        req.on('close', () => {
            turn.clientGone = true;
            try { clientAbort.abort(); } catch (_) { /* already aborted */ }
        });

        await runBuildLoop(turn, {
            res, send, sendError, messages, adapter, cfg, modelId, tier, profile, tools, toolNameSet,
            iterationBudget, draftWrap, userId, modelSupportsVision, approvedPlanForTurn, writeCheckpoint,
            usageTotals, proseParts, clientAbort,
        });

        const awaitingPlan = await handleProposedPlan(turn, { draftWrap, send });
        const { continuation, budgetExhausted } = await runAutoFinalizeNet(turn, {
            draftWrap, iterationBudget, approvedPlanForTurn, send, sendError,
        });
        await persistTurnSnapshot(turn, {
            draftWrap, userId, history, inboundImages, effectiveMessage, proseParts,
            resolvedTier, approvedPlanForTurn, isApproval, priorSnapshot, continuation,
        });

        // ── Wave 6c: log ONE usage row for the turn (in the done finalization
        //    path). The outcome classifies how the turn ended for OpenObserve. ──
        turn.validationErrorCount = Array.isArray(turn.lastValidation?.errors) ? turn.lastValidation.errors.length : 0;
        const outcome = classifyTurnOutcome(turn, { awaitingPlan, continuation, budgetExhausted });
        logTurnUsage(outcome);

        const donePayload = { appId: draftWrap.appId, finalized: turn.lastFinalized };
        if (awaitingPlan) donePayload.awaitingPlan = true;
        if (continuation) donePayload.continuation = continuation;
        send('done', donePayload);
        stopHeartbeat();
        res.end();
    } catch (e) {
        log.error('[appStudioBuilder/stream] error:', e);
        // The real error stays in the server log — the client gets a generic
        // line (an internal exception message is not ours to disclose).
        sendError('internal', 'Something went wrong while building. Your draft is saved — please send your message again.');
        // Still record the turn's usage (Wave 6c) — a turn that died mid-stream
        // burned tokens too. logTurnUsage is idempotent, so a done-path log that
        // already ran wins; this only fires when we never reached it.
        try { logTurnUsage('internal'); } catch (_) { /* never block cleanup */ }
        stopHeartbeat();
        res.end();
    }
});

module.exports = router;
