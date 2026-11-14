/** @typedef {import('./turnSetup').BuilderTurn} BuilderTurn */
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
const log = require('../../../telemetry/log');
const { logSurfaceUsage } = require('../../../core/llm/surfaceUsage');
const { createUsageAccumulator } = require('../../../core/providers/usageNormalizer');
const automationStore = require('../../../stores/automationStore');
const { applyToolCall } = require('../../../automation/builderTools');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const { ensureDraftTitle, UNTITLED_AUTOMATION } = require('../../../automation/builderTools/deriveTitle');
const { HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { persistDraftWrap } = require('./builderDraft');
const { LARGE_CHANGE_STEPS, changedSteps, pendingProposal } = require('../../../usecases/ai/automationBuilder/workMode');
const { proposalPreviewPayload, clientProposal } = require('./datatableTurn');
const { sanitizeHistory, collectAssistantTurn } = require('../../../usecases/ai/automationBuilder/chatTurnLoop');
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
 * @param {BuilderTurn} turn
 */
async function closeTurn(turn) {
    const {
        send, userId, message, history, messages, draftWrap, snapshot, reviewQuestions, approvedPlan, turnMode,
        bufferedBuild, isolated, savedProposal, priorMeta, planCycleRound, planWritten, pausedAfterStep,
        tableChoice, catalogOrder, modelId, brief, sendMetadata, iterationBudget, usageTotals,
        stopReason, lastValidation, lastSummary,
    } = turn;
    let { reviewPlan, baseDraft, baseTitle, baseDescription } = turn;
    // If the model exhausted its iteration budget without finalizing,
    // try to auto-finalize when the draft is structurally complete.
    // Small models sometimes run out of conversational turns AFTER
    // they've already produced a valid graph — abandoning the work
    // would force the user to start over, even though the automation
    // is ready. We only fall back when:
    //   - the draft passes validateDefinition,
    //   - it has a trigger and at least one step (non-empty), and
    //   - the model didn't itself call builder_finalize already.
    //
    // Never after a stop: a turn that ended because one step was refused
    // three times has a draft the model could not finish, and "your draft
    // validates — finalising as-is" would contradict the sentence the
    // user just read. (A wasted round is charged an extra iteration, so a
    // no_progress stop can land exactly on the budget.)
    // `iter >= iterationBudget` used to gate this too, so the net only
    // caught a build that ran OUT of rounds. Every other exit — a final
    // assistant message, a truncation give-up, two empty replies — left
    // `is_draft = true`, and the most common small-model ending is exactly
    // that: four good steps, a clean dry run, then "Your automation is
    // ready" with no builder_finalize. The playbook then read the turn as
    // unfinished and the presenter pressed Mark as done on stage.
    // The draft still has to pass validateDefinition and have a trigger and
    // a real step, so nothing half-built is finalised by this.
    if (!isolated && !turn.lastFinalized && !stopReason && !pausedAfterStep && !reviewQuestions) {
        const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
        const def = draftWrap.def;
        const hasTrigger = !!def?.trigger;
        // A note is a canvas annotation, not a step the
        // automation runs — a draft the model only ever left a sticky note
        // on (never adding real work) must not read as "has a step" and
        // get auto-finalized as if it were a working automation.
        const hasStep = Array.isArray(def?.steps) && def.steps.some((s) => s?.type !== 'note');
        if (finalCheck.ok && hasTrigger && hasStep) {
            // Same rule as the model's own finalize: an automation never
            // ships as "Untitled automation".
            const titleBefore = draftWrap.title;
            const titled = ensureDraftTitle(draftWrap, { brief });
            try {
                const finalized = await applyToolCall('builder_finalize', {}, draftWrap);
                if (finalized?.automation) {
                    send('finalized', { automationId: finalized.automation.id, autoFinalized: true, ...(Array.isArray(finalized.needs) ? { needs: finalized.needs } : {}) });
                    if (titled.derived) sendMetadata();
                    send('message', { content: 'I ran out of conversational turns but your draft validates — finalising as-is. Activate when ready.' });
                    turn.lastFinalized = true;
                }
            } catch (e) {
                log.warn('[AutomationBuilder] auto-finalize failed:', /** @type {Error} */ (e).message);
            }
            // Same as after the model's finalize: a name the failed call
            // never wrote goes back to the default, so the block below
            // persists it.
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

    // A draft that exists and is still untitled at the end of the turn —
    // not finalized, so neither path above named it (or tried and threw,
    // and put the default back) — gets its name now, so the list, the
    // header and the playbook rail never show the default. Only a
    // persisted draft: a turn that built nothing has no row to name.
    if (!isolated && draftWrap.automationId && (!draftWrap.title || draftWrap.title === UNTITLED_AUTOMATION)) {
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

    // A table staged (or dropped) this turn changes the proposal even when
    // no step did.
    const pendingChanged = !!draftWrap._stageDatatables
        && !isDeepStrictEqual(draftWrap._pendingDatatables || [], savedProposal?.pendingDatatables || []);
    const staged = JSON.stringify(baseDraft) !== JSON.stringify(draftWrap.def) || baseTitle !== draftWrap.title || baseDescription !== draftWrap.description || pendingChanged;
    // The same proposal keeps its id while the turn added nothing to it.
    const stageProposal = () => (savedProposal && !pendingChanged && isDeepStrictEqual(savedProposal.definition, draftWrap.def)
        && savedProposal.title === draftWrap.title && savedProposal.description === draftWrap.description)
        ? savedProposal
        : { id: randomUUID(), ...proposalPreviewPayload(draftWrap, baseDraft) };
    let proposal = turnMode === 'approve' && staged ? stageProposal() : null;
    if (approvedPlan) {
        // `built` only when the plan is done. A turn that ended any other way
        // (an error, the iteration budget, a model that gave up) leaves it
        // `building`, and the follow-up ("continue", "fix X") goes on with
        // the same approved plan instead of starting a new planning turn.
        const todosNow = Array.isArray(draftWrap._todos) ? draftWrap._todos : [];
        const planDone = turn.lastFinalized || (todosNow.length > 0 && todosNow.every(t => t.done));
        reviewPlan = { ...reviewPlan, status: reviewQuestions || pausedAfterStep ? 'paused' : planDone ? 'built' : 'building', baseDefinition: structuredClone(draftWrap.def) };
        send('review_plan', { plan: reviewPlan });
    }
    if (bufferedBuild) {
        const changes = changedSteps(baseDraft, draftWrap.def);
        // A large change becomes the same one-click proposal approve mode
        // makes (Apply / Discard on the card). It must not become a plan
        // listing the changes: approving that plan throws the staged
        // definition away and has the agent build it all again.
        // A turn that worked on a waiting proposal never commits by
        // itself: that proposal's changes have not been approved.
        // A new table never commits by itself: creating it is the user's Apply.
        if (changes.length >= LARGE_CHANGE_STEPS || (draftWrap._pendingDatatables || []).length || (savedProposal && staged)) {
            proposal = stageProposal();
        } else if ((changes.length || baseTitle !== draftWrap.title || baseDescription !== draftWrap.description) && !reviewQuestions) {
            await persistDraftWrap(draftWrap);
            send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
            sendMetadata();
            // Keep the committed result as the baseline for the snapshot.
            baseDraft = structuredClone(draftWrap.def);
            baseTitle = draftWrap.title; baseDescription = draftWrap.description;
        }
    }
    // A waiting proposal nothing replaced stays waiting, as long as the
    // live draft it was staged against is unchanged.
    if (!proposal && savedProposal && pendingProposal(savedProposal, isolated ? baseDraft : draftWrap.def)) proposal = savedProposal;
    if (proposal) send('proposal_preview', clientProposal(proposal));
    if (isolated) { draftWrap.def = baseDraft; draftWrap.title = baseTitle; draftWrap.description = baseDescription; }
    // What the next turn must know about the question round: which round of the
    // plan cycle this was, and the approved plan the questions paused (the card
    // answers into it). A plan, an approval or a finished build closes the cycle.
    let questionsMeta;
    if (reviewQuestions) questionsMeta = { round: turnMode === 'plan' ? planCycleRound + 1 : 0, planId: approvedPlan?.id || null, mode: turnMode };
    else if (planWritten || approvedPlan) questionsMeta = null;
    else questionsMeta = priorMeta;
    // A new plan needs a document to own its saved conversation. Only the
    // original empty draft is saved here, never a proposed definition.
    if (!draftWrap.automationId && (reviewPlan || proposal || reviewQuestions)) {
        await persistDraftWrap(draftWrap);
        send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });
    }
    // Snapshot for SSE-resume and for the next turn's prompt. Captures the
    // conversation so far (unsliced — the head-anchored window at compose
    // time bounds what the model sees), the assistant's reply with its
    // tool calls, the latest draft, the structured validation, any
    // summary, the to-do list, and the catalogue order this session
    // renders its system prompt in, and the session's memory (sessionMemory:
    // inspected tool names, the last test run's shape hints). The store trims oldest tool results
    // and then oldest messages past 64KB, in blocks of HISTORY_EVICT_BLOCK
    // so its trim lands on the same boundaries as the prompt window.
    if (draftWrap.automationId) {
        try {
            const lastUserMessage = { role: 'user', content: message || '' };
            const assistantOut = collectAssistantTurn(messages);
            await automationStore.setBuilderSession(draftWrap.automationId, userId, {
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
        } catch (err) { bestEffort('routes/ai/automationBuilder/turnClosing:closeTurn', err); /* non-fatal */ }
    }

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
