import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import AppRefBreadcrumb from './AppRefBreadcrumb';
import BuildTab from './BuildTab';
import { buildHeaderProps, secondaryTriggerOptions } from './builderHeaderState';
import { makeBuilderSend } from './builderSend';
import BuilderShellView from './BuilderShellView';
import { triggerAppRef } from './flow/appRefLabel';
import { isBlankDefinition } from './flow/normalizeDefinition';
import RunsTab from './runs/RunsTab';
import useAutoLabelSteps from './useAutoLabelSteps';
import useAutomationPersistence, { makeBlockSkeleton } from './useAutomationPersistence';
import useBuilderChatPanel from './useBuilderChatPanel';
import useBuilderHotkeys from './useBuilderHotkeys';
import useBuilderHydration from './useBuilderHydration';
import useBuilderLifecycle from './useBuilderLifecycle';
import useBuilderReview from './useBuilderReview';
import useBuilderRuns from './useBuilderRuns';
import useBuilderTabUrl from './useBuilderTabUrl';
import { unwrapRow } from './unwrapRow';
import { useAssistantAsk, useSettingsSection, useWorkModePrefs } from './useBuilderShellState';
import UsedByButtonsCapsule from './UsedByButtonsCapsule';
import useFlowletActions from './useFlowletActions';
import useFlowletScope from './useFlowletScope';
import useManagedPart from './useManagedPart';
import useNdvState from './useNdvState';
import usePatternOrigin from './usePatternOrigin';
import VersionsTab from './versions/VersionsTab';
import { useOrgGroupsQuery } from '../../../api/queries/orgGroups';
import useAutomationApi from '../../../hooks/useAutomationApi';
import useAutomationBuilderStream from '../../../hooks/useAutomationBuilderStream';
import useTranslation from '../../../hooks/useTranslation';
import ExecutionsPanel from '../../admin/Studio/Executions/ExecutionsPanel';
import ManagedPartBanner from '../../shared/ManagedPartBanner';
import useConfirm from '../../shared/useConfirm';

/**
 * Split-view conversational builder.
 *
 * Reuses the EXACT same <InputArea> as direct chat (directMode=true) so
 * users get apps menu, model-tier selector, web search toggle, and file
 * attachments. State (tier, web-search, disabled media) lives in
 * scopedStorage so it persists across sessions just like direct chat.
 */
/**
 * Whether the builder should auto-fire an `autoSendInput` spec ("Build it
 * directly" from a suggestion card). Only on a brand-new builder (no
 * automationId) with no existing conversation — never into an automation the
 * user is already editing. Pure so it can be unit-tested without the shell.
 */
export function canAutoSend({ autoSendInput, automationId, messageCount }) {
    return !!autoSendInput && !automationId && (messageCount || 0) === 0;
}


/** The org groups a Step shares with, until the query has answered. */
const NO_GROUPS = [];

// Hosting hooks for a page that DRIVES the builder (Studio Playbooks):
//   onTurnEnd({ finalized, aborted, error, automationId, messageCount })
//     fires once per turn when the stream stops — the only way a host can
//     tell a finished build from one that asked a question or aborted
//     (onBuilderStateChange is URL state, onPublished is Step mode only).
//   forcedTier — a tier the host pins for every send of this mount; never
//     written to the user's remembered preference.
//   backLabel — the header's back destination in the host's words.
//   forceAssistantOpen — the host is about to auto-send a brief, so the
//     chat must be visible: `automationsAssistantOpen` is a per-user
//     preference and defaults to CLOSED, which meant a playbook could fire
//     its brief into a pane nobody could see and the room watched a static
//     canvas. The person may still close it; only the initial state is
//     forced, and the host's mount never writes the preference back.
//   seedMetadata — { title?, description? } a host already knows for the
//     draft the first send CREATES (the playbook stage reads `Title "…"`
//     off its brief). Sent with every send; the server honours it only
//     when that send creates the draft, so a re-send cannot rename.
//   patternOrigin — the "Find repeating work" pattern this new build
//     was opened from ({ signature?, suggestion }); usePatternOrigin
//     records `built` for it once the build is done.
export default function BuilderShell({ automationId, onBack, onOpenList = null, onExportJson = null, user, initialChatInput = '', autoSendInput = null, onAutomationIdResolved = null, initialScopeKey = null, onScopeChange = null, mode = 'automation', onPublished = null, initialTab = null, initialRunId = null, initialRunStepId = null, onBuilderStateChange = null, initialAppRef = null,
    onTurnEnd = null, forcedTier = null, backLabel = null, forceAssistantOpen = false, seedMetadata = null, patternOrigin = null }) {
    const api = useAutomationApi();
    // Step mode (kind='block'): same builder, but persistence targets the
    // /api/step router, the root is an input/output contract (no real trigger),
    // and there's no activate/run/AI-chat — you Publish to roll changes out.
    const isStep = mode === 'step';
    const apiGetOne = isStep ? api.getStep : api.getAutomation;
    const apiCreateOne = isStep ? api.createStep : api.createAutomation;
    const apiUpdateOne = isStep ? api.updateStep : api.updateAutomation;
    const { state, send, stop: stopBuild, hydrate, hydrateLastRun, setDraft, markServerConfirmed, acceptExternalDraft, dismissExternalDraft, dismissProposal, dismissPlan, executeStep, retryFromStep, stopRun, pollRunProgress, setRunResult, watchActiveRun, clearDryRun, clearError, setValidation, settleRun } = useAutomationBuilderStream({ automationId });
    const { serverAutomation, setServerAutomation } = useBuilderHydration({
        state, automationId, apiGetOne, unwrapRow, isStep, hydrate, hydrateLastRun, onAutomationIdResolved,
    });
    // `built` for a pattern-born build: on finalize, activate or publish, never on the first draft save.
    const markPatternBuilt = usePatternOrigin(isStep ? null : patternOrigin);

    // ── Managed by a Solution stage (design 9) — see useManagedPart ────────
    const { managedPart, managedNotDeployed, readOnly, readOnlyRef, noteManagedRefusal } = useManagedPart({ serverAutomation, isStep });
    // One in-app confirm for the whole builder — published through
    // BuilderConfirmContext so panels and hooks alike can ask a question
    // without falling back to the browser's own dialog.
    const { confirm, confirmDialog } = useConfirm();
    // Node Detail View (NDV) — the focused editor for ONE step; see useNdvState.
    const { ndvStepId, setNdvStepId, ndvDensity, setNdvDensity, ndvMode, setNdvMode, openNdv, closeNdv } = useNdvState();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    /**
     * Dismissing the fatal-error pill has to clear BOTH error sources, because
     * the pill renders both (`error || state.error`). A failed Execute step
     * raises `state.error` inside the stream hook, which the local `setError`
     * cannot reach — so the dismiss button rendered, did nothing, and the
     * error stayed until the next send or execute. That is a good part of why
     * one node's failure felt like the whole workflow was stuck on it
     * (BFSF-370).
     */
    const handleDismissFatal = useCallback(() => { setError(null); clearError(); }, [clearError]);

    const { tab, setTab, reportBuilderState, openRunInRuns } = useBuilderTabUrl({
        initialTab, initialRunId, initialRunStepId, onBuilderStateChange,
    });

    const {
        assistantOpen, setAssistantOpen,
        chatWidth, onChatResizeStart,
        chatInput, setChatInput,
        modelTiers, tierForSend, setTierForPicker,
        messagesContainerRef, messagesBodyRef, messagesEndRef,
        onMessagesScroll,
    } = useBuilderChatPanel({ forceAssistantOpen, initialChatInput, forcedTier, running: state.running });

    const { t } = useTranslation();
    const { workMode, setWorkMode, alwaysPlanLarge, setAlwaysPlanLarge } = useWorkModePrefs({
        automationId, streamAutomationId: state.automationId, startInBuild: !!(autoSendInput || forcedTier),
    });
    const { assistantContext, setAssistantContext, askAssistant, stepByIdForAssistant } = useAssistantAsk({
        readOnlyRef, ndvStepId, setTab, setAssistantOpen, setChatInput, t,
    });

    // A 409 ai_act_check_required from Activate / Make vN sends the person to the AI Act section.
    const { settingsSection, openSettingsAt } = useSettingsSection(tab, setTab);


    // Step mode: the sharing menu offers "specific groups" within the org, so
    // load the caller's org groups (same /auth/groups endpoint as KBs/Agents).
    // A refusal or a failed read leaves the menu on Personal/Org only.
    const { data: orgGroupsData } = useOrgGroupsQuery(isStep);
    const orgGroups = orgGroupsData ?? NO_GROUPS;

    // Step mode seeds a block skeleton so a brand-new Step opens with its
    // input + output contract already on the canvas (there is no trigger
    // picker step for Steps).
    const blockSeed = useMemo(() => (isStep ? makeBlockSkeleton() : null), [isStep]);
    // `isBlankDefinition` rather than a truthiness check: an automation whose row
    // was poisoned with `{}` (see BFSF-318) would otherwise be adopted as a
    // real definition and defeat the seed, leaving the canvas unable to
    // produce a well-formed graph. Treating it as absent lets the normal seed
    // path win, and the next save writes a valid definition — so affected
    // automations self-heal on open.
    const effectiveDef = !isBlankDefinition(state.draft) ? state.draft
        : !isBlankDefinition(serverAutomation?.definition) ? serverAutomation.definition
        : blockSeed;

    // The button in an app this builder belongs to. Two sources, and the URL
    // wins: `?from=` is where the person came from RIGHT NOW, while the
    // trigger's stored back-pointer is where the automation was made from. They
    // are normally the same; when they differ, the trail that got you here is
    // the one that has to lead back.
    const appRef = initialAppRef || triggerAppRef(effectiveDef);

    // The id the SERVER knows. The usage capsule asks the index about this
    // automation, and that index only exists once the automation does — a
    // builder that is still creating has nothing to ask.
    const persistedAutomationId = state.automationId || automationId || serverAutomation?.id || null;


    const { scopeKey, setScopeKey, scopedDef } = useFlowletScope({
        effectiveDef, initialScopeKey, onScopeChange, setNdvStepId,
    });

    const allSteps = useMemo(() => {
        if (!scopedDef) return [];
        // definition.triggers[] (scoped multi-trigger slice — webhook/app_event
        // additional entry points) must resolve here too, or clicking a
        // secondary trigger node opens an empty inspector.
        return [scopedDef.trigger, ...(scopedDef.triggers || []), ...(scopedDef.steps || [])].filter(Boolean);
    }, [scopedDef]);

    // Per-id lookups for the node-attached panels (settings / output).
    const stepById = useCallback((id) => allSteps.find(s => s.id === id) || null, [allSteps]);
    const runStepById = useCallback((id) => (state.steps || []).find(s => s.stepId === id && !s.parentStepId) || null, [state.steps]);

    stepByIdForAssistant.current = stepById;

    const turnBaseRef = useRef(null);

    // "Build it directly" — when the parent opens a fresh builder with an
    // autoSendInput spec (from a suggestion card), fire it once automatically
    // so the user watches the builder construct the automation instead of
    // having to press Send. Guarded so React StrictMode's double-mount and
    // re-renders can't double-fire; only on a brand-new builder with no
    // existing conversation. The fresh `key` mount per open resets the ref.
    const autoSentRef = useRef(false);
    const fireAutoSend = useEffectEvent(() => {
        if (!canAutoSend({ autoSendInput, automationId, messageCount: (state.messages || []).length })) return;
        autoSentRef.current = true;
        onSend(autoSendInput);
    });
    useEffect(() => {
        if (!autoSentRef.current) fireAutoSend();
    }, [autoSendInput, automationId]);

    // The falling edge of a turn, for a host that drives this builder: the
    // server's own verdict (`lastDone.finalized`, from its terminal `done`),
    // an abort, or an HTTP/stream error. Fires once per turn.
    const wasRunningRef = useRef(false);
    const reportTurnEnd = useEffectEvent(() => {
        if (turnBaseRef.current) draftHistory.checkpoint(turnBaseRef.current);
        turnBaseRef.current = null;
        if (state.lastDone?.finalized) markPatternBuilt();
        onTurnEnd?.({
            finalized: !!(state.lastDone && state.lastDone.finalized),
            aborted: !!state.aborted,
            error: state.error || null,
            automationId: state.automationId || automationId || null,
            messageCount: (state.messages || []).length,
        });
    });
    useEffect(() => {
        if (state.running) { wasRunningRef.current = true; return; }
        if (!wasRunningRef.current) return;
        wasRunningRef.current = false;
        reportTurnEnd();
    }, [state.running]);

    // Persistence, runs and the automation's lifecycle live in their own hooks
    // (useAutomationPersistence, useBuilderRuns, useBuilderLifecycle); the
    // shell wires them together and hands the result to BuilderShellLayout.
    const {
        savingState, ensureAutomationCreated, onSaveStep, draftHistory, onVisualEditRoot,
        onVisualEdit, syncServerRow, forceSaveNow, onSaveAutomation,
    } = useAutomationPersistence({
        api, isStep, apiCreateOne, apiUpdateOne, unwrapRow, state, serverAutomation, setServerAutomation,
        hydrate, setDraft, markServerConfirmed, setValidation, noteManagedRefusal, readOnlyRef,
        effectiveDef, scopeKey, setScopeKey, t,
    });
    // Defined after the persistence hook it saves through; the auto-send effect above only calls it once mounted.
    const onSend = makeBuilderSend({
        readOnlyRef, forceSaveNow, state, serverAutomation, effectiveDef, ensureAutomationCreated, setError, workMode,
        alwaysPlanLarge, autoSendInput, forcedTier, tierForSend, assistantContext, ndvStepId, scopeKey, seedMetadata,
        turnBaseRef, send,
    });
    const { formTest, handleExecuteStep, onDryRun, onRunLive, onFormTestRun, closeFormTest, openFormOverlay } = useBuilderRuns({
        api, state, effectiveDef, executeStep, watchActiveRun, setRunResult, settleRun, clearDryRun,
        ensureAutomationCreated, noteManagedRefusal, setBusy, setError, confirm, setTab, ndvStepId, openNdv,
    });
    const {
        aiActGate, setAiActGate, retryAfterAiAct, diagnoseAnchorRef,
        onActivate, onPublish, onDeactivate,
        diagnoseOpen, setDiagnoseOpen, diagnoseLoading, diagnoseError, diagnoseResult, onDiagnose,
        onPublishStep, onSetStepSharing, onSetStepExpose, onSetStepIcon, onSetStepCategory,
    } = useBuilderLifecycle({
        api, state, serverAutomation, setServerAutomation, unwrapRow, ensureAutomationCreated,
        markPatternBuilt, noteManagedRefusal, openSettingsAt, readOnlyRef, setBusy, setError, onPublished,
    });

    // Auto-name newly added steps (label + symbol) with the fast tier, debounced
    // on structural changes and never touching a field the user set by hand.
    //
    // OFF while the chat builder is running. It fires 2s after each structural
    // change, which is exactly the cadence at which the AI adds steps, so it
    // was renaming steps the builder was still writing — and every rename went
    // through onVisualEditRoot, moving the local draft out of step with
    // `lastServerDraft` until its own debounced PUT landed. The next `draft`
    // event from the stream then read that gap as the user editing underneath
    // the AI and raised the accept-or-keep-mine banner, on a canvas the user
    // could not touch. The builder names its own steps anyway; anything it
    // leaves blank is picked up by the pass that runs once the turn ends.
    useAutoLabelSteps({ def: effectiveDef, api, apply: onVisualEditRoot, enabled: !state.running && !readOnly });

    const { layerAgent, onBuildLayer, onRefineLayer, onRename, scope, onExitScope, onDeleteLayer } = useFlowletActions({
        effectiveDef, scopeKey, setScopeKey, ensureAutomationCreated, onVisualEditRoot, onSaveAutomation, confirm, readOnlyRef,
    });

    /**
     * Escape closes whichever modal/panel is on top, in priority order.
     * Returning early on each branch keeps the precedence explicit and
     * keeps Esc context-aware without a separate focus tracker.
     */
    const onEscape = useCallback(() => {
        if (ndvStepId) {
            closeNdv();
        }
    }, [ndvStepId, closeNdv]);

    useBuilderHotkeys({
        enabled: true,
        onUndo: draftHistory.undo,
        onRedo: draftHistory.redo,
        onSave: forceSaveNow,
        onDryRun,
        onEscape,
        onAssistant: () => askAssistant(),
    });


    const { applyingProposal, catalogNonce, clearReview, applyProposal } = useBuilderReview({
        state, serverAutomation, effectiveDef, dismissPlan, dismissProposal, onVisualEditRoot, onSaveAutomation, t,
    });

    const aidForHistory = state.automationId || automationId;

    // The "Start from" choice in the header's run menu: every additional
    // trigger by name, plus what to call the primary one.
    const secondaryTriggers = useMemo(() => secondaryTriggerOptions(effectiveDef), [effectiveDef]);
    const headerProps = buildHeaderProps({
        serverAutomation, effectiveDef, isStep, readOnly, managedPart, busy, tab, setTab, draftHistory, assistantOpen, askAssistant,
        onBack, backLabel, onOpenList, onExportJson, onActivate, onDeactivate, onDryRun, onRunLive, onDiagnose, onRename, mode,
        orgGroups, onPublishStep, onSetStepSharing, onSetStepExpose, onSetStepIcon, onSetStepCategory, scope, onExitScope,
        onDeleteLayer, diagnoseAnchorRef, savingState, onPublish, triggers: secondaryTriggers,
        breadcrumbSlot: breadcrumbSlot({ appRef, isStep, persistedAutomationId, readOnly, managedPart, managedNotDeployed }),
    });

    return (
        <BuilderShellView
            BuildTab={BuildTab}
            VersionsTab={VersionsTab}
            layout={{
                confirm, confirmDialog, aiActGate, setAiActGate, retryAfterAiAct, serverAutomation, state, tab, setTab,
                headerProps, diagnoseOpen, diagnoseResult, diagnoseLoading, diagnoseError, setDiagnoseOpen, diagnoseAnchorRef,
                onSaveAutomation, settingsSection, workMode, setWorkMode, isStep, setServerAutomation, onDryRun, t,
            }}
            build={{
                headerProps, mode, state, user, onSend, workMode, setWorkMode, alwaysPlanLarge, setAlwaysPlanLarge,
                assistantContext, chatWidth, onChatResizeStart, formTest, onFormTestRun, onCloseFormTest: closeFormTest,
                onOpenFormOverlay: openFormOverlay, onOpenRun: openRunInRuns,
                // The persisted row: the webhook trigger's node panel needs its id to list/create webhook URLs (BFSF-320).
                automation: serverAutomation,
                rootDef: effectiveDef, scopedDef, scopeKey, setScopeKey, onVisualEditRoot, chatInput, setChatInput, modelTiers,
                selectedTier: tierForSend, setSelectedTier: setTierForPicker, onApplyProposal: applyProposal, applyingProposal,
                catalogNonce, onStopBuild: stopBuild, messagesContainerRef, messagesBodyRef, messagesEndRef, onMessagesScroll,
                ndvStepId, ndvDensity, setNdvDensity, ndvMode, onNdvModeChange: setNdvMode, openNdv, closeNdv, stepById,
                runStepById, onSaveStep, onVisualEdit, onExecuteStep: handleExecuteStep, onRetryFromStep: retryFromStep,
                onStopRun: stopRun, pollRunProgress, onDismissFatal: handleDismissFatal, onDiagnose, acceptExternalDraft,
                dismissExternalDraft, onBuildLayer, onRefineLayer, layerAgentState: layerAgent.state,
            }}
            {...{ readOnly, assistantOpen, setAssistantOpen, setAssistantContext, askAssistant, error, clearReview, syncServerRow }}
            // Mounted HIDDEN by the layout rather than conditionally, see there.
            history={historySlot({
                automationId: aidForHistory,
                isStep,
                active: tab === 'history',
                initialRunId,
                initialRunStepId,
                onRunStateChange: reportBuilderState,
                onOpenEditor: (sid) => { setTab('build'); if (sid) openNdv(sid); },
            })}
        />
    );
}

// BuilderErrorBanner moved to FloatingValidationPill.jsx — the redesign
// surfaces these records as a sticky bottom-right pill on the Build tab
// instead of a top-of-canvas row that pushes content down.

/**
 * The strips the header renders itself, so they follow the bar into BuildTab's
 * ribbon instead of only existing on the other views.
 *
 * Two strips that answer different questions: the breadcrumb says "you came
 * from here" (one button, from the URL or from the trigger), the capsule says
 * "this is run by these" (every app button, from the index). An automation
 * opened through a link shows both; one opened from the list shows only the
 * second.
 *
 * Not for a reusable Step: AUTOMATIONS call it, not app buttons, and
 * `automation_usage` is not about that.
 */
function breadcrumbSlot({ appRef, isStep, persistedAutomationId, readOnly, managedPart, managedNotDeployed }) {
    if (!(appRef || (!isStep && persistedAutomationId) || readOnly)) return null;
    return (
        <>
            {readOnly ? <ManagedPartBanner managed={managedPart} notDeployed={managedNotDeployed} /> : null}
            {appRef ? <AppRefBreadcrumb appRef={appRef} /> : null}
            {!isStep && persistedAutomationId
                ? <UsedByButtonsCapsule automationId={persistedAutomationId} />
                : null}
        </>
    );
}

/** A Step lists its executions, an automation its runs; neither before it has an id. */
function historySlot({ automationId, isStep, active, initialRunId, initialRunStepId, onRunStateChange, onOpenEditor }) {
    if (!automationId) return null;
    if (!isStep) {
        return (
            <RunsTab
                automationId={automationId}
                active={active}
                initialRunId={initialRunId}
                initialStepId={initialRunStepId}
                onRunStateChange={onRunStateChange}
                onOpenEditor={onOpenEditor}
            />
        );
    }
    return (
        <ExecutionsPanel
            scope="step"
            stepId={automationId}
            active={active}
            initialRunId={initialRunId}
            initialStepId={initialRunStepId}
            onRunStateChange={onRunStateChange}
            onOpenEditor={() => onOpenEditor()}
        />
    );
}
