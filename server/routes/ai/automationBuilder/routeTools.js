// @typecheck noImplicitAny
/**
 * Automation Builder — the tool calls the route answers itself, before the
 * builder dispatch: a call behind a stop, unparseable arguments, the pause
 * and work-mode gates, a removal the approved plan does not name, the
 * question card, the inspection reads, web research, the plan, the
 * checklist and flowlet delegation. Moved verbatim from ./chatStream.js;
 * each branch that used to `continue` the call loop answers true.
 */

const automationStore = require('../../../stores/automationStore');
const { truncateToolResultJson } = require('../../../automation/builderTools');
const { persistDraftWrap } = require('./builderDraft');
const { runDelegationTool } = require('./layerDelegation');
const { INSPECTION_NAMES, inspect } = require('./inspectionTools');
const { runWebResearchTool, isWebResearchTool } = require('./webResearch');
const { MAX_QUESTIONS, writeQuestions, toolAllowed, previewRefusal, planCoversRemoval, resolveRemovalTarget, writePlan, markStagedView } = require('./workMode');
const { proposalPreviewPayload } = require('./datatableTurn');
const { applyPlanMarkDone, normalizePlanTodos } = require('./chatTurnLoop');
const { rejectedCallLabel } = require('./turnStop');

/**
 * Answer one tool call the route handles itself. True when it did (the call
 * is done: its event is sent and its tool message pushed), false when the
 * call goes on to the builder dispatch.
 * @param {import('./turnSetup').BuilderTurn} turn
 * @param {import('./turnSetup').BuilderRound} round
 * @param {import('./turnSetup').BuilderToolCall} tc
 * @param {string} name
 * @param {ReturnType<typeof import('./chatTurnLoop').parseToolArgs>['args']} args
 * @param {boolean} truncated
 */
async function handleRouteTool(turn, round, tc, name, args, truncated) {
    const {
        req, userId, send, messages, draftWrap, userOrgForTiers, approvedPlan, turnMode, bufferedBuild,
        permissionMode, isolated, planAllowsRemoval, pauseAfterStep, baseDraft, questionsClosed,
        catalog, modelId, thinkingModelId, webResearch, webpageToolGate,
    } = turn;
    /** @type {{ error?: string, _fixHint?: string, _draftSteps?: unknown, steps?: unknown[], failedIndex?: number, [k: string]: unknown }} */
    let toolResult;
    if (round.stopHit) {
        // The turn is over. The calls after the stop are not
        // run — a finalize in the same reply would save a draft
        // the model was still fighting with — but each still
        // gets its tool message so the assistant turn stays
        // well-formed in the stored session.
        toolResult = {
            error: `Not run: the build stopped before this call (${round.stopHit.reason}).`,
            _fixHint: 'Reject reason: the build was stopped after a repeated rejection, so this call was not executed. Wait for the user.',
            _skipped: true,
        };
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        return true;
    }
    if (truncated) {
        // Arguments didn't parse as JSON — almost always a
        // mid-call truncation. Running the tool with empty args
        // yields a confusing generic error and a blind retry;
        // instead tell the model exactly what happened so it
        // resends just this one call. Still push a tool message
        // so the assistant turn stays well-formed.
        toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.`, _truncated: true };
        send('tool_call', { name, arguments: {}, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        round.refusedThisIter = true;
        round.lastRefusal = { tool: name, error: toolResult.error, label: name };
        return true;
    }
    if (turn.pausedAfterStep || (bufferedBuild && name === 'builder_remove_step') || (approvedPlan && pauseAfterStep && ((name === 'builder_add_steps' && args.steps?.length > 1) || name === 'builder_generate_layer' || name === 'builder_generate_layers' || name === 'builder_request_dry_run'))) {
        toolResult = { error: 'Pause after each step is enabled. Make one step change, then wait for the user to continue. Batch changes and run actions need a separate turn.' };
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        return true;
    }
    if (req.body.workMode && !toolAllowed(name, permissionMode, { planAllowsRemoval })) {
        toolResult = { error: previewRefusal(name, turnMode) };
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        round.refusedThisIter = true;
        return true;
    }
    // An approved plan lets the build turn remove the steps IT names
    // and no others: the plan line must say remove and name the step.
    if (planAllowsRemoval && name === 'builder_remove_step') {
        // Looked up in the graph the call changes (its scope), and a step that
        // is not found there is refused, never waved through: the check must
        // not depend on the tool failing on its own.
        const target = resolveRemovalTarget(draftWrap.def, args);
        if (!target || !planCoversRemoval(approvedPlan, target)) {
            toolResult = { error: target
                ? `The approved plan does not name "${target.label || target.id}" for removal, so it is not removed. Removing a step the plan does not name needs a separate human-approved proposal.`
                : `Unknown stepId "${args?.stepId}"${args?.scope ? ` in flowlet "${args.scope}"` : ''}. Nothing was removed; read the draft for the existing step ids.` };
            send('tool_call', { name, arguments: args, result: toolResult });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
            round.refusedThisIter = true;
            return true;
        }
    }
    // The plan is written: the user decides now. Whatever else the
    // reply held (a checklist, a summary, more questions) is not run.
    if (turn.planWritten) {
        toolResult = { error: 'The plan is written and waits for the user. Stop here.' };
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        return true;
    }
    if (req.body.workMode && name === 'builder_ask_questions') {
        // A table choice is consent, not clarification: it is allowed
        // after the round is spent. Everything else is refused.
        const asksTable = Array.isArray(args?.questions) && args.questions.some((/** @type {{ datatableIds?: unknown }} */ q) => q && Array.isArray(q.datatableIds) && q.datatableIds.length);
        if (questionsClosed && !asksTable) {
            toolResult = { error: 'You already asked your questions for this plan and the user answered. Do not ask again: call builder_write_plan now and list what is still open under assumptions.' };
            send('tool_call', { name, arguments: args, result: toolResult });
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
            round.refusedThisIter = true;
            return true;
        }
        const written = writeQuestions(args, { datatables: draftWrap._datatables });
        turn.reviewQuestions = written ? written.questions : null;
        toolResult = written
            ? { ok: true, awaitingAnswers: true, ...(written.dropped ? { _note: `${written.dropped} question(s) were not shown (limit ${MAX_QUESTIONS}). Put what they would have settled under assumptions.` } : {}) }
            : { error: `Provide 1–${MAX_QUESTIONS} questions, each with 2–4 short answers (a table question: datatableIds from the Datatables block, plus createLabel).` };
        if (turn.reviewQuestions) send('review_questions', { questions: turn.reviewQuestions.map(({ choice, ...q }) => q), planId: approvedPlan?.id || null });
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        round.acceptedThisIter = !!turn.reviewQuestions;
        return true;
    }
    if (turn.reviewQuestions) {
        toolResult = { error: 'Wait for the user to answer the questions before continuing.' };
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        return true;
    }
    if (req.body.workMode && INSPECTION_NAMES.has(name)) {
        try { toolResult = await inspect(name, args, draftWrap, { store: automationStore, pii: require('../../../core/privacy/piiDetection') }); }
        catch (e) { toolResult = { error: /** @type {Error} */ (e).message }; }
        markStagedView(toolResult, isolated && JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def));
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: truncateToolResultJson(toolResult) });
        round.acceptedThisIter = !toolResult.error;
        return true;
    }
    if (webResearch.offered && isWebResearchTool(name)) {
        const out = await runWebResearchTool(name, args, {
            research: webResearch, gate: webpageToolGate,
            ids: { userId, orgId: userOrgForTiers, automationId: draftWrap.automationId || null, modelId: modelId || null },
        });
        toolResult = /** @type {typeof toolResult} */ (out.result);
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            // A web page is outside data: the shield's block
            // lists strip what this tool class may not carry.
            content: out.modelText != null ? await webpageToolGate.forModel(out.modelText, name) : JSON.stringify(toolResult),
        });
        if (toolResult.error) { round.refusedThisIter = true; round.lastRefusal = { tool: name, error: String(toolResult.error), label: name }; }
        else round.acceptedThisIter = true;
        return true;
    }
    if (name === 'builder_write_plan' && turnMode === 'plan') {
        const nextPlan = writePlan(args, turn.reviewPlan, { datatables: draftWrap._datatables });
        if (nextPlan) {
            turn.reviewPlan = { ...nextPlan, baseDefinition: structuredClone(baseDraft) };
            send('review_plan', { plan: turn.reviewPlan });
            // The plan ends the cycle and the turn. A checklist from
            // before it would sit beside the Build button.
            turn.planWritten = true;
            turn.planCycleRound = 0;
            draftWrap._todos = [];
            send('plan', { todos: [] });
        }
        toolResult = nextPlan ? { ok: true, planId: nextPlan.id, awaitingApproval: true } : { error: 'Provide a title, goal and non-empty list of step descriptions.' };
        send('tool_call', { name, arguments: args, result: toolResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
        round.acceptedThisIter = !!nextPlan;
        return true;
    }
    // ── Self-planning (route-handled, non-mutating): record the
    //    agent's to-do list and surface it to the user. ──
    if (name === 'builder_set_plan') {
        // Full-list form replaces the plan; the cheap
        // `markDone` diff form flips existing items so a
        // progress update doesn't resend the whole list.
        // In an approved build the list IS the plan's steps: a model
        // that rewrites it loses the plan the user approved.
        const replacing = Array.isArray(args.todos) && args.todos.length;
        const todos = (replacing && !approvedPlan)
            ? normalizePlanTodos(args.todos)
            : applyPlanMarkDone(draftWrap._todos || [], args.markDone);
        draftWrap._todos = todos;
        // Echo the LIST, not a count. This is the model's only
        // cross-round memory of its own plan: with {ok,count} it
        // had nowhere to read the plan back from and re-derived
        // it from the user's message on every round. `i` is
        // load-bearing — markDone takes 0-based indices.
        const planResult = {
            ok: true,
            todos: todos.map((t, i) => ({ i, text: t.text, done: !!t.done })),
            next: (todos.find(t => !t.done) || {}).text || null,
            ...(replacing && approvedPlan ? { _note: 'The checklist is the approved plan; only markDone is applied.' } : {}),
        };
        send('plan', { todos });
        send('tool_call', { name, arguments: args, result: planResult });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(planResult) });
        round.acceptedThisIter = true;
        return true;
    }
    // ── Flowlet delegation (route-handled): spawn one or several
    //    thinking-model sub-agents to build whole flowlet(s),
    //    merge into the draft, persist + emit a draft snapshot,
    //    and let the post-loop validator feed errors back. ──
    if (name === 'builder_generate_layer' || name === 'builder_generate_layers') {
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
        messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof toolResult === 'string' ? toolResult : truncateToolResultJson(toolResult) });
        if (toolResult && typeof toolResult === 'object' && toolResult.error) {
            round.refusedThisIter = true;
            round.lastRefusal = { tool: name, error: String(toolResult.error), label: rejectedCallLabel(name, args, toolResult) };
        } else {
            round.acceptedThisIter = true;
        }
        return true;
    }
    return false;
}

module.exports = { handleRouteTool };
