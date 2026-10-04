// @typecheck
/**
 * Context policy — how much of a conversation the model actually gets to see.
 *
 * Two mechanisms decide that, and they are NOT the same thing:
 *
 *   1. LOCAL COMPACTION (core/llm/compaction.js). Lossy. Folds older turns into
 *      a ~200-word fast-tier summary and truncates tool results. Cheap, but it
 *      throws information away permanently for the rest of the conversation.
 *   2. SERVER-SIDE CONTEXT MANAGEMENT (Anthropic `context_management`, wired in
 *      core/providers/claude.js). Lossless for the parts it keeps: it clears
 *      stale tool results / thinking blocks per request, without rewriting our
 *      stored history, and it leaves the recent window verbatim.
 *
 * Local compaction was unconditional and fired at 16 messages. On a model with
 * a 1M-token context window that is pure loss: the conversation gets replaced
 * by a summary long before the context window is anywhere near full, which is
 * exactly the "the model forgets what we discussed" report. So it is now an
 * OPT-IN organisation setting, default OFF, and (2) carries the load instead.
 *
 * With compaction off there is still a hard ceiling — the model's context
 * window — so an emergency fold remains, triggered on estimated prompt size
 * rather than message count. A 400 "prompt is too long" is worse than a
 * summary.
 *
 * Stored per org under `org_ai_context_<orgId>` (configStore). Read on the
 * chat hot path, so results are memoised for CACHE_TTL_MS.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_ai_context_';
const CACHE_TTL_MS = 30_000;

/**
 * Percentage of the model's CONTEXT WINDOW at which the emergency fold fires.
 *
 * Expressed as a percentage rather than a token count on purpose: the same
 * setting then means ~750k tokens on Claude Sonnet 5 and ~150k on Haiku 4.5,
 * so an admin never has to know a model's window to pick a safe number, and
 * the value stays correct when the org switches model.
 */
const DEFAULT_CONTEXT_BUDGET_PERCENT = 75;
const MIN_CONTEXT_BUDGET_PERCENT = 25;
const MAX_CONTEXT_BUDGET_PERCENT = 95;

/**
 * Product default. `compactionEnabled: false` is deliberate — see the module
 * header. A self-host that wants the old behaviour back for every org can flip
 * it with BEEFLOW_CHAT_COMPACTION_DEFAULT=1 instead of editing every org row.
 */
function _envDefaultCompaction() {
    const raw = String(process.env.BEEFLOW_CHAT_COMPACTION_DEFAULT || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

const DEFAULT_POLICY = Object.freeze({
    compactionEnabled: false,
    // Only meaningful when compactionEnabled — the message count at which a
    // fold happens and how many recent turns stay verbatim.
    compactionThreshold: 16,
    recentWindow: 8,
    // Applies in BOTH modes: the ceiling the emergency fold defends.
    contextBudgetPercent: DEFAULT_CONTEXT_BUDGET_PERCENT,
});

const _cache = new Map(); // orgId|'' → { at, policy }

/**
 * Normalise a stored blob (or nothing) into a complete policy object.
 * Unknown / out-of-range values fall back to the default rather than
 * propagating into the prompt builder.
 */
function normalizePolicy(stored) {
    const src = (stored && typeof stored === 'object') ? stored : {};
    const enabled = typeof src.compactionEnabled === 'boolean'
        ? src.compactionEnabled
        : _envDefaultCompaction();

    const asInt = (v, fallback, min, max) => {
        // `Number(null)` and `Number('')` are 0, not NaN — treating a missing
        // field as "0, clamped to the minimum" would silently rewrite the
        // defaults, so absent values are rejected before the numeric coercion.
        if (v === null || v === undefined || v === '') return fallback;
        const n = Number(v);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, Math.round(n)));
    };

    const threshold = asInt(src.compactionThreshold, DEFAULT_POLICY.compactionThreshold, 4, 400);
    // The recent window must stay strictly below the threshold or the fold
    // boundary lands at or before the watermark and nothing is ever folded.
    const recent = Math.min(
        asInt(src.recentWindow, DEFAULT_POLICY.recentWindow, 2, 200),
        threshold - 2
    );

    return {
        compactionEnabled: enabled,
        compactionThreshold: threshold,
        recentWindow: Math.max(2, recent),
        contextBudgetPercent: asInt(
            src.contextBudgetPercent,
            DEFAULT_CONTEXT_BUDGET_PERCENT,
            MIN_CONTEXT_BUDGET_PERCENT,
            MAX_CONTEXT_BUDGET_PERCENT,
        ),
    };
}

/**
 * Resolve the effective context policy for an organisation.
 * `orgId` may be null (personal / consumer account) — those get the default.
 *
 * Never throws: a config-store failure falls back to the default policy, which
 * is the conservative one (no lossy rewriting of the user's conversation).
 */
async function resolveContextPolicy(orgId) {
    const key = orgId || '';
    const hit = _cache.get(key);
    if (hit && (Date.now() - hit.at) < CACHE_TTL_MS) return hit.policy;

    let stored = null;
    if (orgId) {
        try {
            stored = await configStore.getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
        } catch (err) {
            log.warn(`[ContextPolicy] Failed to read policy for org ${orgId}: ${err.message}`);
        }
    }
    const policy = normalizePolicy(stored);
    _cache.set(key, { at: Date.now(), policy });
    return policy;
}

/** Drop the memoised policy for an org (called by the settings route on save). */
function invalidateContextPolicy(orgId) {
    _cache.delete(orgId || '');
}

/**
 * Context window (max INPUT tokens) for a model id.
 *
 * Only used to size the emergency fold, so a wrong guess costs an early or a
 * late fold, never a crash. Deliberately conservative for unknown ids.
 *
 * Claude: 1M native (no beta header) on Opus 4.6+/4.7/4.8/5, Sonnet 4.6/5 and
 * Fable/Mythos 5; 200k on Haiku 4.5, Sonnet 4.5, Opus 4.5 and the 3.x family.
 */
function contextWindowFor(modelId) {
    // An Azure deployment answers with the window of the model behind it.
    modelId = require('../providers/azureDeployments').azureModelFor(modelId);
    const m = String(modelId || '').toLowerCase();
    if (!m) return 128_000;

    // A self-hosted runtime's window is whatever it was started with, and a
    // model id says nothing about it: the same 9B runs 16k on one box and
    // 128k on the next. The local adapter records the number llama-server
    // reports (providers/localModels), and that beats every guess below.
    const { localContextWindowFor } = require('../providers/localModels');
    const reported = localContextWindowFor(modelId);
    if (reported) return reported;

    // Claude windows come from the catalog rather than a regex, for the same
    // reason OpenAI's do below: a regex cannot answer for an id it was not
    // written against, and the Claude branch had to be edited by hand on every
    // release. The catalog's generation-aware fallback handles unreleased ids.
    if (/claude/.test(m) || /anthropic/.test(m)) {
        const { contextWindowFor: claudeWindow } = require('../providers/claudeModels');
        const win = claudeWindow(m);
        if (win) return win;
        return 200_000;
    }
    if (/gemini/.test(m)) return /1\.5-pro/.test(m) ? 2_000_000 : 1_000_000;
    // OpenAI windows come from the catalog rather than a regex: gpt-5.6 and
    // gpt-6 are 1.05M, not the 400k the /gpt-5/ pattern used to return, and a
    // gpt-6 id matched nothing at all and fell to the 128k default — which
    // folds a conversation at 96k tokens inside a million-token window.
    if (/^gpt-|^o\d/.test(m)) {
        const { contextWindowFor: openaiWindow } = require('../providers/openaiModels');
        const win = openaiWindow(m);
        if (win) return win;
    }
    // Mistral: the catalog, overridden by what /v1/models reported. The
    // current line-up (Large 3, Medium 3.5, Small 4, Ministral 3) is 256k;
    // the flat 128k this used to return folded their conversations halfway.
    if (/^(mistral|ministral|magistral|codestral|devstral|pixtral)-/.test(m)) {
        const { describeMistralModel } = require('../providers/mistralModels');
        const win = describeMistralModel(m).context;
        if (win) return win;
    }
    return 128_000;
}

/**
 * Token ceiling above which the emergency fold runs. Leaves room for the system
 * prompt, tool definitions and the model's own output on top of the
 * conversation itself — which is why the default is well under 100%.
 */
function overflowTokensFor(modelId, percent = DEFAULT_CONTEXT_BUDGET_PERCENT) {
    const pct = Number.isFinite(percent) ? percent : DEFAULT_CONTEXT_BUDGET_PERCENT;
    return Math.floor(contextWindowFor(modelId) * pct / 100);
}

/**
 * Representative models for the settings screen, so it can show what a chosen
 * percentage means in real tokens without duplicating `contextWindowFor`'s
 * table in the SPA. Two entries is enough to convey the range: the value means
 * very different things on a 1M-token model and a 200k one.
 */
function contextWindowExamples() {
    return [
        { label: 'Claude Sonnet 5', contextWindow: contextWindowFor('claude-sonnet-5') },
        { label: 'Claude Haiku 4.5', contextWindow: contextWindowFor('claude-haiku-4-5') },
    ];
}

/**
 * Build the options blob `compaction.compactMessages` expects from a resolved
 * policy plus the per-conversation state. One helper so the two chat runtimes
 * (agent chatStream + directChat) cannot drift apart.
 */
function buildCompactionOptions({ policy, existingSummary, summaryUpTo, modelId, userOrgId }) {
    const p = policy || DEFAULT_POLICY;
    return {
        enabled: p.compactionEnabled,
        threshold: p.compactionThreshold,
        recentWindow: p.recentWindow,
        overflowTokens: overflowTokensFor(modelId, p.contextBudgetPercent),
        existingSummary: existingSummary || null,
        summaryUpTo: Number.isInteger(summaryUpTo) ? summaryUpTo : 0,
        summaryModelId: 'tier:fast',
        userOrgId: userOrgId || null,
    };
}

module.exports = {
    resolveContextPolicy,
    invalidateContextPolicy,
    normalizePolicy,
    buildCompactionOptions,
    contextWindowFor,
    overflowTokensFor,
    contextWindowExamples,
    DEFAULT_POLICY,
    CONFIG_KEY_PREFIX,
    DEFAULT_CONTEXT_BUDGET_PERCENT,
    MIN_CONTEXT_BUDGET_PERCENT,
    MAX_CONTEXT_BUDGET_PERCENT,
};
