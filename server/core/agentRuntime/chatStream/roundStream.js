// @typecheck noImplicitAny
/**
 * One round's model call: down the native adapter branch or the raw SSE
 * branch (the choice was made in ./roundRequest), with the turn's token
 * counters, reasoning and stop reason updated from whichever ran.
 *
 * The round stop reason is hoisted out of both branches so the loop's
 * empty-round guard (./turnLoop) can tell "cut off at the output limit" from
 * "the model simply said nothing".
 *
 * The phases themselves (./roundRequest, ./nativeAdapterStream,
 * ./rawSseStream, ../phaseEvents) are handed in as `steps` by ./turnLoop:
 * they sit in the server's large import cycle, which this module stays out of.
 */
const terminationStore = require('../../../stores/terminationStore');
const { isTruncatedStop } = require('../../llm/toolLoop');
const { bestEffort } = require('../../../utils/bestEffort');

/**
 * Stream one round. Writes the token counters and reasoning into `st` (see
 * ./turnState) and returns what the loop needs to decide the next step.
 * @param {{ st: import('./turnLoop').LoopState, req: Awaited<ReturnType<import('./turnLoop').RoundSteps['buildRoundRequest']>>, terminationBaseRow: import('./turnLoop').TerminationBaseRow, steps: import('./turnLoop').RoundSteps, signal: AbortSignal | null, guardrailViolation: import('./turnLoop').LoopTurn['guardrailViolation'], _forceFinalAnswer: boolean } & Pick<import('./turnLoop').LoopTurn, 'agent' | 'agentId' | 'userId' | 'messageMetadata' | 'config' | 'modelToUse' | 'conversation' | 'tools' | 'onEvent' | 'regexConfig'>} opts
 */
async function streamRound({ st, req, terminationBaseRow, steps, ...turn }) {
    const { streamNativeAdapterRound, streamRawSseRound } = steps;
    const {
        agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
        tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
    } = turn;
    const {
        headers, apiUrl, finalMessages, effectiveSystemPrompt, effectiveVolatilePrompt,
        tierSettings, providerAdapter, useNativeAdapter, _adapterIsLocal, _streamCallStart,
    } = req;
    const thinking = st.thinking;
    /** @type {string | null} */
    let _roundStopReason = null;
    /** @type {Awaited<ReturnType<import('./turnLoop').RoundSteps['streamNativeAdapterRound']>>['_invalidToolCalls']} */
    let _invalidToolCalls = [];
    let _round;

    if (useNativeAdapter) {
        // ─── Adapter streaming (SDK providers + self-hosted runtimes) ─────
        _round = await streamNativeAdapterRound({
            agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
            tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
            effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
            providerAdapter, _adapterIsLocal, _streamCallStart,
            _thinking: thinking.text, _thinkingParts: thinking.parts,
            _thinkingSnapshotFrom: thinking.snapshotFrom, _getThinkingPart: thinking.getPart,
        });
        _invalidToolCalls = _round._invalidToolCalls;
        thinking.snapshotFrom = _round._thinkingSnapshotFrom;
        const _adapterStreamUsage = _round._adapterStreamUsage;

        st.promptTokens += _adapterStreamUsage?.prompt_tokens || 0;
        st.completionTokens += _adapterStreamUsage?.completion_tokens || 0;
        _roundStopReason = _adapterStreamUsage?.stop_reason || null;
    } else {
        // ─── Raw fetch SSE streaming (OpenAI-compatible) ──────────────
        _round = await streamRawSseRound({
            agent, agentId, userId, messageMetadata, modelToUse, conversation,
            tools, signal, onEvent, regexConfig, guardrailViolation, _forceFinalAnswer,
            effectiveSystemPrompt, effectiveVolatilePrompt, finalMessages, tierSettings,
            headers, apiUrl, _streamCallStart, _thinking: thinking.text,
        });
        const _sseStreamUsage = _round._sseStreamUsage;
        const _sseFinishReason = _round._sseFinishReason;

        st.promptTokens += _sseStreamUsage?.prompt_tokens || 0;
        st.completionTokens += _sseStreamUsage?.completion_tokens || 0;
        _roundStopReason = _sseFinishReason || null;
    }
    thinking.text = _round._thinking;
    if (isTruncatedStop(_roundStopReason)) {
        terminationStore.logTermination({ ...terminationBaseRow(), termination_type: 'max_tokens' }).catch((e) => bestEffort('core/agentRuntime/chatStream/roundStream:streamRound', e));
    }

    return {
        currentToolCalls: _round.currentToolCalls,
        contentBuffer: _round.contentBuffer,
        guardrailViolation: _round.guardrailViolation,
        _invalidToolCalls,
        _roundStopReason,
    };
}

/**
 * One whole model round: build the request (./roundRequest), mark the first
 * hand-over to the model, then stream it. `t` is the prepared turn (see
 * ./turnPrepare), `st` the loop state (./turnState).
 * @param {import('./turnLoop').LoopTurn} t
 * @param {import('./turnLoop').LoopState} st
 * @param {{ guardrailViolation: import('./turnLoop').LoopTurn['guardrailViolation'], _assistantTokenisationInfo: import('./turnLoop').LoopTurn['_assistantTokenisationInfo'], _forceFinalAnswer: boolean, signal: AbortSignal | null, terminationBaseRow: import('./turnLoop').TerminationBaseRow, steps: import('./turnLoop').RoundSteps }} round
 */
async function runModelRound(t, st, { guardrailViolation, _assistantTokenisationInfo, _forceFinalAnswer, signal, terminationBaseRow, steps }) {
    const { buildRoundRequest, emitPhase } = steps;
    const { agent, agentId, userId, messageMetadata, config, modelToUse, conversation, messages, onEvent } = t;
    // What this round sends, and down which branch — see ./roundRequest.
    const _req = await buildRoundRequest({
        agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
        messages, iterations: st.iterations, persistedByLive: t.persistedByLive, dlpShield: t.dlpShield, onEvent,
        systemPrompt: t.systemPrompt, volatileSystemPrompt: t.volatileSystemPrompt,
        guardrailViolation, moderationViolation: t.moderationViolation,
        _forceFinalAnswer, _assistantTokenisationInfo,
    });

    // Final pre-LLM phase marker — only on the first iteration. This
    // tells the UI "we're handing the request to the model now" so the
    // status placeholder fades out before the first token arrives.
    if (st.iterations === 1) {
        emitPhase(onEvent, 'streaming_start', modelToUse);
    }

    const _round = await streamRound({
        st, req: _req, terminationBaseRow, steps,
        agent, agentId, userId, messageMetadata, config, modelToUse, conversation,
        tools: t.tools, signal, onEvent, regexConfig: t.regexConfig, guardrailViolation, _forceFinalAnswer,
    });
    return { ..._round, useNativeAdapter: _req.useNativeAdapter, _assistantTokenisationInfo: _req._assistantTokenisationInfo };
}

module.exports = { streamRound, runModelRound };
