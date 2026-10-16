import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import AppRefBreadcrumb from './AppRefBreadcrumb';
import BuilderShellLayout from './BuilderShellLayout';
import BuildTab from './BuildTab';
import { followUpPlanId } from './chat/planBuild';
import { triggerAppRef } from './flow/appRefLabel';
import { normalizeDefinitionShape, isBlankDefinition } from './flow/normalizeDefinition';
import { triggerTypeLabel } from './flow/triggerLabels';
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
import scopedStorage from '../../../utils/scopedStorage';
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

export default function BuilderShell({ automationId, onBack, onOpenList = null, onExportJson = null, user, initialChatInput = '', autoSendInput = null, onAutomationIdResolved = null, initialScopeKey = null, onScopeChange = null, mode = 'automation', onPublished = null, initialTab = null, initialRunId = null, initialRunStepId = null, onBuilderStateChange = null, initialAppRef = null,
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
    const modeStorageKey = `automationWorkMode:${automationId || 'new'}`;
    const [workMode, setWorkMode] = useState(() => {
        if (autoSendInput || forcedTier) return 'build';
        const saved = scopedStorage.getItem(modeStorageKey);
        return ['discuss', 'approve', 'plan', 'build'].includes(saved) ? saved : 'approve';
    });
    useEffect(() => { scopedStorage.setItem(`automationWorkMode:${state.automationId || automationId || 'new'}`, workMode); }, [workMode, state.automationId, automationId]);
    const [alwaysPlanLarge, setAlwaysPlanLarge] = useState(() => scopedStorage.getItem(`automationLargePlan:${automationId || 'new'}`) !== 'false');
    useEffect(() => { scopedStorage.setItem(`automationLargePlan:${state.automationId || automationId || 'new'}`, String(alwaysPlanLarge)); }, [alwaysPlanLarge, state.automationId, automationId]);
    const [assistantContext, setAssistantContext] = useState(null);
    const askAssistant = useCallback((stepId = null, field = null) => {
        // The AI builder writes the definition: not on a managed automation.
        if (readOnlyRef.current) return;
        setTab('build');
        setAssistantOpen(true);
        const step = stepByIdForAssistant.current?.(stepId || ndvStepId);
        if (step) setAssistantContext({ id: step.id, label: step.label || step.type || step.kind });
        if (field) setChatInput(t('automations.assistant.map_prompt', 'Help me map the field "{field}". It expects {kind}. Current binding: {binding}.', {
            field: field.label || '', kind: field.expectKind || 'a value', binding: JSON.stringify(field.value ?? null),
        }));
    }, [ndvStepId, setTab, setAssistantOpen, setChatInput, t]);
    const stepByIdForAssistant = useRef(null);

    // The Settings section to open at (handoff 5): a 409
    // ai_act_check_required from Activate / Make vN live sends the person to
    // the AI Act section. Cleared when they leave Settings.
    const [settingsSection, setSettingsSection] = useState(null);
    useEffect(() => {
        if (tab !== 'settings') setSettingsSection(null);
    }, [tab]);
    // Open Settings at one section: the AI Act refusal below, and the
    // canvas's "Not in Files yet · add" tip (Start, with the Files dialog open).
    const openSettingsAt = useCallback((section) => {
        setSettingsSection(section || null);
        setTab('settings');
    }, [setTab]);

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

    // Het id dat de SERVER kent. De usage-capsule vraagt de index om deze
    // automatisering, en die index bestaat pas als de automatisering bestaat — een builder
    // die nog aan het maken is heeft niets te vragen.
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

    // InputArea calls onSendMessage(text, attachments, parentId).
    // We read webSearchEnabled / disabledMedia from scopedStorage so the
    // toggles in the input UI are picked up automatically.
    const turnBaseRef = useRef(null);
    const onSend = async (text, attachments, options = {}) => {
        if (readOnlyRef.current) return;
        try {
        const pendingSave = forceSaveNow();
        if (pendingSave) await pendingSave;
        const targetAutomationId = state.automationId || serverAutomation?.id || (!isBlankDefinition(effectiveDef) ? await ensureAutomationCreated(effectiveDef) : null);
        setError(null);
        const webSearchEnabled = scopedStorage.getItem('webSearchEnabled') !== 'false';
        const disabledMedia = scopedStorage.getJSON('disabledMedia', {}) || {};
        // Until the approved plan is done every message continues it ("continue",
        // "fix X", the answer to a question the build asked); only then does the
        // user's own work mode apply to the next request again.
        const approvedPlanId = options.approvedPlanId || followUpPlanId({ plan: state.reviewPlan, questionsPlanId: state.reviewQuestionsPlanId, answering: !!options.answers });
        turnBaseRef.current = workMode === 'build' || approvedPlanId ? structuredClone(effectiveDef || normalizeDefinitionShape(null)) : null;
        send({
            message: text,
            // Set when the text answers the builder's questions: the chat shows
            // the structured list, the model gets the text.
            answers: options.answers || null,
            targetAutomationId,
            workMode: approvedPlanId ? 'plan' : workMode,
            approvedPlanId,
            alwaysPlanLarge: !!alwaysPlanLarge && !autoSendInput && !forcedTier,
            pauseAfterStep: options.pauseAfterStep ?? (!!approvedPlanId && !!state.reviewPlan?.pauseAfterStep),
            selectedStepId: assistantContext?.id || ndvStepId || null,
            modelTier: tierForSend,
            attachments: attachments || [],
            webSearchEnabled,
            disabledMedia,
            // Which canvas the user is looking at — lets the server hint
            // the model's default `scope` for builder tool calls.
            canvasScope: scopeKey,
            seedMetadata: seedMetadata || null,
        });
        } catch (error) { setError(error.message || String(error)); }
    };

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


    const isActive = !!serverAutomation?.isActive;
    const isDraft = !!serverAutomation?.isDraft;
    const title = serverAutomation?.title || (isStep ? 'New Step' : 'New automation');
    // Diagnose button only makes sense for app_event triggers — schedule
    // and manual triggers have nothing to probe externally.
    const isAppEventTrigger = effectiveDef?.trigger?.kind === 'app_event';
    const statusLabel = isDraft ? 'Draft' : (isActive ? 'Live' : 'Paused');
    const statusBadgeClass = isDraft
        ? 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
        : isActive
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';

    const { applyingProposal, catalogNonce, clearReview, applyProposal } = useBuilderReview({
        state, serverAutomation, effectiveDef, dismissPlan, dismissProposal, onVisualEditRoot, onSaveAutomation, t,
    });

    const triggerKind = effectiveDef?.trigger?.kind || serverAutomation?.triggerType;
    const aidForHistory = state.automationId || automationId;

    // Whether the Activate control is enabled. A DRAFT can be activated as soon
    // as it's structurally complete (a trigger + at least one step) — the server
    // /activate route finalises (isDraft:false) AND validates the definition, so
    // it's the real gate. This decouples going-live from a successful chat
    // `builder_finalize` turn (which can be interrupted, e.g. by a connector
    // gateway timeout, leaving an otherwise-complete workflow stuck in Draft).
    const canActivate = !isStep
        && !!effectiveDef?.trigger
        && Array.isArray(effectiveDef?.steps) && effectiveDef.steps.length > 0;

    // The "Start from" choice in the header's run menu: every additional
    // trigger by name, plus what to call the primary one.
    const secondaryTriggerOptions = useMemo(() => (Array.isArray(effectiveDef?.triggers) ? effectiveDef.triggers : [])
        .filter(t => t && typeof t.id === 'string' && t.id)
        .map(t => ({ id: t.id, label: t.label || triggerTypeLabel(t), kind: t.kind || 'manual' })), [effectiveDef]);
    const primaryTriggerLabel = effectiveDef?.trigger?.label || triggerTypeLabel(effectiveDef?.trigger);

    // Header props bundled so the SAME header renders either at the shell level
    // (Settings / Run history / Version history) or inside BuildTab (the Editor
    // view, where it also hosts the add-step ribbon) — one unified top bar in
    // both cases. The view's id stays `build`; only its label reads "Editor".
    const headerProps = {
        title, triggerKind, isActive, isDraft, statusLabel, statusBadgeClass, canActivate,
        canDiagnose: isAppEventTrigger, busy, onBack, backLabel, onOpenList, onExportJson: isStep ? null : onExportJson, onActivate, onDeactivate,
        onDryRun, onRunLive, onDiagnose, onRename, mode,
        onAssistant: isStep || readOnly ? null : () => askAssistant(), assistantOpen: assistantOpen && !readOnly,
        triggers: secondaryTriggerOptions, primaryTriggerLabel,
        step: isStep ? serverAutomation : null, orgGroups, onPublishStep,
        onSetStepSharing, onSetStepExpose, onSetStepIcon, onSetStepCategory, scope, onExitScope,
        onDeleteLayer, diagnoseAnchorRef, savingState, tab, onTabChange: setTab,
        // `managed` rides on the row the header derives its live state from.
        automation: isStep ? null : (readOnly && serverAutomation ? { ...serverAutomation, managed: managedPart || {} } : serverAutomation),
        onPublish,
        // Undo/redo act on the CANVAS draft — pressing them from Settings or
        // Runs used to mutate a definition the user could not see. Jump to
        // the Editor first, so the change lands in view.
        onUndo: () => { if (tab !== 'build') setTab('build'); draftHistory.undo(); },
        onRedo: () => { if (tab !== 'build') setTab('build'); draftHistory.redo(); },
        canUndo: draftHistory.canUndo, canRedo: draftHistory.canRedo,
        // Rendered by the header itself, so the strip follows the bar into
        // BuildTab's ribbon instead of only existing on the other views.
        //
        // Twee stroken, en ze beantwoorden verschillende vragen: de kruimel
        // zegt "hier kwam je vandaan" (één knop, uit de URL of uit de trigger),
        // de capsule zegt "hier wordt dit door gedraaid" (élke app-knop, uit de
        // index). Een automatisering die je via een link opende hoort allebei te
        // tonen; eentje die je uit de lijst opende alleen de tweede.
        //
        // Niet voor een herbruikbare Step: die wordt door AUTOMATISERINGEN aangeroepen,
        // niet door app-knoppen, en `automation_usage` gaat daar niet over.
        breadcrumbSlot: (appRef || (!isStep && persistedAutomationId) || readOnly) ? (
            <>
                {readOnly ? <ManagedPartBanner managed={managedPart} notDeployed={managedNotDeployed} /> : null}
                {appRef ? <AppRefBreadcrumb appRef={appRef} /> : null}
                {!isStep && persistedAutomationId
                    ? <UsedByButtonsCapsule automationId={persistedAutomationId} />
                    : null}
            </>
        ) : null,
    };

    return (
        <BuilderShellLayout
            {...{
                confirm, confirmDialog, aiActGate, setAiActGate, retryAfterAiAct, serverAutomation, state, tab, setTab,
                headerProps, diagnoseOpen, diagnoseResult, diagnoseLoading, diagnoseError, setDiagnoseOpen, diagnoseAnchorRef,
                onSaveAutomation, settingsSection, workMode, setWorkMode, isStep, setServerAutomation, onDryRun, t,
            }}
            editor={tab === 'build' && (
                <BuildTab
                    headerProps={headerProps}
                    mode={mode}
                    // A managed automation's canvas is read-only for real (the
                    // draft never changes, nothing is saved) and the AI
                    // builder cannot be opened from it.
                    readOnly={readOnly}
                    assistantOpen={assistantOpen && !readOnly}
                    setAssistantOpen={readOnly ? noop : setAssistantOpen}
                    chatWidth={chatWidth}
                    onChatResizeStart={onChatResizeStart}
                    formTest={formTest}
                    onFormTestRun={onFormTestRun}
                    onCloseFormTest={closeFormTest}
                    onOpenFormOverlay={openFormOverlay}
                    onOpenRun={openRunInRuns}
                    state={state}
                    // The persisted row — the webhook trigger's node panel
                    // needs its id to list/create webhook URLs (BFSF-320).
                    automation={serverAutomation}
                    rootDef={effectiveDef}
                    scopedDef={scopedDef}
                    scopeKey={scopeKey}
                    setScopeKey={setScopeKey}
                    onVisualEditRoot={onVisualEditRoot}
                    chatInput={chatInput}
                    setChatInput={setChatInput}
                    modelTiers={modelTiers}
                    selectedTier={tierForSend}
                    setSelectedTier={setTierForPicker}
                    user={user}
                    onSend={onSend}
                    workMode={workMode}
                    setWorkMode={setWorkMode}
                    alwaysPlanLarge={alwaysPlanLarge}
                    setAlwaysPlanLarge={setAlwaysPlanLarge}
                    assistantContext={assistantContext}
                    onClearAssistantContext={() => setAssistantContext(null)}
                    onAskAssistant={readOnly ? null : askAssistant}
                    onApplyProposal={applyProposal}
                    applyingProposal={applyingProposal}
                    catalogNonce={catalogNonce}
                    onDiscardProposal={() => clearReview('discardProposal', state.proposal?.id)}
                    onRejectPlan={() => clearReview('rejectPlan', state.reviewPlan?.id)}
                    onApprovePlan={(pauseAfterStep) => onSend(t('automations.assistant.approved_prompt', 'I approve this plan. Build it and report any deviations.'), [], { approvedPlanId: state.reviewPlan?.id, pauseAfterStep })}
                    onStopBuild={stopBuild}
                    messagesContainerRef={messagesContainerRef}
                    messagesBodyRef={messagesBodyRef}
                    messagesEndRef={messagesEndRef}
                    onMessagesScroll={onMessagesScroll}
                    ndvStepId={ndvStepId}
                    ndvDensity={ndvDensity}
                    setNdvDensity={setNdvDensity}
                    ndvMode={ndvMode}
                    onNdvModeChange={setNdvMode}
                    openNdv={openNdv}
                    closeNdv={closeNdv}
                    stepById={stepById}
                    runStepById={runStepById}
                    onSaveStep={onSaveStep}
                    onVisualEdit={onVisualEdit}
                    onExecuteStep={handleExecuteStep}
                    onRetryFromStep={retryFromStep}
                    onStopRun={stopRun}
                    pollRunProgress={pollRunProgress}
                    fatalError={error || state.error}
                    onDismissFatal={handleDismissFatal}
                    onDiagnose={onDiagnose}
                    acceptExternalDraft={acceptExternalDraft}
                    dismissExternalDraft={dismissExternalDraft}
                    onBuildLayer={onBuildLayer}
                    onRefineLayer={onRefineLayer}
                    layerAgentState={layerAgent.state}
                />
            )}
            versions={tab === 'versions' && (
                <VersionsTab automation={serverAutomation} onRestored={syncServerRow} />
            )}
            // Mounted HIDDEN by the layout rather than conditionally, see there.
            history={aidForHistory && !isStep ? (
                <RunsTab
                    automationId={aidForHistory}
                    active={tab === 'history'}
                    initialRunId={initialRunId}
                    initialStepId={initialRunStepId}
                    onRunStateChange={reportBuilderState}
                    onOpenEditor={(sid) => { setTab('build'); if (sid) openNdv(sid); }}
                />
            ) : aidForHistory ? (
                <ExecutionsPanel
                    scope="step"
                    stepId={aidForHistory}
                    active={tab === 'history'}
                    initialRunId={initialRunId}
                    initialStepId={initialRunStepId}
                    onRunStateChange={reportBuilderState}
                    onOpenEditor={() => setTab('build')}
                />
            ) : null}
        />
    );
}

// BuilderErrorBanner moved to FloatingValidationPill.jsx — the redesign
// surfaces these records as a sticky bottom-right pill on the Build tab
// instead of a top-of-canvas row that pushes content down.

function noop() { /* the AI builder has no way in on a managed automation */ }
