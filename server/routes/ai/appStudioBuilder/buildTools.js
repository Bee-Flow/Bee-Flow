// @typecheck noImplicitAny
/**
 * App Studio Builder build loop: running one round's tool calls. Each call is
 * applied (the plan tool is the route's own), annotated, reported over SSE,
 * persisted after a mutation, and checked against the repeat ladder (rung 3
 * and 3b); after the round, the screenshots go to a vision model and a
 * mutated draft is validated. Split out of buildLoop.js; behaviour unchanged.
 *
 * `ctx` is the collaborators runBuildLoop was handed; `ls` the loop state.
 */

const crypto = require('crypto');
const { validateAppDefinition } = require('../../../appStudio/validate');
const { MUTATING_TOOLS, DATA_MODEL_TOOLS, applyToolCall, persistDraft } = require('../../../appStudio/builderTools');
const { mergePlanTodos, applyPlanMarkDone, planEcho } = require('../../../core/llm/planChecklist');
const { inferAppPlanProgress } = require('./planProgress');
const { toolCallEvent, labelForTool } = require('./toolCallEvents');
const { dataModelEvent } = require('./dataModelEvent');
const { parseToolArgs, renderValidationNote, truncateJson, RECOVERED_CALL_HINT, REPAIRED_CALL_HINT } = require('./turnLoop');
const log = require('../../../telemetry/log');

/**
 * @typedef {import('./turnClosing').BuilderTurn} BuilderTurn
 * @typedef {import('./buildRound').BuildCtx} BuildCtx
 * @typedef {import('./buildRound').LoopState} LoopState
 * @typedef {import('./buildRound').RepeatedStop} RepeatedStop
 * @typedef {NonNullable<import('./buildRound').RoundResponse['toolCalls']>[number] & { _recovered?: boolean, _recoveredFrom?: string }} RoundToolCall
 * @typedef {import('./toolCallEvents').ToolResult & {
 *   validation?: { ok?: boolean, errors?: unknown[], warnings?: unknown[] },
 *   plan?: unknown, presented?: boolean, _repeated?: number,
 *   alreadyAdded?: RepeatedStop['alreadyAdded'],
 *   _plan?: { markedDone: number[], next: string|null },
 * }} CallResult
 */

const TOOL_REFUSAL_STREAK_MAX = 4; // consecutive refusals of one tool that end the turn (rung 3b)

/**
 * The model's own to-do list (route-handled). The full-list form replaces it
 * and keeps the ticks the build already earned (2026-09-13: a verbatim
 * resend reset 0/6 twice); the cheap markDone form flips items. The echo
 * carries the LIST with indices: it is the model's only cross-round memory
 * of its plan.
 * @param {import('../../../appStudio/builderTools').ToolArgs} args
 * @param {BuildCtx} ctx
 * @returns {CallResult}
 */
function setPlan(args, ctx) {
    const { draftWrap, send } = ctx;
    if (Array.isArray(args.todos) && args.todos.length) {
        const merged = mergePlanTodos(draftWrap._todos || [], args.todos);
        draftWrap._todos = merged.todos;
        /** @type {CallResult} */
        const toolResult = planEcho(merged.todos);
        if (merged.unchanged) toolResult.note = 'Plan unchanged — these items were already recorded; done flags kept. Do not resend the plan; continue with `next`.';
        else send('plan', { todos: merged.todos });
        return toolResult;
    }
    const todos = applyPlanMarkDone(draftWrap._todos || [], args.markDone);
    draftWrap._todos = todos;
    send('plan', { todos });
    return planEcho(todos);
}

/**
 * The hints a recovered (written, not made) or repaired (cut-off) call carries in its result.
 * @param {RoundToolCall} tc
 * @param {CallResult} toolResult
 */
function addCallHints(tc, toolResult) {
    if (tc._recovered && toolResult && typeof toolResult === 'object') {
        // The model never made this call: it wrote it. Say so where it reads:
        // the result. (An error result keeps its own hint.)
        toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), RECOVERED_CALL_HINT];
    }
    if (tc._repaired && toolResult && typeof toolResult === 'object') {
        // The adapter closed a cut-off argument string after its last complete
        // entry (base.js). Without this the model reads a clean result and
        // assumes the tail landed too.
        toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), REPAIRED_CALL_HINT];
    }
}

/**
 * Tick the checklist from what the call DID. The small local models never
 * send markDone; the owner watched a finished app sit at 0/6. Additive only,
 * and `_plan` rides the result so the model reads its progress.
 * @param {string} name
 * @param {import('../../../appStudio/builderTools').ToolArgs} args
 * @param {CallResult} toolResult
 * @param {BuildCtx} ctx
 */
function tickPlanFromCall(name, args, toolResult, ctx) {
    const { draftWrap, send } = ctx;
    if (name === 'app_set_plan' || !Array.isArray(draftWrap._todos) || !draftWrap._todos.length) return;
    const ticked = inferAppPlanProgress(draftWrap._todos, { name, args, result: toolResult });
    if (!ticked.length) return;
    draftWrap._todos = applyPlanMarkDone(draftWrap._todos, ticked);
    send('plan', { todos: draftWrap._todos });
    if (toolResult && typeof toolResult === 'object') {
        toolResult._plan = { markedDone: ticked, next: (draftWrap._todos.find((t) => !t.done) || {}).text || null };
    }
}

/**
 * Persist + emit after a successful call, per tool; returns whether the draft mutated.
 * @param {BuilderTurn} turn
 * @param {string} name
 * @param {CallResult} toolResult
 * @param {BuildCtx} ctx
 * @returns {Promise<boolean>}
 */
async function afterSuccessfulCall(turn, name, toolResult, ctx) {
    const { send, sendError, draftWrap, approvedPlanForTurn, writeCheckpoint } = ctx;
    let mutated = false;
    // Persist + emit a draft snapshot after every successful mutation.
    if (MUTATING_TOOLS.has(name)) {
        const persisted = await persistDraft(draftWrap);
        if (persisted.error) {
            sendError('save_conflict', persisted.error);
            turn.persistBroken = true;
        } else {
            send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
            mutated = true;
        }
    }
    // Data mutations (tables/rows/roles/datasets, already persisted inside the
    // tool) also announce the new data shape so the editor invalidates its
    // table/dataset/role caches live.
    if (DATA_MODEL_TOOLS.has(name)) send('data_model', dataModelEvent(draftWrap));
    // Wave 5: phase marker → progress SSE + a revert checkpoint.
    if (name === 'app_mark_phase') {
        const total = (approvedPlanForTurn && Array.isArray(approvedPlanForTurn.phases))
            ? approvedPlanForTurn.phases.length : 0;
        turn.lastPhaseIndex = toolResult.index;
        send('phase', { index: toolResult.index, total, label: toolResult.label });
        await writeCheckpoint(`AI checkpoint — ${toolResult.label}`);
    }
    // Wave 5: app_apply_template persisted BOTH sides inside installTemplate;
    // reflect the fresh state to the client.
    if (name === 'app_apply_template') {
        send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
        send('data_model', dataModelEvent(draftWrap));
        mutated = true;
        turn.builtThisTurn = true;
    }
    return mutated;
}

/**
 * app_finalize: a finalized draft, or the validation that stopped it.
 * @param {BuilderTurn} turn
 * @param {boolean} ok
 * @param {CallResult} toolResult
 * @param {BuildCtx} ctx
 */
function reportFinalize(turn, ok, toolResult, ctx) {
    const { send, draftWrap } = ctx;
    if (ok && toolResult.finalized) {
        turn.lastFinalized = true;
        send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
    } else if (toolResult && toolResult.validation) {
        turn.lastValidation = toolResult.validation;
        send('validation_errors', { errors: toolResult.validation.errors, warnings: toolResult.validation.warnings });
    }
}

/**
 * Rung 3 of the repeat ladder: the same call refused three times. The model
 * does not read "stop retrying" (measured); the ROUTE ends the turn. Rung 3b
 * (2026-09-13): the same TOOL refused round after round with slightly
 * different arguments never trips the identical-resend count, so refusals
 * are also counted per tool name, reset by a success of that tool.
 * @param {string} name
 * @param {boolean} ok
 * @param {CallResult} toolResult
 * @param {LoopState} ls
 */
function trackRefusals(name, ok, toolResult, ls) {
    if (toolResult && typeof toolResult === 'object' && toolResult._repeated >= 3) {
        ls.repeatedStop = { name, error: String(toolResult.error || '').slice(0, 300), alreadyAdded: toolResult.alreadyAdded || null };
    }
    if (ok) {
        ls.toolRefusalStreak.delete(name);
        return;
    }
    const streak = (ls.toolRefusalStreak.get(name) || 0) + 1;
    ls.toolRefusalStreak.set(name, streak);
    if (streak >= TOOL_REFUSAL_STREAK_MAX && !ls.repeatedStop) {
        log.warn(`[AppStudioBuilder] ${name} refused ${streak} times in a row this turn — ending the turn`);
        ls.repeatedStop = { name, error: String(toolResult && toolResult.error || '').slice(0, 300), alreadyAdded: null, streak };
    }
}

/**
 * app_screenshot: the PNG must never enter the tool message (the base64
 * would blow the prompt and non-Claude providers reject non-string tool
 * content). The user ALWAYS gets it as an SSE image event; the model gets it
 * as a user image message after this round, and only when it can see.
 * Returns the tool message content to use instead, or null.
 * @param {string} name
 * @param {CallResult} toolResult
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 * @returns {string|null}
 */
function screenshotContent(name, toolResult, ctx, ls) {
    if (!(name === 'app_screenshot' && toolResult && typeof toolResult === 'object')) return null;
    if (toolResult._screenshotDataUrl) {
        const m = /^data:([^;]+);base64,(.+)$/s.exec(toolResult._screenshotDataUrl);
        if (m) ctx.send('image', { data: m[2], mimeType: m[1], caption: toolResult._screenshotCaption || 'Screenshot' });
        if (ctx.modelSupportsVision) ls.pendingVisionImages.push(toolResult._screenshotDataUrl);
    }
    return String(toolResult.content || 'Screenshot captured.');
}

/**
 * Run one tool call of the round; returns whether the draft mutated.
 * @param {BuilderTurn} turn
 * @param {RoundToolCall} tc
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 * @returns {Promise<boolean>}
 */
async function runToolCall(turn, tc, ctx, ls) {
    const { send, draftWrap, messages } = ctx;
    turn.toolCallCount += 1;
    const name = tc.function.name;
    const { args, truncated } = parseToolArgs(tc.function.arguments, name);
    /** @type {CallResult} */
    let toolResult;
    if (truncated) {
        toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.` };
        ls.escalateNextRound = true;
    } else if (name === 'app_set_plan') {
        toolResult = setPlan(args, ctx);
    } else {
        toolResult = await applyToolCall(name, args, draftWrap);
    }
    addCallHints(tc, toolResult);
    const ok = !(toolResult && typeof toolResult === 'object' && toolResult.error);
    if (ok) tickPlanFromCall(name, args, toolResult, ctx);
    if (ok && (MUTATING_TOOLS.has(name) || DATA_MODEL_TOOLS.has(name))) { turn.mutatingToolCalls += 1; turn.builtThisTurn = true; }

    // Wave 5: app_propose_plan is a read tool the ROUTE finishes. Capture the
    // bounded plan, mint a planId, and END the turn after this round. The
    // model only ever sees the acknowledgement: the echoed plan is stripped.
    if (ok && name === 'app_propose_plan' && toolResult && toolResult.plan) {
        const planId = `plan_${crypto.randomBytes(3).toString('hex')}`;
        turn.proposedPlan = { planId, plan: toolResult.plan };
        toolResult = { presented: true, planId };
    }

    send('tool_call', { ...toolCallEvent(name, args, toolResult, ok, draftWrap), ...(tc._recovered ? { recovered: tc._recoveredFrom || true } : {}) });
    // app_finalize is neither a phase marker nor a template, so its report
    // still follows its own snapshot and data model event, as before.
    const mutated = ok ? await afterSuccessfulCall(turn, name, toolResult, ctx) : false;
    if (name === 'app_finalize') reportFinalize(turn, ok, toolResult, ctx);
    if (!ok) ls.escalateNextRound = true;
    trackRefusals(name, ok, toolResult, ls);

    const toolContent = screenshotContent(name, toolResult, ctx, ls);
    messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolContent ?? (typeof toolResult === 'string' ? toolResult : truncateJson(toolResult)),
    });
    return mutated;
}

/**
 * Run the round's tool calls in order; returns whether the draft mutated. Stops at a broken save.
 * @param {BuilderTurn} turn
 * @param {RoundToolCall[]} toolCalls
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 */
async function runRoundTools(turn, toolCalls, ctx, ls) {
    let mutatedThisIter = false;
    for (const tc of toolCalls) {
        if (await runToolCall(turn, tc, ctx, ls)) mutatedThisIter = true;
        if (turn.persistBroken) break;
    }
    return mutatedThisIter;
}

/**
 * What the user reads when the repeat ladder ends the turn. Two wordings: a
 * change the builder REFUSED three times, and (2026-09-13) a batch the model
 * kept resending after it had landed: those components exist once, and
 * saying "refused" about them would be false.
 * @param {RepeatedStop} repeatedStop
 */
function repeatedStopMessage(repeatedStop) {
    const dup = repeatedStop.alreadyAdded;
    if (dup) {
        return `I added those components once and was then asked to add them again three times — they are in the app once (${(dup.added || []).slice(0, 8).map((a) => `${a.type} ${a.id}`).join(', ')}${(dup.added || []).length > 8 ? ', …' : ''}). Everything built so far is saved. Tell me what should come next — for example the action that saves the form, or another screen.`;
    }
    return repeatedStop.streak
        ? `I tried ${labelForTool(repeatedStop.name)} ${repeatedStop.streak} times in a row and the builder refused each one (last reason: ${repeatedStop.error}). Everything built so far is saved. Tell me how you want to proceed — for example a different table, column or screen.`
        : `I tried the same change three times and the builder refused it each time (${labelForTool(repeatedStop.name)}: ${repeatedStop.error}). Everything built so far is saved. Tell me how you want to proceed — for example a different table, column or screen.`;
}

/**
 * Hand this round's screenshots to the (vision-capable) model as a user
 * message so it can actually SEE the screen and iterate. The array-content
 * message never reaches the persisted history: sanitizeHistory keeps string
 * content only.
 * @param {BuildCtx['messages']} messages
 * @param {LoopState} ls
 */
function flushVisionImages(messages, ls) {
    if (!ls.pendingVisionImages.length) return;
    messages.push({
        role: 'user',
        content: [
            ...ls.pendingVisionImages.map((url) => ({ type: 'image_url', image_url: { url } })),
            { type: 'text', text: '[SCREENSHOT — machine-generated] Above is the screenshot you just captured with app_screenshot. Inspect it — wrapped or overflowing rows, empty regions, charts without data, clipped text, cramped spacing — and fix what is wrong before finalizing.' },
        ],
    });
    ls.pendingVisionImages.length = 0;
}

/**
 * Validation feedback loop: after any mutation, validate the draft, surface
 * the records to the client, and feed errors back to the model as a clearly
 * framed role:'user' report (NOT role:'system': system messages get hoisted
 * or concatenated by the Claude/Gemini adapters and would invalidate the
 * prompt cache mid-turn).
 * @param {BuilderTurn} turn
 * @param {BuildCtx} ctx
 * @param {LoopState} ls
 */
function validateAfterMutation(turn, ctx, ls) {
    const { draftWrap, send, messages } = ctx;
    turn.lastValidation = validateAppDefinition(draftWrap.def, {
        dataModel: draftWrap.dataModel,
        datasets: draftWrap.datasetIds,
        datatables: draftWrap._ownerDatatables,
    });
    send('validation_errors', { errors: turn.lastValidation.errors, warnings: turn.lastValidation.warnings });
    if (turn.lastValidation.errors.length) {
        messages.push({ role: 'user', content: renderValidationNote(turn.lastValidation) });
        ls.escalateNextRound = true;
    }
}

module.exports = { TOOL_REFUSAL_STREAK_MAX, runRoundTools, repeatedStopMessage, flushVisionImages, validateAfterMutation };
