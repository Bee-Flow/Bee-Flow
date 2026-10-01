// @typecheck
/**
 * Claude/Anthropic Provider Adapter
 *
 * 100% SDK-based — uses @anthropic-ai/sdk for ALL API calls.
 * No raw fetch, no base URL needed. The SDK handles endpoints internally.
 */

const BaseProvider = require("./base");
const { qualifiesForStrict } = require("./openaiModelCaps");
const {
    describeClaudeModel,
    resolveEffort,
} = require("./claudeModels");
const { downscaleClaudeMessages } = require("../documents/imageDownscale");
const { inlineInternalImages } = require("../documents/imageInline");
const log = require('../../telemetry/log');
const { normalizeUsage } = require("./usageNormalizer");

const DEFAULT_MAX_TOKENS = 8192;

// Explicit SDK request timeout. Passing ANY constructor `timeout` disables the
// SDK's pre-flight "Streaming is required for operations that may take longer
// than 10 minutes" guard (see @anthropic-ai/sdk messages.create: the guard only
// runs when the client was built with `timeout == null`). Without this, a
// non-streaming chat() with a reasoning model throws synchronously whenever
// max_tokens clears the guard's ceiling — either the time-based limit
// (max_tokens > ~21333) or a per-model cap (Opus 4/4.1 non-streaming = 8192,
// which adaptive thinking's 16384 max_tokens bump always exceeds). That broke
// the Support auto-responder ("AI auto-responder failed (Streaming is
// required…). Escalated to staff."). 600000ms matches the SDK's own default, so
// the effective request timeout is unchanged — only the over-conservative
// estimate-based pre-flight rejection is removed. Streaming is exempt from the
// guard and already used its default 10-min timeout, so it is unaffected.
const SDK_TIMEOUT_MS = 600000; // 10 minutes (== @anthropic-ai/sdk DEFAULT_TIMEOUT)

// Claude Code subscription (OAuth) tokens are only accepted by the Anthropic API
// when the first system block is exactly this string. Injected in OAuth dev mode
// (BEEFLOW_CLAUDE_CODE_OAUTH=1); see core/providers/claudeCodeAuth.js.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Drop orphan tool_use/tool_result blocks so Anthropic doesn't reject the
 * request. After compaction or aggressive history pruning, the message array
 * can contain a `tool_result` whose matching `tool_use` has been summarised
 * away — Claude returns "unexpected tool_use_id found in tool_result blocks".
 *
 * Rules enforced (mirrors the API's contract):
 *   1. tool_result.tool_use_id must reference a tool_use emitted in the
 *      immediately previous assistant message.
 *   2. Every tool_use must have a matching tool_result in the immediately
 *      following user message.
 *
 * Anything that violates either rule is dropped. Messages that become empty
 * after dropping orphans are removed from the array entirely.
 */
/**
 * Merge runs of consecutive user messages that each carry tool_result blocks
 * into ONE user message. Anthropic requires every tool_result answering an
 * assistant turn's tool_use blocks to arrive in the SINGLE user message
 * immediately following that turn. Our tool loops (builder, chat, flowlet)
 * push one role:'tool' message per result, which normalizes to N consecutive
 * user messages on a parallel-tool-call round — without this merge,
 * repairToolPairs pairs only the FIRST result with the assistant turn and
 * silently drops the rest (the model then loses those results entirely).
 * Plain-text user messages are never merged — only tool_result carriers.
 */
function mergeToolResultRuns(messages) {
    const out = [];
    const carriesToolResult = (m) => m && m.role === 'user'
        && Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result');
    for (const msg of messages) {
        const prev = out[out.length - 1];
        if (carriesToolResult(msg) && carriesToolResult(prev)) {
            prev.content = [...prev.content, ...msg.content];
            continue;
        }
        out.push(msg);
    }
    return out;
}

function repairToolPairs(messages) {
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        // user/tool_result message — keep only tool_result blocks whose id
        // appears in the previous assistant's tool_use blocks.
        if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_result')) {
            const prev = out[out.length - 1];
            const prevToolUseIds = new Set(
                (prev?.role === 'assistant' && Array.isArray(prev.content)
                    ? prev.content.filter(b => b?.type === 'tool_use').map(b => b.id)
                    : [])
            );
            const cleaned = msg.content.filter(b => {
                if (b?.type !== 'tool_result') return true; // keep non-tool blocks (rare but legal)
                return prevToolUseIds.has(b.tool_use_id);
            });
            if (cleaned.length === 0) continue; // entire message was orphaned — drop
            out.push({ ...msg, content: cleaned });
            continue;
        }

        // assistant message with tool_use blocks — drop any tool_use whose
        // matching tool_result isn't in the next message. If all tool_uses
        // are orphaned and no other content remains, drop the message.
        if (msg.role === 'assistant' && Array.isArray(msg.content) && msg.content.some(b => b?.type === 'tool_use')) {
            const next = messages[i + 1];
            const nextResultIds = new Set(
                (next?.role === 'user' && Array.isArray(next.content)
                    ? next.content.filter(b => b?.type === 'tool_result').map(b => b.tool_use_id)
                    : [])
            );
            const cleaned = msg.content.filter(b => {
                if (b?.type !== 'tool_use') return true;
                return nextResultIds.has(b.id);
            });
            const hasMeaningful = cleaned.some(b => b?.type === 'text' || b?.type === 'tool_use' || b?.type === 'thinking');
            if (!hasMeaningful) continue; // assistant turn was nothing but orphan tool_uses — drop
            out.push({ ...msg, content: cleaned });
            continue;
        }

        out.push(msg);
    }
    return out;
}

// Server-side context editing (Claude-only): Anthropic clears old tool
// results from the prompt before the model sees it, once a request crosses
// the trigger. Applied entirely on Anthropic's side — our own history and
// persistence are untouched, so it composes with the provider-agnostic
// watermark compaction in core/compaction.js (that handles cross-turn
// history; this handles heavy in-turn tool loops). Escape hatch:
// CLAUDE_CONTEXT_EDITING_DISABLED=1 turns it off without a code change.
const CONTEXT_EDITING_BETA = 'context-management-2025-06-27';
const CONTEXT_EDITING_DISABLED = process.env.CLAUDE_CONTEXT_EDITING_DISABLED === '1';

/**
 * Whether the API returns the reasoning TEXT alongside each thinking block.
 *
 * This is not cosmetic and it is not the same switch as "is thinking on".
 * `display` defaults to `'omitted'` on Claude Opus 5, Sonnet 5, Opus 4.8/4.7
 * and Fable/Mythos 5 — a silent change from Opus 4.6 / Sonnet 4.6, where the
 * default was `'summarized'`. With `'omitted'` the model still thinks, is still
 * billed for it, and still returns a signed thinking block — but the `thinking`
 * field is an empty string and NO `thinking_delta` events are streamed. The
 * product's reasoning panel then has nothing to render and hides itself, which
 * looks exactly like "thinking is broken".
 *
 * So the default here is `'summarized'`: this app shows reasoning to the user.
 * `'omitted'` is the right choice for a deployment that never surfaces it —
 * it trims time-to-first-text-token — but it saves no money.
 *
 * CLAUDE_THINKING_DISPLAY=summarized | omitted
 */
const THINKING_DISPLAY = (() => {
    const raw = String(process.env.CLAUDE_THINKING_DISPLAY || '').trim().toLowerCase();
    return raw === 'omitted' ? 'omitted' : 'summarized';
})();

/**
 * How many assistant turns of thinking the API is asked to preserve.
 *
 * 'all' (default) keeps the model's whole reasoning trail in context, which is
 * the point — on Opus 4.6 / Sonnet 4.6 and earlier the API otherwise keeps
 * only the LAST turn. 'off' omits the edit entirely (falls back to the model
 * default); a positive integer caps it for deployments that would rather pay
 * less than let the model re-read every earlier thought.
 *
 * CLAUDE_KEEP_THINKING_TURNS=all | off | <positive integer>
 */
const KEEP_THINKING_TURNS = (() => {
    const raw = String(process.env.CLAUDE_KEEP_THINKING_TURNS || '').trim().toLowerCase();
    if (raw === 'off' || raw === '0') return 'off';
    if (raw === 'all' || raw === '') return 'all';
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : 'all';
})();

/**
 * Claude Opus 5 and the Fable/Mythos family run safety classifiers that can
 * DECLINE a request. This is not an error and does not throw: the API answers
 * HTTP 200 with `stop_reason: 'refusal'`, NO text content, and a structured
 * `stop_details` giving an open-set category.
 *
 * So code that reads content blocks without checking `stop_reason` first shows
 * the user a blank answer with no explanation — which is exactly what this
 * adapter did. `stop_details` is populated ONLY for a refusal and is null for
 * every other stop reason, so it must always be guarded before reading.
 */
const REFUSAL_CATEGORY_HINTS = {
    cyber: 'security or exploitation content',
    bio: 'biological or chemical risk content',
    reasoning_extraction: 'a request to reveal internal reasoning',
    frontier_llm: 'a request about frontier model internals',
};

function refusalMessage(response) {
    const details = response?.stop_details || null;
    const hint = (details && REFUSAL_CATEGORY_HINTS[details.category]) || null;
    const why = hint ? ` It was classified as ${hint}.` : '';
    const extra = details && details.explanation ? ` ${details.explanation}` : '';
    return `The model declined to answer this request.${why}${extra}`.trim();
}

/**
 * `model_context_window_exceeded` is a stop reason the API added in 2026: the
 * request simply did not fit. Worth distinguishing from a refusal and from a
 * plain `max_tokens` truncation, because the remedy is different (fold the
 * conversation, don\'t rephrase it).
 */
function isContextWindowStop(response) {
    return response?.stop_reason === 'model_context_window_exceeded';
}

/**
 * Anthropic rejects a replayed `thinking` block whose signature it cannot
 * verify — the usual cause is a conversation that changed model mid-thread, so
 * the stored signature was minted by a different model. The blocks are an
 * optimisation, never load-bearing, so the adapter drops them and retries once
 * rather than failing the user's turn.
 */
function isThinkingReplayRejection(err) {
    if (err?.status && err.status !== 400) return false;
    const body = JSON.stringify(err?.error || '') + (err?.message || '');
    if (!/thinking|signature/i.test(body)) return false;
    return /invalid|verif|unexpected|expected|does not match|mismatch/i.test(body);
}

class ClaudeProvider extends BaseProvider {
    // Modern Claude models can reject forced tool_choice. Use native JSON for
    // closed structured-output schemas; actual action tools keep their own path.
    supportsStructuredOutput(modelId, schema) {
        const match = describeClaudeModel(modelId).id.match(/^claude-(?:sonnet|opus|haiku|fable|mythos)-(\d+)/);
        return !!match && Number(match[1]) >= 5 && (schema === undefined || qualifiesForStrict(schema));
    }

    constructor() {
        super("claude");
    }

    // ─── SDK Client ──────────────────────────────────────────────

    createClient(token, oauth = false) {
        // The CJS build exports the class itself; the .d.ts only declares it as `default`.
        const Anthropic = /** @type {typeof import('@anthropic-ai/sdk').default} */ (/** @type {unknown} */ (require('@anthropic-ai/sdk')));
        if (oauth) {
            // Subscription/OAuth token → Authorization: Bearer + the oauth beta
            // header. apiKey:null stops the SDK falling back to ANTHROPIC_API_KEY
            // from env and sending both headers (the API 401s when both are set).
            return new Anthropic({
                apiKey: null,
                authToken: token,
                defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
                timeout: SDK_TIMEOUT_MS,
            });
        }
        return new Anthropic({ apiKey: token, timeout: SDK_TIMEOUT_MS });
    }

    /**
     * Resolve the credential + auth mode. In Claude Code OAuth dev mode
     * (BEEFLOW_CLAUDE_CODE_OAUTH=1) the stored apiKey is ignored and a fresh
     * subscription token is read/refreshed from ~/.claude/.credentials.json. A
     * directly-pasted sk-ant-oat… token also flips to OAuth mode (no auto-refresh).
     */
    async _resolveAuth(apiKey) {
        const ccoa = require('./claudeCodeAuth');
        if (ccoa.isEnabled()) {
            return { token: await ccoa.getAccessToken(), oauth: true };
        }
        if (typeof apiKey === 'string' && apiKey.startsWith('sk-ant-oat')) {
            return { token: apiKey, oauth: true };
        }
        return { token: apiKey, oauth: false };
    }

    /**
     * Prepend the Claude Code identity as the first system block (OAuth mode only).
     * Existing system blocks — and their cache_control breakpoints — are preserved
     * after it. Idempotent and safe when there is no system prompt yet.
     */
    _injectClaudeCodeIdentity(params) {
        const idBlock = { type: 'text', text: CLAUDE_CODE_IDENTITY };
        if (Array.isArray(params.system)) {
            if (params.system[0] && params.system[0].text === CLAUDE_CODE_IDENTITY) return;
            params.system = [idBlock, ...params.system];
        } else if (typeof params.system === 'string' && params.system.length) {
            params.system = [idBlock, { type: 'text', text: params.system }];
        } else {
            params.system = [idBlock];
        }
    }

    // ─── Message Normalization ───────────────────────────────────

    normalizeContent(content) {
        if (content == null) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            const blocks = content.map(block => {
                // Convert OpenAI image_url → Claude native image block.
                // Preserve cache_control if the caller marked it (directChat
                // tags the last attachment block to extend the cache prefix).
                if (block.type === 'image_url') {
                    const url = typeof block.image_url === 'string'
                        ? block.image_url
                        : block.image_url?.url || '';
                    const preserved = block.cache_control ? { cache_control: block.cache_control } : {};
                    if (url.startsWith('data:')) {
                        const match = url.match(/^data:([^;]+);base64,(.+)$/s);
                        if (match) {
                            return {
                                type: 'image',
                                source: { type: 'base64', media_type: match[1], data: match[2] },
                                ...preserved,
                            };
                        }
                    } else if (url.startsWith('http')) {
                        return {
                            type: 'image',
                            source: { type: 'url', url },
                            ...preserved,
                        };
                    }
                    return null; // Skip if unresolvable
                }
                return block;
            }).filter(Boolean);
            // Never hand the SDK an empty content array — Anthropic rejects it and
            // the whole request fails ("Error generating response"). This happened
            // when the only content was an image whose data URL couldn't be parsed,
            // e.g. a pasted image with an unexpected data-URL shape (BFSF-189).
            return blocks.length > 0
                ? blocks
                : [{ type: 'text', text: '[Attachment could not be processed]' }];
        }
        return JSON.stringify(content);
    }

    /**
     * Rebuild the Claude `thinking` / `redacted_thinking` blocks for a stored
     * assistant turn.
     *
     * WHY THIS MATTERS. Extended thinking is not decoration: on a multi-turn
     * conversation the model reads its own prior reasoning back, and Anthropic
     * caches those blocks as part of the message prefix. Dropping them on
     * replay both loses the reasoning and rewrites the prefix, so every later
     * turn is a cache miss AND starts from a thinner context. This adapter used
     * to rebuild them for tool-call turns only, which meant a plain
     * question→answer conversation lost 100% of its reasoning history.
     *
     * Only blocks with a `signature` are replayable — Anthropic rejects an
     * unsigned thinking block — and `redacted_thinking` needs its opaque
     * `data` payload echoed back verbatim (it carries no readable text).
     *
     * @param {object} m Stored assistant message; `m.thinking` is the
     *   structured part array persisted by the chat runtimes.
     * @returns {Array} Claude content blocks, in the original order.
     */
    replayThinkingBlocks(m) {
        if (!Array.isArray(m?.thinking)) return [];
        const blocks = [];
        for (const t of m.thinking) {
            if (!t || typeof t !== 'object') continue;
            if (t.redacted) {
                // The encrypted payload is the only thing Anthropic accepts here;
                // a redacted block without it cannot be reconstructed.
                if (t.redactedData) blocks.push({ type: 'redacted_thinking', data: t.redactedData });
                continue;
            }
            // The SIGNATURE is what makes a block replayable, not the text.
            // Under `display: 'omitted'` the API returns signed blocks whose
            // `thinking` field is empty and decrypts the signature server-side
            // to reconstruct the reasoning — so requiring non-empty text here
            // would silently drop every block on the models that default to
            // omitted. Round-tripped text is ignored by the API either way.
            if (t.signature) {
                blocks.push({
                    type: 'thinking',
                    thinking: typeof t.text === 'string' ? t.text : '',
                    signature: t.signature,
                });
            }
        }
        return blocks;
    }

    /**
     * @param {Array} messages OpenAI-shape history.
     * @param {object} [opts]
     * @param {boolean} [opts.keepThinking=true] Replay stored thinking blocks.
     *   Set false when this request runs with thinking off (the blocks would be
     *   dead weight) or when retrying after Anthropic rejected a signature.
     */
    normalizeMessages(messages, opts = {}) {
        const keepThinking = opts.keepThinking !== false;
        const normalized = mergeToolResultRuns(messages
            .filter((m) => m && m.role && m.role !== "system")
            .map((m) => {
                if (m.role === "tool") {
                    // Convert OpenAI tool response → Claude tool_result block
                    const toolUseId = m.tool_call_id || m.toolCallId || m.id;
                    return {
                        role: "user",
                        content: [{
                            type: "tool_result",
                            tool_use_id: toolUseId || "unknown_tool_use_id",
                            content: this.normalizeContent(m.content),
                        }],
                    };
                }
                if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
                    // Convert OpenAI assistant tool_calls → Claude tool_use content blocks.
                    // When the prior turn had extended thinking WITH signatures, Anthropic
                    // requires the thinking blocks to precede the tool_use blocks on replay
                    // or conversation integrity breaks. Unsigned thinking is dropped.
                    const contentBlocks = keepThinking ? this.replayThinkingBlocks(m) : [];
                    if (m.content) {
                        contentBlocks.push({ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) });
                    }
                    for (const tc of m.tool_calls) {
                        const fn = tc.function || tc;
                        let input = {};
                        try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || fn.input || {}); } catch (e) { }
                        contentBlocks.push({
                            type: "tool_use",
                            id: tc.id,
                            name: fn.name,
                            input,
                        });
                    }
                    return { role: "assistant", content: contentBlocks };
                }
                const content = this.normalizeContent(m.content);
                if (m.role === "assistant" && keepThinking) {
                    // Plain (no tool call) assistant turn — same replay, so the
                    // model keeps its reasoning across an ordinary chat too.
                    const thinkingBlocks = this.replayThinkingBlocks(m);
                    if (thinkingBlocks.length > 0) {
                        const rest = typeof content === 'string'
                            ? (content.trim() ? [{ type: 'text', text: content }] : [])
                            : content.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
                        // A thinking-only assistant turn is not a valid message —
                        // if the answer text is gone there is nothing to anchor
                        // the reasoning to, so drop it rather than 400 the turn.
                        if (rest.length > 0) {
                            return { role: "assistant", content: [...thinkingBlocks, ...rest] };
                        }
                    }
                }
                return { role: m.role, content };
            }));

        // ─── Prompt caching ──────────────────────────────────────────
        // Anthropic allows up to 4 cache_control breakpoints per request and
        // requires longer TTLs to appear earlier in the wire order. The
        // adapter already places one 1h breakpoint on the first system block
        // (extractSystem) which caches "tools + stable system" together.
        // Here we add up to three 5-min breakpoints further down the request:
        //
        //   (a) Immediately after the compaction summary block, if present.
        //       This lets Anthropic cache (tools + system + summary) as a
        //       durable prefix that stays stable across many turns, even as
        //       the recent-window messages keep changing.
        //
        //   (b) On the last genuine user text message. This creates a
        //       shorter-lived breakpoint so the next turn can still hit the
        //       cache for "system + tools + summary + full recent history".
        //       Skipped if the message already has a cache_control marker
        //       set upstream (e.g. directChat attaches one to the last file
        //       block so the document content gets cached).
        //
        //   (c) On the last tool_result in a multi-turn agent loop. Each
        //       extra round otherwise re-tokenises the full tool history at
        //       full price. Tool_result blocks DO support cache_control per
        //       Anthropic docs.
        //
        //   (d) On the PREVIOUS user turn, if a breakpoint is still free.
        //       Anthropic only looks back 20 content blocks from a breakpoint
        //       when hunting for an existing cache entry, so a single turn that
        //       appends more than 20 blocks (a fan-out of tool calls, a
        //       multi-page upload) pushes the previous write out of range and
        //       silently re-bills the whole prefix. A trailing breakpoint one
        //       turn back is a cache READ (free refresh), not a second write,
        //       and it is what the docs recommend for growing conversations.
        //
        // Total breakpoints used: 1 (system, 1h) + up to 3 (5-min) = 4 max,
        // exactly at the 4-breakpoint cap.
        //
        // All skipped for very short conversations (<4 messages) where
        // caching overhead isn't worth it.
        const hasCacheControl = (msg) => {
            if (!Array.isArray(msg.content)) return false;
            return msg.content.some(b => b && typeof b === 'object' && b.cache_control);
        };

        // Block types that accept `cache_control`. Marking the LAST of them —
        // not the last *text* block — is what puts attachments inside the
        // cached prefix: an uploaded PDF is pushed as `text` (extracted) +
        // `document` (the raw bytes), so a text-only search parked the
        // breakpoint before the expensive half and re-billed the document at
        // full price on every follow-up question.
        const CACHEABLE_BLOCK_TYPES = new Set([
            'text', 'image', 'document', 'tool_result', 'tool_use', 'search_result',
        ]);

        const markLastCacheableBlock = (msg) => {
            if (typeof msg.content === 'string' && msg.content.trim()) {
                msg.content = [{
                    type: "text",
                    text: msg.content,
                    cache_control: { type: "ephemeral" },
                }];
                return true;
            }
            if (Array.isArray(msg.content) && msg.content.length > 0) {
                for (let j = msg.content.length - 1; j >= 0; j--) {
                    if (CACHEABLE_BLOCK_TYPES.has(msg.content[j]?.type)) {
                        msg.content[j].cache_control = { type: "ephemeral" };
                        return true;
                    }
                }
            }
            return false;
        };

        const markLastToolResultBlock = (msg) => {
            if (!Array.isArray(msg.content) || msg.content.length === 0) return false;
            for (let j = msg.content.length - 1; j >= 0; j--) {
                if (msg.content[j].type === 'tool_result') {
                    msg.content[j].cache_control = { type: "ephemeral" };
                    return true;
                }
            }
            return false;
        };

        const isSummaryMessage = (msg) => {
            if (msg.role !== 'user') return false;
            const text = typeof msg.content === 'string'
                ? msg.content
                : Array.isArray(msg.content)
                    ? (msg.content.find(b => b.type === 'text')?.text || '')
                    : '';
            return text.startsWith('[Conversation Summary');
        };

        if (normalized.length >= 4) {
            let breakpointsUsed = 0;
            const BREAKPOINT_BUDGET = 3; // (a) summary, (b) last-user, (c) last-tool_result, (d) previous-user

            // Count pre-existing markers (e.g. attachment caching set in directChat).
            for (const msg of normalized) {
                if (hasCacheControl(msg)) breakpointsUsed += 1;
            }

            // (a) Breakpoint on the summary message, if the compactor inserted one.
            const summaryIdx = normalized.findIndex(isSummaryMessage);
            if (summaryIdx >= 0 && !hasCacheControl(normalized[summaryIdx]) && breakpointsUsed < BREAKPOINT_BUDGET) {
                if (markLastCacheableBlock(normalized[summaryIdx])) breakpointsUsed += 1;
            }

            // (b) Breakpoint on the last genuine user text message — skipped
            //     if the message already carries a marker (attachment cache).
            if (breakpointsUsed < BREAKPOINT_BUDGET) {
                for (let i = normalized.length - 1; i >= 0; i--) {
                    const msg = normalized[i];
                    if (msg.role !== 'user') continue;
                    if (i === summaryIdx) continue; // already marked above
                    if (hasCacheControl(msg)) continue; // upstream already marked
                    if (Array.isArray(msg.content) && msg.content.some(b => b.type === 'tool_result')) continue;
                    if (markLastCacheableBlock(msg)) { breakpointsUsed += 1; break; }
                }
            }

            // (c) Breakpoint on the latest tool_result, if any. Multi-turn
            //     agent loops re-send the full tool-call chain every round;
            //     caching the last tool_result lets the next iteration read
            //     the prior context at 10% cost.
            if (breakpointsUsed < BREAKPOINT_BUDGET) {
                for (let i = normalized.length - 1; i >= 0; i--) {
                    const msg = normalized[i];
                    if (msg.role !== 'user') continue;
                    if (hasCacheControl(msg)) continue;
                    if (!Array.isArray(msg.content) || !msg.content.some(b => b.type === 'tool_result')) continue;
                    if (markLastToolResultBlock(msg)) { breakpointsUsed += 1; break; }
                }
            }

            // (d) Trailing breakpoint one user turn further back — keeps the
            //     previous write inside the 20-block lookback window. Only
            //     runs with budget to spare, and only when there is real
            //     history in front of it to cache.
            if (breakpointsUsed < BREAKPOINT_BUDGET) {
                let seenUserTurns = 0;
                for (let i = normalized.length - 1; i >= 2; i--) {
                    const msg = normalized[i];
                    if (msg.role !== 'user') continue;
                    if (hasCacheControl(msg)) { seenUserTurns += 1; continue; }
                    seenUserTurns += 1;
                    if (seenUserTurns < 2) continue; // skip the current turn
                    if (markLastCacheableBlock(msg)) { breakpointsUsed += 1; }
                    break;
                }
            }
        }

        // ─── Drop orphan tool_use / tool_result pairs ───────────────────
        // Anthropic rejects the request with `messages.N.content.0:
        // unexpected tool_use_id` whenever a tool_result references a
        // tool_use_id that doesn't appear in the immediately previous
        // assistant message. This happens after compaction collapses an
        // assistant(tool_use) into a summary while leaving its matching
        // tool_result in the recent window, or when conversation persistence
        // strips tool_calls but keeps the tool messages.
        //
        // We walk the array in order, tracking which tool_use ids the latest
        // assistant message emitted, and drop any tool_result block that
        // references an unknown id. Symmetrically, drop any tool_use block
        // whose result isn't in the immediately following user message — an
        // assistant turn ending in tool_use without a matching result is
        // also rejected by the API. Empty messages get filtered out.
        return repairToolPairs(normalized);
    }

    extractSystem(messages) {
        const systemMessages = messages.filter((m) => m?.role === "system");
        if (!systemMessages.length) return undefined;

        // Per-message blocks let the caller layer caching by stability:
        //   - First system message = stable identity + tooling + project
        //     context. Gets a 1-hour ephemeral breakpoint so an active user
        //     hitting the same agent for an afternoon reads from cache for
        //     hours at -90%, paying the +100% write only once.
        //   - Subsequent system messages (the volatile block: timestamp,
        //     retrieved memory, per-query KB chunks) get NO cache_control so
        //     they don't churn writes. Anthropic still serves the cached
        //     prefix from the first breakpoint.
        //
        // Callers MUST keep block 0 byte-identical across a conversation's
        // turns — see core/agentRuntime/contextBuilder.js for the contract and
        // core/promptCacheStability.test.js for the regression tests. A single
        // changing byte here costs more than not caching at all, because the
        // 1h write premium is charged every turn.
        //
        // Minimum cacheable prefix is model-dependent and NOT monotonic across
        // generations: 512 tokens on Opus 5, 1024 on Opus 4.8 / Sonnet 5,
        // 2048 on Opus 4.7, 4096 on Opus 4.6 / Haiku 4.5. Below the minimum a
        // breakpoint is silently ignored — no error, just no caching.
        const blocks = systemMessages.map((m, i) => {
            const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            const block = { type: "text", text };
            if (i === 0) {
                block.cache_control = { type: "ephemeral", ttl: "1h" };
            }
            return block;
        });
        return blocks;
    }

    // ─── Thinking/Reasoning ──────────────────────────────────────

    // Claude models that reject sampling params (temperature/top_p/top_k) and
    // manual budget_tokens — adaptive thinking only. Opus 4.6 / Sonnet 4.6
    // still accept temperature + budgets.
    //
    // This used to be a regex spelling the Opus generation as `4-[78]`, which
    // no 5-series id can match: claude-opus-5 was therefore treated as a legacy
    // 4.x model and sent `temperature: 1` plus `budget_tokens`, both of which
    // Opus 5 answers with a 400. The fact now lives in ./claudeModels.js, where
    // an unreleased id still inherits its generation's rules.
    isAdaptiveOnlyReasoning(modelId) {
        return describeClaudeModel(modelId).adaptiveOnly;
    }

    buildThinking(model, options = {}) {
        if (!this.supportsReasoning(model)) return undefined;

        const effortRaw = options.reasoningEffort;
        if (effortRaw === 'none') return undefined; // Explicitly disabled

        // Adaptive-only models reject manual budget_tokens. Legacy 4.x (Opus 4.6 /
        // Sonnet 4.6) still accept it, though adaptive is recommended.
        const adaptiveOnly = this.isAdaptiveOnlyReasoning(model);
        if (!adaptiveOnly && options.budgetTokens && options.budgetTokens > 0) {
            return { thinking: { type: "enabled", budget_tokens: options.budgetTokens } };
        }

        // Adaptive thinking: effort is passed via output_config (top-level), not
        // nested in thinking. Which levels a model actually accepts is a
        // per-model fact (`xhigh` only arrived with Opus 4.7), so the ladder and
        // the xhigh->max fallback for the ladders without it live in the catalog.
        const effort = resolveEffort(model, effortRaw) || 'medium';
        // `display` is what makes the reasoning visible at all — see
        // THINKING_DISPLAY. The legacy `budget_tokens` path above deliberately
        // leaves it unset: those models already default to 'summarized', so
        // the only thing setting it there could do is break on an older API.
        return { thinking: { type: "adaptive", display: THINKING_DISPLAY }, effort };
    }

    supportsReasoning(modelId) {
        // Opus/Sonnet 4.x-5.x and Fable/Mythos support extended thinking.
        // Haiku 4.5 is deliberately excluded — see the catalog note on it.
        return describeClaudeModel(modelId).reasoning;
    }

    supportsVision(modelId) {
        // Claude 3+, 4.x and 5.x all take image input. Two other copies of this
        // check existed (appStudio/aiRuntime.js and agentRuntime/
        // attachmentProcessor.js) and had already drifted apart — the latter
        // silently omitted Sonnet 5 and Fable, disabling the PDF-vision
        // fallback for models we ship. All three now read the same catalog.
        return describeClaudeModel(modelId).vision;
    }

    supportsDocuments(modelId) {
        // Native PDF document blocks ride the same vision capability: the API
        // renders each page and reads its text layer server-side. Anything that
        // can see an image can take a document block.
        return this.supportsVision(modelId);
    }

    supportsContextEditing(modelId) {
        // Context editing (clear_tool_uses_20250919) is available on the
        // Claude 4+ and Claude 5 families; Claude 3.x rejects the parameter.
        return describeClaudeModel(modelId).contextEditing;
    }

    // ─── Tool Normalization ──────────────────────────────────────

    normalizeTools(tools = []) {
        return tools.map((t) => {
            const fn = t.function || t;
            return {
                name: fn.name,
                description: fn.description || "",
                input_schema: fn.parameters || fn.input_schema || {},
            };
        });
    }

    // ─── SDK Params Builder ──────────────────────────────────────

    _buildSdkParams(model, messages, options = {}) {
        // Resolved first: whether thinking is on decides whether stored
        // thinking blocks are worth replaying into the history at all.
        let thinkingConfig = this.buildThinking(model, options);

        // Extended thinking is incompatible with a forced tool choice: per
        // https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use
        // only `auto` and `none` are allowed while thinking is enabled —
        // `any`/`tool` get a 400 and the whole call fails. Forced choice is the
        // mechanical structured-output path (llmClient.chatForcedTool), where
        // reasoning adds nothing, so thinking yields to the force, never the
        // other way around. Skipping replay too: thinking blocks without a
        // thinking param are dead weight in the history.
        const tc = options.toolChoice;
        const forcedChoice = tc === 'any' || tc === 'required'
            || !!(tc && typeof tc === 'object' && (tc.name || tc.function?.name));
        if (forcedChoice && thinkingConfig) {
            thinkingConfig = undefined;
        }
        const keepThinking = !!thinkingConfig && !options._noThinkingReplay;

        const params = {
            model,
            messages: this.normalizeMessages(messages, { keepThinking }),
            max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        };

        const system = this.extractSystem(messages);
        if (system) params.system = system;

        // The adaptive-only family (Opus 4.7/4.8, Sonnet 5, Fable/Mythos 5) rejects
        // sampling params with a 400 — never forward a caller-supplied temperature.
        const adaptiveOnly = this.isAdaptiveOnlyReasoning(model);
        if (options.temperature !== undefined && !adaptiveOnly) params.temperature = options.temperature;

        if (options.tools && options.tools.length > 0) {
            const normalizedTools = this.normalizeTools(options.tools);
            // Tools come before system in Anthropic's wire format. Per the
            // mixed-TTL rule ("longer TTL must appear first"), placing a
            // 5-min breakpoint on tools while system has a 1-hour breakpoint
            // would violate ordering. The system block-1 1h breakpoint
            // already caches "tools + system" as a single prefix, so the
            // standalone tools breakpoint is redundant — drop it.
            params.tools = normalizedTools;
            if (options.toolChoice === "auto") params.tool_choice = { type: "auto" };
            if (options.toolChoice === "any" || options.toolChoice === "required") {
                params.tool_choice = { type: "any" };
            }
            if (options.toolChoice && typeof options.toolChoice === "object") {
                // Force a single named tool. Accept BOTH the bare `{name}` form
                // and the OpenAI wire shape `{type:'function',function:{name}}`
                // that openai-style callers and llmClient.forcedToolChoice emit —
                // Anthropic's SDK only understands `{type:'tool',name}`, so a
                // caller passing the OpenAI shape previously fell through here and
                // silently ran with tool_choice unset (auto), breaking every
                // forced-structured-output call routed to a Claude model.
                const forcedName = options.toolChoice.name || options.toolChoice.function?.name;
                if (forcedName) params.tool_choice = { type: "tool", name: forcedName };
            }
        }

        // ─── Server-side context management ──────────────────────────
        //
        // This is the LOSSLESS half of context handling and, since local
        // compaction became opt-in (core/llm/contextPolicy.js), the one that
        // normally runs. Anthropic edits the request server-side; our stored
        // conversation is never rewritten, so nothing is destroyed for later
        // turns the way a fast-tier summary destroys it.
        //
        // Two edits, and ORDER MATTERS — `clear_thinking_20251015` must come
        // first when combined, per Anthropic's docs.
        //
        //   1. clear_thinking_20251015 — `keep: all`. Not a no-op: on Opus 4.6
        //      / Sonnet 4.6 and earlier the API's DEFAULT is to keep only the
        //      last turn's thinking and silently drop the rest, which is half
        //      of "the model loses its reasoning in long chats". We replay the
        //      blocks (replayThinkingBlocks) and this stops the server from
        //      throwing them away again. Opus 4.5+/Sonnet 4.6+ already default
        //      to keeping everything, so there it just pins the behaviour.
        //      CLAUDE_KEEP_THINKING_TURNS=<n> caps it for cost-sensitive
        //      deployments.
        //
        //   2. clear_tool_uses_20250919 — only meaningful with tools in play.
        //      Fires on genuinely heavy tool turns, keeps the recent pairs the
        //      model is actively reasoning about, and clears enough per
        //      activation to justify the cache invalidation at the clear point.
        //      `clear_tool_inputs` stays false so the model still sees WHAT it
        //      called even once the result is gone.
        //
        // Native server-side compaction (compact_20260112) is deliberately NOT
        // enabled: its compaction blocks must be replayed verbatim on later
        // requests, and our flattened message persistence cannot round-trip
        // them.
        if (!CONTEXT_EDITING_DISABLED && !options._noContextEditing && this.supportsContextEditing(model)) {
            const edits = [];

            if (thinkingConfig && KEEP_THINKING_TURNS !== 'off') {
                edits.push({
                    type: 'clear_thinking_20251015',
                    keep: KEEP_THINKING_TURNS === 'all'
                        ? { type: 'all' }
                        : { type: 'thinking_turns', value: KEEP_THINKING_TURNS },
                });
            }

            if (params.tools) {
                edits.push({
                    type: 'clear_tool_uses_20250919',
                    trigger: { type: 'input_tokens', value: 30000 },
                    keep: { type: 'tool_uses', value: 5 },
                    clear_at_least: { type: 'input_tokens', value: 5000 },
                });
            }

            if (edits.length > 0) params.context_management = { edits };
        }

        if (thinkingConfig) {
            params.thinking = thinkingConfig.thinking;
            // Legacy 4.x require temperature=1 when thinking is enabled; the
            // adaptive-only family rejects sampling params, so leave it unset.
            if (!adaptiveOnly) params.temperature = 1;
            if (thinkingConfig.thinking.type === 'adaptive') {
                // effort belongs inside output_config per SDK v0.78.0 OutputConfig interface
                if (thinkingConfig.effort) {
                    params.output_config = { effort: thinkingConfig.effort };
                }
                // Ensure enough room for thinking + answer
                if (params.max_tokens < 16384) params.max_tokens = 16384;
            } else if (thinkingConfig.thinking.budget_tokens && params.max_tokens < thinkingConfig.thinking.budget_tokens + 1024) {
                // Legacy budget_tokens mode
                params.max_tokens = thinkingConfig.thinking.budget_tokens + 1024;
            }
        }

        if (options.responseFormat?.type === 'json_schema' && options.responseFormat.json_schema?.schema) {
            params.output_config = { ...params.output_config,
                format: { type: 'json_schema', schema: options.responseFormat.json_schema.schema } };
        }
        return params;
    }

    /**
     * Per-request headers for beta params attached by _buildSdkParams.
     * Per-request headers REPLACE defaultHeaders with the same name, so in
     * OAuth mode the oauth beta must ride along with the context-management
     * beta (comma-separated list is the documented form).
     */
    _requestOptionsFor(params, oauth) {
        if (!params.context_management) return undefined;
        const betas = oauth ? `oauth-2025-04-20,${CONTEXT_EDITING_BETA}` : CONTEXT_EDITING_BETA;
        return { headers: { 'anthropic-beta': betas } };
    }

    _isContextManagementRejection(err) {
        const body = JSON.stringify(err?.error || '') + (err?.message || '');
        return /context[_-]?management/i.test(body);
    }

    // ─── High-Level API (all SDK) ────────────────────────────────

    /**
     * Non-streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored — SDK handles it.
     */
    async chat(apiKey, baseUrl, model, messages, options = {}) {
        const { token, oauth } = await this._resolveAuth(apiKey);
        const client = this.createClient(token, oauth);
        // Our own storage URLs must become bytes BEFORE normalization — Anthropic
        // refuses to fetch them (robots.txt) and 400s the entire request.
        const withImages = await inlineInternalImages(messages);
        const params = this._buildSdkParams(model, withImages, options);
        if (oauth) this._injectClaudeCodeIdentity(params);
        await downscaleClaudeMessages(params.messages);

        log.info('[Claude] SDK chat for model:', model);
        let response;
        try {
            response = await client.messages.create(params, this._requestOptionsFor(params, oauth));
        } catch (err) {
            // A replayed thinking block the API won't verify (usually a model
            // switch mid-conversation) — drop the blocks and retry once. They
            // are context, never the request itself.
            if (!options._noThinkingReplay && isThinkingReplayRejection(err)) {
                log.warn('[Claude] thinking replay rejected — retrying without stored thinking blocks:', err.message);
                return this.chat(apiKey, baseUrl, model, messages, { ...options, _noThinkingReplay: true });
            }
            // A rejection of the context-management beta (unexpected model /
            // beta drift) must not take down chat for the whole model — strip
            // the param and retry once without it.
            if (!params.context_management || !this._isContextManagementRejection(err)) throw err;
            log.warn('[Claude] context_management rejected — retrying without it:', err.message);
            delete params.context_management;
            response = await client.messages.create(params);
        }

        const textContent = response.content
            ?.filter(c => c.type === 'text')
            .map(c => c.text)
            .join('') || null;

        const toolCalls = response.content
            ?.filter(c => c.type === 'tool_use')
            .map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input) },
            }));

        // A refusal (or an over-long request) carries no text, so returning
        // `content: null` here reads downstream as "the model had nothing to
        // say" rather than "the model declined". Give it words.
        let content = textContent;
        if (!content && response.stop_reason === 'refusal') {
            content = refusalMessage(response);
            log.warn('[Claude] request refused —',
                JSON.stringify(response.stop_details || null));
        } else if (!content && isContextWindowStop(response)) {
            content = 'This conversation no longer fits in the model context window.';
            log.warn('[Claude] model_context_window_exceeded');
        } else if (!content && response.stop_reason === 'max_tokens' && (!toolCalls || toolCalls.length === 0)) {
            // Thinking can eat the entire budget before the first visible token;
            // null here reads downstream as "the model had nothing to say".
            content = 'The model hit its output length limit before it could answer. Please try again — a shorter conversation or a higher token budget helps.';
            log.warn('[Claude] max_tokens with no visible output (budget spent before text)');
        }

        return {
            content,
            toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
            stopReason: response.stop_reason,
            stopDetails: response.stop_details || null,
            usage: normalizeUsage('claude', response.usage),
            raw: response,
        };
    }

    /**
     * Streaming chat via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async stream(apiKey, baseUrl, model, messages, options = {}, onEvent) {
        const { token, oauth } = await this._resolveAuth(apiKey);
        const client = this.createClient(token, oauth);
        // See chat(): stored images are inlined before normalization.
        const withImages = await inlineInternalImages(messages);
        const params = this._buildSdkParams(model, withImages, options);
        if (oauth) this._injectClaudeCodeIdentity(params);
        await downscaleClaudeMessages(params.messages);

        log.info('[Claude] SDK streaming for model:', model);
        log.info('[Claude] Params:', JSON.stringify({
            model: params.model,
            max_tokens: params.max_tokens,
            temperature: params.temperature,
            thinking: params.thinking || 'disabled',
            output_config: params.output_config || 'n/a',
            tools: params.tools ? `${params.tools.length} tool(s)` : 'none',
            messageCount: params.messages?.length || 0,
        }));

        let textChunks = 0;
        let thinkingChunks = 0;
        let eventCount = 0;
        let currentToolUse = null; // Track in-progress tool_use block
        /** @type {{ partId: string, redacted: boolean, signature: string|null, redactedData?: string } | null} */
        let currentThinking = null; // Track in-progress thinking / redacted_thinking block
        let thinkingPartCounter = 0;
        /** @type {Record<string, any> | null} */
        let streamUsage = null;
        let stopReason = null;
        let stopDetails = null;

        try {
            const stream = await client.messages.stream(params, this._requestOptionsFor(params, oauth));

            for await (const event of stream) {
                eventCount++;
                if (event.type === 'content_block_delta') {
                    if (event.delta?.type === 'text_delta' && event.delta?.text) {
                        textChunks++;
                        onEvent('text', { text: event.delta.text });
                    } else if (event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
                        thinkingChunks++;
                        onEvent('thinking', {
                            text: event.delta.thinking,
                            partId: currentThinking?.partId,
                        });
                    } else if (event.delta?.type === 'signature_delta' && event.delta?.signature) {
                        // Server-side only — signature is persisted onto the thinking block
                        // and echoed back to Anthropic on multi-turn tool flows. Never shown to UI.
                        if (currentThinking) {
                            currentThinking.signature = event.delta.signature;
                            onEvent('thinking_signature', {
                                partId: currentThinking.partId,
                                signature: event.delta.signature,
                            });
                        }
                    } else if (event.delta?.type === 'input_json_delta' && event.delta?.partial_json) {
                        // Accumulate tool call JSON arguments
                        if (currentToolUse) {
                            currentToolUse.arguments += event.delta.partial_json;
                            // Surface the in-progress arguments so callers can live-
                            // stream a tool arg (e.g. notebook_write content) as it is
                            // generated. Consumers that don't handle it ignore it.
                            onEvent('tool_args_delta', { name: currentToolUse.name, partial: currentToolUse.arguments });
                        }
                    }
                } else if (event.type === 'content_block_start') {
                    const blockType = event.content_block?.type;
                    if (blockType === 'tool_use') {
                        // Start accumulating a new tool call
                        currentToolUse = {
                            id: event.content_block.id,
                            name: event.content_block.name,
                            arguments: '',
                        };
                        log.info('[Claude] Tool use block start:', event.content_block.name);
                    } else if (blockType === 'thinking') {
                        currentThinking = {
                            partId: `claude-${thinkingPartCounter++}`,
                            redacted: false,
                            signature: null,
                        };
                        onEvent('thinking_start', { partId: currentThinking.partId });
                    } else if (blockType === 'redacted_thinking') {
                        currentThinking = {
                            partId: `claude-${thinkingPartCounter++}`,
                            redacted: true,
                            signature: null,
                        };
                        onEvent('thinking_start', { partId: currentThinking.partId, redacted: true });
                        // The opaque payload is the ONLY thing that can be
                        // replayed for a redacted block — there is no readable
                        // text and no signature delta. Persist it the same way
                        // a signature is persisted, or the block is lost for
                        // every later turn.
                        if (event.content_block.data) {
                            currentThinking.redactedData = event.content_block.data;
                            onEvent('thinking_signature', {
                                partId: currentThinking.partId,
                                redactedData: event.content_block.data,
                            });
                        }
                    }
                } else if (event.type === 'content_block_stop') {
                    // Emit accumulated tool call when block ends. Drop a nameless
                    // block, or one whose accumulated arguments aren't valid JSON,
                    // instead of emitting input:{} — a poisoned tool call echoed back
                    // next round can trigger an upstream 400 / spin loop (BFSF-143).
                    if (currentToolUse) {
                        let input;
                        let _drop = false;
                        if (!currentToolUse.name || !String(currentToolUse.name).trim()) {
                            log.warn('[Claude] Dropping nameless streamed tool call');
                            _drop = true;
                        } else {
                            try { input = JSON.parse(currentToolUse.arguments || '{}'); }
                            catch (e) { log.warn(`[Claude] Dropping tool_use ${currentToolUse.name}: invalid JSON args (${e.message})`); _drop = true; }
                        }
                        if (!_drop) {
                            onEvent('tool_use', {
                                id: currentToolUse.id,
                                name: currentToolUse.name,
                                input,
                            });
                            log.info(`[Claude] Stream tool_use: ${currentToolUse.name}`);
                        }
                        currentToolUse = null;
                    } else if (currentThinking) {
                        onEvent('thinking_stop', {
                            partId: currentThinking.partId,
                            redacted: currentThinking.redacted || undefined,
                        });
                        currentThinking = null;
                    }
                } else if (event.type === 'message_start') {
                    // normal start
                } else if (event.type === 'message_delta') {
                    // normal delta
                } else if (event.type === 'message_stop') {
                    // normal stop
                } else if (/** @type {any} */ (event).type === 'error') { // not in the SDK's event union; defensive
                    log.error('[Claude] Stream error event:', JSON.stringify(event));
                    onEvent('error', { error: /** @type {any} */ (event).error?.message || 'Unknown stream error' });
                }
            }

            // Try to get the final message for usage info
            try {
                const finalMessage = await stream.finalMessage();
                log.info('[Claude] Final message — stop_reason:', finalMessage.stop_reason,
                    'usage:', JSON.stringify(finalMessage.usage));
                // A refused turn streams no text at all. Without this the UI
                // just stops, with no message and no error.
                if (textChunks === 0 && finalMessage.stop_reason === 'refusal') {
                    log.warn('[Claude] stream refused —',
                        JSON.stringify(finalMessage.stop_details || null));
                    onEvent('text', { text: refusalMessage(finalMessage) });
                } else if (textChunks === 0 && isContextWindowStop(finalMessage)) {
                    onEvent('text', { text: 'This conversation no longer fits in the model context window.' });
                }
                stopReason = finalMessage.stop_reason || null;
                stopDetails = finalMessage.stop_details || null;
                if (finalMessage.usage) {
                    // Same normaliser as the non-streaming chat(): input_tokens
                    // stays the uncached remainder (usageNormalizer header), the
                    // 5m/1h cache-write split is carried instead of one
                    // "dominant" TTL, and tier/geo/server-tool counts ride along.
                    streamUsage = {
                        ...normalizeUsage('claude', finalMessage.usage),
                        stop_reason: finalMessage.stop_reason || null,
                    };
                    if (streamUsage.cached_tokens > 0) {
                        log.info(`[Claude] ⚡ Cache hit: ${streamUsage.cached_tokens} cached input tokens (saved ~${Math.round(streamUsage.cached_tokens * 0.9)} token-equivalents)`);
                    }
                    if (streamUsage.cache_creation_tokens > 0) {
                        log.info(`[Claude] 📦 Cache created: ${streamUsage.cache_creation_tokens} tokens (5m=${streamUsage.cache_creation_5m_tokens}, 1h=${streamUsage.cache_creation_1h_tokens})`);
                    }
                }
            } catch (e) {
                // already consumed
            }
        } catch (err) {
            // A rejection of the context-management beta would otherwise loop
            // forever in upstream retries (the 400 is permanent for identical
            // params). Safe to restart here: a connect-time 400 fires before
            // any event was emitted downstream.
            if (params.context_management && eventCount === 0 && this._isContextManagementRejection(err)) {
                log.warn('[Claude] context_management rejected — retrying stream without it:', err.message);
                return this.stream(apiKey, baseUrl, model, messages, { ...options, _noContextEditing: true }, onEvent);
            }
            // Same connect-time-only guard for an unverifiable thinking block:
            // safe to restart because nothing has been emitted downstream yet.
            if (eventCount === 0 && !options._noThinkingReplay && isThinkingReplayRejection(err)) {
                log.warn('[Claude] thinking replay rejected — retrying stream without stored thinking blocks:', err.message);
                return this.stream(apiKey, baseUrl, model, messages, { ...options, _noThinkingReplay: true }, onEvent);
            }
            log.error('[Claude] Stream error:', err.message);
            if (err.status) log.error('[Claude] Error status:', err.status);
            if (err.error) log.error('[Claude] API error body:', JSON.stringify(err.error));
            // Enrich the error with status info for upstream retry classification
            if (err.status && !err.message.includes(`API error ${err.status}`)) {
                err.message = `API error ${err.status}: ${JSON.stringify(err.error || err.message)}`;
            }
            throw err;  // Let retryStreamCall handle retry/classify
        }

        log.info(`[Claude] Stream complete — ${eventCount} events, ${textChunks} text chunks, ${thinkingChunks} thinking chunks`);
        onEvent('done', { ...(streamUsage || {}), stopReason, stopDetails });
    }

    /**
     * List models via SDK.
     * baseUrl is accepted for interface compatibility but ignored.
     */
    async listModels(apiKey, _baseUrl) {
        try {
            const { token, oauth } = await this._resolveAuth(apiKey);
            const client = this.createClient(token, oauth);
            const response = await client.models.list();
            return (response.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
        } catch (e) {
            log.error('[Claude] SDK listModels failed:', e.message);
            return [];
        }
    }
}

module.exports = ClaudeProvider;