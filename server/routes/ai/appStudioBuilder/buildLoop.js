// @typecheck noImplicitAny
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

const { effortForIteration } = require('../../../appStudio/builderModelProfiles');
const { emptyUsageTotals } = require('./turnLoop');
const {
    MAX_TOKENS_PER_ROUND, requestRound, recoverWrittenCalls, accountRound, thinkingToReplay, settleToolLessRound, assistantToolMessage,
} = require('./buildRound');
const {
    TOOL_REFUSAL_STREAK_MAX, runRoundTools, repeatedStopMessage, flushVisionImages, validateAfterMutation,
} = require('./buildTools');
const log = require('../../../telemetry/log');

/**
 * The state that begins and ends inside one turn's loop. The state the
 * ROUTE reads back (lastFinalized, lastValidation, persistBroken,
 * modelEndedTurn, builtThisTurn, proposedPlan, lastPhaseIndex, the counters
 * and iter) lives on `turn`, and usageTotals/proseParts are the caller's
 * (Wave 6c), so the route's outer catch can still log a turn that blew up.
 * @param {import('./buildRound').BuildCtx['profile']} profile
 * @param {import('./buildRound').BuildCtx['tier']} tier
 * @returns {import('./buildRound').LoopState}
 */
function freshLoopState(profile, tier) {
    return {
        escalateNextRound: false, // a repair signal for the log only: effort is fixed per turn
        truncationRetries: 0,
        emptyReplyRetries: 0,     // a round with neither a tool call nor text: one nudge, then a plain message
        invalidArgsRetries: 0,
        repeatedStop: null,       // rung 3 of the repeat ladder: ends the turn
        // Rung 3b: consecutive refusals per tool name (see buildTools.js).
        toolRefusalStreak: new Map(),
        roundTotals: emptyUsageTotals(),
        // ONE effort for the whole turn, the tier's own setting first: a Fast
        // tier set to 'None' really sends none (Gemma thinking off), and the
        // chat template's tail stays byte-stable across the rounds of a turn.
        // The per-round escalation this replaced re-rendered that tail and
        // could switch thinking ON mid-build after a single rejected call.
        turnEffort: effortForIteration(0, false, profile, tier.reasoningEffort),
        // Screenshots captured this round, queued for a vision-capable model as
        // a user image message after the round's tool results: tool-result
        // content must stay a string for OpenAI/Mistral (webpageChat.js's pattern).
        pendingVisionImages: [],
    };
}

/**
 * One round; returns 'next' to run another, or 'end' to end the turn.
 * @param {import('./turnClosing').BuilderTurn} turn
 * @param {number} iter
 * @param {import('./buildRound').BuildCtx} ctx
 * @param {import('./buildRound').LoopState} ls
 * @returns {Promise<'next'|'end'>}
 */
async function runRound(turn, iter, ctx, ls) {
    if (ls.escalateNextRound) log.info(`[AppStudioBuilder] round ${iter} follows a rejected call`);
    ls.escalateNextRound = false;

    const response = await requestRound(iter, ctx, ls);
    if (!response) return 'end';
    const recoveredRound = recoverWrittenCalls(response, iter, ctx.toolNameSet);
    accountRound(response, iter, ctx, ls);
    const thinkingForReplay = thinkingToReplay(ctx.adapter, response);

    if (!response.toolCalls || !response.toolCalls.length) {
        const settled = settleToolLessRound(response, recoveredRound, thinkingForReplay, iter, ctx, ls);
        if (settled === 'retry') return 'next';
        if (settled === 'done') turn.modelEndedTurn = true; // final prose: turn done
        return 'end';
    }

    ctx.messages.push(assistantToolMessage(response, thinkingForReplay));
    const mutatedThisIter = await runRoundTools(turn, response.toolCalls, ctx, ls);
    if (turn.persistBroken) return 'end';
    if (ls.repeatedStop) {
        ctx.send('message', { content: repeatedStopMessage(ls.repeatedStop) });
        return 'end';
    }
    flushVisionImages(ctx.messages, ls);
    // Wave 5: a plan was proposed: end the turn and let the route emit the
    // plan + await approval (no validation feedback on a plan turn).
    if (turn.proposedPlan) return 'end';
    if (mutatedThisIter) validateAfterMutation(turn, ctx, ls);
    return turn.lastFinalized ? 'end' : 'next';
}

/**
 * @param {import('./turnClosing').BuilderTurn} turn
 * @param {import('./buildRound').BuildCtx} ctx
 */
async function runBuildLoop(turn, ctx) {
    const { res, iterationBudget, profile, tier } = ctx;
    const ls = freshLoopState(profile, tier);
    for (turn.iter = 0; turn.iter < iterationBudget; turn.iter++) {
        // Read-only alias for this round: only the loop header advances it.
        const iter = turn.iter;
        if (turn.clientGone || res.writableEnded) {
            log.info('[appStudioBuilder/stream] client disconnected — aborting build loop');
            break;
        }
        if (await runRound(turn, iter, ctx, ls) === 'end') break;
    }
}

module.exports = { runBuildLoop, MAX_TOKENS_PER_ROUND, TOOL_REFUSAL_STREAK_MAX };
