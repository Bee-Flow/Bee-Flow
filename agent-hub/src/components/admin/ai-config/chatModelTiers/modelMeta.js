// Bundled model metadata + capability detectors for the chat-model-tier admin
// panel. Moved verbatim from ChatModelTiersConfig.jsx; only the `export`
// keywords are new.
// Reuse model metadata from AIConfigPanel
export const getModelMeta = (id) => {
    const meta = MODEL_META[id];
    if (meta) return meta;
    const prefixes = Object.keys(MODEL_META).sort((a, b) => b.length - a.length);
    for (const prefix of prefixes) {
        if (id.startsWith(prefix.replace(/-latest$/, '').replace(/-\d{4}$/, ''))) {
            return MODEL_META[prefix];
        }
    }
    return null;
};

// Detect models that support OpenAI reasoning settings
export const isReasoningCapable = (modelId) => {
    if (!modelId) return false;
    if (/^o\d/.test(modelId)) return true;                          // o1, o3, o4-mini, etc.
    if (/^gpt-[5-9]/.test(modelId)) return true;                    // GPT-5, 5.6, 6 and later
    if (/^claude-haiku-4-5/.test(modelId)) return false;            // Haiku 4.5: no adaptive thinking
    if (/^claude-(opus|sonnet)-[45]/.test(modelId)) return true;    // Claude Opus/Sonnet 4.x & 5.x
    if (/^claude-(fable|mythos)/.test(modelId)) return true;        // Fable/Mythos 5 (always-on thinking)
    return false;
};

// Detect Claude models specifically (they use adaptive thinking with effort levels)
export const isClaudeReasoning = (modelId) => {
    if (!modelId) return false;
    if (/^claude-haiku-4-5/.test(modelId)) return false;
    return /^claude-(opus|sonnet)-[45]/.test(modelId) || /^claude-(fable|mythos)/.test(modelId);
};

// Adaptive-only Claude family: rejects a manual thinking budget AND sampling
// params, and exposes the 'xhigh' effort level — Opus 4.7/4.8, Opus 5,
// Sonnet 5, Fable/Mythos. (Opus 4.6 / Sonnet 4.6 still accept a fixed budget.)
//
// This gates the budget control and the xhigh/max options in TierCard /
// CustomTierCard, so an id missing here is not cosmetic: the panel offers a
// thinking budget the API answers with a 400, and hides the two effort levels
// the model actually supports. `claude-opus-5` was missing for exactly that
// reason — the old pattern spelled the Opus generation as `4-[78]`, which no
// 5-series id can match. Kept in sync with
// server/core/providers/claudeModels.js (describeClaudeModel().adaptiveOnly).
export const isClaudeAdaptiveOnly = (modelId) =>
    /^claude-(opus-(4-[78]|[5-9])|sonnet-[5-9]|fable|mythos)/.test(modelId || '');

// Any Claude model (used to show Claude-specific tier settings inline)
export const isClaudeModel = (modelId) => /^claude-/.test(modelId || '');

// OpenAI reasoning models (o-series + GPT-5 and later)
export const isOpenAIReasoning = (modelId) => /^gpt-[5-9]|^o\d/.test(modelId || '');
// The GPT-5.0–5.5 line: the only one with a 'minimal' tier and a verbosity knob.
export const isGpt5 = (modelId) => /^gpt-5/.test(modelId || '') && !isGpt56Plus(modelId);
// Pro models reason at 'high' only (gpt-5-pro, gpt-5.2-pro, gpt-5.4-pro, …)
export const isGpt5Pro = (modelId) => /^gpt-\d(\.\d+)?-pro$/.test(modelId || '');
// Only codex-max accepts the 'xhigh' effort tier, on the pre-5.6 line
export const isCodexMax = (modelId) => /codex-max/.test(modelId || '');

// gpt-5.6 and everything after it. A separate generation, not a point release:
// 'minimal' is gone, 'xhigh'/'max' are general, and there is no verbosity knob.
export const isGpt56Plus = (modelId) => {
    const m = /^gpt-(\d+)(?:\.(\d+))?/.exec(modelId || '');
    if (!m) return false;
    const major = Number(m[1]);
    const minor = m[2] === undefined ? 0 : Number(m[2]);
    return major > 5 || (major === 5 && minor >= 6);
};

// gpt-6 and later drop the 'none' effort entirely — asking for it is a 400.
export const hasNoneEffort = (modelId) => !/^gpt-[6-9]/.test(modelId || '');

// Labels for an effort vocabulary the server stamped on a model (`efforts`
// in its /models entry — Mistral's none/high). The server maps any other
// value onto the nearest of these, so the panel offers exactly these.
const EFFORT_LABELS = {
    none: 'None: answers straight away',
    minimal: 'Minimal',
    low: 'Low: quick tasks',
    medium: 'Medium: balanced',
    high: 'High: reasons before answering',
    xhigh: 'xHigh: extended exploration',
    max: 'Max: deepest reasoning',
};
const EFFORT_RANK = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };

// The effort the server uses for a tier nobody set (server/core/llm/
// modelResolver.js TIER_DEFAULTS). `fast` has none there; on a model with a
// stamped vocabulary the adapter then sends `none`.
const TIER_DEFAULT_EFFORT = {
    fast: 'none', standard: 'low', swarm: 'low', thinking: 'medium',
    writer: 'low', deep_thinking: 'high', smart: 'medium', pro: 'low',
};
export const defaultTierEffort = (tierKey) => TIER_DEFAULT_EFFORT[tierKey] || 'none';

/** `[value, label]` pairs for a server-stamped effort list. */
export const stampedEffortOptions = (efforts) =>
    (Array.isArray(efforts) ? efforts : []).map(value => [value, EFFORT_LABELS[value] || value]);

/**
 * The value the server will actually send for `value`: the nearest one in
 * `efforts`, a tie going to the cheaper. Mirrors normalizeMistralEffort in
 * server/core/providers/mistralModels.js, so a tier stored as 'medium' shows
 * as the 'high' Mistral really gets.
 */
export const clampToEfforts = (value, efforts) => {
    if (!Array.isArray(efforts) || efforts.length === 0) return value;
    if (efforts.includes(value)) return value;
    const want = EFFORT_RANK[value];
    if (want === undefined) return efforts[0];
    let best = efforts[0];
    let bestDistance = Infinity;
    for (const candidate of efforts) {
        const rank = EFFORT_RANK[candidate];
        if (rank === undefined) continue;
        const distance = Math.abs(rank - want);
        if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best;
};

/**
 * The reasoning-effort options an OpenAI model actually accepts, as
 * `[value, label]` pairs for a <select>.
 *
 * This mirrors the server catalog in core/providers/openaiModels.js. It is a
 * copy, and a copy is a liability — but an admin panel offering a value the API
 * rejects is worse, and until the tier UI reads its metadata from the server
 * this is where the vocabulary has to live.
 */
export const openAIEffortOptions = (modelId) => {
    if (isGpt5Pro(modelId)) return [['high', 'High — pro models reason at high only']];

    const opts = [];
    if (hasNoneEffort(modelId)) opts.push(['none', 'None (disabled)']);
    if (isGpt5(modelId)) opts.push(['minimal', 'Minimal — fastest, lightest reasoning']);
    opts.push(['low', 'Low — quick tasks']);
    opts.push(['medium', 'Medium — balanced (default)']);
    opts.push(['high', 'High — complex reasoning']);
    if (isGpt56Plus(modelId) || isCodexMax(modelId)) {
        opts.push(['xhigh', 'xHigh — extended exploration']);
    }
    if (isGpt56Plus(modelId)) opts.push(['max', 'Max — deepest reasoning']);
    return opts;
};

export const MODEL_META = {
    // Mistral — the current line-up (server/core/providers/mistralModels.js).
    // Magistral, Pixtral and Devstral are retired on La Plateforme; reasoning
    // is now a switch on Small 4 and Medium 3.5.
    'mistral-large-latest': { name: 'Mistral Large 3', cat: 'Generalist' },
    'mistral-medium-latest': { name: 'Mistral Medium 3.5', cat: 'Generalist' },
    'mistral-small-latest': { name: 'Mistral Small 4', cat: 'Generalist' },
    'ministral-14b-latest': { name: 'Ministral 3 14B', cat: 'Generalist' },
    'ministral-8b-latest': { name: 'Ministral 3 8B', cat: 'Generalist' },
    'ministral-3b-latest': { name: 'Ministral 3 3B', cat: 'Generalist' },
    'codestral-latest': { name: 'Codestral', cat: 'Coding' },
    // OpenAI
    'gpt-6-astra': { name: 'GPT-6 Astra', cat: 'Reasoning' },
    'gpt-5.6-sol': { name: 'GPT-5.6 Sol', cat: 'Reasoning' },
    'gpt-5.6-terra': { name: 'GPT-5.6 Terra', cat: 'Reasoning' },
    'gpt-5.6-luna': { name: 'GPT-5.6 Luna', cat: 'Reasoning' },
    'gpt-5.5': { name: 'GPT-5.5', cat: 'Reasoning' },
    'gpt-5.4': { name: 'GPT-5.4', cat: 'Reasoning' },
    'gpt-5.4-mini': { name: 'GPT-5.4 Mini', cat: 'Generalist' },
    'gpt-5.4-nano': { name: 'GPT-5.4 Nano', cat: 'Generalist' },
    'gpt-5.4-pro': { name: 'GPT-5.4 Pro', cat: 'Reasoning' },
    'gpt-5.2': { name: 'GPT-5.2', cat: 'Generalist' },
    'gpt-5.2-pro': { name: 'GPT-5.2 Pro', cat: 'Reasoning' },
    'gpt-5.1': { name: 'GPT-5.1', cat: 'Generalist' },
    'gpt-5.1-chat': { name: 'GPT-5.1 Chat', cat: 'Generalist' },
    'gpt-5.1-codex-max': { name: 'GPT-5.1 Codex Max', cat: 'Coding' },
    'gpt-5.1-codex': { name: 'GPT-5.1 Codex', cat: 'Coding' },
    'gpt-5': { name: 'GPT-5', cat: 'Reasoning' },
    'gpt-5-pro': { name: 'GPT-5 Pro', cat: 'Reasoning' },
    'gpt-5-chat': { name: 'GPT-5 Chat', cat: 'Generalist' },
    'gpt-5-codex': { name: 'GPT-5 Codex', cat: 'Coding' },
    'gpt-5-mini': { name: 'GPT-5 Mini', cat: 'Generalist' },
    'gpt-5-nano': { name: 'GPT-5 Nano', cat: 'Generalist' },
    'gpt-4o': { name: 'GPT-4o', cat: 'Generalist' },
    'gpt-4o-mini': { name: 'GPT-4o Mini', cat: 'Generalist' },
    'gpt-4.1': { name: 'GPT-4.1', cat: 'Generalist' },
    'gpt-4.1-mini': { name: 'GPT-4.1 Mini', cat: 'Generalist' },
    'gpt-4.1-nano': { name: 'GPT-4.1 Nano', cat: 'Generalist' },
    'o3': { name: 'o3', cat: 'Reasoning' },
    'o3-mini': { name: 'o3 Mini', cat: 'Reasoning' },
    'o4-mini': { name: 'o4 Mini', cat: 'Reasoning' },
    // Claude
    'claude-fable-5-1': { name: 'Claude Fable 5.1', cat: 'Reasoning' },
    'claude-fable-5': { name: 'Claude Fable 5', cat: 'Reasoning' },
    'claude-opus-5': { name: 'Claude Opus 5', cat: 'Reasoning' },
    'claude-opus-4-8': { name: 'Claude Opus 4.8', cat: 'Reasoning' },
    'claude-opus-4-7': { name: 'Claude Opus 4.7', cat: 'Reasoning' },
    'claude-opus-4-6': { name: 'Claude Opus 4.6', cat: 'Reasoning' },
    'claude-sonnet-5': { name: 'Claude Sonnet 5', cat: 'Generalist' },
    'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', cat: 'Generalist' },
    'claude-haiku-4-5': { name: 'Claude Haiku 4.5', cat: 'Generalist' },
};
