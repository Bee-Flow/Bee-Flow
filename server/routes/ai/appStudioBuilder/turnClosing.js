/**
 * App Studio Builder — how a turn ends.
 *
 * Four things happen after the build loop, in this order: a proposed plan is
 * persisted and handed to the client for approval; the auto-finalize net
 * decides whether a draft the model never finalized is saved anyway, handed a
 * continuation token, or reported as out of budget; the session snapshot is
 * written so a refresh rehydrates the same conversation; and the turn is
 * classified for the usage row.
 *
 * `turn` is the loop's live state object (see ./buildLoop.js) — these
 * functions read what the loop recorded, and the net writes its own verdict
 * back onto it.
 */

const crypto = require('crypto');
const studioAppStore = require('../../../stores/studioAppStore');
const { validateAppDefinition } = require('../../../appStudio/validate');
const { applyToolCall, persistDraft } = require('../../../appStudio/builderTools');
const { briefForSnapshot } = require('../../../appStudio/builderTools/appNaming');
const { summariseApp } = require('../../../appStudio/builderPrompt');
const { HISTORY_EVICT_BLOCK } = require('./turnMessages');

/** A plan proposed this turn: persist it, hand it over, and wait. */
async function handleProposedPlan(turn, { draftWrap, send }) {
    // ── Wave 5: a proposed plan ends the turn awaiting approval. Persist
    //    it (pendingPlan) so a refresh mid-review rehydrates the PlanCard —
    //    which needs an app row, so create one for a still-fresh draft. ──
    let awaitingPlan = false;
    if (turn.proposedPlan) {
        if (!draftWrap.appId) { try { await persistDraft(draftWrap); } catch (_) { /* no persistence this turn */ } }
        send('plan', turn.proposedPlan);
        awaitingPlan = true;
    }
    return awaitingPlan;
}

/** The auto-finalize net — see the note inside for the two exits it runs on. */
async function runAutoFinalizeNet(turn, { draftWrap, iterationBudget, approvedPlanForTurn, send, sendError }) {
    // The auto-finalize net. It runs on exactly two exits:
    //  • the BUDGET ran out (iter reached iterationBudget) — the original
    //    net: a small model that produced a valid app and never got to
    //    app_finalize should not have its work abandoned. Two cases there:
    //    MID-PLAN (an approved plan still in flight) + the draft validates
    //    → do NOT finalize a half-built plan; hand back a continuation
    //    token so the client resumes the next phase on the SAME tier.
    //    Otherwise + the draft validates → finalize it.
    //  • the MODEL closed the turn on a final message after building
    //    something this turn (the same hole the routine builder's net had:
    //    "I have built the app!" with no app_finalize left the playbook
    //    phase running, the handoff card asking a question, and the
    //    presenter pressing Mark as done live). Built is the condition:
    //    finalizing a prose-only reply would flip a phase to done — and
    //    save a new version — on a turn that changed nothing.
    // Never after a stop or a failure — the repeat ladder's rung 3, a
    // truncated or empty reply, a provider error, a closed tab: the draft
    // is one the model could not finish, the user has just read a sentence
    // saying so, and "the app validates — saved" would contradict it (the
    // routine builder's `!stopReason`, for the same reason). Never mid-plan
    // on a prose exit either: a half-built plan is not finalized, and the
    // continuation wording belongs to the budget case.
    // The gate is app_dry_run's STATIC pass: the same data-aware
    // validateAppDefinition an auto-finalize must clear; the DATA pass is
    // skipped — 0-rows would only warn anyway.
    let continuation = null;
    let budgetExhausted = false;
    const budgetOut = turn.iter >= iterationBudget;
    const builtAndEnded = turn.modelEndedTurn && turn.builtThisTurn && !approvedPlanForTurn;
    if (!turn.lastFinalized && !turn.persistBroken && !turn.proposedPlan && draftWrap.appId && (budgetOut || builtAndEnded)) {
        const finalCheck = validateAppDefinition(draftWrap.def, {
            dataModel: draftWrap.dataModel,
            datasets: draftWrap.datasetIds,
            datatables: draftWrap._ownerDatatables,
        });
        if (approvedPlanForTurn && finalCheck.ok) {
            const token = `cont_${crypto.randomBytes(6).toString('hex')}`;
            const phases = Array.isArray(approvedPlanForTurn.phases) ? approvedPlanForTurn.phases : [];
            const nextIdx = turn.lastPhaseIndex === null ? 0 : turn.lastPhaseIndex + 1;
            const nextPhase = nextIdx < phases.length
                ? { index: nextIdx, label: phases[nextIdx].label ?? null }
                : { index: nextIdx, label: null };
            continuation = { token, nextPhase };
            send('message', { content: 'I paused between phases to stay within the build budget — continue to build the next phase.' });
        } else if (finalCheck.ok) {
            const finalized = await applyToolCall('app_finalize', {}, draftWrap);
            if (finalized && finalized.finalized) {
                turn.lastFinalized = true;
                send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
                // Say WHY, truthfully: on a turn the model closed itself
                // nothing ran out, so the budget wording would be a lie
                // printed right under the model's own closing sentence.
                send('message', { content: budgetOut
                    ? 'I ran out of build turns but the app validates — saved as-is. Tell me what to adjust next.'
                    : 'The app validates — saved as it stands. Tell me what to adjust next.' });
            }
        } else if (budgetOut) {
            // Budget exhausted, the draft still has validation errors, and
            // there's no approved plan to continue — surface it cleanly
            // (Wave 6c taxonomy) rather than ending on a silent unfinalized
            // done. The draft is persisted, so the user can just send again.
            budgetExhausted = true;
            sendError('budget_exhausted', 'I ran out of build turns and the app still has issues to fix — send another message and I\'ll keep going.');
        }
        // The model closed the turn on a draft that does not validate: the
        // validation report already streamed after the last mutation, and
        // the turn ends unfinalized — as it always did.
    }
    return { continuation, budgetExhausted };
}

/** The session snapshot the client rehydrates from. Non-fatal by design. */
async function persistTurnSnapshot(turn, {
    draftWrap, userId, history, inboundImages, effectiveMessage, proseParts,
    resolvedTier, approvedPlanForTurn, isApproval, priorSnapshot, continuation,
}) {
    // Session snapshot for rehydration (owner-scoped; store trims >64KB but
    // never the pinned plan-first keys). approvedPlan/pendingPlan/continueToken
    // are cleared once the build finalizes ("until phases complete").
    if (draftWrap.appId) {
        try {
            const conversationTail = [
                ...history,
                // Images never enter the snapshot (they'd blow the 64KB trim
                // and sanitizeHistory keeps string content only) — but leave
                // a one-line trace so a later turn knows a picture was shown.
                { role: 'user', content: inboundImages.length
                    ? `${String(effectiveMessage)}\n(the user attached ${inboundImages.length} image${inboundImages.length === 1 ? '' : 's'} on this turn)`
                    : String(effectiveMessage) },
                ...(proseParts.length ? [{ role: 'assistant', content: proseParts.join('') }] : []),
            ];
            const snapshotBody = {
                sessionId: draftWrap.builderSessionId,
                appId: draftWrap.appId,
                messages: conversationTail,
                lastValidation: turn.lastValidation || null,
                summary: summariseApp(draftWrap.def, { dataModel: draftWrap.dataModel, datasets: draftWrap.datasetIds }),
                updatedAt: new Date().toISOString(),
                lastTier: resolvedTier,
                ...(Array.isArray(draftWrap._todos) && draftWrap._todos.length ? { todos: draftWrap._todos } : {}),
                brief: briefForSnapshot(draftWrap._turnMessage), // survives the HEAD trim of `messages`; undefined = no key
            };
            if (!turn.lastFinalized) {
                if (approvedPlanForTurn) snapshotBody.approvedPlan = approvedPlanForTurn;
                // Keep the pending plan around (proposed this turn, or still
                // under review from a prior turn) until it is approved.
                const pendingPlan = turn.proposedPlan
                    || (isApproval ? null : priorSnapshot?.pendingPlan)
                    || null;
                if (pendingPlan) snapshotBody.pendingPlan = pendingPlan;
                if (continuation) snapshotBody.continueToken = continuation.token;
            }
            // Uncapped here; the store evicts from the HEAD in whole
            // blocks when the snapshot is over size, so the prefix the
            // model saw survives between evictions (the routine builder's
            // builderSessions pattern).
            await studioAppStore.setBuilderSession(draftWrap.appId, userId, snapshotBody, { trimBlock: HISTORY_EVICT_BLOCK });
        } catch (_) { /* non-fatal */ }
    }
}

/** How the turn ended, for the usage row's stop_reason → OpenObserve. */
function classifyTurnOutcome(turn, { awaitingPlan, continuation, budgetExhausted }) {
    return turn.lastFinalized ? 'finalized'
        : awaitingPlan ? 'awaiting_plan'
            : continuation ? 'continuation'
                : turn.persistBroken ? 'save_conflict'
                    : budgetExhausted ? 'budget_exhausted'
                        : turn.clientGone ? 'client_disconnected'
                            : 'incomplete';
}

module.exports = { handleProposedPlan, runAutoFinalizeNet, persistTurnSnapshot, classifyTurnOutcome };
