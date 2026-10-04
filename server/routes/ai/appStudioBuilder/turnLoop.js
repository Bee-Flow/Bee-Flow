/**
 * App Studio Builder — the per-round mechanics of the build loop that are
 * not the route's own wiring: the machine-message prefixes, the history
 * sanitation that strips them, tool-argument parsing bound to this
 * builder's parameterless tools, and the model-facing JSON truncation.
 *
 * The truncation / provider-error / usage arithmetic is core/llm/toolLoop.js,
 * shared with the automation builder; this module only binds the app builder's
 * prefix and tool set onto it.
 */

'use strict';

const toolLoop = require('../../../core/llm/toolLoop');
const leakedToolCalls = require('../../../core/llm/leakedToolCalls');
// The owner's automations + documents note (rendered by builderPrompt, which
// owns the prefix so the renderer and the stripper cannot disagree).
const { OWNER_CONTEXT_PREFIX } = require('../../../appStudio/builderPrompt');

// Marker prefixes for the synthetic machine messages — framed as generated
// (not the human) and stripped from cross-turn history by sanitizeHistory.
const VALIDATION_NOTE_PREFIX = '[VALIDATION REPORT — machine-generated, not from the human user]';
const DRAFT_STATE_PREFIX = '[DRAFT STATE — machine-generated: the app\'s current definition with its REAL ids]';
const EDITOR_CONTEXT_PREFIX = '[EDITOR CONTEXT — machine-generated: what the user is looking at]';
// Wave 5 plan-first machine messages — re-rendered each turn from persisted
// state, so (like the notes above) they are stripped from cross-turn history.
const APPROVED_PLAN_PREFIX = '[APPROVED PLAN — machine-generated: build exactly this]';
const PLAN_POLICY_PREFIX = '[PLAN POLICY — machine-generated]';
// Told to a blind (non-vision) model when the human attached a picture.
const IMAGE_NOTE_PREFIX = '[IMAGE NOTE — machine-generated]';

const MACHINE_PREFIXES = [
    VALIDATION_NOTE_PREFIX, DRAFT_STATE_PREFIX, EDITOR_CONTEXT_PREFIX,
    APPROVED_PLAN_PREFIX, PLAN_POLICY_PREFIX, IMAGE_NOTE_PREFIX,
    // 2026-09-17: the owner's automations/documents moved out of the system
    // prompt into a per-turn note (prefix-cache discipline: the system
    // prompt is now identical across users). Re-rendered every turn, so it
    // is stripped from history like the draft state.
    OWNER_CONTEXT_PREFIX,
];

/**
 * Prose-only history from a session snapshot; loop-internal notes stripped.
 *
 * UNCAPPED on purpose. This used to end in `.slice(-20)`: a sliding tail moves
 * the first kept message on every turn, which shifts every byte after the
 * few-shots and breaks the llama.cpp prompt-prefix cache each time the user
 * replies. Length is bounded at the compose site by the head-anchored
 * `windowHistory` (core/llm/historyWindow.js), which evicts whole blocks from
 * the front so the prefix survives between evictions.
 */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .filter((m) => !MACHINE_PREFIXES.some((p) => m.content.startsWith(p)))
        .map((m) => ({ role: m.role, content: m.content }));
}

// Tools that legitimately take NO arguments — empty args must not be treated
// as a truncated call.
const PARAMLESS_TOOLS = new Set(['app_get_draft', 'app_list_automations', 'app_get_data_model', 'app_list_connectors', 'app_list_templates', 'app_finalize']);

/** Parse a tool call's `arguments` defensively → { args, truncated } (core/llm/toolLoop). */
function parseToolArgs(raw, toolName) {
    return toolLoop.parseToolArgs(raw, toolName, { paramless: PARAMLESS_TOOLS });
}

/**
 * The [assistant, user] pair appended when a round ran into max_tokens without
 * a tool call; the note carries VALIDATION_NOTE_PREFIX so sanitizeHistory
 * drops it from cross-turn history.
 */
function truncationRetryMessages(content, thinkingForReplay) {
    return toolLoop.truncationRetryMessages(content, thinkingForReplay, { notePrefix: VALIDATION_NOTE_PREFIX });
}

/**
 * The pair appended when a round ended with neither a tool call nor text and
 * no call could be recovered from what it wrote (core/llm/leakedToolCalls);
 * `rejected` names what the recovery saw. Same prefix rule as above.
 */
function emptyReplyRetryMessages(content, thinkingForReplay, rejected) {
    return toolLoop.emptyReplyRetryMessages(content, thinkingForReplay, { notePrefix: VALIDATION_NOTE_PREFIX, rejected });
}

// How many validation errors one note shows the model.
//
// The note used to carry JSON.stringify(errors) uncapped, after EVERY mutating
// round, under "Fix every error below". A broken draft produces dozens, and a
// small local model asked to fix all of them at once answers with one malformed
// mega-call — which fails validation, which grows the list. Five is enough to
// show a pattern and small enough to act on; the next round lists what is left,
// so nothing is lost, it is only paced.
const VALIDATION_ERRORS_SHOWN = 5;

function renderValidationNote(validation) {
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
    const warnLine = warnings.length
        ? `\nwarnings(${warnings.length}): ${[...new Set(warnings.map((w) => w && w.code).filter(Boolean))].join(', ')}`
        : '';
    const shown = errors.slice(0, VALIDATION_ERRORS_SHOWN);
    const rest = errors.length - shown.length;
    const more = rest > 0
        ? `\n(${rest} more error${rest === 1 ? '' : 's'} not shown — fix these first and the next check will list the rest.)`
        : '';
    return `${VALIDATION_NOTE_PREFIX}\nFix the error${shown.length === 1 ? '' : 's'} below before calling app_finalize. Each record has {code, path, message, hint}; the hint tells you what to do next.\n${JSON.stringify(shown)}${more}${warnLine}`;
}

/** JSON-safe truncation for model-facing tool messages (never cuts mid-JSON). */
function truncateJson(result, maxChars = 30_000) {
    let s;
    try { s = JSON.stringify(result); } catch (_) { return JSON.stringify({ error: 'unserializable tool result' }); }
    if (typeof s !== 'string') return JSON.stringify(null);
    if (s.length <= maxChars) return s;
    return JSON.stringify({ _truncated: true, preview: s.slice(0, Math.max(0, maxChars - 200)) });
}

module.exports = {
    VALIDATION_NOTE_PREFIX,
    DRAFT_STATE_PREFIX,
    EDITOR_CONTEXT_PREFIX,
    APPROVED_PLAN_PREFIX,
    PLAN_POLICY_PREFIX,
    IMAGE_NOTE_PREFIX,
    OWNER_CONTEXT_PREFIX,
    MACHINE_PREFIXES,
    PARAMLESS_TOOLS,
    sanitizeHistory,
    parseToolArgs,
    truncationRetryMessages,
    emptyReplyRetryMessages,
    isBlankReply: toolLoop.isBlankReply,
    renderValidationNote,
    truncateJson,
    // Re-exported so the route reads one module for its loop mechanics.
    isTruncatedStop: toolLoop.isTruncatedStop,
    providerErrorExcerpt: toolLoop.providerErrorExcerpt,
    providerErrorStatus: toolLoop.providerErrorStatus,
    accumulateUsage: toolLoop.accumulateUsage,
    emptyUsageTotals: toolLoop.emptyUsageTotals,
    recoverLeakedToolCalls: leakedToolCalls.recoverLeakedToolCalls,
    RECOVERED_CALL_HINT: leakedToolCalls.RECOVERED_CALL_HINT,
    REPAIRED_CALL_HINT: leakedToolCalls.REPAIRED_CALL_HINT,
};
