/**
 * Direct Chat — the per-round decisions the streamed turn takes from its own
 * live state: where the volatile system block sits, what the step-machine
 * guard writes onto it, and whether the non-streaming tool pre-check runs.
 *
 * All of them read `turn.adapter` / `turn.config`, which swapModelForActiveStage
 * reassigns mid-turn, so each is a function OF the turn and never a constant
 * computed once. They were closures inside the route handler; here they can be
 * exercised without a request, which is the only way to prove that the guard
 * replaces its tail instead of growing it.
 */

const log = require('../../../telemetry/log');
const { isLocalProviderType, localAdapters } = require('../../../core/providers');
const { toolSetFingerprint, systemPrefixFingerprint } = require('../../../core/llm/promptCacheStability');
const { placeVolatileBlock, hoistVolatileBlock, supportsLateSystemBlock } = require('../../../core/llm/promptLayout');

// Providers whose stream path parses tool calls itself.
const SDK_TYPES = ['google', 'openai', 'claude', 'mistral'];

/**
 * Is this turn talking to a self-hosted runtime?
 *
 * Both halves matter: the stored provider type covers a configured runtime,
 * the adapter identity covers the ones the URL heuristic guessed (those have
 * no stored type).
 */
function adapterIsLocal(turn) {
    const { config, adapter } = turn;
    return isLocalProviderType(config?.providerType) || Object.values(localAdapters).includes(adapter);
}

/**
 * Skip the non-streaming tool pre-check?
 *
 * The pre-check bought a chance to downgrade the step-machine toolChoice
 * before streaming; every stream call now retries once with toolChoice 'auto'
 * on the same bad-shape error, and the streamed loop mirrors the step-machine
 * bookkeeping round for round. On a single-slot llama.cpp server it cost one
 * whole thrown-away generation plus an extra prompt evaluation per turn
 * (measured 2026-09-11: ~29 s on a 4.3k-token prompt), so it is skipped for
 * every provider whose stream path parses tool calls itself.
 */
function skipToolPrecheck(turn) {
    const { adapter, config, modelId, chatOptions } = turn;
    return !!(adapter?.shouldUseResponsesApi?.(modelId, chatOptions)
        || SDK_TYPES.includes(config?.providerType)
        || isLocalProviderType(config?.providerType)
        || Object.values(localAdapters).includes(adapter));
}

/**
 * Put the volatile block where this turn's provider wants it.
 *
 * Behind the history for anything that extracts or folds system messages —
 * a self-hosted prefix cache then keeps the stable prompt AND the history and
 * only re-reads the folded volatile+user tail. Back at index 1 for the rest
 * (Scaleway's strict chat templates). Idempotent, so the caller re-runs it
 * before every stream call: the adapter can change mid-turn.
 */
function layoutVolatile(turn) {
    const { messages, volatileMessage, config } = turn;
    if (!volatileMessage) return;
    if (supportsLateSystemBlock(config?.providerType, { isLocal: adapterIsLocal(turn) })) {
        placeVolatileBlock(messages, volatileMessage);
    } else {
        hoistVolatileBlock(messages, volatileMessage);
    }
}

/**
 * The step-machine guard's writer: `base + guard`, REPLACED every round.
 *
 * The guard text interpolates roundsInCurrentStep, so it differs every round.
 * Appending it used to grow the block for the whole turn — and it was appended
 * to messages[0], the provider-cached prefix, so every round re-read the entire
 * prompt on a self-hosted model. `capture()` re-reads the base after the block
 * was moved behind the history; a null/empty guard restores exactly that base.
 *
 * @param {object} turn the live turn state (read on every call — the block is
 *   replaced wholesale by a mid-turn adapter swap)
 * @returns {{ set: (text: string|null) => void, capture: () => void }}
 */
function createVolatileGuard(turn) {
    let base = null;
    return {
        set(text) {
            const { volatileMessage } = turn;
            if (!volatileMessage) return;
            if (base === null) base = volatileMessage.content;
            volatileMessage.content = base + (text || '');
        },
        capture() {
            base = turn.volatileMessage ? turn.volatileMessage.content : null;
        },
    };
}

/**
 * Log this turn's cacheable prefix: the same fingerprint on consecutive turns
 * of a conversation is what a prefix cache needs, and a drifting one names the
 * culprit in the app log instead of on the latency.
 */
function traceStablePrefix(turn, label) {
    const { messages, volatileMessage, directChatTools } = turn;
    const sys = typeof messages?.[0]?.content === 'string' ? messages[0].content : '';
    log.info(`[DirectChat] prefix ${label}: system=${systemPrefixFingerprint(sys)} tools=${toolSetFingerprint(directChatTools)} volatileAt=${messages.indexOf(volatileMessage)}/${messages.length}`);
}

module.exports = { adapterIsLocal, skipToolPrecheck, layoutVolatile, createVolatileGuard, traceStablePrefix, SDK_TYPES };
