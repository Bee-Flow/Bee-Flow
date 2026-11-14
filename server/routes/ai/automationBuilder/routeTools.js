// @typecheck strict
/**
 * Automation Builder — the tool calls the route answers itself, before the
 * builder dispatch: a call behind a stop, unparseable arguments, the pause
 * and work-mode gates, a removal the approved plan does not name, the
 * question card, the inspection reads, web research, the plan, the
 * checklist and flowlet delegation. ROUTE_ANSWERS holds them in the order
 * they are tried; the first that answers ends the call.
 */

const automationStore = require('../../../stores/automationStore');
const { truncateToolResultJson } = require('../../../automation/builderTools');
const { persistDraftWrap } = require('../../../usecases/ai/automationBuilder/builderDraft');
const { runDelegationTool } = require('../../../usecases/ai/automationBuilder/layerDelegation');
const { INSPECTION_NAMES, inspect } = require('../../../usecases/ai/automationBuilder/inspectionTools');
const { runWebResearchTool, isWebResearchTool } = require('../../../usecases/ai/automationBuilder/webResearch');
const { MAX_QUESTIONS, isBlankDraft, writeQuestions, toolAllowed, previewRefusal, planCoversRemoval, resolveRemovalTarget, writePlan, markStagedView } = require('../../../usecases/ai/automationBuilder/workMode');
const { proposalPreviewPayload } = require('../../../usecases/ai/automationBuilder/proposalPayload');
const { applyPlanMarkDone, normalizePlanTodos } = require('../../../usecases/ai/automationBuilder/chatTurnLoop');
const { rejectedCallLabel } = require('../../../usecases/ai/automationBuilder/turnStop');
const { askFirstRefusal, questionLimit } = require('../../../usecases/ai/automationBuilder/modeRules.mts');
const { briefGaps, briefText } = require('../../../usecases/ai/automationBuilder/briefGaps.mts');

// The turns whose plan on a new automation was already sent back once to ask
// first: the nudge happens once, the model's second plan stands.
/** @type {WeakSet<object>} */
const askedFirst = new WeakSet();

/**
 * @typedef {import('./turnSetup').BuilderTurn} BuilderTurn
 * @typedef {import('./turnSetup').BuilderRound} BuilderRound
 * @typedef {import('./turnSetup').BuilderToolCall} BuilderToolCall
 * @typedef {ReturnType<typeof import('../../../usecases/ai/automationBuilder/chatTurnLoop').parseToolArgs>['args']} ToolArgs
 * @typedef {{ error?: string, _fixHint?: string, _draftSteps?: unknown, steps?: unknown[], failedIndex?: number, [k: string]: unknown }} RouteToolResult
 * @typedef {{ tc: BuilderToolCall, name: string, args: ToolArgs, truncated: boolean }} RouteCall
 * One answer of the route: true when it answered the call (its event is sent
 * and its tool message pushed), false when the call is not its to answer.
 * @typedef {(turn: BuilderTurn, round: BuilderRound, call: RouteCall) => boolean | Promise<boolean>} RouteAnswer
 */

/**
 * The `tool_call` event and the tool message of an answered call: every call
 * gets its tool message, so the assistant turn stays well-formed in the
 * stored session.
 * @param {BuilderTurn} turn
 * @param {RouteCall} call
 * @param {RouteToolResult} toolResult
 */
function answer(turn, call, toolResult) {
    turn.send('tool_call', { name: call.name, arguments: call.args, result: toolResult });
    turn.messages.push({ role: 'tool', tool_call_id: call.tc.id, content: JSON.stringify(toolResult) });
    return true;
}

/**
 * The turn is over: the calls after the stop are not run (a finalize in the
 * same reply would save a draft the model was still fighting with).
 * @type {RouteAnswer}
 */
function afterStop(turn, round, call) {
    if (!round.stopHit) return false;
    return answer(turn, call, {
        error: `Not run: the build stopped before this call (${round.stopHit.reason}).`,
        _fixHint: 'Reject reason: the build was stopped after a repeated rejection, so this call was not executed. Wait for the user.',
        _skipped: true,
    });
}

/**
 * Arguments that did not parse as JSON, almost always a mid-call truncation.
 * Running the tool with empty arguments yields a confusing generic error and
 * a blind retry; the model is told what happened so it resends this one call.
 * @type {RouteAnswer}
 */
function truncatedArguments(turn, round, call) {
    if (!call.truncated) return false;
    const { name } = call;
    const error = `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.`;
    answer(turn, { ...call, args: {} }, { error, _truncated: true });
    round.refusedThisIter = true;
    round.lastRefusal = { tool: name, error, label: name };
    return true;
}

/**
 * Pause after each step: one step change per turn, no batches, no run actions.
 * @param {BuilderTurn} turn
 * @param {RouteCall} call
 */
function pausesCall(turn, { name, args }) {
    if (turn.pausedAfterStep || (turn.bufferedBuild && name === 'builder_remove_step')) return true;
    if (!(turn.approvedPlan && turn.pauseAfterStep)) return false;
    return (name === 'builder_add_steps' && args.steps?.length > 1) || name === 'builder_generate_layer' || name === 'builder_generate_layers' || name === 'builder_request_dry_run';
}

/** @type {RouteAnswer} */
function pauseGate(turn, _round, call) {
    if (!pausesCall(turn, call)) return false;
    return answer(turn, call, { error: 'Pause after each step is enabled. Make one step change, then wait for the user to continue. Batch changes and run actions need a separate turn.' });
}

/** A tool the work mode does not allow. @type {RouteAnswer} */
function workModeGate(turn, round, call) {
    const { req, permissionMode, planAllowsRemoval, turnMode } = turn;
    if (!req.body.workMode || toolAllowed(call.name, permissionMode, { planAllowsRemoval })) return false;
    round.refusedThisIter = true;
    return answer(turn, call, { error: previewRefusal(call.name, turnMode) });
}

/**
 * An approved plan lets the build turn remove the steps IT names and no
 * others: the plan line must say remove and name the step. The step is
 * looked up in the graph the call changes (its scope), and one that is not
 * found there is refused, never waved through: the check must not depend on
 * the tool failing on its own.
 * @type {RouteAnswer}
 */
function unplannedRemoval(turn, round, call) {
    const { args } = call;
    if (!turn.planAllowsRemoval || call.name !== 'builder_remove_step') return false;
    const target = resolveRemovalTarget(turn.draftWrap.def, args);
    if (target && planCoversRemoval(turn.approvedPlan, target)) return false;
    round.refusedThisIter = true;
    return answer(turn, call, { error: target
        ? `The approved plan does not name "${target.label || target.id}" for removal, so it is not removed. Removing a step the plan does not name needs a separate human-approved proposal.`
        : `Unknown stepId "${args?.stepId}"${args?.scope ? ` in flowlet "${args.scope}"` : ''}. Nothing was removed; read the draft for the existing step ids.` });
}

/**
 * The plan is written: the user decides now. Whatever else the reply held
 * (a checklist, a summary, more questions) is not run.
 * @type {RouteAnswer}
 */
function afterPlanWritten(turn, _round, call) {
    if (!turn.planWritten) return false;
    return answer(turn, call, { error: 'The plan is written and waits for the user. Stop here.' });
}

/**
 * The question card. One round per plan: after it only a table choice may
 * still be asked (consent, not clarification).
 * @type {RouteAnswer}
 */
function askQuestions(turn, round, call) {
    const { req, send, draftWrap, approvedPlan, turnMode, questionsClosed } = turn;
    const { args } = call;
    if (!req.body.workMode || call.name !== 'builder_ask_questions') return false;
    const asksTable = Array.isArray(args?.questions) && args.questions.some((/** @type {{ datatableIds?: unknown }} */ q) => q && Array.isArray(q.datatableIds) && q.datatableIds.length);
    if (questionsClosed && !asksTable) {
        round.refusedThisIter = true;
        return answer(turn, call, { error: 'You already asked your questions for this plan and the user answered. Do not ask again: call builder_write_plan now and list what is still open under assumptions.' });
    }
    const limit = questionLimit(turnMode, approvedPlan, MAX_QUESTIONS, req.body.workMode);
    const written = writeQuestions(args, { datatables: draftWrap._datatables, max: limit });
    turn.reviewQuestions = written ? written.questions : null;
    /** @type {RouteToolResult} */
    const toolResult = written
        ? { ok: true, awaitingAnswers: true, ...(written.dropped ? { _note: `${written.dropped} question(s) were not shown (limit ${limit}). Put what they would have settled under assumptions.` } : {}) }
        : { error: `Provide 1–${limit} questions, each with 2–4 short answers (a table question: datatableIds from the Datatables block, plus createLabel).` };
    if (turn.reviewQuestions) send('review_questions', { questions: turn.reviewQuestions.map(({ choice, ...q }) => q), planId: approvedPlan?.id || null });
    answer(turn, call, toolResult);
    round.acceptedThisIter = !!turn.reviewQuestions;
    return true;
}

/** The card is out: nothing else runs until the user answers. @type {RouteAnswer} */
function awaitingAnswers(turn, _round, call) {
    if (!turn.reviewQuestions) return false;
    return answer(turn, call, { error: 'Wait for the user to answer the questions before continuing.' });
}

/** The inspection reads of a work mode. @type {RouteAnswer} */
async function inspection(turn, round, call) {
    const { req, send, messages, draftWrap, isolated, baseDraft } = turn;
    const { name, args } = call;
    if (!req.body.workMode || !INSPECTION_NAMES.has(name)) return false;
    /** @type {RouteToolResult} */
    let toolResult;
    try { toolResult = await inspect(name, args, draftWrap, { store: automationStore, pii: require('../../../core/privacy/piiDetection') }); }
    catch (e) { toolResult = { error: /** @type {Error} */ (e).message }; }
    markStagedView(toolResult, isolated && JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def));
    send('tool_call', { name, arguments: args, result: toolResult });
    messages.push({ role: 'tool', tool_call_id: call.tc.id, content: truncateToolResultJson(toolResult) });
    round.acceptedThisIter = !toolResult.error;
    return true;
}

/**
 * Web research. A web page is outside data: the shield's block lists strip
 * what this tool class may not carry from the model's copy.
 * @type {RouteAnswer}
 */
async function webResearchCall(turn, round, call) {
    const { userId, send, messages, draftWrap, userOrgForTiers, modelId, webResearch, webpageToolGate } = turn;
    const { name, args } = call;
    if (!webResearch.offered || !isWebResearchTool(name)) return false;
    const out = await runWebResearchTool(name, args, {
        research: webResearch, gate: webpageToolGate,
        ids: { userId, orgId: userOrgForTiers, automationId: draftWrap.automationId || null, modelId: modelId || null },
    });
    const toolResult = /** @type {RouteToolResult} */ (out.result);
    send('tool_call', { name, arguments: args, result: toolResult });
    messages.push({
        role: 'tool',
        tool_call_id: call.tc.id,
        content: out.modelText != null ? await webpageToolGate.forModel(out.modelText, name) : JSON.stringify(toolResult),
    });
    if (toolResult.error) { round.refusedThisIter = true; round.lastRefusal = { tool: name, error: String(toolResult.error), label: name }; }
    else round.acceptedThisIter = true;
    return true;
}

/**
 * Plan first (and Describe it, which runs as 'plan': modeRules turnModeOf)
 * on a new automation: a plan from a brief that does not say where the data
 * comes from, where it goes or who is involved goes back once with "ask
 * first" (modeRules ASK_FIRST_RULE says the same up front).
 * @type {RouteAnswer}
 */
function askFirst(turn, round, call) {
    if (call.name !== 'builder_write_plan' || turn.turnMode !== 'plan') return false;
    if (turn.questionsClosed || askedFirst.has(turn) || !isBlankDraft(turn.baseDraft)) return false;
    const gaps = briefGaps(briefText(turn.message, turn.history));
    if (!gaps.length) return false;
    askedFirst.add(turn);
    round.refusedThisIter = true;
    return answer(turn, call, { error: askFirstRefusal(gaps) });
}

/**
 * The plan of a planning turn. It ends the cycle and the turn; a checklist
 * from before it would sit beside the Build button.
 * @type {RouteAnswer}
 */
function writeReviewPlan(turn, round, call) {
    const { send, draftWrap, baseDraft } = turn;
    if (call.name !== 'builder_write_plan' || turn.turnMode !== 'plan') return false;
    const nextPlan = writePlan(call.args, turn.reviewPlan, { datatables: draftWrap._datatables });
    if (nextPlan) {
        turn.reviewPlan = { ...nextPlan, baseDefinition: structuredClone(baseDraft) };
        send('review_plan', { plan: turn.reviewPlan });
        turn.planWritten = true;
        turn.planCycleRound = 0;
        draftWrap._todos = [];
        send('plan', { todos: [] });
    }
    answer(turn, call, nextPlan ? { ok: true, planId: nextPlan.id, awaitingApproval: true } : { error: 'Provide a title, goal and non-empty list of step descriptions.' });
    round.acceptedThisIter = !!nextPlan;
    return true;
}

/**
 * Self-planning: records the agent's to-do list and shows it to the user.
 * The full-list form replaces the plan; the `markDone` diff form flips
 * existing items, so a progress update does not resend the whole list. In an
 * approved build the list IS the plan's steps: a model that rewrites it
 * would lose the plan the user approved.
 * @type {RouteAnswer}
 */
function setPlan(turn, round, call) {
    const { draftWrap, approvedPlan } = turn;
    const { args } = call;
    if (call.name !== 'builder_set_plan') return false;
    const replacing = Array.isArray(args.todos) && args.todos.length;
    const todos = (replacing && !approvedPlan)
        ? normalizePlanTodos(args.todos)
        : applyPlanMarkDone(draftWrap._todos || [], args.markDone);
    draftWrap._todos = todos;
    // The result echoes the LIST, not a count: it is the model's only
    // cross-round memory of its own plan. `i` is load-bearing: markDone
    // takes 0-based indices.
    const planResult = {
        ok: true,
        todos: todos.map((t, i) => ({ i, text: t.text, done: !!t.done })),
        next: (todos.find(t => !t.done) || {}).text || null,
        ...(replacing && approvedPlan ? { _note: 'The checklist is the approved plan; only markDone is applied.' } : {}),
    };
    turn.send('plan', { todos });
    answer(turn, call, planResult);
    round.acceptedThisIter = true;
    return true;
}

/**
 * Flowlet delegation: one or several thinking-model sub-agents build whole
 * flowlets, merged into the draft; the draft is persisted and sent (or the
 * proposal refreshed), and the post-loop validator feeds errors back.
 * @type {RouteAnswer}
 */
async function delegation(turn, round, call) {
    const { req, userId, send, messages, draftWrap, userOrgForTiers, bufferedBuild, isolated, baseDraft, catalog, thinkingModelId } = turn;
    const { name, args } = call;
    if (name !== 'builder_generate_layer' && name !== 'builder_generate_layers') return false;
    /** @type {RouteToolResult} */
    let toolResult;
    try {
        toolResult = await runDelegationTool(name, args, {
            draftWrap, thinkingModelId, userId,
            userOrgId: userOrgForTiers, session: req.session,
            catalog, send,
        });
    } catch (e) { toolResult = { error: /** @type {Error} */ (e).message }; }
    send('tool_call', { name, arguments: args, result: toolResult });
    if (!isolated) {
        await persistDraftWrap(draftWrap);
        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
    }
    else if (!bufferedBuild) send('proposal_preview', proposalPreviewPayload(draftWrap, baseDraft));
    round.mutatedThisIter = true; // post-loop validation feedback runs
    messages.push({ role: 'tool', tool_call_id: call.tc.id, content: typeof toolResult === 'string' ? toolResult : truncateToolResultJson(toolResult) });
    if (toolResult && typeof toolResult === 'object' && toolResult.error) {
        round.refusedThisIter = true;
        round.lastRefusal = { tool: name, error: String(toolResult.error), label: rejectedCallLabel(name, args, toolResult) };
    } else {
        round.acceptedThisIter = true;
    }
    return true;
}

/** In the order they are tried. @type {RouteAnswer[]} */
const ROUTE_ANSWERS = [
    afterStop, truncatedArguments, pauseGate, workModeGate, unplannedRemoval, afterPlanWritten, askQuestions,
    awaitingAnswers, inspection, webResearchCall, askFirst, writeReviewPlan, setPlan, delegation,
];

/**
 * Answer one tool call the route handles itself. True when it did (the call
 * is done: its event is sent and its tool message pushed), false when the
 * call goes on to the builder dispatch.
 * @param {BuilderTurn} turn
 * @param {BuilderRound} round
 * @param {BuilderToolCall} tc
 * @param {string} name
 * @param {ToolArgs} args
 * @param {boolean} truncated
 */
async function handleRouteTool(turn, round, tc, name, args, truncated) {
    const call = { tc, name, args, truncated };
    for (const routeAnswer of ROUTE_ANSWERS) {
        // An answer that decides without waiting stays synchronous.
        const answered = routeAnswer(turn, round, call);
        if (typeof answered === 'boolean' ? answered : await answered) return true;
    }
    return false;
}

module.exports = { handleRouteTool };
