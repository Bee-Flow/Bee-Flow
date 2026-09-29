/**
 * Shared internals for the conversational builder routes
 * (routes/ai/automationBuilder.js and routes/ai/appStudioBuilder.js).
 *
 * Dependency-light on purpose: no stores, no express — only the pure
 * model-classification bands. Everything route-specific (SSE event shapes,
 * log prefixes) is injected by the caller.
 */

'use strict';

const { classifyModel } = require('../../automation/builderModelProfiles');
const { isLocalProviderType } = require('../../core/providers/localModels');
const log = require('../../telemetry/log');

// Transient provider errors (rate limits, 5xx, network blips) shouldn't kill
// an entire builder turn — the user would lose their in-progress conversation.
// Permanent errors (auth/validation 4xx) are not worth retrying.
function isTransientChatError(err) {
    const status = err && (err.status || err.statusCode);
    if (typeof status === 'number') {
        if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
        if (status >= 400 && status < 500) return false; // auth/validation — permanent
    }
    const msg = String((err && err.message) || '').toLowerCase();
    return /\b(408|429|500|502|503|504)\b/.test(msg)
        || /(rate.?limit|overloaded|too many requests|timeout|timed out|temporarily|econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|network error|aborted)/.test(msg);
}

// Gemini 3.x rejects any functionCall in the request whose part is missing a
// thought_signature, and synthetic few-shot tool_calls can't carry one
// (signatures are cryptographic, model-issued) — both builders skip few-shots
// for these models.
const GEMINI_3X_RE = /gemini-3(\.\d+)?-(pro|flash)/i;

function isGemini3Model(modelId) {
    return GEMINI_3X_RE.test(String(modelId || ''));
}

// Tier keys tried, in order, when flooring a small auto-resolved model up to a
// capable one. The first whose configured model is non-small wins.
const BUILDER_FLOOR_TIER_ORDER = ['standard', 'thinking', 'deep_thinking', 'writer', 'pro', 'smart'];

/**
 * Floor an auto-resolved builder model to at least a non-small capability
 * band. Returns `{ tier, modelId }` — unchanged when `modelId` is already
 * non-small, or when the org has no non-small tier configured (don't break a
 * small-only org).
 */
function applyBuilderTierFloor(resolvedTier, modelId, tiers) {
    if (classifyModel(modelId) !== 'small') return { tier: resolvedTier, modelId };
    for (const key of BUILDER_FLOOR_TIER_ORDER) {
        if (key.startsWith('custom:') || key === 'swarm') continue;
        const cand = tiers?.[key]?.modelId;
        if (cand && classifyModel(cand) !== 'small') return { tier: key, modelId: cand };
    }
    return { tier: resolvedTier, modelId };
}

// Adapter part ids (e.g. "claude-0") reset every stream call; namespace them
// per turn so successive builder iterations don't collide into one part on
// the client. Shared counter — ids only need to be unique per client stream.
let __builderStreamSeq = 0;

// Per-chunk stall watchdog for a self-hosted runtime, and the same number
// core/agentRuntime/chatStream.js already uses for the same adapter.
//
// A cloud provider fails a wedged request for us; a local box does not. Both
// builders ran without any ceiling, so a round that never produced a chunk
// held the process until the client gave up, and — because `clientGone` is
// only read at the TOP of the next iteration — a closed tab still generated
// its current round to the max_tokens cap on a box whose model has ONE slot.
// Measured 2026-09-13/14 on the demo box: 17 builder rounds ran to the 8192
// cap, the longest for 395 s.
//
// It is a STALL timer, not a total-duration cap (see base.js): a slow but live
// generation is never cut, only one that has gone quiet. 120 s is far above
// the worst measured gap between chunks on this hardware.
const LOCAL_STREAM_TIMEOUT_MS = 120000;

/**
 * Run ONE model turn via `adapter.stream`, forwarding live events to the
 * client so the chat panel shows reasoning + text as they arrive, then return
 * the assembled turn `{ content, toolCalls, thinkingParts, usage }` for the
 * builder's tool loop. `thinkingParts` carry the signature so the next turn's
 * assistant message can replay signed thinking blocks before its tool_use
 * blocks (Anthropic conversation-integrity requirement — claude.js rebuilds
 * them from `m.thinking`).
 *
 * Retries on transient provider errors ONLY when nothing has been streamed yet
 * this attempt — once tokens are on the wire, a blind retry would duplicate
 * them, so we surface the error to the caller's graceful-degradation path.
 *
 * Each route owns its SSE thinking shapes via `emitThinking`:
 *   { start(send, { partId, redacted }),
 *     delta(send, { partId, text }),
 *     stop(send, { partId, redacted }) }        // partId may be null on stop
 * Text always goes out as `message { content }` (identical in both routes).
 *
 * Two optional observation hooks feed the build visualisations; both are
 * fire-and-forget and never affect the assembled turn:
 *   onToolArgsDelta({ name, partial })   — the adapter's `tool_args_delta`:
 *       the tool call's arguments JSON accumulated so far (a growing prefix,
 *       usually unterminated). The automation builder scans it for the steps
 *       it already describes (toolDraft.js) and streams a `tool_draft` event.
 *   onPromptProgress({ total, cache, processed, time_ms }) — llama-server's
 *       prefill progress (`prompt_progress` chunks); the builder turns it into
 *       a `prompt_progress` SSE event.
 * A hook that throws is swallowed: a visualisation must never kill a build.
 *
 * `signal` is the caller's client-disconnect signal and `timeoutMs` a per-chunk
 * stall watchdog; both are applied to every attempt. On a self-hosted runtime
 * they are not optional — see LOCAL_STREAM_TIMEOUT_MS.
 */
async function streamWithRetry(adapter, cfg, modelId, messages, options, {
    send,
    emitThinking,
    signal,
    onToolArgsDelta,
    onPromptProgress,
    retries = 2,
    baseDelayMs = 500,
    logPrefix = '[Builder]',
} = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        let fullContent = '';
        const toolCalls = [];
        const invalidToolCalls = [];       // { id, name, error } — see 'tool_use_invalid'
        const thinkingParts = [];          // { id, text, signature, redacted, startedAt, endedAt }
        const partById = new Map();
        let emittedAny = false;
        let streamErr = null;
        let usage = null;                  // adapter-normalized token usage from the 'done' event
        let finishReason = null;           // 'stop' | 'length' | 'max_tokens' | … from the 'done' event
        const tag = `s${__builderStreamSeq++}`;
        const tagPart = (id) => `${tag}-${id}`;

        const ensurePart = (id, redacted) => {
            let p = partById.get(id);
            if (!p) {
                p = { id, text: '', signature: null, redacted: !!redacted, startedAt: Date.now(), endedAt: null };
                partById.set(id, p);
                thinkingParts.push(p);
            }
            return p;
        };

        const onEvent = (type, data) => {
            if (type === 'text') {
                if (data && data.text) { fullContent += data.text; emittedAny = true; send('message', { content: data.text }); }
            } else if (type === 'thinking_start') {
                const id = tagPart((data && data.partId) || `t${thinkingParts.length}`);
                ensurePart(id, data && data.redacted);
                emittedAny = true;
                emitThinking.start(send, { partId: id, redacted: (data && data.redacted) || undefined });
            } else if (type === 'thinking') {
                // data.partId is the raw adapter id (tag it); the no-partId
                // fallback reuses the last part's already-tagged id as-is.
                const id = (data && data.partId)
                    ? tagPart(data.partId)
                    : (thinkingParts.length ? thinkingParts[thinkingParts.length - 1].id : tagPart('t0'));
                const p = ensurePart(id);
                const text = (data && data.text) || '';
                p.text += text;
                emittedAny = true;
                emitThinking.delta(send, { partId: id, text });
            } else if (type === 'thinking_signature') {
                if (data && data.partId) {
                    const p = partById.get(tagPart(data.partId));
                    if (p) {
                        if (data.signature) p.signature = data.signature;
                        // redacted_thinking carries no text/signature — the
                        // opaque payload is what gets replayed.
                        if (data.redactedData) p.redactedData = data.redactedData;
                    }
                }
            } else if (type === 'thinking_stop') {
                const id = data && data.partId ? tagPart(data.partId) : null;
                if (id) { const p = partById.get(id); if (p) p.endedAt = Date.now(); }
                emitThinking.stop(send, { partId: id, redacted: (data && data.redacted) || undefined });
            } else if (type === 'tool_use') {
                toolCalls.push({
                    id: (data && data.id) || `call_${Date.now()}_${toolCalls.length}`,
                    type: 'function',
                    function: { name: data && data.name, arguments: JSON.stringify((data && data.input) || {}) },
                    _thought_signature: (data && data.thought_signature) || undefined,
                    // The adapter closed arguments that were not valid JSON on
                    // the wire (base.js flushToolCalls, loose parser). Kept so
                    // the loop can tell the model in the tool result that only
                    // the complete entries landed (REPAIRED_CALL_HINT).
                    _repaired: (data && data._repaired) ? true : undefined,
                });
                emittedAny = true;
            } else if (type === 'tool_use_invalid') {
                // The adapter refuses to hand up a call whose arguments never
                // became valid JSON (base.js: echoing one back is a 400 or a
                // spin loop). Without this the round looked empty and the model
                // was never told what went wrong. Not counted in `emittedAny`:
                // nothing usable is on the wire, so a transient-error retry
                // stays safe.
                invalidToolCalls.push({
                    id: (data && data.id) || null,
                    name: (data && data.name) || null,
                    error: (data && data.error) || 'invalid JSON arguments',
                });
            } else if (type === 'error') {
                streamErr = new Error((data && (data.error || data.message)) || 'stream error');
            } else if (type === 'done') {
                // Every adapter normalizes usage into its 'done' payload
                // (prompt_tokens / completion_tokens / cached_tokens /
                // cache_creation_tokens). Capture it so the builder loop can
                // account per-round cost; absent/partial payloads stay null.
                // The stop reason rides on the same payload but is NOT usage:
                // the builder re-emits `usage` verbatim as an SSE event, so it
                // is split off here and handed back on its own.
                const { stop_reason, finish_reason, ...rest } = (data && typeof data === 'object') ? data : {};
                finishReason = stop_reason || finish_reason || null;
                if (rest.prompt_tokens !== undefined || rest.completion_tokens !== undefined) {
                    usage = rest;
                }
            } else if (type === 'tool_args_delta') {
                // Observation only: the call itself still arrives whole as
                // 'tool_use'. Not counted in emittedAny — nothing the model
                // said is on the wire yet, so a retry stays safe.
                if (typeof onToolArgsDelta === 'function') {
                    try { onToolArgsDelta(data || {}); } catch (_) { /* a visualisation never kills a build */ }
                }
            } else if (type === 'prompt_progress') {
                if (typeof onPromptProgress === 'function') {
                    try { onPromptProgress(data || {}); } catch (_) { /* a visualisation never kills a build */ }
                }
            }
        };

        try {
            // A self-hosted runtime cannot fail a wedged request for us, and a
            // closed tab must free the single slot rather than generate to the
            // cap for nobody. Defaults only: a caller that set either one keeps
            // its own value.
            const streamOptions = isLocalProviderType(cfg.providerType)
                ? {
                    signal,
                    timeoutMs: LOCAL_STREAM_TIMEOUT_MS,
                    ...options,
                }
                : (signal ? { signal, ...options } : options);
            await adapter.stream(cfg.apiKey, cfg.url, modelId, messages, streamOptions, onEvent);
            // An in-stream error with nothing usable produced → treat as a throw
            // so the retry / graceful path handles it consistently.
            if (streamErr && !fullContent && !toolCalls.length) throw streamErr;
            return {
                content: fullContent || null,
                toolCalls: toolCalls.length ? toolCalls : null,
                // Calls the model tried to make and got wrong. A round with
                // none of these and no toolCalls really is a silent round; one
                // with these is a repairable mistake.
                invalidToolCalls: invalidToolCalls.length ? invalidToolCalls : null,
                thinkingParts: thinkingParts.filter(p => p.text || p.redacted),
                usage,
                // Lets the tool loop tell a max_tokens cut-off from a final
                // answer (chatTurnLoop.isTruncatedStop). Null when the adapter
                // reports none.
                finishReason,
            };
        } catch (e) {
            lastErr = e;
            if (attempt === retries || !isTransientChatError(e) || emittedAny) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            log.warn(`${logPrefix} stream attempt ${attempt + 1} failed (${e.message}); retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

module.exports = {
    isTransientChatError,
    isGemini3Model,
    BUILDER_FLOOR_TIER_ORDER,
    applyBuilderTierFloor,
    streamWithRetry,
};
