// @typecheck strict
/**
 * Automation Builder — one tool call of a round: the route's own answers
 * (./routeTools.js) first, then the builder dispatch (or an org webpage tool
 * behind the Privacy Shield gate), the finalize check, the plan tick, the
 * change status, the persist and the events, and the result the model reads.
 * dispatchToolCall, at the end of this file, runs the steps above it in
 * order; `round` carries the per-round bookkeeping the loop reads afterwards.
 */

const log = require('../../../telemetry/log');
const { applyToolCall, compactDryRunForModel, truncateToolResultJson } = require('../../../automation/builderTools');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const { ensureDraftTitle } = require('../../../automation/builderTools/deriveTitle');
const { persistDraftWrap } = require('../../../usecases/ai/automationBuilder/builderDraft');
const { inferPlanProgress } = require('../../../usecases/ai/automationBuilder/planProgress');
const { withChangeStatus, markStagedView } = require('../../../usecases/ai/automationBuilder/workMode');
const { proposalPreviewPayload } = require('../../../usecases/ai/automationBuilder/proposalPayload');
const { parseToolArgs, mutates, applyPlanMarkDone, RECOVERED_CALL_HINT, REPAIRED_CALL_HINT } = require('../../../usecases/ai/automationBuilder/chatTurnLoop');
const { rejectedCallLabel, rejectedStepPosition } = require('../../../usecases/ai/automationBuilder/turnStop');
const { handleRouteTool } = require('./routeTools');

/**
 * @typedef {import('./turnSetup').BuilderTurn} BuilderTurn
 * @typedef {import('./turnSetup').BuilderRound} BuilderRound
 * @typedef {import('./turnSetup').BuilderToolCall} BuilderToolCall
 * @typedef {ReturnType<typeof import('../../../usecases/ai/automationBuilder/chatTurnLoop').parseToolArgs>['args']} ToolArgs
 * @typedef {ReturnType<typeof import('../../../automation/builderTools/deriveTitle').ensureDraftTitle> | null} Titled
 * @typedef {Awaited<ReturnType<typeof applyToolCall>>} ToolResult  a tool's answer: a result object, or { error }
 */

/**
 * Runs the call: an org webpage tool behind its gate, else the builder
 * dispatch. A throw becomes an error result. `shieldModelCopy` says an org
 * tool ran, so the model's copy of its result goes through the tool block lists.
 * @param {BuilderTurn} turn
 * @param {string} name
 * @param {ToolArgs} args
 */
async function runTool(turn, name, args) {
    const { send, draftWrap, webpageInspectorEnabled, webpageInspectorCtx, isWebpageAutomationTool, executeWebpageAutomationTool, webpageToolGate } = turn;
    try {
        if (webpageInspectorEnabled && isWebpageAutomationTool(name)) {
            const refusal = await webpageToolGate.refuse(name, args);
            if (refusal) return { toolResult: { error: refusal.modelError }, shieldModelCopy: false };
            // toolMenu sets the context whenever it enables the inspector.
            const toolResult = await executeWebpageAutomationTool(name, args, /** @type {NonNullable<typeof webpageInspectorCtx>} */ (webpageInspectorCtx));
            return { toolResult, shieldModelCopy: true };
        }
        // Announce a dry run the moment it exists (see
        // builderTools: builder_request_dry_run → onRunCreated).
        if (name === 'builder_request_dry_run') {
            draftWrap._onDryRunStarted = (created) => send('dryrun_started', {
                run: { id: created.id, status: created.status || 'running', startedAt: created.startedAt || new Date().toISOString() },
            });
        }
        return { toolResult: await applyToolCall(name, args, draftWrap), shieldModelCopy: false };
    } catch (e) {
        return { toolResult: { error: /** @type {Error} */ (e).message }, shieldModelCopy: false };
    }
}

/**
 * Says in the result, where the model reads, that the call was not made as
 * sent: recovered from text the model wrote, or closed by the adapter after
 * its last complete entry (base.js), so its tail never arrived.
 * @param {BuilderToolCall} tc
 * @param {ToolResult} toolResult
 */
function addCallHints(tc, toolResult) {
    if (!toolResult || typeof toolResult !== 'object') return;
    if (tc._recovered) toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), RECOVERED_CALL_HINT];
    if (tc._repaired) toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), REPAIRED_CALL_HINT];
}

/**
 * A finalize that saved: refused when the draft has structural errors (the
 * model gets them back and corrects itself), announced otherwise. Runs
 * BEFORE the plan tick and the `tool_call` event, so a refused finalize never
 * reads as `{ automation }` on the wire or to the plan tick. Answers the
 * result as it now stands.
 * @param {BuilderTurn} turn
 * @param {ToolResult} toolResult
 * @param {Titled} titled
 */
function checkFinalize(turn, toolResult, titled) {
    const { send, draftWrap, sendMetadata } = turn;
    const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
    if (!finalCheck.ok) {
        turn.lastValidation = finalCheck;
        send('validation_errors', { errors: finalCheck.errors, warnings: finalCheck.warnings });
        toolResult = {
            error: 'Cannot finalize: definition has validation errors. Address the errors below and try again.',
            validation: finalCheck,
        };
    } else {
        // `needs` (builderTools finalize) feeds the chat's hand-over card.
        send('finalized', { automationId: toolResult.automation.id, ...(Array.isArray(toolResult.needs) ? { needs: toolResult.needs } : {}) });
        turn.lastFinalized = true;
    }
    if (titled && titled.derived && toolResult && typeof toolResult === 'object') {
        toolResult._hint = `Named "${titled.title}" automatically — call builder_set_metadata to rename.`;
        sendMetadata();
    }
    return toolResult;
}

/**
 * A PARTIAL batch: builder_add_steps refused entry i after building 0..i-1,
 * so the result is an error whose `added` steps are in the draft.
 * @param {ToolResult} toolResult
 * @returns {boolean}
 */
function isPartialBatch(toolResult) {
    return !!(toolResult && typeof toolResult === 'object' && toolResult.error
        && Array.isArray(toolResult.added) && toolResult.added.length > 0);
}

/**
 * What the plan tick reads. inferPlanProgress reads nothing off an error
 * result, so a partial batch hands it the built part only: the added list
 * and the entries that produced it.
 * @param {string} name
 * @param {ToolArgs} args
 * @param {ToolResult} toolResult
 * @param {boolean} partialBatch
 */
function planEvidence(name, args, toolResult, partialBatch) {
    if (!partialBatch) return { name, args, result: toolResult };
    return {
        name,
        args: Array.isArray(args?.steps) && Number.isInteger(toolResult.failedIndex)
            ? { ...args, steps: args.steps.slice(0, toolResult.failedIndex) }
            : args,
        result: { added: toolResult.added },
    };
}

/**
 * Ticks the plan from what the call DID (planProgress.js): the small local
 * models never mark done themselves. Additive only, and `_plan` rides on the
 * tool result so the model reads its progress instead of re-deriving it.
 * @param {BuilderTurn} turn
 * @param {string} name
 * @param {ToolArgs} args
 * @param {ToolResult} toolResult
 * @param {boolean} partialBatch
 */
function tickPlan(turn, name, args, toolResult, partialBatch) {
    const { send, draftWrap, turnMode } = turn;
    if (turnMode === 'plan' || turnMode === 'discuss') return;
    if (!Array.isArray(draftWrap._todos) || !draftWrap._todos.length) return;
    if (!toolResult || typeof toolResult !== 'object' || (toolResult.error && !partialBatch)) return;
    const ticked = inferPlanProgress(draftWrap._todos, planEvidence(name, args, toolResult, partialBatch));
    if (!ticked.length) return;
    draftWrap._todos = applyPlanMarkDone(draftWrap._todos, ticked);
    send('plan', { todos: draftWrap._todos });
    toolResult._plan = {
        markedDone: ticked,
        next: (draftWrap._todos.find(t => !t.done) || {}).text || null,
    };
}

/**
 * In a work mode the result says where the change went (applied, staged in a
 * proposal, buffered), and a staged table refreshes the proposal: it changes
 * the proposal, not the graph, so it needs the validation feedback and,
 * outside a buffered build, a fresh preview.
 * @param {BuilderTurn} turn
 * @param {BuilderRound} round
 * @param {string} name
 * @param {ToolResult} toolResult
 */
function markChangeStatus(turn, round, name, toolResult) {
    const { req, send, draftWrap, bufferedBuild, isolated, baseDraft, savedProposal } = turn;
    if (req.body.workMode && mutates(name)) withChangeStatus(toolResult, { isolated, buffered: bufferedBuild && !savedProposal });
    if (name === 'builder_create_datatable') {
        if (req.body.workMode) withChangeStatus(toolResult, { isolated: draftWrap._stageDatatables, buffered: bufferedBuild });
        if (draftWrap._stageDatatables && toolResult?.staged) {
            round.mutatedThisIter = true;
            if (!bufferedBuild) send('proposal_preview', proposalPreviewPayload(draftWrap, baseDraft));
        }
    }
    if (req.body.workMode && name === 'builder_summarise') markStagedView(toolResult, isolated && JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def));
}

/**
 * Logs a rejected mutation with the arguments that were rejected: the stored
 * session keeps only the summary. `repeat=` is the ladder rung the rejection
 * sat on and `failedIndex=` the batch entry it named ('-' outside a batch),
 * so a loop can be read off the log without replaying it. The cap is 20000
 * characters: a cut line cannot become a fixture
 * (scripts/builder-trace-from-log.mjs refuses a truncated call).
 * @param {BuilderTurn} turn
 * @param {string} name
 * @param {ToolArgs} args
 * @param {ToolResult} toolResult
 */
function logRejection(turn, name, args, toolResult) {
    if (!(toolResult && typeof toolResult === 'object' && toolResult.error && mutates(name))) return;
    let shown = '';
    try { shown = JSON.stringify(args); } catch (_) { shown = '[unserialisable]'; }
    if (shown.length > 20000) shown = shown.slice(0, 20000) + '…[truncated]';
    log.info(`[AutomationBuilder] rejected ${name} session=${turn.draftWrap.builderSessionId}: repeat=${toolResult._repeated || 1} failedIndex=${toolResult.failedIndex ?? '-'} ${String(toolResult.error).slice(0, 400)} args=${shown}`);
}

/**
 * The ladder's third rung: the same call, refused three times. Remembered on
 * the round; the loop acts on it after this call's bookkeeping has run.
 * @param {BuilderTurn} turn
 * @param {BuilderRound} round
 * @param {string} name
 * @param {ToolArgs} args
 * @param {ToolResult} toolResult
 */
function rememberStop(turn, round, name, args, toolResult) {
    if (!(toolResult && typeof toolResult === 'object' && toolResult._stop) || round.stopHit) return;
    const s = toolResult._stop;
    round.stopHit = {
        reason: s.reason || 'repeated_rejection',
        tool: s.tool || name,
        error: String(s.error || toolResult.error || ''),
        label: s.label || rejectedCallLabel(name, args, toolResult),
        position: rejectedStepPosition(turn.draftWrap.def, args, s.entryIndex),
    };
}

/** @param {BuilderTurn} turn */
async function persistAndSendDraft(turn) {
    const { send, draftWrap } = turn;
    await persistDraftWrap(draftWrap);
    send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
}

/**
 * After a mutation (and its persist): the proposal preview of a turn that
 * stages its changes, the pause after one step of an approved plan, and the
 * round's note that the draft changed.
 * @param {BuilderTurn} turn
 * @param {BuilderRound} round
 */
function afterMutation(turn, round) {
    const { send, draftWrap, bufferedBuild, isolated, approvedPlan, pauseAfterStep, baseDraft } = turn;
    if (isolated && !bufferedBuild) send('proposal_preview', proposalPreviewPayload(draftWrap, baseDraft));
    if (approvedPlan && pauseAfterStep && JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def)) turn.pausedAfterStep = true;
    round.mutatedThisIter = true;
}

/**
 * The events a call's result carries besides `tool_call`: a new name (after
 * the persist, so the event carries the id a first mutation just minted),
 * the summary, the dry run. A dry run or a finalize counts as tested.
 * @param {BuilderTurn} turn
 * @param {BuilderRound} round
 * @param {string} name
 * @param {ToolResult} toolResult
 */
function sendResultEvents(turn, round, name, toolResult) {
    const { send, draftWrap, isolated, sendMetadata } = turn;
    if (!isolated && name === 'builder_set_metadata' && toolResult && typeof toolResult === 'object' && !toolResult.error) {
        sendMetadata();
    }
    if (name === 'builder_summarise') {
        send('summary', toolResult);
        if (toolResult && typeof toolResult.summary === 'string') turn.lastSummary = toolResult.summary;
    }
    if (name === 'builder_request_dry_run') {
        if (toolResult?.run) send('dryrun', { run: toolResult.run, steps: toolResult.steps || [] });
        draftWrap._onDryRunStarted = null;
    }
    if (name === 'builder_request_dry_run' || name === 'builder_finalize') round.testedThisIter = true;
}

/**
 * What the model reads of the result. A dry run gets the compact projection
 * (the client already received the full rows in the `dryrun` event);
 * everything else goes through the JSON-safe truncation.
 * @param {string} name
 * @param {ToolResult} toolResult
 */
function modelContentOf(name, toolResult) {
    const modelResult = (name === 'builder_request_dry_run' && toolResult?.run)
        ? compactDryRunForModel(toolResult)
        : toolResult;
    return typeof modelResult === 'string' ? modelResult : truncateToolResultJson(modelResult);
}

/**
 * Counts the call on the result as it finally stands (a finalize refused for
 * validation errors is a refusal). A PARTIAL batch is both: entry i was
 * refused, but entries 0..i-1 are in the draft, so it also counts as
 * accepted, unless every added entry is `reused` (a resend of steps built
 * earlier this turn, not progress).
 * @param {BuilderRound} round
 * @param {string} name
 * @param {ToolArgs} args
 * @param {ToolResult} toolResult
 * @param {boolean} partialBatch
 */
function countOutcome(round, name, args, toolResult, partialBatch) {
    if (toolResult && typeof toolResult === 'object' && toolResult.error) {
        round.refusedThisIter = true;
        round.lastRefusal = { tool: name, error: String(toolResult.error), label: rejectedCallLabel(name, args, toolResult) };
        if (partialBatch && toolResult.added.some((/** @type {{ reused?: boolean }} */ a) => !a?.reused)) round.acceptedThisIter = true;
    } else {
        round.acceptedThisIter = true;
    }
}

/**
 * @param {import('./turnSetup').BuilderTurn} turn
 * @param {import('./turnSetup').BuilderRound} round
 * @param {import('./turnSetup').BuilderToolCall} tc
 */
async function dispatchToolCall(turn, round, tc) {
    const { send, draftWrap, brief } = turn;
    const name = tc.function.name;
    const { args, truncated } = parseToolArgs(tc.function.arguments, name);
    if (await handleRouteTool(turn, round, tc, name, args, truncated)) return;
    // A finalize on an untitled draft names it first (persistDraft writes
    // the title inside the finalize call, so this must run BEFORE it). The
    // result then says so, and the model can still rename with
    // builder_set_metadata.
    const titleBefore = draftWrap.title;
    const titled = name === 'builder_finalize' ? ensureDraftTitle(draftWrap, { brief }) : null;
    const ran = await runTool(turn, name, args);
    let toolResult = ran.toolResult;
    addCallHints(tc, toolResult);
    // The finalize threw before it persisted (an update or a trigger resync
    // failed): the name exists in memory only. The default goes back, or the
    // end-of-turn naming, which reads draftWrap.title, takes the draft for
    // named and the row keeps "Untitled automation" with no `metadata` event.
    if (titled && titled.derived && !toolResult?.automation) draftWrap.title = titleBefore;
    if (name === 'builder_finalize' && toolResult?.automation) toolResult = checkFinalize(turn, toolResult, titled);

    const partialBatch = isPartialBatch(toolResult);
    tickPlan(turn, name, args, toolResult, partialBatch);
    markChangeStatus(turn, round, name, toolResult);
    send('tool_call', { name, arguments: args, result: toolResult });
    logRejection(turn, name, args, toolResult);
    rememberStop(turn, round, name, args, toolResult);

    // After every mutation, persist and send the draft; a turn that stages
    // its changes refreshes the proposal instead.
    if (mutates(name)) {
        if (!turn.isolated) await persistAndSendDraft(turn);
        afterMutation(turn, round);
    }
    sendResultEvents(turn, round, name, toolResult);
    const modelContent = modelContentOf(name, toolResult);
    turn.messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        // An org tool's result with the categories its class forbids
        // stripped out; the panel got the full result.
        content: ran.shieldModelCopy ? await turn.webpageToolGate.forModel(modelContent, name) : modelContent,
    });
    countOutcome(round, name, args, toolResult, partialBatch);
}

module.exports = { dispatchToolCall };
