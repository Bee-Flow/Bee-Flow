// @typecheck
/** @typedef {import('./turnSetup').BuilderTurn} BuilderTurn */
/**
 * Automation Builder — the rounds of a turn: one model call per round
 * (announced with `round_start`, streamed with the two live visualisations),
 * leaked-call recovery, the tool calls (./toolDispatch.js), the validation
 * note, the wasted-round charge and the stop. A round without a tool call
 * goes to ./roundNudges.js. Moved verbatim from ./chatStream.js; the turn's
 * shared state rides on `turn`, this loop's own counters on `loop`, one
 * round's bookkeeping on `round`. Answers the iteration count `done` reports.
 */

const log = require('../../../telemetry/log');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const { withoutStagedTableIssues } = require('../../../automation/builderTools/pendingDatatables');
const { isLocalProviderType } = require('../../../core/providers/localModels');
const { streamWithRetry } = require('./modelStream');
const { scanToolDraft, deriveDraftKey, makeDraftThrottle, makeProgressThrottle } = require('./toolDraft');
const { accumulateUsage, renderValidationNote, providerErrorExcerpt, recoverLeakedToolCalls } = require('./chatTurnLoop');
const { WASTED_ROUNDS_LIMIT, stopSentence } = require('./turnStop');
const { dispatchToolCall } = require('./toolDispatch');
const { afterToolLessRound } = require('./roundNudges');

/**
 * @param {BuilderTurn} turn
 */
async function runBuildLoop(turn) {
    const {
        res, userId, send, messages, tools, draftWrap, turnMode, isolated, adapter, cfg, modelId, tier, profile,
        iterationBudget, clientAbort, turnEffort, usageTotals,
    } = turn;
    const loop = {
        // Rounds in a row in which every tool call was refused. Such a round
        // built nothing and taught the model one error message — it is
        // charged an extra iteration, and four of them end the turn.
        wastedRounds: 0,
        truncationRetries: 0,
        emptyReplyRetries: 0,   // a round with neither a tool call nor text — one nudge, then a plain message
        // Repair rounds spent on unparseable tool arguments (bounded by
        // roundNudges.INVALID_ARGS_MAX_RETRIES).
        invalidArgsRetries: 0,
        // One re-pin of tool_choice after a prose round on an empty draft.
        repinToolChoice: false,
        prosePinUsed: false,
        // One nudge per turn each: a plan turn that ended without a plan, and an
        // approved build that ended with its checklist still open.
        planGuardUsed: false,
        buildGuardUsed: false,
    };
    let iter = 0;
    for (iter = 0; iter < iterationBudget; iter++) {
        if (turn.clientGone || res.writableEnded) {
            log.info('[automationBuilder/stream] client disconnected — aborting build loop');
            if (turn.narrator) turn.narrator.close();
            break;
        }
        // First iteration on small / reasoning profiles: force a
        // tool call so the model can't fall back to prose. From
        // iteration 2 onward it's 'auto' — the model legitimately
        // needs to emit text once it's done mutating the draft.
        // Forcing a specific tool is incompatible with extended thinking
        // (Anthropic rejects tool_choice other than auto/none when thinking
        // is on). It can't actually collide here — forceFirstToolCall is only
        // set on the 'small' profile, whose models aren't reasoning-capable so
        // buildThinking no-ops — but guard anyway for safety.
        // Pinned on round 0, and pinned AGAIN for one round when the model
        // answered in prose while the draft is still empty.
        //
        // `forceFirstToolCall` exists because these models drop to prose
        // instead of building; releasing the pin after a single round left
        // that failure wide open from round 1 on, and prose with any content
        // is read as "done" further down — so a build request could end,
        // silently and successfully, with an empty canvas. Re-pinning costs
        // one round and only happens when nothing has been built yet, so a
        // model that has already made progress can still stop and talk.
        // Verified on the demo box 2026-09-16: llama-server honours
        // tool_choice:'required' on later rounds, not just the first.
        // A plan turn is never pinned on round 0 (it may only answer a
        // question); the plan end guard pins it once, and only where a forced
        // choice is safe (no extended thinking: see the note above).
        const turnToolChoice = (turnMode === 'plan'
            ? loop.repinToolChoice
            : (turnMode !== 'discuss' && profile.forceFirstToolCall && (iter === 0 || loop.repinToolChoice)))
            ? 'required'
            : 'auto';
        loop.repinToolChoice = false;
        let response;
        try {
            // Announce the round before the model call. On the local box the
            // first round's prefill takes ~200 s and the client renders a
            // waiting card for it; it needs the prompt size to hint how long.
            // The narrator wrapper forwards unknown events; old clients
            // ignore it.
            send('round_start', {
                iter, modelId, promptChars: JSON.stringify(messages).length, effort: turnEffort,
                // Lets the client say "on this machine, nothing sent
                // outside" and expect a prefill measurement.
                local: isLocalProviderType(cfg.providerType),
                providerType: cfg.providerType || null,
            });
            // Per-round gates for the two live visualisations. A new pair
            // each round: the first delta of a round always lands at once.
            const draftGate = makeDraftThrottle();
            const progressGate = makeProgressThrottle();
            // Stream the turn so the chat panel shows reasoning + text + tool
            // calls live (parity with direct/agent chat) instead of one
            // batched dump. reasoningEffort enables extended thinking on
            // capable models (Opus/Sonnet); the adapter no-ops it otherwise.
            response = await streamWithRetry(adapter, cfg, modelId, messages, {
                // 8192 (was 4096): a complex turn can chain several tool
                // calls whose JSON arguments don't fit in 4k — truncation
                // there produces invalid tool-call JSON. The extra headroom
                // makes that rare; the parse guard below catches the rest.
                maxTokens: 8192,
                temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
                tools,
                toolChoice: turnToolChoice,
                reasoningEffort: turnEffort,
                // OpenAI reasoning models stream NO thinking unless a
                // summary is requested (buildReasoningParams) — without
                // this the builder showed an empty "Thinking…" bubble on
                // o-series/GPT-5 tiers. Honour the tier's own setting,
                // default to 'auto' (visible thinking is a builder
                // feature); Claude/Gemini ignore the option.
                reasoningSummary: tier.reasoningSummary !== undefined ? tier.reasoningSummary : 'auto',
                // OpenAI-only cache routing hint (_applyCacheHints); the
                // other adapters ignore unknown options.
                promptCacheKey: draftWrap.builderSessionId || undefined,
                userId: String(userId),
            }, {
                send,
                signal: clientAbort.signal,
                // The steps a tool call already describes while its
                // arguments are still streaming (contract: tool_draft).
                // Throttled to one per 250 ms, plus one at once whenever a
                // derived field changes. The tool_call event that follows
                // clears it on the client.
                onToolArgsDelta: ({ name, partial }) => {
                    const text = typeof partial === 'string' ? partial : '';
                    const scan = scanToolDraft(name, text);
                    if (!draftGate(deriveDraftKey(scan))) return;
                    send('tool_draft', { iter, name, chars: text.length, count: scan.count, capped: !!scan.capped, steps: scan.steps, inspect: scan.inspect });
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
            // gracefully either way. But say the TRUE thing: a 4xx other
            // than 429/408 is a permanent rejection — the same request fails
            // the same way, and "please send your message again" sends the
            // user into a loop. Measured 2026-09-11: a chat template that
            // refuses a mid-conversation system message returned 400 twice
            // while the UI called it temporary and the owner saw only a
            // build that died instantly.
            const status = Number(chatErr?.status || chatErr?.statusCode
                || (/API error (\d{3})/.exec(String(/** @type {Error} */ (chatErr)?.message || '')) || [])[1]) || null;
            const permanent = !!status && status >= 400 && status < 500 && status !== 408 && status !== 429;
            log.error('[AutomationBuilder] chat failed after retries:', /** @type {Error} */ (chatErr).message);
            if (permanent) {
                send('error', {
                    error: `The AI model rejected the request (HTTP ${status}): ${providerErrorExcerpt(/** @type {Error} */ (chatErr).message)} — Your draft is saved. Resending will not help; check the model or tier settings.`,
                    transient: false,
                });
            } else {
                send('error', { error: 'The AI provider had a temporary problem. Your draft is saved — please send your message again.', transient: true });
            }
            break;
        }

        // Assistant text + thinking already streamed live via streamWithRetry.

        // Token accounting: accumulate this round's usage and surface it
        // (additive SSE event — clients that don't know it ignore it).
        if (response.usage) {
            accumulateUsage(usageTotals, response.usage);
            send('usage', { iter, effort: turnEffort, ...response.usage, totals: { ...usageTotals } });
        }

        // Signed thinking blocks for replay: Anthropic requires the thinking
        // that preceded a turn's tool_use to be re-sent on the next request.
        //
        // On a self-hosted runtime that hands reasoning back as plain text
        // (adapter.surfacesRawReasoning() — providers/local.js), the
        // UNSIGNED parts are kept too, as {text} only: the local adapter
        // maps `thinking` on an assistant tool-call message to
        // `reasoning_content` when the request thinks, and Gemma 4 /
        // Qwen3 re-read the reasoning that led to a call in the same turn
        // instead of re-deriving it every round. Nothing else reads an
        // unsigned part (the Claude adapter drops them).
        const surfacesRawReasoning = typeof adapter.surfacesRawReasoning === 'function' && adapter.surfacesRawReasoning() === true;
        const thinkingForReplay = (response.thinkingParts || [])
            .filter(p => p.text && !p.redacted && (p.signature || surfacesRawReasoning))
            .map(p => (p.signature
                ? { text: p.text, signature: p.signature, redacted: p.redacted || undefined }
                : { text: p.text }));

        // A call the model WROTE instead of made — Gemma 4 puts it in its
        // thought channel in its own wire syntax, which the runtime's parser
        // does not read there, so the round arrives as reasoning text with
        // no tool call and stop='stop' (measured on the app builder
        // 2026-09-13; the same model drives this one). The grammar is small
        // and the call is right there: parse it and run it like any other,
        // and tell the model in the tool result (core/llm/leakedToolCalls).
        let recoveredRound = null;
        if (!response.toolCalls || !response.toolCalls.length) {
            const toolNameSet = new Set(tools.map(t => t && t.function && t.function.name).filter(Boolean));
            recoveredRound = recoverLeakedToolCalls(response, { toolNames: toolNameSet, iter });
            if (recoveredRound.toolCalls.length) {
                log.warn(`[AutomationBuilder] round ${iter}: recovered ${recoveredRound.toolCalls.length} tool call(s) written as text in the model's ${recoveredRound.sources.join('/')} (${recoveredRound.toolCalls.map(tc => tc.function.name).join(', ')})`);
                response.toolCalls = recoveredRound.toolCalls;
                response.content = recoveredRound.content;
            }
        }

        if (response.toolCalls && response.toolCalls.length) {
            messages.push({
                role: 'assistant',
                content: response.content || null,
                ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
                tool_calls: response.toolCalls.map(tc => ({
                    id: tc.id, type: 'function',
                    function: {
                        name: tc.function.name,
                        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
                    },
                    _thought_signature: tc._thought_signature || undefined,
                    _raw_content_parts: tc._raw_content_parts || undefined,
                })),
            });

            const round = {
                mutatedThisIter: false,
                testedThisIter: false,   // round included dry_run/finalize
                // The wasted-round charge: a round counts as wasted only when
                // it had calls and none of them was accepted.
                acceptedThisIter: false,
                refusedThisIter: false,
                // The first `_stop` a result carried this round, with what the
                // user needs to hear about it. Set once; never overwritten.
                stopHit: null,
                // The last refusal of the round — what `no_progress` reports.
                lastRefusal: null,
            };
            for (const tc of response.toolCalls) {
                await dispatchToolCall(turn, round, tc);
            }
            if (turn.reviewQuestions || turn.pausedAfterStep || turn.planWritten) break;


            // Validation feedback loop: after any mutation, validate the
            // draft and feed the structured records back to the LLM. This
            // is what lets the model self-correct on specific failures
            // (e.g. "you wired a condition with no edges") instead of
            // looping on prose.
            //
            // The note is a role:'user' message, NOT role:'system': the
            // Claude adapter hoists every system message into the
            // top-level system array (claude.js extractSystem), which
            // grew the system block mid-turn and invalidated the
            // message-tier cache breakpoints on every round after a
            // mutation; Google concatenates system messages into its
            // cache-keyed systemInstruction with the same effect. A
            // clearly-framed user message stays in chronological position
            // on every provider.
            //
            // Token gating: the model only NEEDS the full report when
            // there are errors. Warnings on a half-built graph are mostly
            // expected incompleteness (unwired branches, missing outputs)
            // and used to trigger premature "fix" rounds — so they ride
            // along as one compact codes line, and surface on their own
            // only on a dry-run/finalize round (the pre-flight moment
            // where completeness genuinely matters). The client SSE event
            // stays unfiltered — user-facing behaviour is unchanged.
            if (round.mutatedThisIter || round.testedThisIter) {
                turn.lastValidation = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
                // A step on a table this proposal stages is fine; the validator
                // flags every pending id, and only the ones nobody staged stay.
                if (isolated) turn.lastValidation = withoutStagedTableIssues(turn.lastValidation, new Set((draftWrap._pendingDatatables || []).map(e => e.ref)));
                send('validation_errors', { errors: turn.lastValidation.errors, warnings: turn.lastValidation.warnings });
                const note = renderValidationNote(turn.lastValidation, { tested: round.testedThisIter });
                if (note) messages.push({ role: 'user', content: note });
            }

            // ── Is this turn still going anywhere? ──
            // The ladder's stop wins. Otherwise a round in which every
            // call was refused is charged twice (iter += 1: it built
            // nothing, and the next round starts from the same draft with
            // one more error message), and the fourth such round in a row
            // is the stop — the model is changing its calls just enough
            // to dodge the ladder and not enough to land one. Any
            // accepted call resets the count: progress is progress.
            if (round.stopHit && !turn.lastFinalized) {
                turn.stopReason = round.stopHit;
            } else if (round.refusedThisIter && !round.acceptedThisIter) {
                loop.wastedRounds += 1;
                iter += 1;
                if (loop.wastedRounds >= WASTED_ROUNDS_LIMIT) {
                    turn.stopReason = { reason: 'no_progress', ...(round.lastRefusal || { tool: null, error: '', label: null }) };
                }
            } else if (round.acceptedThisIter) {
                loop.wastedRounds = 0;
            }
            if (turn.stopReason) {
                // ONE sentence, the same on the wire and in the stored
                // turn (collectAssistantTurn reads the assistant message's
                // content into the session snapshot — without this the
                // next visit shows a build that just stopped talking).
                const sentence = stopSentence(turn.stopReason, draftWrap.def);
                log.warn(`[AutomationBuilder] stopped session=${draftWrap.builderSessionId} reason=${turn.stopReason.reason} tool=${turn.stopReason.tool || '-'} iterations=${iter + 1}: ${sentence}`);
                send('builder_aborted', {
                    reason: turn.stopReason.reason,
                    iterations: iter + 1,
                    lastValidation: turn.lastValidation || null,
                    rejected: { tool: turn.stopReason.tool || null, error: turn.stopReason.error || '', label: turn.stopReason.label || null },
                });
                send('message', { content: `${response.content ? '\n\n' : ''}${sentence}` });
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i]?.role !== 'assistant') continue;
                    const a = messages[i];
                    a.content = [typeof a.content === 'string' ? a.content : '', sentence].filter(Boolean).join('\n\n');
                    break;
                }
                break;
            }

            if (turn.lastFinalized) break;
            continue;
        }

        if (afterToolLessRound(turn, loop, { iter, response, thinkingForReplay, recoveredRound }) === 'continue') continue;
        break;
    }
    return iter;
}

module.exports = { runBuildLoop };

/**
 * This loop's own counters (see the comments on each in runBuildLoop).
 * @typedef {{
 *   wastedRounds: number, truncationRetries: number, emptyReplyRetries: number, invalidArgsRetries: number,
 *   repinToolChoice: boolean, prosePinUsed: boolean, planGuardUsed: boolean, buildGuardUsed: boolean,
 * }} BuildLoopState
 */
