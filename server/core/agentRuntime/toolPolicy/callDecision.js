/**
 * ONE CALL AT A TIME: the verdict a policy yields for a single tool name, the
 * bounded argument preview the confirm card shows, and whether anybody is
 * there to answer it.
 *
 * Pure and total, all three — they run inside a dispatch path, where an
 * exception takes the whole turn down.
 */

'use strict';

const { effectOf } = require('../../../automation/sideEffectMap');
const { _plainObject } = require('./configShape');

/**
 * What should happen to ONE tool call? Pure, total, and free of the runtime —
 * hand it a policy and a name and it answers, which is what makes every branch
 * testable without a chat turn.
 *
 *   'refuse'  the name was never offered this round. Nothing runs. This is the
 *             gate against a hallucinated or prompt-injected name reaching the
 *             dispatcher's dynamic-name fallback.
 *   'confirm' the call is held back for a person to approve.
 *   'run'     dispatch as normal.
 *
 * ── THE NAME GATE IS OPT-IN TOO ─────────────────────────────────────
 * It shipped global, and that was a behaviour change nobody asked for: before
 * the grants layer, a name outside the offered stack went to the dispatcher,
 * which resolves it against the caller's agent-callable automations and Steps,
 * answers a progressive-disclosure name with a "load that group first" hint,
 * and otherwise tries a component tool. Refusing all of that for EVERY agent
 * changed what a legacy agent does without adding a field anyone could set —
 * the one thing this whole layer promised not to do.
 *
 * So `enforceNames` follows the same fence as the hold-back: an agent with
 * stored grants (or an automation carrying its own confirm) refuses an unoffered
 * name; an agent without one gets `not_offered_unenforced` — a 'run' the
 * caller logs, so the injection case is still visible in the logs, just not
 * silently behaviour-changed. Curating an agent is what closes the stack.
 *
 * A MISSING policy means "this call site does not enforce" and yields 'run'.
 * That is not a grant decision going fail-open: an unreadable or unknown grant
 * still lands on 'refuse'/'confirm' inside `buildToolPolicy`, which fails
 * closed by construction. It is the older, un-instrumented call sites (the
 * non-streaming chat path) keeping the behaviour they have — the streaming
 * runtime always passes one, and falls back to a bare name whitelist rather
 * than to nothing if building it ever throws.
 */
function decideToolCall({ toolName, policy }) {
    const allowed = policy && policy.allowedToolNames;
    if (!(allowed instanceof Set)) {
        return { action: 'run', reason: 'no_policy', effect: null, confirm: 'direct' };
    }
    if (typeof toolName !== 'string' || !toolName) {
        return { action: 'refuse', reason: 'unnameable', effect: 'writes', confirm: 'ask' };
    }
    const effect = (policy.effectByTool instanceof Map && policy.effectByTool.get(toolName))
        || effectOf(toolName);
    if (!allowed.has(toolName)) {
        if (policy.enforceNames === false) {
            return { action: 'run', reason: 'not_offered_unenforced', effect, confirm: 'direct' };
        }
        return { action: 'refuse', reason: 'not_offered', effect, confirm: 'ask' };
    }
    const confirm = (policy.confirmByTool instanceof Map && policy.confirmByTool.get(toolName)) || 'direct';
    if (policy.gatedTools instanceof Set && policy.gatedTools.has(toolName)) {
        return { action: 'confirm', reason: 'confirm_required', effect, confirm: 'ask' };
    }
    return { action: 'run', reason: 'allowed', effect, confirm };
}

// Preview bounds — this travels over SSE to a card, not to a log file.
const PREVIEW_MAX_KEYS = 20;
const PREVIEW_MAX_STRING = 500;

/**
 * A small, flat, bounded rendering of a call's arguments for the confirm card.
 *
 * Deliberately shallow: the card shows "what is about to happen", and a nested
 * blob neither reads well nor bounds cheaply. Nested values become a type
 * label rather than being dropped, so a person can still tell that an argument
 * was supplied. Never throws — a preview that fails would take the turn with
 * it, and the confirmation is the safe half.
 */
function previewToolArgs(args) {
    const out = {};
    if (!_plainObject(args)) return out;
    let n = 0;
    for (const [k, v] of Object.entries(args)) {
        if (n >= PREVIEW_MAX_KEYS) { out['…'] = `${Object.keys(args).length - n} more`; break; }
        n++;
        if (typeof v === 'string') {
            out[k] = v.length > PREVIEW_MAX_STRING ? v.slice(0, PREVIEW_MAX_STRING) + '…' : v;
        } else if (v === null || ['number', 'boolean'].includes(typeof v)) {
            out[k] = v;
        } else if (Array.isArray(v)) {
            out[k] = `[${v.length} item${v.length === 1 ? '' : 's'}]`;
        } else if (typeof v === 'object') {
            out[k] = '{…}';
        }
    }
    return out;
}

/** Is this run headless? The existing marker, not a new env flag. */
function isUnattended(messageMetadata) {
    if (!messageMetadata || typeof messageMetadata !== 'object') return false;
    return messageMetadata.autoSend === true || messageMetadata.unattended === true;
}

module.exports = {
    decideToolCall, previewToolArgs, isUnattended,
    PREVIEW_MAX_KEYS, PREVIEW_MAX_STRING,
};
