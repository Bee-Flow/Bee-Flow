/**
 * Automation Builder — the per-round mechanics of the chat build loop: the
 * model-facing validation report (and the history sanitation that strips it),
 * token accounting, tool-argument parsing, the agent's to-do list, and the
 * assistant-turn snapshot persisted for SSE resume.
 */

const { MUTATING_TOOLS } = require('../../../automation/builderTools');

// Marker prefix for the synthetic validation feedback message. Used to frame
// it as machine-generated (not the human) and to strip it from cross-turn
// history in sanitizeHistory.
const VALIDATION_NOTE_PREFIX = '[VALIDATION REPORT — machine-generated, not from the human user]';

// The truncation / provider-error / usage / arg-parsing mechanics are the
// shared core/llm/toolLoop.js (one implementation for both builders); this
// module binds the automation builder's note prefix and parameterless set.
const toolLoop = require('../../../core/llm/toolLoop');
const { TRUNCATION_PLACEHOLDER, isTruncatedStop, providerErrorExcerpt, accumulateUsage } = toolLoop;
const { recoverLeakedToolCalls, RECOVERED_CALL_HINT, REPAIRED_CALL_HINT } = require('../../../core/llm/leakedToolCalls');

/**
 * The [assistant, user] pair the loop appends when a round ran into max_tokens
 * without producing a tool call. The user note carries VALIDATION_NOTE_PREFIX
 * so sanitizeHistory drops it from cross-turn history like the validation
 * reports. Pure — exported for tests.
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

/**
 * Render the model-facing validation feedback for a round, or null when
 * there is nothing worth a message.
 *
 * - errors → full structured records (the model must fix these).
 * - warnings → ONE compact codes line. On a plain build round warnings alone
 *   produce NO message (a half-built graph legitimately warns about unwired
 *   branches etc. — surfacing them mid-build triggered premature fix rounds);
 *   on a dry-run/finalize round (`tested`) they do surface, as that is the
 *   completeness check moment.
 */
// How many validation errors one note shows the model.
//
// The note used to carry JSON.stringify(errors) uncapped, after EVERY mutating
// round, under "Fix every error below". A broken draft produces dozens, and a
// small local model asked to fix all of them at once answers with one malformed
// mega-call — which fails validation, which grows the list. Five is enough to
// show a pattern and small enough to act on; the next round lists what is left,
// so nothing is lost, it is only paced.
const VALIDATION_ERRORS_SHOWN = 5;

function renderValidationNote(validation, { tested = false } = {}) {
    if (!validation) return null;
    const errors = Array.isArray(validation.errors) ? validation.errors : [];
    const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
    const warnLine = warnings.length
        ? `warnings(${warnings.length}): ${[...new Set(warnings.map(w => w && w.code).filter(Boolean))].join(', ')}`
        : '';
    if (errors.length) {
        const shown = errors.slice(0, VALIDATION_ERRORS_SHOWN);
        const rest = errors.length - shown.length;
        const more = rest > 0
            ? `\n(${rest} more error${rest === 1 ? '' : 's'} not shown — fix these first and the next check will list the rest.)`
            : '';
        return `${VALIDATION_NOTE_PREFIX}\nFix the error${shown.length === 1 ? '' : 's'} below before calling builder_finalize. Each record has {code, path, message, hint}; the hint tells you what to do next.\n${JSON.stringify(shown)}${more}${warnLine ? `\n${warnLine}` : ''}`;
    }
    if (tested && warnings.length) {
        return `${VALIDATION_NOTE_PREFIX}\nNo errors. ${warnLine}\n${JSON.stringify(warnings)}`;
    }
    return null;
}

function mutates(toolName) {
    // builder_inspect_tool, builder_summarise, builder_request_dry_run,
    // and builder_finalize are all non-mutating from the draft definition's
    // perspective (finalize flips a flag but doesn't change `def`).
    // Source of truth lives in builderTools.MUTATING_TOOLS so new mutators
    // (flowlet tools, array ops, …) persist + emit a draft snapshot without
    // this list silently drifting out of date.
    return MUTATING_TOOLS.has(toolName);
}

// Tools that legitimately take NO arguments — an empty/missing args string is
// valid for these, so a JSON-parse "failure" on an empty string must NOT be
// treated as a truncation.
const PARAMLESS_BUILDER_TOOLS = new Set(['builder_summarise', 'builder_finalize', 'builder_request_dry_run']);

/** Parse a tool call's `arguments` defensively → { args, truncated } (core/llm/toolLoop). */
function parseToolArgs(raw, toolName) {
    return toolLoop.parseToolArgs(raw, toolName, { paramless: PARAMLESS_BUILDER_TOOLS });
}

/**
 * Cross-turn history as the model may see it: user/assistant text only, minus
 * the loop-internal validation notes. UNCAPPED on purpose — this used to end in
 * `.slice(-20)`, and a sliding tail moves the first kept message on every turn,
 * which shifted every byte after the system prompt and broke the prompt-prefix
 * cache each time the user replied (~22k tokens re-read per turn on the local
 * box). Length is now bounded at the compose site by the head-anchored
 * `windowHistory` (core/llm/historyWindow.js), which evicts whole blocks from
 * the front so the prefix survives between evictions.
 */
function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        // Synthetic per-round validation notes are loop-internal context —
        // replaying them across turns would re-surface long-fixed issues.
        .filter(m => !m.content.startsWith(VALIDATION_NOTE_PREFIX))
        .map(m => ({ role: m.role, content: m.content }));
}

/**
 * Collapse the LLM-loop messages array down to the latest assistant turn
 * for snapshot persistence: pulls the most recent assistant entry and
 * resolves its tool_calls/results so a resume can rebuild the chat bubble.
 */
function collectAssistantTurn(loopMessages) {
    if (!Array.isArray(loopMessages)) return null;
    // Walk back to the last assistant message.
    let assistantIdx = -1;
    for (let i = loopMessages.length - 1; i >= 0; i--) {
        if (loopMessages[i]?.role === 'assistant') { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) return null;
    const a = loopMessages[assistantIdx];
    const toolCalls = Array.isArray(a.tool_calls)
        ? a.tool_calls.map(tc => {
            // Pair with its tool result (next 'tool' message with matching id).
            const result = loopMessages.slice(assistantIdx + 1).find(m => m.role === 'tool' && m.tool_call_id === tc.id);
            let parsedResult = null;
            try { parsedResult = result?.content ? JSON.parse(result.content) : null; }
            catch { parsedResult = result?.content || null; }
            let parsedArgs = {};
            try { parsedArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); }
            catch { parsedArgs = {}; }
            return { name: tc.function?.name, arguments: parsedArgs, result: parsedResult };
        })
        : [];
    return {
        role: 'assistant',
        content: typeof a.content === 'string' ? a.content : '',
        toolCalls,
    };
}

// The to-do list shape is shared with the App Studio builder (core/llm/planChecklist).
const { applyPlanMarkDone, normalizePlanTodos } = require('../../../core/llm/planChecklist');

module.exports = {
    VALIDATION_NOTE_PREFIX,
    TRUNCATION_PLACEHOLDER,
    isTruncatedStop,
    truncationRetryMessages,
    emptyReplyRetryMessages,
    isBlankReply: toolLoop.isBlankReply,
    recoverLeakedToolCalls,
    RECOVERED_CALL_HINT,
    REPAIRED_CALL_HINT,
    renderValidationNote,
    providerErrorExcerpt,
    accumulateUsage,
    mutates,
    parseToolArgs,
    sanitizeHistory,
    collectAssistantTurn,
    applyPlanMarkDone,
    normalizePlanTodos,
};
