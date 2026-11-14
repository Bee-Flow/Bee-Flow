/** @typedef {import('../../../routes/ai/automationBuilder/turnSetup').BuilderTurn} BuilderTurn */
// @typecheck strict
/**
 * Automation Builder — closing a turn after its rounds: the auto-finalize
 * net, naming an untitled draft, the proposal (approve mode, a buffered
 * build), the plan status, the question round's memory, and the builder
 * session snapshot. Moved verbatim from ./chatStream.js; `done` itself is
 * sent by the route.
 */

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { applyToolCall } = require('../../../automation/builderTools');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const log = require('../../../telemetry/log');
const { logSurfaceUsage } = require('../../../core/llm/surfaceUsage');
const { createUsageAccumulator } = require('../../../core/providers/usageNormalizer');
const automationStore = require('../../../stores/automationStore');
const { ensureDraftTitle, UNTITLED_AUTOMATION } = require('../../../automation/builderTools/deriveTitle');
const { HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { persistDraftWrap } = require('./builderDraft');
const { LARGE_CHANGE_STEPS, changedSteps, pendingProposal } = require('./workMode');
const { proposalPreviewPayload, clientProposal } = require('./proposalPayload');
const { sanitizeHistory, collectAssistantTurn } = require('./chatTurnLoop');
const { bestEffort } = require('../../../utils/bestEffort');
const { hintsFromDryRun, mergeDryRunHints, stepIdsOf } = require('../../../automation/builderPrompt/lastTestRun.mts');

// The inspected-tool memory: at most this many names, newest last.
const MAX_INSPECTED_TOOLS = 100;
const MAX_TOOL_NAME = 200;

/**
 * @typedef {{ role?: string, content?: unknown, tool_call_id?: string,
 *   tool_calls?: Array<{ id?: string, function?: { name?: string } }> }} LoopMessage
 */

/**
 * The parsed answer to one dry-run call, when it is a run (a refused call or
 * an unparseable copy is null).
 * @param {LoopMessage[]} after  the messages after the call
 * @param {string | undefined} callId
 * @returns {{ run: unknown, steps: unknown[] } | null}
 */
function dryRunAnswer(after, callId) {
    const answer = after.find((r) => r?.role === 'tool' && r.tool_call_id === callId);
    if (typeof answer?.content !== 'string') return null;
    /** @type {{ run?: unknown, steps?: unknown } | null} */
    let parsed = null;
    try { parsed = JSON.parse(answer.content); } catch { return null; }
    return parsed && parsed.run && Array.isArray(parsed.steps) ? { run: parsed.run, steps: parsed.steps } : null;
}

/**
 * The hints of the LAST dry run this turn ran (its compact model copy in the
 * loop's messages), or null when the turn ran none that answered. The
 * few-shot examples carry synthetic dry runs of their own: they are skipped.
 * @param {unknown[]} messages
 * @param {Set<unknown>} skip
 */
function lastDryRunHintsOf(messages, skip) {
    const list = /** @type {LoopMessage[]} */ (Array.isArray(messages) ? messages : []);
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (m?.role !== 'assistant' || skip.has(m) || !Array.isArray(m.tool_calls)) continue;
        const calls = m.tool_calls.filter((tc) => tc?.function?.name === 'builder_request_dry_run').reverse();
        for (const tc of calls) {
            const run = dryRunAnswer(list.slice(i + 1), tc.id);
            if (run) return hintsFromDryRun(run);
        }
    }
    return null;
}

/**
 * The inspected tool names to remember: the stored ones, then this turn's,
 * deduplicated with the newest last, only those the user can still run (all
 * of them when that could not be told), at most MAX_INSPECTED_TOOLS.
 * @param {unknown} prior
 * @param {Set<string> | undefined} now
 * @param {Set<string> | null | undefined} available
 */
function rememberedTools(prior, now, available) {
    /** @type {string[]} */
    const names = [];
    const all = [...(Array.isArray(prior) ? prior : []), ...(now instanceof Set ? now : [])];
    for (const n of all) {
        if (typeof n !== 'string' || !n || n.length > MAX_TOOL_NAME) continue;
        if (available instanceof Set && !available.has(n)) continue;
        const at = names.indexOf(n);
        if (at >= 0) names.splice(at, 1);
        names.push(n);
    }
    return names.slice(-MAX_INSPECTED_TOOLS);
}

/**
 * What the builder session remembers for the next turn besides the draft
 * (F7): the tool names inspected so far (`inspectedTools`, newest last; the
 * next turn seeds `_inspectedTools` from it, turnSetup.js) and the last test
 * run's per-step shape hints (`lastDryRunHints`, rendered as "## Last test
 * run" by builderPrompt/lastTestRun.mts). Hints only, never a value; both
 * bounded. A turn without a dry run keeps the hints it had, minus the steps
 * that left the draft. An empty field is left out.
 * @param {{ messages: unknown[], fewShotMessages?: unknown[], snapshot: any, draftWrap: BuilderTurn['draftWrap'], proposal?: { definition?: unknown } | null }} p
 * @returns {{ inspectedTools?: string[], lastDryRunHints?: import('../../../automation/builderPrompt/lastTestRun.mts').DryRunHints }}
 */
function sessionMemory({ messages, fewShotMessages, snapshot, draftWrap, proposal }) {
    const inspectedTools = rememberedTools(snapshot?.inspectedTools, draftWrap?._inspectedTools, draftWrap?._availableToolNames);
    // Steps of the draft, and of a waiting proposal the next turn works on.
    const keep = stepIdsOf(draftWrap?.def);
    for (const id of stepIdsOf(proposal?.definition)) keep.add(id);
    const fresh = lastDryRunHintsOf(messages, new Set(Array.isArray(fewShotMessages) ? fewShotMessages : []));
    const lastDryRunHints = mergeDryRunHints(snapshot?.lastDryRunHints, fresh, { keep });
    // An empty memory is left out: the snapshot is rebuilt field by field
    // every turn, so a missing key reads (and clears) as empty.
    return {
        ...(inspectedTools.length ? { inspectedTools } : {}),
        ...(Object.keys(lastDryRunHints).length ? { lastDryRunHints } : {}),
    };
}

/**
 * Saves the draft as it is and says so. A failed save is logged and leaves
 * the turn unfinalized.
 * @param {BuilderTurn} turn
 * @param {boolean} named  the draft was named for this save
 */
async function finalizeAsIs(turn, named) {
    const { send, draftWrap, sendMetadata } = turn;
    try {
        const finalized = await applyToolCall('builder_finalize', {}, draftWrap);
        if (finalized?.automation) {
            send('finalized', { automationId: finalized.automation.id, autoFinalized: true, ...(Array.isArray(finalized.needs) ? { needs: finalized.needs } : {}) });
            if (named) sendMetadata();
            send('message', { content: 'I ran out of conversational turns but your draft validates — finalising as-is. Activate when ready.' });
            turn.lastFinalized = true;
        }
    } catch (e) {
        log.warn('[AutomationBuilder] auto-finalize failed:', /** @type {Error} */ (e).message);
    }
}

/**
 * The auto-finalize net: small models often stop after a valid graph ("Your
 * automation is ready") without calling builder_finalize, which would leave
 * `is_draft = true` on an automation that is ready. A draft that passes
 * validateDefinition and has a trigger and a real step is saved, so nothing
 * half-built is finalised; a turn that could not says so (`builder_aborted`).
 * @param {BuilderTurn} turn
 */
async function autoFinalize(turn) {
    const { send, draftWrap, brief, iterationBudget, lastValidation } = turn;
    const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
    const def = draftWrap.def;
    const hasTrigger = !!def?.trigger;
    // A note is a canvas annotation, not a step the automation runs: a draft
    // the model only ever left a sticky note on must not read as "has a
    // step" and get auto-finalized as if it were a working automation.
    const hasStep = Array.isArray(def?.steps) && def.steps.some((s) => s?.type !== 'note');
    if (finalCheck.ok && hasTrigger && hasStep) {
        // Same rule as the model's own finalize: an automation never
        // ships as "Untitled automation".
        const titleBefore = draftWrap.title;
        const titled = ensureDraftTitle(draftWrap, { brief });
        await finalizeAsIs(turn, titled.derived);
        // Same as after the model's finalize: a name the failed call never
        // wrote goes back to the default, so naming the draft persists it.
        if (titled.derived && !turn.lastFinalized) draftWrap.title = titleBefore;
    }
    if (!turn.lastFinalized) {
        send('builder_aborted', {
            reason: 'max_iterations',
            iterations: iterationBudget,
            lastValidation: lastValidation || finalCheck || null,
        });
    }
}

/**
 * A persisted draft that is still untitled at the end of the turn (not
 * finalized, or finalized with a throw that put the default back) gets its
 * name now, so the list, the header and the playbook rail never show the
 * default. A turn that built nothing has no row to name.
 * @param {BuilderTurn} turn
 */
async function nameUntitledDraft(turn) {
    const { draftWrap, brief, sendMetadata } = turn;
    try {
        const titled = ensureDraftTitle(draftWrap, { brief });
        if (titled.derived) {
            await persistDraftWrap(draftWrap);
            sendMetadata();
        }
    } catch (e) {
        log.warn('[AutomationBuilder] naming the draft failed:', /** @type {Error} */ (e).message);
    }
}

/**
 * What closing a turn works out: the plan as it now stands, the baseline
 * the changes are measured against and the proposal to show.
 * @typedef {{ reviewPlan: BuilderTurn['reviewPlan'], baseDraft: BuilderTurn['baseDraft'], baseTitle: BuilderTurn['baseTitle'],
 *   baseDescription: BuilderTurn['baseDescription'], proposal: Proposal | null, staged: boolean, pendingChanged: boolean }} Closing
 * @typedef {NonNullable<BuilderTurn['savedProposal']>} Proposal
 */

/**
 * The proposal of this turn's staged changes. The same proposal keeps its id
 * while the turn added nothing to it.
 * @param {BuilderTurn} turn
 * @param {Closing} closing
 * @returns {Proposal}
 */
function stageProposal(turn, closing) {
    const { draftWrap, savedProposal } = turn;
    return (savedProposal && !closing.pendingChanged && isDeepStrictEqual(savedProposal.definition, draftWrap.def)
        && savedProposal.title === draftWrap.title && savedProposal.description === draftWrap.description)
        ? savedProposal
        : { id: randomUUID(), ...proposalPreviewPayload(draftWrap, closing.baseDraft) };
}

/**
 * The approved plan's status after this turn: `built` only when the plan is
 * done. A turn that ended any other way (an error, the iteration budget, a
 * model that gave up) leaves it `building`, and the follow-up ("continue",
 * "fix X") goes on with the same approved plan instead of starting a new
 * planning turn.
 * @param {BuilderTurn} turn
 * @param {Closing} closing
 */
function closeApprovedPlan(turn, closing) {
    const { send, draftWrap, reviewQuestions, pausedAfterStep } = turn;
    const todosNow = Array.isArray(draftWrap._todos) ? draftWrap._todos : [];
    const planDone = turn.lastFinalized || (todosNow.length > 0 && todosNow.every(t => t.done));
    const status = reviewQuestions || pausedAfterStep ? 'paused' : planDone ? 'built' : 'building';
    closing.reviewPlan = { ...closing.reviewPlan, status, baseDefinition: structuredClone(draftWrap.def) };
    send('review_plan', { plan: closing.reviewPlan });
}

/**
 * A buffered build ends as a proposal or commits. A large change becomes the
 * one-click proposal approve mode makes (never a plan listing the changes:
 * approving that would have the agent build it all again). A turn that
 * worked on a waiting proposal never commits by itself, and neither does a
 * new table: creating it is the user's Apply. A small change is saved, and
 * becomes the baseline.
 * @param {BuilderTurn} turn
 * @param {Closing} closing
 */
async function closeBufferedBuild(turn, closing) {
    const { send, draftWrap, savedProposal, reviewQuestions, sendMetadata } = turn;
    const changes = changedSteps(closing.baseDraft, draftWrap.def);
    if (changes.length >= LARGE_CHANGE_STEPS || (draftWrap._pendingDatatables || []).length || (savedProposal && closing.staged)) {
        closing.proposal = stageProposal(turn, closing);
    } else if ((changes.length || closing.baseTitle !== draftWrap.title || closing.baseDescription !== draftWrap.description) && !reviewQuestions) {
        await persistDraftWrap(draftWrap);
        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
        sendMetadata();
        closing.baseDraft = structuredClone(draftWrap.def);
        closing.baseTitle = draftWrap.title; closing.baseDescription = draftWrap.description;
    }
}

/**
 * What the next turn must know about the question round: which round of the
 * plan cycle this was, and the approved plan the questions paused (the card
 * answers into it). A plan, an approval or a finished build closes the cycle.
 * @param {BuilderTurn} turn
 */
function questionsMetaOf(turn) {
    const { reviewQuestions, turnMode, planCycleRound, approvedPlan, planWritten, priorMeta } = turn;
    if (reviewQuestions) return { round: turnMode === 'plan' ? planCycleRound + 1 : 0, planId: approvedPlan?.id || null, mode: turnMode };
    return planWritten || approvedPlan ? null : priorMeta;
}

/**
 * The snapshot for SSE-resume and for the next turn's prompt: the
 * conversation so far (unsliced; the window at compose time bounds what the
 * model sees), the reply with its tool calls, the draft, the validation, the
 * summary, the to-do list, the catalogue order and the session's memory. The
 * store trims past 64KB in blocks of HISTORY_EVICT_BLOCK, so its trim lands
 * on the same boundaries as the prompt window.
 * @param {BuilderTurn} turn
 * @param {Closing} closing
 * @param {ReturnType<typeof questionsMetaOf>} questionsMeta
 */
async function storeSession(turn, closing, questionsMeta) {
    const { userId, message, history, messages, draftWrap, snapshot, reviewQuestions, tableChoice, catalogOrder, lastValidation, lastSummary } = turn;
    const { reviewPlan, proposal } = closing;
    try {
        const lastUserMessage = { role: 'user', content: message || '' };
        const assistantOut = collectAssistantTurn(messages);
        // closeTurn stores the session of a draft that has a row.
        await automationStore.setBuilderSession(/** @type {string} */ (draftWrap.automationId), userId, {
            sessionId: draftWrap.builderSessionId,
            draft: draftWrap.def,
            lastValidation: lastValidation || null,
            summary: lastSummary || null,
            conversation: [
                ...sanitizeHistory(history),
                lastUserMessage,
                ...(assistantOut ? [assistantOut] : []),
            ],
            reviewPlan, reviewQuestions, proposal, questionsMeta,
            // Tables the user chose or this session created: binding a step to
            // them needs no new consent. Written here because this write
            // rebuilds the snapshot field by field.
            approvedDatatableIds: [...new Set([...(snapshot?.approvedDatatableIds || []), ...(tableChoice?.approvedIds || []), ...(draftWrap._createdDatatableIds || [])])].slice(-200),
            todos: Array.isArray(draftWrap._todos) ? draftWrap._todos : [],
            updatedAt: new Date().toISOString(),
            ...(catalogOrder ? { catalogOrder } : {}),
            ...sessionMemory({ messages, fewShotMessages: turn.fewShotMessages, snapshot, draftWrap, proposal }),
        }, { trimBlock: HISTORY_EVICT_BLOCK });
    } catch (err) { bestEffort('usecases/ai/automationBuilder/turnClosing:closeTurn', err); /* non-fatal */ }
}

/**
 * @param {BuilderTurn} turn
 */
async function closeTurn(turn) {
    const { send, draftWrap, turnMode, bufferedBuild, isolated, savedProposal, modelId, usageTotals } = turn;
    // Never after a stop: the draft of a turn that ended on a step refused
    // three times is one the model could not finish, and "your draft
    // validates — finalising as-is" would contradict what the user just read.
    if (!isolated && !turn.lastFinalized && !turn.stopReason && !turn.pausedAfterStep && !turn.reviewQuestions) await autoFinalize(turn);
    if (!isolated && draftWrap.automationId && (!draftWrap.title || draftWrap.title === UNTITLED_AUTOMATION)) await nameUntitledDraft(turn);

    // A table staged (or dropped) this turn changes the proposal even when
    // no step did.
    const pendingChanged = !!draftWrap._stageDatatables
        && !isDeepStrictEqual(draftWrap._pendingDatatables || [], savedProposal?.pendingDatatables || []);
    const staged = JSON.stringify(turn.baseDraft) !== JSON.stringify(draftWrap.def) || turn.baseTitle !== draftWrap.title || turn.baseDescription !== draftWrap.description || pendingChanged;
    /** @type {Closing} */
    const closing = { reviewPlan: turn.reviewPlan, baseDraft: turn.baseDraft, baseTitle: turn.baseTitle, baseDescription: turn.baseDescription, proposal: null, staged, pendingChanged };
    if (turnMode === 'approve' && staged) closing.proposal = stageProposal(turn, closing);
    if (turn.approvedPlan) closeApprovedPlan(turn, closing);
    if (bufferedBuild) await closeBufferedBuild(turn, closing);
    // A waiting proposal nothing replaced stays waiting, as long as the
    // live draft it was staged against is unchanged.
    if (!closing.proposal && savedProposal && pendingProposal(savedProposal, isolated ? closing.baseDraft : draftWrap.def)) closing.proposal = savedProposal;
    if (closing.proposal) send('proposal_preview', clientProposal(closing.proposal));
    if (isolated) { draftWrap.def = closing.baseDraft; draftWrap.title = closing.baseTitle; draftWrap.description = closing.baseDescription; }
    const questionsMeta = questionsMetaOf(turn);
    // A new plan needs a document to own its saved conversation. Only the
    // original empty draft is saved here, never a proposed definition.
    if (!draftWrap.automationId && (closing.reviewPlan || closing.proposal || turn.reviewQuestions)) {
        await persistDraftWrap(draftWrap);
        send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });
    }
    if (draftWrap.automationId) await storeSession(turn, closing, questionsMeta);

    if (usageTotals.rounds > 0) {
        log.info(`[AutomationBuilder] usage session=${draftWrap.builderSessionId} model=${modelId} rounds=${usageTotals.rounds} in=${log.textForLog(usageTotals.prompt)} cached=${usageTotals.cached} cacheWrite=${usageTotals.cacheCreation} out=${usageTotals.completion}`);
        meterBuilderTurn(turn);
    }
}

/**
 * The full usage of a turn's rounds, beside the flat `usageTotals` the SSE
 * events carry: the sum keeps `prompt_includes_cache` and the 5m/1h cache-write
 * split, which the flat totals lose: an Anthropic prompt count rebuilt from
 * them reads as cache-inclusive, so the uncached input is rated at zero and
 * the 1h cache writes at the 5m rate.
 * @type {WeakMap<BuilderTurn, ReturnType<typeof createUsageAccumulator>>}
 */
const roundUsage = new WeakMap();

/**
 * Adds one round's usage (the adapter's, as it reported it) to the turn.
 * @param {BuilderTurn} turn
 * @param {unknown} usage
 */
function addRoundUsage(turn, usage) {
    let acc = roundUsage.get(turn);
    if (!acc) { acc = createUsageAccumulator(); roundUsage.set(turn, acc); }
    acc.add(usage);
}

/**
 * One usage row per builder turn (source automation_builder,
 * core/llm/surfaceUsage.js): the person, their organisation, the automation
 * being built, the builder session and the tokens of every round.
 * @param {BuilderTurn} turn
 * @param {import('../../../core/llm/surfaceUsage').UsageSink} [store] the ledger sink (default: the usage store)
 */
function meterBuilderTurn(turn, store) {
    const { userId, userOrgForTiers, modelId, usageTotals, draftWrap } = turn;
    const acc = roundUsage.get(turn);
    logSurfaceUsage({
        source: 'automation_builder', userId, orgId: userOrgForTiers, model: modelId,
        usage: acc && acc.hasUsage ? acc.total() : {
            prompt_tokens: usageTotals.prompt, completion_tokens: usageTotals.completion,
            cached_tokens: usageTotals.cached, cache_creation_tokens: usageTotals.cacheCreation,
        },
        agentId: draftWrap.automationId || null, conversationId: draftWrap.builderSessionId || null,
    }, store);
}

module.exports = { closeTurn, sessionMemory, meterBuilderTurn, addRoundUsage };
