/**
 * App Studio Builder — the build loop: one turn's rounds with the model.
 *
 * Each round sends the conversation, streams the answer back over SSE
 * (thinking, prose, the card being typed), runs whatever tools the model
 * asked for, persists + validates after every mutation, and feeds the result
 * back as the next round's input. It ends when the model closes the turn, a
 * plan is proposed, the draft finalizes, the budget runs out, or one of the
 * ladders below gives up.
 *
 * THE LADDERS (each measured, each ends the turn with a taxonomy code rather
 * than a silent `done`):
 *   • truncation — a round that hit max_tokens without a tool call; one retry.
 *   • unparseable arguments — the adapter could not hand the call up, so the
 *     round looks empty; the model is asked for THAT call again, twice at most.
 *   • empty reply — neither a tool call nor a word, typically a call written
 *     as text that core/llm/leakedToolCalls could not recover; one nudge.
 *   • repeat rung 3 / 3b — the same change refused three times, or one tool
 *     refused TOOL_REFUSAL_STREAK_MAX times in a row.
 *
 * `turn` is the state the route reads back afterwards (and the outer catch
 * logs a blown-up turn from): an object rather than a set of let-bindings,
 * precisely because it has to survive this function throwing.
 */

const crypto = require('crypto');
const { validateAppDefinition } = require('../../../appStudio/validate');
const { MUTATING_TOOLS, DATA_MODEL_TOOLS, applyToolCall, persistDraft } = require('../../../appStudio/builderTools');
const { effortForIteration } = require('../../../appStudio/builderModelProfiles');
const { isTransientChatError } = require('../builderShared');
const { isLocalProviderType } = require('../../../core/providers/localModels');
const { makeDraftThrottle, makeProgressThrottle } = require('../../../core/llm/partialJsonScan');
const { mergePlanTodos, applyPlanMarkDone, planEcho } = require('../../../core/llm/planChecklist');
const { scanAppToolDraft, deriveAppDraftKey } = require('./toolDraft');
const { inferAppPlanProgress } = require('./planProgress');
const { toolCallEvent, labelForTool } = require('./toolCallEvents');
const { dataModelEvent } = require('./dataModelEvent');
const { streamWithRetry } = require('./modelStream');
const {
    parseToolArgs, truncationRetryMessages, emptyReplyRetryMessages, renderValidationNote, truncateJson,
    isTruncatedStop, providerErrorExcerpt, providerErrorStatus, accumulateUsage, emptyUsageTotals,
    recoverLeakedToolCalls, RECOVERED_CALL_HINT, REPAIRED_CALL_HINT, isBlankReply,
} = require('./turnLoop');
const log = require('../../../telemetry/log');

const TOOL_REFUSAL_STREAK_MAX = 4; // consecutive refusals of one tool that end the turn (rung 3b)

// Output cap per model round. A round that stops at this cap without a tool
// call is retried once (see the loop) — the log names the round.
const MAX_TOKENS_PER_ROUND = 8192;

async function runBuildLoop(turn, {
    res, send, sendError, messages, adapter, cfg, modelId, tier, profile, tools, toolNameSet,
    iterationBudget, draftWrap, userId, modelSupportsVision, approvedPlanForTurn, writeCheckpoint,
    usageTotals, proseParts, clientAbort,
}) {
    // The state the ROUTE reads back — lastFinalized, lastValidation,
    // persistBroken, modelEndedTurn, builtThisTurn, proposedPlan,
    // lastPhaseIndex, the counters and iter — lives on `turn`, and
    // usageTotals/proseParts are the caller's (Wave 6c), so the route's outer
    // catch can still log a turn that blew up in here. Only the state that
    // begins and ends inside the loop is declared below.
    let escalateNextRound = false;  // a repair signal for the log only — effort is fixed per turn
    let truncationRetries = 0;
    let emptyReplyRetries = 0;      // a round with neither a tool call nor text — one nudge, then a plain message
    // The two facts the auto-finalize net (after the loop) reads. The MODEL
    // closed the turn — a final message with no tool call — is the one
    // exit where "the app is done" is the model's own reading; every other
    // exit (a stop, a failure, a closed tab) is ours. And something LANDED
    // this turn: a prose-only answer to a question is not a build.
    // Repair rounds spent on unparseable tool arguments. Bounded: a model
    // that cannot write valid JSON twice will not manage it on the tenth
    // try, and each attempt costs a full round on a single-slot box.
    let invalidArgsRetries = 0;
    const INVALID_ARGS_MAX_RETRIES = 2;
    let repeatedStop = null;        // rung 3 of the repeat ladder — ends the turn
    // Rung 3b (measured 2026-09-13): the same TOOL refused round after round
    // with slightly different arguments (a garbled tail, a renamed action
    // id) never trips the identical-resend count, and one turn burned 20
    // rounds on it. Consecutive refusals per tool name, reset by a success
    // of that tool; at TOOL_REFUSAL_STREAK_MAX the turn ends the same way.
    const toolRefusalStreak = new Map();
    const roundTotals = emptyUsageTotals();
    // ONE effort for the whole turn, the tier's own setting first: a Fast
    // tier set to 'None' really sends none (Gemma thinking off), and the
    // chat template's tail stays byte-stable across the rounds of a turn.
    // The per-round escalation this replaced re-rendered that tail and
    // could switch thinking ON mid-build after a single rejected call.
    const turnEffort = effortForIteration(0, false, profile, tier.reasoningEffort);
    // Screenshots captured this round, queued for a vision-capable model as
    // a user image message after the round's tool results — tool-result
    // content must stay a string for OpenAI/Mistral, so the image cannot
    // ride the tool message itself (webpageChat.js's pattern).
    const pendingVisionImages = [];

    for (turn.iter = 0; turn.iter < iterationBudget; turn.iter++) {
        // Read-only alias for this round: every line below names the round
        // it is in, and only the loop header advances it.
        const iter = turn.iter;
        if (turn.clientGone || res.writableEnded) {
            log.info('[appStudioBuilder/stream] client disconnected — aborting build loop');
            break;
        }
        const turnToolChoice = (iter === 0 && profile.forceFirstToolCall) ? 'required' : 'auto';
        if (escalateNextRound) log.info(`[AppStudioBuilder] round ${iter} follows a rejected call`);
        escalateNextRound = false;

        // Before the model reads: what it is about to read and where.
        send('round_start', {
            iter, modelId, promptChars: JSON.stringify(messages).length, effort: turnEffort,
            local: isLocalProviderType(cfg.providerType),
            providerType: cfg.providerType || null,
        });
        // Fresh gates each round: the first delta of a round always lands.
        const progressGate = makeProgressThrottle();
        const draftGate = makeDraftThrottle();

        let response;
        try {
            response = await streamWithRetry(adapter, cfg, modelId, messages, {
                maxTokens: MAX_TOKENS_PER_ROUND,
                temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
                tools,
                toolChoice: turnToolChoice,
                reasoningEffort: turnEffort,
                reasoningSummary: tier.reasoningSummary !== undefined ? tier.reasoningSummary : 'auto',
                promptCacheKey: draftWrap.builderSessionId || undefined,
                userId: String(userId),
            }, {
                send,
                signal: clientAbort.signal,
                // The card being typed: read the streamed arguments so far
                // and say what they already describe.
                onToolArgsDelta: ({ name, partial }) => {
                    const text = typeof partial === 'string' ? partial : '';
                    const scan = scanAppToolDraft(name, text);
                    if (!draftGate(deriveAppDraftKey(scan))) return;
                    send('tool_draft', { iter, name, chars: text.length, count: scan.count, items: scan.items, parentId: scan.parentId });
                },
                // llama-server prefill progress; ≤ 4/s, the completing
                // chunk always passes.
                onPromptProgress: ({ total, cache, processed, time_ms }) => {
                    const done = total > 0 && processed >= total;
                    if (!progressGate(done)) return;
                    send('prompt_progress', { iter, total, cache, processed, timeMs: time_ms });
                },
            });
        } catch (chatErr) {
            // The draft is persisted after every mutation, so end the turn
            // either way — but say the TRUE thing. A 4xx other than
            // 408/429 is the provider refusing the request itself (a chat
            // template rejecting the shape, an unknown model): "send it
            // again" would loop the user into the same refusal.
            log.error('[AppStudioBuilder] chat failed after retries:', chatErr.message);
            const status = providerErrorStatus(chatErr) || (typeof chatErr?.status === 'number' ? chatErr.status : null);
            const permanent = status !== null && status >= 400 && status < 500 && !isTransientChatError(chatErr);
            if (permanent) {
                sendError('model_rejected', `The AI model rejected the request (HTTP ${status}): ${providerErrorExcerpt(chatErr.message)} — your draft is saved. Resending will not help; check the model or tier settings.`);
            } else {
                // Unknown or network-shaped failures keep the transient
                // wording: "send again" is the right advice for those.
                sendError('transient_upstream', 'The AI provider had a temporary problem. Your draft is saved — please send your message again.');
            }
            break;
        }

        // A call the model WROTE instead of made — Gemma 4 puts it in its
        // thought channel in its own wire syntax, and the runtime's parser
        // does not read it there (2026-09-13: round 4 of the invoice app,
        // `app_upsert_table` for suppliers, came back as reasoning text and
        // the turn ended in silence). The grammar is small and the call is
        // right there, so the server parses it and runs it like any other;
        // the model reads what happened in the tool result. Before the
        // prose push so a recovered span never lands in the transcript.
        let recoveredRound = null;
        if (!response.toolCalls || !response.toolCalls.length) {
            recoveredRound = recoverLeakedToolCalls(response, { toolNames: toolNameSet, iter });
            if (recoveredRound.toolCalls.length) {
                const names = recoveredRound.toolCalls.map((tc) => tc.function.name).join(', ');
                log.warn(`[AppStudioBuilder] round ${iter}: recovered ${recoveredRound.toolCalls.length} tool call(s) written as text in the model's ${recoveredRound.sources.join('/')} (${names})`);
                response.toolCalls = recoveredRound.toolCalls;
                response.content = recoveredRound.content;
            }
        }

        if (response.content) proseParts.push(response.content);
        if (response.usage) {
            // The cumulative pair the first clients read, plus this round's
            // adapter payload verbatim: llama.cpp `timings` (prompt_n,
            // cache_n, predicted_per_second) and cached_tokens feed the
            // engine line on the canvas.
            usageTotals.inputTokens += Number(response.usage.prompt_tokens) || 0;
            usageTotals.outputTokens += Number(response.usage.completion_tokens) || 0;
            accumulateUsage(roundTotals, response.usage);
            send('usage', { ...response.usage, iter, effort: turnEffort, totals: { ...roundTotals }, ...usageTotals });
        }

        // Signed thinking blocks must be replayed before the tool_use
        // blocks on the next request (Anthropic conversation integrity).
        // An adapter that surfaces RAW reasoning (the local one: llama.cpp
        // replays reasoning_content after the last user message) keeps
        // its unsigned parts too, as {text} — the adapter maps them.
        const rawReasoning = typeof adapter?.surfacesRawReasoning === 'function' && !!adapter.surfacesRawReasoning();
        const thinkingForReplay = (response.thinkingParts || [])
            .filter((p) => p.text && !p.redacted && (p.signature || rawReasoning))
            .map((p) => (p.signature ? { text: p.text, signature: p.signature } : { text: p.text }));

        if (!response.toolCalls || !response.toolCalls.length) {
            // A round that hit max_tokens without a tool call is not "the
            // model is done" — it is a reply that never got to building
            // (reasoning that ran to the cap). One retry, told plainly;
            // the second time the turn ends with a code the client can
            // word, instead of a silent `done` with nothing built.
            if (isTruncatedStop(response.finishReason)) {
                if (truncationRetries < 1) {
                    truncationRetries += 1;
                    log.warn(`[AppStudioBuilder] round ${iter} hit the length limit without a tool call — retrying once`);
                    messages.push(...truncationRetryMessages(response.content, thinkingForReplay));
                    continue;
                }
                sendError('model_truncated', 'The model ran out of room while reasoning and never got to building. Switch the builder to a tier with thinking off, or shorten the request.');
                break;
            }
            // Neither a tool call nor a word for the user is not "done"
            // either: it is the round above with a call the server could
            // NOT parse (an unknown name, broken arguments), or a model
            // that simply stopped. Nudge once, naming what was seen; the
            // second time the turn ends with a code the client can word
            // instead of an empty canvas and a `done`.
            // A call the model DID make but wrote with broken JSON arguments.
            // The adapter cannot hand it up (base.js: echoing a half-written
            // call back is a 400 or a spin loop), so the round arrives
            // looking empty. Naming the tool and asking for that one call
            // again is a repair the model can perform; the blank-reply nudge
            // below is not, because it does not know what went wrong.
            if (!response.toolCalls && Array.isArray(response.invalidToolCalls) && response.invalidToolCalls.length
                && invalidArgsRetries < INVALID_ARGS_MAX_RETRIES) {
                invalidArgsRetries += 1;
                const names = response.invalidToolCalls.map((c) => c.name).filter(Boolean);
                const label = names.length ? names.join(', ') : 'a tool';
                log.warn(`[AppStudioBuilder] round ${iter}: ${response.invalidToolCalls.length} call(s) had unparseable arguments (${label}) — asking for a resend`);
                messages.push({
                    role: 'user',
                    content: `[Instructions from the system — not written by the user]\nYour arguments for ${label} were not valid JSON, so the call could not be run. Send just THAT call again, with complete, valid JSON arguments and nothing else. Keep it small: if the call was long, split it into two smaller calls.`,
                });
                continue;
            }
            const emptyReply = isBlankReply(response.content);
            const rejected = recoveredRound ? recoveredRound.rejected : [];
            if (emptyReply || rejected.length) {
                if (emptyReplyRetries < 1) {
                    emptyReplyRetries += 1;
                    log.warn(`[AppStudioBuilder] round ${iter} produced no tool call and no text${rejected.length ? ` (${rejected.length} call(s) written as text could not be recovered: ${rejected.map((r) => `${r.name || '?'}:${r.reason}`).join(', ')})` : ''} — nudging once`);
                    messages.push(...emptyReplyRetryMessages(response.content, thinkingForReplay, rejected));
                    continue;
                }
                sendError('model_empty_reply', 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch the builder to another tier.');
                break;
            }
            turn.modelEndedTurn = true;
            break; // final prose — turn done
        }

        messages.push({
            role: 'assistant',
            content: response.content || null,
            ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
            tool_calls: response.toolCalls.map((tc) => ({
                id: tc.id, type: 'function',
                function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
                },
                _thought_signature: tc._thought_signature || undefined,
            })),
        });

        let mutatedThisIter = false;
        for (const tc of response.toolCalls) {
            turn.toolCallCount += 1;
            const name = tc.function.name;
            const { args, truncated } = parseToolArgs(tc.function.arguments, name);
            let toolResult;
            if (truncated) {
                toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.` };
                escalateNextRound = true;
            } else if (name === 'app_set_plan') {
                // Route-handled: the model's own to-do list. Full-list form
                // replaces it; the cheap markDone form flips items. The echo
                // carries the LIST with indices — it is the model's only
                // cross-round memory of its plan.
                if (Array.isArray(args.todos) && args.todos.length) {
                    // A full list again keeps the ticks the build already
                    // earned (2026-09-13: a verbatim resend reset 0/6 twice).
                    const merged = mergePlanTodos(draftWrap._todos || [], args.todos);
                    draftWrap._todos = merged.todos;
                    toolResult = planEcho(merged.todos);
                    if (merged.unchanged) toolResult.note = 'Plan unchanged — these items were already recorded; done flags kept. Do not resend the plan; continue with `next`.';
                    else send('plan', { todos: merged.todos });
                } else {
                    const todos = applyPlanMarkDone(draftWrap._todos || [], args.markDone);
                    draftWrap._todos = todos;
                    toolResult = planEcho(todos);
                    send('plan', { todos });
                }
            } else {
                toolResult = await applyToolCall(name, args, draftWrap);
            }
            if (tc._recovered && toolResult && typeof toolResult === 'object') {
                // The model never made this call — it wrote it. Say so where
                // it reads: the result. (An error result keeps its own hint.)
                toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), RECOVERED_CALL_HINT];
            }
            if (tc._repaired && toolResult && typeof toolResult === 'object') {
                // The adapter closed a cut-off argument string after its
                // last complete entry (base.js). Without this the model
                // reads a clean result and assumes the tail landed too.
                toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), REPAIRED_CALL_HINT];
            }
            const ok = !(toolResult && typeof toolResult === 'object' && toolResult.error);
            // Tick the checklist from what the call DID. The small local
            // models never send markDone; the owner watched a finished app
            // sit at 0/6. Additive only — the model's own markDone still
            // works — and `_plan` rides the result so the model reads its
            // progress instead of re-deriving it.
            if (ok && name !== 'app_set_plan' && Array.isArray(draftWrap._todos) && draftWrap._todos.length) {
                const ticked = inferAppPlanProgress(draftWrap._todos, { name, args, result: toolResult });
                if (ticked.length) {
                    draftWrap._todos = applyPlanMarkDone(draftWrap._todos, ticked);
                    send('plan', { todos: draftWrap._todos });
                    if (toolResult && typeof toolResult === 'object') {
                        toolResult._plan = { markedDone: ticked, next: (draftWrap._todos.find((t) => !t.done) || {}).text || null };
                    }
                }
            }
            if (ok && (MUTATING_TOOLS.has(name) || DATA_MODEL_TOOLS.has(name))) { turn.mutatingToolCalls += 1; turn.builtThisTurn = true; }

            // ── Wave 5: app_propose_plan is a read tool the ROUTE finishes.
            //    Capture the bounded plan, mint a planId, and END the turn
            //    after this round (below). The model only ever sees the
            //    acknowledgement — the echoed plan is stripped here. ──
            if (ok && name === 'app_propose_plan' && toolResult && toolResult.plan) {
                const planId = `plan_${crypto.randomBytes(3).toString('hex')}`;
                turn.proposedPlan = { planId, plan: toolResult.plan };
                toolResult = { presented: true, planId };
            }

            send('tool_call', { ...toolCallEvent(name, args, toolResult, ok, draftWrap), ...(tc._recovered ? { recovered: tc._recoveredFrom || true } : {}) });

            // Persist + emit a draft snapshot after every successful mutation.
            if (ok && MUTATING_TOOLS.has(name)) {
                const persisted = await persistDraft(draftWrap);
                if (persisted.error) {
                    sendError('save_conflict', persisted.error);
                    turn.persistBroken = true;
                } else {
                    send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
                    mutatedThisIter = true;
                }
            }
            // Data mutations (tables/rows/roles/datasets — already persisted
            // inside the tool) additionally announce the new data shape so
            // the editor invalidates its table/dataset/role caches live.
            if (ok && DATA_MODEL_TOOLS.has(name)) {
                send('data_model', dataModelEvent(draftWrap));
            }
            if (name === 'app_finalize') {
                if (ok && toolResult.finalized) {
                    turn.lastFinalized = true;
                    send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
                } else if (toolResult && toolResult.validation) {
                    turn.lastValidation = toolResult.validation;
                    send('validation_errors', { errors: toolResult.validation.errors, warnings: toolResult.validation.warnings });
                }
            }
            // ── Wave 5: phase marker → progress SSE + a revert checkpoint. ──
            if (ok && name === 'app_mark_phase') {
                const total = (approvedPlanForTurn && Array.isArray(approvedPlanForTurn.phases))
                    ? approvedPlanForTurn.phases.length : 0;
                turn.lastPhaseIndex = toolResult.index;
                send('phase', { index: toolResult.index, total, label: toolResult.label });
                await writeCheckpoint(`AI checkpoint — ${toolResult.label}`);
            }
            // ── Wave 5: app_apply_template persisted BOTH sides inside
            //    installTemplate; reflect the fresh state to the client. ──
            if (ok && name === 'app_apply_template') {
                send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
                send('data_model', dataModelEvent(draftWrap));
                mutatedThisIter = true;
                turn.builtThisTurn = true;
            }
            if (!ok) escalateNextRound = true;
            // Rung 3 of the repeat ladder: the same call refused three
            // times. The model does not read "stop retrying" (measured);
            // the ROUTE ends the turn and tells the user in plain words.
            if (toolResult && typeof toolResult === 'object' && toolResult._repeated >= 3) {
                repeatedStop = { name, error: String(toolResult.error || '').slice(0, 300), alreadyAdded: toolResult.alreadyAdded || null };
            }
            if (ok) toolRefusalStreak.delete(name);
            else {
                const streak = (toolRefusalStreak.get(name) || 0) + 1;
                toolRefusalStreak.set(name, streak);
                if (streak >= TOOL_REFUSAL_STREAK_MAX && !repeatedStop) {
                    log.warn(`[AppStudioBuilder] ${name} refused ${streak} times in a row this turn — ending the turn`);
                    repeatedStop = { name, error: String(toolResult && toolResult.error || '').slice(0, 300), alreadyAdded: null, streak };
                }
            }

            // app_screenshot: the PNG must never enter the tool message —
            // the base64 would blow the prompt and non-Claude providers
            // reject non-string tool content. The user ALWAYS gets it as
            // an SSE image event; the model gets it as a user image
            // message after this round, and only when it can see.
            let toolContent = null;
            if (name === 'app_screenshot' && toolResult && typeof toolResult === 'object') {
                if (toolResult._screenshotDataUrl) {
                    const m = /^data:([^;]+);base64,(.+)$/s.exec(toolResult._screenshotDataUrl);
                    if (m) send('image', { data: m[2], mimeType: m[1], caption: toolResult._screenshotCaption || 'Screenshot' });
                    if (modelSupportsVision) pendingVisionImages.push(toolResult._screenshotDataUrl);
                }
                toolContent = String(toolResult.content || 'Screenshot captured.');
            }

            messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolContent ?? (typeof toolResult === 'string' ? toolResult : truncateJson(toolResult)),
            });
            if (turn.persistBroken) break;
        }
        if (turn.persistBroken) break;
        if (repeatedStop) {
            // Two wordings: a change the builder REFUSED three times, and
            // (2026-09-13) a batch the model kept resending after it had
            // landed — those components exist once, and saying "refused"
            // about them would be false.
            const dup = repeatedStop.alreadyAdded;
            const content = dup
                ? `I added those components once and was then asked to add them again three times — they are in the app once (${(dup.added || []).slice(0, 8).map((a) => `${a.type} ${a.id}`).join(', ')}${(dup.added || []).length > 8 ? ', …' : ''}). Everything built so far is saved. Tell me what should come next — for example the action that saves the form, or another screen.`
                : repeatedStop.streak
                    ? `I tried ${labelForTool(repeatedStop.name)} ${repeatedStop.streak} times in a row and the builder refused each one (last reason: ${repeatedStop.error}). Everything built so far is saved. Tell me how you want to proceed — for example a different table, column or screen.`
                    : `I tried the same change three times and the builder refused it each time (${labelForTool(repeatedStop.name)}: ${repeatedStop.error}). Everything built so far is saved. Tell me how you want to proceed — for example a different table, column or screen.`;
            send('message', { content });
            break;
        }

        // Hand this round's screenshots to the (vision-capable) model as a
        // user message so it can actually SEE the screen and iterate. The
        // array-content message never reaches the persisted history —
        // sanitizeHistory keeps string content only.
        if (pendingVisionImages.length) {
            messages.push({
                role: 'user',
                content: [
                    ...pendingVisionImages.map((url) => ({ type: 'image_url', image_url: { url } })),
                    { type: 'text', text: '[SCREENSHOT — machine-generated] Above is the screenshot you just captured with app_screenshot. Inspect it — wrapped or overflowing rows, empty regions, charts without data, clipped text, cramped spacing — and fix what is wrong before finalizing.' },
                ],
            });
            pendingVisionImages.length = 0;
        }

        // Wave 5: a plan was proposed — end the turn and let the route emit
        // the plan + await approval (no validation feedback on a plan turn).
        if (turn.proposedPlan) break;

        // Validation feedback loop: after any mutation, validate the draft,
        // surface the records to the client, and feed errors back to the
        // model as a clearly-framed role:'user' report (NOT role:'system' —
        // system messages get hoisted/concatenated by the Claude/Gemini
        // adapters and would invalidate the prompt cache mid-turn).
        if (mutatedThisIter) {
            turn.lastValidation = validateAppDefinition(draftWrap.def, {
                dataModel: draftWrap.dataModel,
                datasets: draftWrap.datasetIds,
                datatables: draftWrap._ownerDatatables,
            });
            send('validation_errors', { errors: turn.lastValidation.errors, warnings: turn.lastValidation.warnings });
            if (turn.lastValidation.errors.length) {
                messages.push({ role: 'user', content: renderValidationNote(turn.lastValidation) });
                escalateNextRound = true;
            }
        }

        if (turn.lastFinalized) break;
    }
}

module.exports = { runBuildLoop, MAX_TOKENS_PER_ROUND, TOOL_REFUSAL_STREAK_MAX };
