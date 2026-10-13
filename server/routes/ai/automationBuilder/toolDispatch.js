/**
 * Automation Builder — one tool call of a round: the route's own answers
 * (./routeTools.js) first, then the builder dispatch (or an org webpage tool
 * behind the Privacy Shield gate), the finalize check, the plan tick, the
 * change status, the persist and the events, and the result the model reads.
 * Moved verbatim from the call loop in ./chatStream.js; `round` carries the
 * per-round bookkeeping the loop reads afterwards.
 */

const log = require('../../../telemetry/log');
const { applyToolCall, compactDryRunForModel, truncateToolResultJson } = require('../../../automation/builderTools');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const { ensureDraftTitle } = require('../../../automation/builderTools/deriveTitle');
const { persistDraftWrap } = require('./builderDraft');
const { inferPlanProgress } = require('./planProgress');
const { withChangeStatus, markStagedView } = require('./workMode');
const { proposalPreviewPayload } = require('./datatableTurn');
const { parseToolArgs, mutates, applyPlanMarkDone, RECOVERED_CALL_HINT, REPAIRED_CALL_HINT } = require('./chatTurnLoop');
const { rejectedCallLabel, rejectedStepPosition } = require('./turnStop');
const { handleRouteTool } = require('./routeTools');

async function dispatchToolCall(turn, round, tc) {
    const {
        req, send, messages, draftWrap, turnMode, bufferedBuild, isolated, approvedPlan, pauseAfterStep,
        baseDraft, savedProposal, brief, sendMetadata, webpageInspectorEnabled, webpageInspectorCtx,
        isWebpageAutomationTool, executeWebpageAutomationTool, webpageToolGate,
    } = turn;
    const name = tc.function.name;
    const { args, truncated } = parseToolArgs(tc.function.arguments, name);
    let toolResult;
    // Set when an org tool ran, so the model's copy of its
    // result goes through the tool block lists (BFSF-354).
    let shieldModelCopy = false;
    if (await handleRouteTool(turn, round, tc, name, args, truncated)) return;
    // A finalize on an untitled draft names it first (persistDraft
    // writes the title inside the finalize call, so this must run
    // BEFORE it). The result then says so, and the model can still
    // rename with builder_set_metadata.
    const titleBefore = draftWrap.title;
    const titled = name === 'builder_finalize' ? ensureDraftTitle(draftWrap, { brief }) : null;
    try {
        if (webpageInspectorEnabled && isWebpageAutomationTool(name)) {
            const refusal = await webpageToolGate.refuse(name, args);
            if (refusal) {
                toolResult = { error: refusal.modelError };
            } else {
                toolResult = await executeWebpageAutomationTool(name, args, webpageInspectorCtx);
                shieldModelCopy = true;
            }
        } else {
            // Announce a dry run the moment it exists (see
            // builderTools: builder_request_dry_run → onRunCreated).
            if (name === 'builder_request_dry_run') {
                draftWrap._onDryRunStarted = (created) => send('dryrun_started', {
                    run: { id: created.id, status: created.status || 'running', startedAt: created.startedAt || new Date().toISOString() },
                });
            }
            toolResult = await applyToolCall(name, args, draftWrap);
        }
    } catch (e) { toolResult = { error: e.message }; }
    if (tc._recovered && toolResult && typeof toolResult === 'object') {
        // The model never made this call — it wrote it. Say so
        // where it reads: the result.
        toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), RECOVERED_CALL_HINT];
    }
    if (tc._repaired && toolResult && typeof toolResult === 'object') {
        // The adapter closed a cut-off argument string after
        // its last complete entry (base.js). The model has no
        // other way to learn that its tail never arrived.
        toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), REPAIRED_CALL_HINT];
    }
    if (titled && titled.derived && !toolResult?.automation) {
        // The finalize threw before it persisted (an update or a
        // trigger resync failed): the name exists in memory only.
        // Put the default back, or the end-of-turn naming below —
        // which reads draftWrap.title — takes the draft for named
        // and the row keeps "Untitled automation" with no
        // `metadata` event ever sent.
        draftWrap.title = titleBefore;
    }
    if (name === 'builder_finalize' && toolResult?.automation) {
        // Block finalization when the current draft has any
        // structural errors. This keeps a half-formed graph
        // from being saved as "ready" — the LLM gets the
        // structured errors back and self-corrects.
        //
        // BEFORE the plan tick and the `tool_call` event: this
        // swap used to run after them, so the wire carried
        // `{automation, ok:false}` for a refused finalize —
        // scripts/drive-builder.js (`maxFailedCalls`) counted
        // it as a success, the UI card showed one, and the
        // plan tick read `{automation}` as "the build is over".
        const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
        if (!finalCheck.ok) {
            turn.lastValidation = finalCheck;
            send('validation_errors', { errors: finalCheck.errors, warnings: finalCheck.warnings });
            // Replace the success result with a diagnostic so
            // the LLM sees this attempt failed.
            toolResult = {
                error: 'Cannot finalize: definition has validation errors. Address the errors below and try again.',
                validation: finalCheck,
            };
        } else {
            send('finalized', { automationId: toolResult.automation.id });
            turn.lastFinalized = true;
        }
        if (titled && titled.derived && toolResult && typeof toolResult === 'object') {
            toolResult._hint = `Named "${titled.title}" automatically — call builder_set_metadata to rename.`;
            sendMetadata();
        }
    }
    // Tick the plan from what the call DID (planProgress.js). The
    // model is told to markDone with every build call; the small
    // local ones never do, and the owner watched a fully built
    // automation sit at 0/9. Additive only — the model's own
    // markDone keeps working. `_plan` rides on the tool result
    // so the model reads its progress instead of re-deriving it.
    //
    // A PARTIAL batch (builder_add_steps refused entry i after
    // building 0..i-1) is an error result whose `added` steps
    // are in the draft — they tick the plan like any other
    // append. inferPlanProgress reads nothing off an error
    // result, so it is handed the built part only: the added
    // list and the entries that produced it.
    const partialBatch = toolResult && typeof toolResult === 'object' && toolResult.error
        && Array.isArray(toolResult.added) && toolResult.added.length > 0;
    if (turnMode !== 'plan' && turnMode !== 'discuss' && Array.isArray(draftWrap._todos) && draftWrap._todos.length
        && toolResult && typeof toolResult === 'object' && (!toolResult.error || partialBatch)) {
        const evidence = partialBatch
            ? {
                name,
                args: Array.isArray(args?.steps) && Number.isInteger(toolResult.failedIndex)
                    ? { ...args, steps: args.steps.slice(0, toolResult.failedIndex) }
                    : args,
                result: { added: toolResult.added },
            }
            : { name, args, result: toolResult };
        const ticked = inferPlanProgress(draftWrap._todos, evidence);
        if (ticked.length) {
            draftWrap._todos = applyPlanMarkDone(draftWrap._todos, ticked);
            send('plan', { todos: draftWrap._todos });
            toolResult._plan = {
                markedDone: ticked,
                next: (draftWrap._todos.find(t => !t.done) || {}).text || null,
            };
        }
    }
    if (req.body.workMode && mutates(name)) withChangeStatus(toolResult, { isolated, buffered: bufferedBuild && !savedProposal });
    if (name === 'builder_create_datatable') {
        if (req.body.workMode) withChangeStatus(toolResult, { isolated: draftWrap._stageDatatables, buffered: bufferedBuild });
        // A staged table changes the proposal (not the graph): it needs the
        // validation feedback and, outside a buffered build, a fresh preview.
        if (draftWrap._stageDatatables && toolResult?.staged) {
            round.mutatedThisIter = true;
            if (!bufferedBuild) send('proposal_preview', proposalPreviewPayload(draftWrap, baseDraft));
        }
    }
    if (req.body.workMode && name === 'builder_summarise') markStagedView(toolResult, isolated && JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def));
    send('tool_call', { name, arguments: args, result: toolResult });
    // A rejected call, with the arguments that were rejected.
    // The stored session keeps only the summary, so without
    // this line a screenshot of the panel is all that survives
    // of what the model actually sent (2026-09-12: two loops
    // diagnosed from the picture, the third not at all).
    //
    // `repeat=` is the ladder rung the rejection sat on and
    // `failedIndex=` the batch entry it named ('-' outside a
    // batch), so a loop can be read off the log without
    // replaying it. The cap is 20000 chars: at 4000 a full
    // invoice batch was cut every time, and a cut line cannot
    // become a fixture (scripts/builder-trace-from-log.mjs
    // refuses both markers rather than replay half a call).
    if (toolResult && typeof toolResult === 'object' && toolResult.error && mutates(name)) {
        let shown = '';
        try { shown = JSON.stringify(args); } catch (_) { shown = '[unserialisable]'; }
        if (shown.length > 20000) shown = shown.slice(0, 20000) + '…[truncated]';
        log.info(`[AutomationBuilder] rejected ${name} session=${draftWrap.builderSessionId}: repeat=${toolResult._repeated || 1} failedIndex=${toolResult.failedIndex ?? '-'} ${String(toolResult.error).slice(0, 400)} args=${shown}`);
    }
    // The ladder's third rung: the same call, refused three
    // times. Remembered here; acted on after this call's
    // bookkeeping (persist, validation) has run.
    if (toolResult && typeof toolResult === 'object' && toolResult._stop && !round.stopHit) {
        const s = toolResult._stop;
        round.stopHit = {
            reason: s.reason || 'repeated_rejection',
            tool: s.tool || name,
            error: String(s.error || toolResult.error || ''),
            label: s.label || rejectedCallLabel(name, args, toolResult),
            position: rejectedStepPosition(draftWrap.def, args, s.entryIndex),
        };
    }

    // After every mutation, persist + emit a draft snapshot.
    if (mutates(name)) {
        if (!isolated) {
            await persistDraftWrap(draftWrap);
            send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
        }
        else if (!bufferedBuild) send('proposal_preview', proposalPreviewPayload(draftWrap, baseDraft));
        if (approvedPlan && pauseAfterStep && JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def)) turn.pausedAfterStep = true;
        round.mutatedThisIter = true;
    }
    // The name changed — after the persist, so the event carries
    // the id a first mutation just minted.
    if (!isolated && name === 'builder_set_metadata' && toolResult && typeof toolResult === 'object' && !toolResult.error) {
        sendMetadata();
    }
    if (name === 'builder_summarise') {
        send('summary', toolResult);
        if (toolResult && typeof toolResult.summary === 'string') {
            turn.lastSummary = toolResult.summary;
        }
    }
    if (name === 'builder_request_dry_run' && toolResult?.run) {
        send('dryrun', { run: toolResult.run, steps: toolResult.steps || [] });
    }
    if (name === 'builder_request_dry_run') draftWrap._onDryRunStarted = null;
    if (name === 'builder_request_dry_run' || name === 'builder_finalize') {
        round.testedThisIter = true;
    }

    // Model-facing message: dry-run results get the compact
    // projection (the client already received the full rows
    // via the `dryrun` SSE event above); everything else goes
    // through the JSON-safe truncation.
    const modelResult = (name === 'builder_request_dry_run' && toolResult?.run)
        ? compactDryRunForModel(toolResult)
        : toolResult;
    const modelContent = typeof modelResult === 'string' ? modelResult : truncateToolResultJson(modelResult);
    messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        // An org tool's result with the categories its class
        // forbids stripped out; the panel got the full result.
        content: shieldModelCopy ? await webpageToolGate.forModel(modelContent, name) : modelContent,
    });
    // Counted on the result as it finally stands (a finalize
    // refused for validation errors is a refusal). A PARTIAL
    // batch is both: entry i was refused, but entries 0..i-1
    // are in the draft — measured: four such rounds in a row,
    // each landing steps, ended the turn as `no_progress`
    // ("rejected every step I tried") and were charged the
    // wasted-round iteration each time. `reused` entries are
    // a resend of steps built earlier this turn, not progress.
    if (toolResult && typeof toolResult === 'object' && toolResult.error) {
        round.refusedThisIter = true;
        round.lastRefusal = { tool: name, error: String(toolResult.error), label: rejectedCallLabel(name, args, toolResult) };
        if (partialBatch && toolResult.added.some(a => !a?.reused)) round.acceptedThisIter = true;
    } else {
        round.acceptedThisIter = true;
    }
}

module.exports = { dispatchToolCall };
