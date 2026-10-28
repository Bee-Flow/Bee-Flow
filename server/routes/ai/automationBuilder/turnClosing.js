/** @typedef {import('./turnSetup').BuilderTurn} BuilderTurn */
// @typecheck noImplicitAny
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
const automationStore = require('../../../stores/automationStore');
const { applyToolCall } = require('../../../automation/builderTools');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const { ensureDraftTitle, UNTITLED_AUTOMATION } = require('../../../automation/builderTools/deriveTitle');
const { HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { persistDraftWrap } = require('./builderDraft');
const { LARGE_CHANGE_STEPS, changedSteps, pendingProposal } = require('./workMode');
const { proposalPreviewPayload, clientProposal } = require('./datatableTurn');
const { sanitizeHistory, collectAssistantTurn } = require('./chatTurnLoop');
const { bestEffort } = require('../../../utils/bestEffort');

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
                    send('finalized', { automationId: finalized.automation.id, autoFinalized: true });
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
    // renders its system prompt in. The store trims oldest tool results
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
                ...(catalogOrder ? { catalogOrder } : {}),
                updatedAt: new Date().toISOString(),
            }, { trimBlock: HISTORY_EVICT_BLOCK });
        } catch (err) { bestEffort('routes/ai/automationBuilder/turnClosing:closeTurn', err); /* non-fatal */ }
    }

    if (usageTotals.rounds > 0) {
        log.info(`[AutomationBuilder] usage session=${draftWrap.builderSessionId} model=${modelId} rounds=${usageTotals.rounds} in=${log.textForLog(usageTotals.prompt)} cached=${usageTotals.cached} cacheWrite=${usageTotals.cacheCreation} out=${usageTotals.completion}`);
    }
}

module.exports = { closeTurn };
