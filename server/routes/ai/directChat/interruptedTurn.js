/**
 * Interrupted-turn persistence for direct chat.
 *
 * Direct chat persists the conversation once, at the very end of a turn. When
 * the turn dies AFTER a side-effecting tool already ran (stream error, adapter
 * failure), that single save never happens: the DB keeps no trace of the tool
 * call, so on the next turn the model happily repeats it — e.g. creating the
 * same YouTrack issue twice.
 *
 * buildInterruptedTurnMessages assembles the user + assistant rows for that
 * failure path. The assistant `content` is deliberately model-facing: direct
 * chat feeds assistant content back into later turns (toolHistory is UI-only),
 * so the "already completed, do not repeat" note is what actually stops the
 * re-execution.
 */

const { isSideEffect } = require('../../../automation/sideEffectMap');

function _previewArgs(args) {
    try {
        const s = JSON.stringify(args || {});
        return s.length > 160 ? s.slice(0, 160) + '…' : s;
    } catch {
        return '{}';
    }
}

/**
 * @param {Object} params
 * @param {Array}  params.baseMessages - existing conversation messages (from DB); not mutated
 * @param {string} params.tokenizedMessage - the user's message (tokenized form, as persisted normally)
 * @param {Array}  [params.persistedAttachments] - attachment metadata for the user row
 * @param {Array}  params.toolHistory - collected tool calls: { name, args, status, resultPreview }
 * @param {string} params.errorNote - human-readable reason the turn was interrupted
 * @param {Function} [params.isSideEffect] - (toolName) => boolean; defaults to sideEffectMap
 * @returns {Array|null} full message list to persist, or null when nothing side-effecting ran
 */
function buildInterruptedTurnMessages({
    baseMessages,
    tokenizedMessage,
    persistedAttachments,
    toolHistory,
    errorNote,
    isSideEffect: isSideEffectFn = isSideEffect,
}) {
    const history = Array.isArray(toolHistory) ? toolHistory : [];
    const sideEffecting = history.filter(t => t && t.name && isSideEffectFn(t.name));
    if (sideEffecting.length === 0) return null;

    const timestamp = new Date().toISOString();

    const userSave = { role: 'user', content: tokenizedMessage, timestamp };
    if (Array.isArray(persistedAttachments) && persistedAttachments.length > 0) {
        userSave.attachments = persistedAttachments;
    }

    const lines = sideEffecting.map(t =>
        ` - ${t.name}(${_previewArgs(t.args)}) → ${String(t.resultPreview || t.status || 'done').slice(0, 200)}`
    );
    const assistantSave = {
        role: 'assistant',
        content:
            '[The response was interrupted by an error, but these actions had ALREADY completed and MUST NOT be repeated:\n' +
            lines.join('\n') +
            `\nError: ${errorNote || 'unknown error'}]`,
        timestamp,
        interrupted: true,
        toolHistory: history,
    };

    return [...(baseMessages || []), userSave, assistantSave];
}

module.exports = { buildInterruptedTurnMessages };
