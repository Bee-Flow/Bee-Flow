// @typecheck
/**
 * Automation Builder — a round that ended without a tool call: a truncated
 * reply, unparseable arguments, a blank reply, prose on an empty draft, a
 * plan turn without a plan, an approved build with open steps. Each gets at
 * most one nudge (or its own bound); anything else is the model's final
 * message. Moved verbatim from ./chatStream.js; answers 'continue' (another
 * round) or 'break' (the turn's rounds are over).
 */

const log = require('../../../telemetry/log');
const { isTruncatedStop, truncationRetryMessages, emptyReplyRetryMessages, isBlankReply } = require('./chatTurnLoop');

// Repair rounds spent on unparseable tool arguments. Bounded: a model
// that cannot write valid JSON twice will not manage it on the tenth
// try, and each attempt costs a full round on a single-slot box.
const INVALID_ARGS_MAX_RETRIES = 2;

function afterToolLessRound(turn, loop, { iter, response, thinkingForReplay, recoveredRound }) {
    const { send, messages, draftWrap, turnMode, approvedPlan, answerTurn, profile } = turn;
    // No tool calls. Either the assistant produced its final message —
    // or it was cut off at max_tokens before getting to a tool call,
    // which on a thinking model means reasoning that never converged
    // (four such rounds in one evening on the demo box, 8192 tokens of
    // <think> each). The two look identical without the stop reason;
    // with it, retry ONCE — same effort level, see turnEffort above,
    // with a note telling the model to answer with the tool call
    // directly — instead of ending the turn in silence, and tell the
    // user plainly if that fails too.
    if (isTruncatedStop(response.finishReason)) {
        if (loop.truncationRetries < 1) {
            loop.truncationRetries++;
            messages.push(...truncationRetryMessages(response.content, thinkingForReplay));
            log.warn(`[AutomationBuilder] round ${iter} hit max_tokens with no tool call (stop=${response.finishReason}); retrying once with a direct-answer note`);
            return 'continue';
        }
        send('error', { error: 'The model ran out of room while reasoning and never got to building. Switch the builder to a tier with thinking off, or shorten the request.', transient: false });
        return 'break';
    }
    // A call the model DID make but wrote with broken JSON arguments.
    // The adapter cannot hand it up (base.js: echoing a half-written
    // call back is a 400 or a spin loop), so the round arrives looking
    // empty. Naming the tool and asking for that one call again is a
    // repair the model can actually perform — the blank-reply nudge
    // below is not, because it does not know what went wrong.
    if (!response.toolCalls && Array.isArray(response.invalidToolCalls) && response.invalidToolCalls.length
        && loop.invalidArgsRetries < INVALID_ARGS_MAX_RETRIES) {
        loop.invalidArgsRetries++;
        const names = response.invalidToolCalls.map(c => c.name).filter(Boolean);
        const label = names.length ? names.join(', ') : 'a tool';
        log.warn(`[AutomationBuilder] round ${iter}: ${response.invalidToolCalls.length} call(s) had unparseable arguments (${label}) — asking for a resend`);
        messages.push({
            role: 'user',
            content: `[Instructions from the system — not written by the user]\nYour arguments for ${label} were not valid JSON, so the call could not be run. Send just THAT call again, with complete, valid JSON arguments and nothing else. Keep it small: if the call was long, split it into two smaller calls.`,
        });
        return 'continue';
    }
    // Neither a tool call nor a word for the user is not "done" either:
    // it is the round above with a call the server could NOT parse (an
    // unknown name, broken arguments), or a model that simply stopped.
    // Nudge once, naming what was seen; the second time tell the user
    // plainly instead of ending on a silent `done`.
    const emptyReply = isBlankReply(response.content);
    const rejectedLeaks = recoveredRound ? recoveredRound.rejected : [];
    // The plan nudge on a turn where the user only asked something: the
    // answer was already given, an empty reply to the nudge is the model
    // agreeing. It is not "stopped twice".
    if (emptyReply && loop.planGuardUsed && !answerTurn && !turn.planWritten && !rejectedLeaks.length) return 'break';
    if (emptyReply || rejectedLeaks.length) {
        if (loop.emptyReplyRetries < 1) {
            loop.emptyReplyRetries++;
            log.warn(`[AutomationBuilder] round ${iter} produced no tool call and no text${rejectedLeaks.length ? ` (${rejectedLeaks.length} call(s) written as text could not be recovered: ${rejectedLeaks.map(r => `${r.name || '?'}:${r.reason}`).join(', ')})` : ''} — nudging once`);
            messages.push(...emptyReplyRetryMessages(response.content, thinkingForReplay, rejectedLeaks));
            return 'continue';
        }
        send('error', { error: 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch the builder to another tier.', transient: false });
        return 'break';
    }
    // Prose while the draft is still empty is not "done" — it is the
    // model talking about the build instead of doing it. Pin the next
    // round to a tool call once; if it talks again, let it through so a
    // genuine question or refusal can still reach the user.
    const draftHasSteps = Array.isArray(draftWrap?.def?.steps) && draftWrap.def.steps.length > 0;
    if (turnMode !== 'discuss' && turnMode !== 'plan' && !loop.prosePinUsed && profile.forceFirstToolCall && !draftHasSteps) {
        loop.prosePinUsed = true;
        loop.repinToolChoice = true;
        log.warn(`[AutomationBuilder] round ${iter} answered in prose with an empty draft — pinning one round to a tool call`);
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
            role: 'user',
            content: '[Instructions from the system — not written by the user]\nNothing has been built yet. Make the next change by CALLING A TOOL now — do not describe it.',
        });
        return 'continue';
    }
    // A plan turn ends in a plan or in questions, never in prose about
    // a plan (RC3: the user was left with nothing to approve). One nudge
    // with the tool list unchanged, so the prompt cache holds. A forced
    // tool choice only where it is safe: after the user's answers, on a
    // model without extended thinking (forceFirstToolCall).
    if (turnMode === 'plan' && !turn.planWritten && !loop.planGuardUsed) {
        loop.planGuardUsed = true;
        loop.repinToolChoice = answerTurn && !!profile.forceFirstToolCall;
        log.warn(`[AutomationBuilder] round ${iter} ended a plan turn in prose without a plan — nudging once${answerTurn ? ' (answer turn)' : ''}`);
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
            role: 'user',
            content: answerTurn
                ? '[Instructions from the system — not written by the user]\nThe user answered your questions. End this turn by CALLING builder_write_plan now; put anything still open under assumptions.'
                : '[Instructions from the system — not written by the user]\nPlan first: if the user asked for a change or a new automation, end this turn by calling builder_write_plan. If they only asked a question, your answer is complete: reply with nothing more.',
        });
        return 'continue';
    }
    // An approved build is finished when its checklist is. A model that
    // stops with items open (the owner's "I can't remove steps") gets one
    // push to finish them, mark them done, or say what blocks it.
    if (approvedPlan && !loop.buildGuardUsed && !turn.lastFinalized && (draftWrap._todos || []).some(t => !t.done)) {
        loop.buildGuardUsed = true;
        const open = draftWrap._todos.map((t, i) => (t.done ? null : `${i}) ${t.text}`)).filter(Boolean).join('; ');
        log.warn(`[AutomationBuilder] round ${iter} ended an approved build with open plan steps — nudging once`);
        messages.push({ role: 'assistant', content: response.content });
        messages.push({
            role: 'user',
            content: `[Instructions from the system — not written by the user]\nThe user approved the plan, so building it is your job now. These steps are still open: ${open}. Do them with the build tools, or, if they are already done, mark them with builder_set_plan({markDone:[indices]}). If something blocks you, say exactly what and stop.`,
        });
        return 'continue';
    }
    // Assistant produced a final message; we're done with this turn.
    return 'break';
}

module.exports = { afterToolLessRound, INVALID_ARGS_MAX_RETRIES };
