import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import AppRefBreadcrumb from './AppRefBreadcrumb';
import UsedByButtonsCapsule from './UsedByButtonsCapsule';
import ExecutionsPanel from '../../admin/Studio/Executions/ExecutionsPanel';
import { BuilderConfirmProvider } from './BuilderConfirmContext';
import BuilderHeader from './BuilderHeader';
import { deepEqual } from '../../../utils/deepEqual';
import useTranslation from '../../../hooks/useTranslation';
import { toast } from '../../shared/Toast';
import BuildTab from './BuildTab';
import { triggerAppRef } from './flow/appRefLabel';
import {
    setScopedGraph, deleteLayerFromDefinition, deleteLayerAndCalls,
    isLayerEmpty, renameLayer, countLayerRefs,
} from './flow/flowletScope';
import { normalizeDefinitionShape, isBlankDefinition } from './flow/normalizeDefinition';
import { densityForOpen } from './flow/settings/formDensity';
import useFormModePreference from './flow/settings/useFormModePreference';
import { triggerTypeLabel } from './flow/triggerLabels';
import useAutomationDraftHistory from './flow/useAutomationDraftHistory';
import RunsTab from './runs/RunsTab';
import AiActQuestionsDialog from './settings/AiActQuestionsDialog';
import SettingsTab from './SettingsTab';
import TriggerDiagnosePanel from './TriggerDiagnosePanel';
import useAutoLabelSteps from './useAutoLabelSteps';

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

// A fresh Step's root graph: a single layer_input trigger (its input contract)
// + a single layer_output step (its return). Same shape as an inline Flowlet,
// but at the document root. Seeded so the canvas is usable immediately.
function makeBlockSkeleton() {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [{ id: 'out', type: 'layer_output', fields: {} }],
        edges: [],
    };
}

import useBuilderChatPanel from './useBuilderChatPanel';
import useBuilderHotkeys from './useBuilderHotkeys';
import useBuilderHydration from './useBuilderHydration';
import useBuilderTabUrl from './useBuilderTabUrl';
import useFlowletScope from './useFlowletScope';
import usePatternOrigin from './usePatternOrigin';
import VersionsTab from './versions/VersionsTab';
import { publishAutomation, isAiActRefusal } from '../../../api/queries/automation/meta';
import { readinessStamp } from '../../../api/queries/automation/readiness';
import useAutomationApi from '../../../hooks/useAutomationApi';
import useAutomationBuilderStream from '../../../hooks/useAutomationBuilderStream';
import useFlowletAgentStream from '../../../hooks/useFlowletAgentStream';
import { API_BASE, authFetch } from '../../../utils/helpers';
import scopedStorage from '../../../utils/scopedStorage';
import { declaresManaged, managedOf, managedRefusalOf } from '../../shared/managedPart';
import ManagedPartBanner from '../../shared/ManagedPartBanner';
import useConfirm from '../../shared/useConfirm';

export default function BuilderShell({ automationId, onBack, onOpenList = null, user, initialChatInput = '', autoSendInput = null, onAutomationIdResolved = null, initialScopeKey = null, onScopeChange = null, mode = 'automation', onPublished = null, initialTab = null, initialRunId = null, initialRunStepId = null, onBuilderStateChange = null, initialAppRef = null,
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
    // `managed` sits BESIDE the row in a GET answer ({ automation, summary,
    // managed }); it is carried onto the row so the header and the read-only
    // switch below see it wherever they read the automation from.
    const unwrapRow = (r) => {
        const row = (r && (r.automation || r.step)) || r;
        return row && r && r.automation && r.managed !== undefined ? { ...row, managed: r.managed } : row;
    };
    const { state, send, stop: stopBuild, hydrate, hydrateLastRun, setDraft, markServerConfirmed, acceptExternalDraft, dismissExternalDraft, dismissProposal, dismissPlan, executeStep, retryFromStep, stopRun, pollRunProgress, setRunResult, watchActiveRun, clearDryRun, clearError, setValidation, settleRun } = useAutomationBuilderStream({ automationId });
    const { serverAutomation, setServerAutomation } = useBuilderHydration({
        state, automationId, apiGetOne, unwrapRow, isStep, hydrate, hydrateLastRun, onAutomationIdResolved,
    });
    // `built` for a pattern-born build: on finalize, activate or publish, never on the first draft save.
    const markPatternBuilt = usePatternOrigin(isStep ? null : patternOrigin);

    // ── Managed by a Solution stage (design 9) ────────────────────────────
    // What the server said on the GET (`managed`), kept across the answers of
    // a save or an activate that do not repeat it, and whatever a refused
    // write or run said (409 managed_part[_not_deployed]) for a tab that was
    // opened before the stage took the automation over. A managed automation is
    // read-only for real: the canvas gets `readOnly`, the draft never changes,
    // nothing is saved and the AI builder cannot be entered. On/Off and Run
    // stay (the live state and the stage decide those).
    const [managedSeen, setManagedSeen] = useState(null);
    const [managedRefusal, setManagedRefusal] = useState(null);
    useEffect(() => {
        if (declaresManaged(serverAutomation)) setManagedSeen(managedOf(serverAutomation));
    }, [serverAutomation]);
    const managedPart = isStep ? null : (managedSeen ?? managedRefusal?.managed ?? null);
    const managedNotDeployed = !isStep && managedRefusal?.reason === 'not_deployed';
    const readOnly = !isStep && (!!managedPart || managedRefusal != null);
    const readOnlyRef = useRef(false);
    readOnlyRef.current = readOnly;
    /** True when `e` was the stage's refusal; the banner then speaks for it. */
    const noteManagedRefusal = useCallback((e) => {
        const info = managedRefusalOf(e);
        if (info) setManagedRefusal(info);
        return !!info;
    }, []);
    // One in-app confirm for the whole builder — published through
    // BuilderConfirmContext so panels and hooks alike can ask a question
    // without falling back to the browser's own dialog.
    const { confirm, confirmDialog } = useConfirm();
    // Node Detail View (NDV) — the focused Input|Parameters|Output editor for
    // ONE step. `ndvStepId` is the step being edited (null = closed). Replaces
    // the old node-anchored peek + multi-pin dock.
    const [ndvStepId, setNdvStepId] = useState(null);
    // How much of the step to show: a single click opens the SMALL editor
    // (just the settings the step needs), a double click the full
    // Input|Parameters|Output workspace.
    //
    // The drawer reopens the way it was LEFT: the last quick/full choice is
    // remembered per user (user request 2026-09-03). A double click still
    // forces the full view — formDensity.densityForOpen. Inside an open
    // drawer the ⤢ / shrink buttons and the column toggles switch freely,
    // and every switch updates the memory.
    const [ndvDensity, setNdvDensityState] = useState(() => (scopedStorage.getItem('ndvDensity') === 'full' ? 'full' : 'quick'));
    const setNdvDensity = useCallback((d) => {
        const next = d === 'full' ? 'full' : 'quick';
        setNdvDensityState(next);
        scopedStorage.setItem('ndvDensity', next);
    }, []);
    // How much of the step's FORM exists (Simple / All options) — the user's
    // persisted choice, orthogonal to the gesture-owned density above.
    const { mode: ndvMode, setMode: setNdvMode } = useFormModePreference();
    const openNdv = useCallback((id, density) => {
        if (!id) return;
        setNdvStepId(id);
        setNdvDensity(densityForOpen(density, scopedStorage.getItem('ndvDensity')));
    }, [setNdvDensity]);
    const closeNdv = useCallback(() => setNdvStepId(null), []);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Executing a step does NOT open its editor. Hitting ▶ on the canvas is a
    // question about DATA — "how much came out, and what goes to the next
    // node" — and the answer now lands on the connection itself (see
    // flow/dataSummary.js + the chip in flow/edges.jsx). Covering the canvas
    // with a settings dialog buried exactly the thing being asked for. The
    // Execute buttons inside the editor still work; it is already open there.
    //
    // One deliberate carve-out (BFSF-408, reopened): a FORM trigger with no
    // saved sample yet has no data to run WITH — every {{trigger.output.*}}
    // downstream resolves to undefined, so "how much came out" has no answer
    // to land on the edge. There the visual form preview (FormBuilderFields,
    // default-open for a testable trigger) is the thing worth surfacing, not
    // a blank run — see the redirect in handleExecuteStep below.
    //
    // The trigger's saved sample, kept in a ref because the run helpers below
    // are declared long before `effectiveDef` exists (it needs the draft, the
    // server row and the Step seed to have been resolved first). Assigned once
    // per render, right after that resolution.
    // The form test overlay: `{ form, triggerStepId }` while open, null
    // otherwise. Declared up here rather than beside its handlers because
    // handleExecuteStep below closes over the setter, and a useCallback's
    // dependency array is evaluated during render — a `const` declared later
    // would be in its temporal dead zone at that moment.
    const [formTest, setFormTest] = useState(null);
    const triggerSampleRef = useRef(null);
    // The id of the PRIMARY trigger when it is a bare form trigger — kind
    // 'form', no pinnedOutput yet — else null. Same ref-assigned-in-render
    // pattern as triggerSampleRef, and for the same reason.
    const bareFormTriggerIdRef = useRef(null);
    const formDeclRef = useRef(null);
    // definition.triggers[] — the additional entry points of a multi-trigger
    // automation, each with its own pinnedOutput. Same ref-in-render pattern.
    const secondaryTriggersRef = useRef([]);
    // The body every whole-flow run is POSTed with. `{}` when there is no
    // sample, so an untouched automation keeps sending exactly what it always did.
    // A run started FROM a secondary trigger (the header's "Start from"
    // choice) carries that trigger's own sample and names it, so the server
    // seeds the DAG from that node. Anything that is not a trigger id — the
    // hotkey and the split button hand over nothing or a click event — means
    // the primary.
    const runBody = useCallback((triggerStepId = null) => {
        const from = typeof triggerStepId === 'string' && triggerStepId ? triggerStepId : null;
        const sample = from
            ? (secondaryTriggersRef.current.find(t => t?.id === from)?.pinnedOutput ?? null)
            : triggerSampleRef.current;
        return {
            ...(sample == null ? {} : { triggerPayload: sample }),
            ...(from ? { triggerStepId: from } : {}),
        };
    }, []);

    // Every run the editor starts carries the TRIGGER's saved sample as its
    // `triggerPayload` (BFSF-408). Without it an automation that cannot be fired
    // for real yet — a form nobody has submitted, an app_event with no matching
    // message — entered with `trigger.output === {}`, so every downstream step
    // mapping off the trigger resolved to undefined and could be neither built
    // nor tested. `opts.triggerPayload` still wins, so the form preview's
    // "submit these answers" can hand over what the author just typed.
    //
    // A BARE form trigger (kind 'form', nothing pinned/edited yet) is the one
    // case rerouted instead of run: "hit play, nothing happens" was the
    // reopened ticket's literal complaint, from every one of Execute's entry
    // points (canvas hover-▶, right-click "Execute step", and the editor's own
    // header/Output buttons — they all resolve to this same function). A run
    // with no data would just repeat that silence, so open the trigger's own
    // editor instead, where the visual form preview now shows by default —
    // "hit play" and "see the form" become the same gesture. Already looking
    // at that exact trigger's editor is a no-op here: the preview is already
    // on screen, and re-invoking openNdv would reset an expanded FULL view
    // back to quick. `opts.triggerPayload` is the escape hatch: the preview's
    // own Submit button (onTestSubmit) always carries one — even `{}` for an
    // all-optional form — and that must always execute for real.
    const handleExecuteStep = useCallback(
        (stepId, opts) => {
            if (!opts?.triggerPayload && bareFormTriggerIdRef.current && bareFormTriggerIdRef.current === stepId) {
                // A form trigger has nothing to run WITH until somebody fills
                // the page in, so Execute opens that page over the canvas and
                // its Submit starts the run. This used to open the node editor
                // and leave you to find the inline preview inside it, which is
                // the same answer one gesture further away.
                const t = formDeclRef.current;
                if (t) setFormTest(t);
                else toast.info('Add at least one question to this form first.');
                return Promise.resolve();
            }
            return executeStep(stepId, { triggerPayload: triggerSampleRef.current, ...(opts || {}) });
        },
        [executeStep, ndvStepId, openNdv],
    );

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

    const { tab, setTab, reportBuilderState } = useBuilderTabUrl({
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

    // Inline-rename saving state. Three transitions:
    //   idle → saving → saved → idle (after 1.5s)
    //   idle → saving → error
    const [savingState, setSavingState] = useState('idle');
    const savedTimer = useRef(null);
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
    // The AI Act gate on Activate / Make live. Bee checks the automation itself
    // and the server refuses only with the questions it could not answer:
    // those open in a dialog (AiActQuestionsDialog) whose "Save and make
    // live" retries the same call. A prohibited practice, or a second refusal
    // right after the dialog, sends the person to Settings instead.
    const [aiActGate, setAiActGate] = useState(null);
    const aiActRetryRef = useRef(false);
    const openAiActOnRefusal = (e, action) => {
        if (!isAiActRefusal(e)) return false;
        if (e.code === 'ai_act_check_required' && !aiActRetryRef.current) {
            setAiActGate({ action });
            return true;
        }
        openSettingsAt('ai-act');
        toast.info(e.message || 'Complete the AI Act check before this automation goes live.');
        return true;
    };

    // Diagnose button anchor — the popover positions itself just below
    // this element instead of floating in a fixed top-right corner.
    const diagnoseAnchorRef = useRef(null);

    // Step mode: the sharing menu offers "specific groups" within the org, so
    // load the caller's org groups (same /auth/groups endpoint as KBs/Agents).
    const [orgGroups, setOrgGroups] = useState([]);
    useEffect(() => {
        if (!isStep) return;
        let alive = true;
        (async () => {
            try {
                const r = await authFetch(`${API_BASE}/auth/groups`);
                if (r.ok && alive) {
                    const data = await r.json();
                    setOrgGroups(Array.isArray(data) ? data : []);
                }
            } catch (_) { /* silent — menu falls back to Personal/Org only */ }
        })();
        return () => { alive = false; };
    }, [isStep]);

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

    // What the automation ENTERS with when you press Run / Dry-run / ▶ Execute:
    // the primary trigger's own pinned output. That pin is either a captured
    // run or a payload the author typed into the trigger's Output → Edit sheet
    // (BFSF-408), and it is the ONE hand-authored payload slot — the old
    // `definition.manualTriggerPayload` was write-only and is gone.
    triggerSampleRef.current = effectiveDef?.trigger?.pinnedOutput ?? null;
    secondaryTriggersRef.current = Array.isArray(effectiveDef?.triggers) ? effectiveDef.triggers : [];
    // See handleExecuteStep above: a bare form trigger reroutes Execute to
    // its own editor instead of running blind.
    bareFormTriggerIdRef.current = (effectiveDef?.trigger?.kind === 'form' && triggerSampleRef.current == null)
        ? effectiveDef.trigger.id
        : null;
    // What that Execute should OPEN — the declaration as it stands right now,
    // so a question added a moment ago is on the test page.
    formDeclRef.current = (effectiveDef?.trigger?.kind === 'form' && effectiveDef.trigger.form)
        ? { form: effectiveDef.trigger.form, triggerStepId: effectiveDef.trigger.id }
        : null;

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
        turnBaseRef.current = workMode === 'build' || options.approvedPlanId ? structuredClone(effectiveDef || normalizeDefinitionShape(null)) : null;
        send({
            message: text,
            targetAutomationId,
            workMode: options.approvedPlanId ? 'plan' : workMode,
            approvedPlanId: options.approvedPlanId || null,
            alwaysPlanLarge: !!alwaysPlanLarge && !autoSendInput && !forcedTier,
            pauseAfterStep: !!options.pauseAfterStep,
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

    const onActivate = async () => {
        setBusy(true);
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before activating.'); return; }
            const r = await api.activate(aid);
            setServerAutomation(r.automation);
            markPatternBuilt();
        }
        catch (e) { noteManagedRefusal(e); if (!openAiActOnRefusal(e, 'activate')) setError(e.message); }
        aiActRetryRef.current = false;
        setBusy(false);
    };
    // "Make vN live": the working copy becomes the live version. The version
    // the person saw travels along; the server refuses (409) if it moved on.
    const onPublish = async () => {
        const aid = serverAutomation?.id;
        // A stage's deploy is the only way a managed automation gets a new live version.
        if (!aid || readOnlyRef.current) return;
        setBusy(true);
        try {
            const r = await publishAutomation(aid, serverAutomation?.version ?? null);
            if (r?.automation) setServerAutomation(r.automation);
            markPatternBuilt();
        }
        catch (e) { noteManagedRefusal(e); if (!openAiActOnRefusal(e, 'publish')) setError(e.message); }
        aiActRetryRef.current = false;
        setBusy(false);
    };
    // The AI Act answers are recorded: the same call again, once.
    const retryAfterAiAct = () => {
        const action = aiActGate?.action;
        setAiActGate(null);
        aiActRetryRef.current = true;
        if (action === 'publish') onPublish(); else onActivate();
    };
    const onDeactivate = async () => {
        setBusy(true);
        try {
            const aid = state.automationId || serverAutomation?.id;
            if (!aid) return;
            const r = await api.deactivate(aid);
            setServerAutomation(r.automation);
        }
        catch (e) { noteManagedRefusal(e); setError(e.message); }
        setBusy(false);
    };
    const onDryRun = async (fromTrigger = null) => {
        setBusy(true); setError(null);
        let stopWatch = () => {};
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before running.'); return; }
            stopWatch = watchActiveRun(aid); // live progress while it runs
            const r = await api.dryRun(aid, runBody(fromTrigger));
            setRunResult(r.run, r.steps);
            toast.success('Dry-run complete — open a step to see its output.');
        }
        // `watchActiveRun` may already have surfaced a 'running' progress stub
        // by the time the request throws, and nothing else will ever settle it:
        // no run record is coming. Left running, `liveRunInFlight` stays true
        // and every ▶ Execute button is disabled for the rest of the session —
        // one of the mechanisms behind BFSF-360 ("Execute does nothing").
        catch (e) { noteManagedRefusal(e); setError(e.message); settleRun(); }
        finally { stopWatch(); setBusy(false); }
    };

    // Live full-flow run from the editor (the "Run live" option in the Run
    // menu). Unlike Dry-run this performs every side-effect for real, so we
    // gate it behind a confirm. Results land in each node's Run tab via
    // setRunResult, exactly like the dry-run path.
    /**
     * The live run itself, once the payload is settled.
     *
     * Split out of onRunLive so the form overlay can start exactly the same
     * run with the answers somebody just typed — the alternative was a second
     * copy of the watch/settle/report plumbing, which is the half that has the
     * bugs (BFSF-360).
     */
    const startLiveRun = async (body) => {
        setBusy(true); setError(null);
        let stopWatch = () => {};
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before running.'); return null; }
            stopWatch = watchActiveRun(aid); // live progress while it runs
            // `test: true`: the editor runs what is on the canvas (the working
            // copy). Without it the server runs the LIVE version, which on a
            // automation with changes not yet live is not what the author sees.
            const r = await api.run(aid, { ...body, test: true });
            if (r?.skipped) {
                clearDryRun();
                toast.success(r.message || 'Nothing to run against yet.');
            } else if (r?.pending) {
                // Run outlived the request window; hand off to Run history and
                // clear the live stub so the progress banner doesn't hang.
                clearDryRun();
                toast.success('Run started — results will appear in Run history shortly.');
            } else {
                setRunResult(r.run, r.steps);
                // A form journey is not over when the request returns — the
                // automation may be paused on its next page, and the overlay is
                // about to say so. Only claim completion when nothing is.
                if (r?.run?.status !== 'awaiting_form') toast.success('Live run complete — open a step to see its output.');
            }
            return r;
        }
        // Same as onDryRun: settle the live progress stub so a failed run-start
        // can't strand the builder in "running" forever (BFSF-360).
        catch (e) { noteManagedRefusal(e); setError(e.message); settleRun(); throw e; }
        finally { stopWatch(); setBusy(false); }
    };

    /**
     * The form a test overlay should open on, for the trigger being run.
     *
     * Reads the DECLARATION rather than anything saved, so the page under test
     * is the one on screen — an author who just added a question expects to see
     * it, not the version the server last stored.
     */
    const formForTrigger = (fromTrigger = null) => {
        const t = (typeof fromTrigger === 'string' && fromTrigger)
            ? [effectiveDef?.trigger, ...(effectiveDef?.triggers || [])].find(x => x?.id === fromTrigger)
            : effectiveDef?.trigger;
        return (t?.kind === 'form' && t?.form) ? { form: t.form, triggerStepId: t.id } : null;
    };

    const closeFormTest = useCallback(() => setFormTest(null), []);

    /**
     * Start the run the overlay's Submit asked for.
     *
     * The answers ARE the trigger payload — the same thing a real submission
     * hands the automation — so nothing else about the run differs from pressing
     * Run on any other trigger.
     */
    const onFormTestRun = async (answers) => {
        const from = formTest?.triggerStepId || null;
        return startLiveRun({
            triggerPayload: answers,
            ...(from && from !== effectiveDef?.trigger?.id ? { triggerStepId: from } : {}),
        });
    };

    const onRunLive = async (fromTrigger = null) => {
        const ok = await confirm({
            title: 'Run this automation for real?',
            description: 'Every step performs its action — sending messages, writing data, and anything else in the flow.',
            confirmLabel: 'Run it',
            destructive: true,
        });
        if (!ok) return;
        // A form trigger has no payload to run WITH: the trigger is a page a
        // person fills in. So Run opens that page over the canvas, and the
        // submit starts the run — "hit play" and "see the form" become one
        // gesture instead of Run quietly doing nothing.
        const asForm = formForTrigger(fromTrigger);
        if (asForm) { setTab('build'); setFormTest(asForm); return; }
        await startLiveRun(runBody(fromTrigger)).catch(() => {});
    };

    // Trigger health-check panel state. Only shown when the user opens it,
    // so a healthy automation never has visual noise.
    const [diagnoseOpen, setDiagnoseOpen] = useState(false);
    const [diagnoseLoading, setDiagnoseLoading] = useState(false);
    const [diagnoseError, setDiagnoseError] = useState(null);
    const [diagnoseResult, setDiagnoseResult] = useState(null);
    const onDiagnose = async () => {
        const aid = state.automationId || serverAutomation?.id;
        if (!aid) return;
        setDiagnoseOpen(true);
        setDiagnoseLoading(true);
        setDiagnoseError(null);
        setDiagnoseResult(null);
        try {
            const r = await api.diagnoseTrigger(aid);
            setDiagnoseResult(r);
        } catch (e) {
            setDiagnoseError(e.message);
        }
        setDiagnoseLoading(false);
    };

    // Unsaved-changes guard. The builder persists every mutation to the
    // server so the only "unsaved" window is between the local SSE-driven
    // draft update and the server's snapshot persistence at end-of-turn.
    // We block accidental tab-close while the SSE turn is mid-flight or
    // the local draft diverges from the last server snapshot.
    useEffect(() => {
        const handler = (e) => {
            // Block if a chat turn is mid-flight or the local draft hasn't
            // been confirmed by the server yet. We prefer `state.lastServerDraft`
            // (set by markServerConfirmed after each PUT) over the HTTP-side
            // serverAutomation.definition because the HTTP path can lag the
            // SSE path during a save round-trip.
            const baseline = state.lastServerDraft || serverAutomation?.definition || null;
            // A null local draft means the user hasn't made any local edits yet
            // — that's NOT unsaved work, so don't warn (deepEqualDef(null,
            // baseline) would otherwise report a false "unsaved changes" on a
            // freshly-opened automation the user only viewed).
            if (!state.running && (state.draft == null || deepEqualDef(state.draft, baseline))) return;
            e.preventDefault();
            // Modern browsers ignore the custom string but require setting returnValue.
            e.returnValue = '';
            return '';
        };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [state.running, state.draft, state.lastServerDraft, serverAutomation]);

    /**
     * Adopt a definition the server has just persisted for a WHOLE-DOCUMENT
     * write: point the local draft at it AND move the "last confirmed by the
     * server" baseline to it.
     *
     * The two always belong together, and getting it half right is silent data
     * loss rather than an error: `markServerConfirmed` alone leaves `state.draft`
     * on the pre-write definition, and the next canvas edit is committed on top
     * of that stale draft — so the write that just succeeded is PUT away again
     * (this is exactly how a saved Settings tab lost its notificationSettings
     * the moment the user added a step). One helper so a future fourth call
     * site can't repeat it.
     *
     * NOT used by the debounced visual-save path: there the local draft is
     * already the newest thing there is (applyVisualDraft set it before the PUT
     * was even scheduled), and re-adopting the server's echo would revert edits
     * made while the request was in flight. That path confirms only.
     */
    const adoptPersistedDefinition = useCallback((def) => {
        if (!def) return;
        setDraft(def);
        markServerConfirmed(def);
    }, [setDraft, markServerConfirmed]);

    /**
     * The validation chip and the node badges read `state.validation`, which
     * only the AI builder's `validation_errors` event used to write. Every
     * save of a definition gets the server's own verdict back, so adopt it
     * (BFSF-58): the warnings of a successful PUT, or the blocking records of
     * a 400. Otherwise a manual edit left the builder's last pass on screen
     * (fixed problems stayed, new ones never showed) and an automation built by
     * hand never showed any. A response without `warnings` (the Steps route
     * sends none) changes nothing. The automation route answers `warnings: []`
     * even to a PUT that carried no definition, so only call this for a save
     * that sent one (onSaveAutomation checks `patch.definition`).
     */
    const adoptSaveValidation = useCallback((r) => {
        if (Array.isArray(r?.warnings)) setValidation({ errors: [], warnings: r.warnings });
    }, [setValidation]);
    const adoptSaveRejection = useCallback((e) => {
        if (e?.status === 400 && Array.isArray(e.details)) setValidation({ errors: e.details, warnings: [] });
    }, [setValidation]);

    /**
     * @param {object} nextGraph      the edited SCOPED graph
     * @param {object|null} layerPatches  flowlets edited in the same pass, when
     *        the inspector was showing a step inside an expanded flowlet
     *        (see BuildTab's onSaveStepFlat / flow/inlineFlowlets.js)
     */
    const onSaveStep = async (nextGraph, layerPatches = null) => {
        // A definition write: refused here, before the draft or the server see it.
        if (readOnlyRef.current) throw Object.assign(new Error(t('managed_part.save_refused', 'This part is managed by a Solution stage. Change it in Dev and deploy.')), { status: 409, code: 'managed_part' });
        // The inspector edits the SCOPED graph — wrap it back into the
        // whole document before persisting so the server always receives
        // a complete definition.
        let whole = setScopedGraph(effectiveDef, scopeKey, nextGraph);
        if (layerPatches && Object.keys(layerPatches).length) {
            whole = { ...whole, layers: { ...(whole.layers || {}), ...layerPatches } };
        }
        const nextDef = normalizeDefinitionShape(whole);
        // Record the inspector's edit as an undo/redo entry. It used to write
        // the draft straight through, so the edit never entered the history
        // stack — a Redo afterwards popped a `future` snapshot captured BEFORE
        // it and silently reverted the inspector's work.
        //
        // `commit` applies through applyVisualDraft, which also schedules its
        // own debounced PUT. We persist below — awaited, so the caller can
        // surface a save error, and via the /api/step router when mode='step',
        // which the visual-save path does not do — so that second write is
        // suppressed instead of duplicated. `commit` runs `apply` synchronously,
        // so the flag can't leak past this call.
        suppressVisualPersistRef.current = true;
        try { draftHistory.commit(nextDef); }
        finally { suppressVisualPersistRef.current = false; }
        // Lazy-create when the user clicked Save in the inspector before
        // any other persist round-trip happened (e.g. they only added
        // nodes via the palette, then opened the inspector to set inputs
        // / mappings, then hit Save). The visual-edit debounce may not
        // have fired yet, so we must create here too.
        const aid = await ensureAutomationCreated(nextDef);
        if (!aid) throw new Error('Could not create automation. Refresh and try again.');
        let r;
        try { r = await apiUpdateOne(aid, { definition: nextDef }); }
        catch (e) { noteManagedRefusal(e); adoptSaveRejection(e); throw e; }
        adoptSaveValidation(r);
        const persisted = unwrapRow(r);
        setServerAutomation(persisted);
        // Sync the SSE-hook's draft + baseline with what the server now
        // holds. Without this, a later SSE `draft` event would see a
        // local/baseline mismatch and surface a phantom conflict.
        adoptPersistedDefinition(persisted?.definition || nextDef);
    };

    /**
     * Lazy-create the automation when the user starts building via the
     * visual editor (palette / drag) before sending a chat message.
     * Returns the resolved aid. Re-entrant safe: concurrent callers
     * share the same in-flight create promise so the user can't end up
     * with two stub automations from a flurry of clicks.
     */
    const createInflightRef = useRef(null);
    const ensureAutomationCreated = useCallback(async (defForCreate) => {
        const existing = state.automationId || serverAutomation?.id;
        if (existing) return existing;
        if (createInflightRef.current) return createInflightRef.current;
        const body = {
            title: serverAutomation?.title || (isStep ? 'Untitled Step' : 'Untitled automation'),
            definition: normalizeDefinitionShape(
                defForCreate || state.draft || serverAutomation?.definition || (isStep ? makeBlockSkeleton() : null),
            ),
        };
        createInflightRef.current = (async () => {
            try {
                const r = await apiCreateOne(body);
                const created = unwrapRow(r);
                setServerAutomation(created);
                hydrate({ automationId: created.id });
                return created.id;
            } finally {
                createInflightRef.current = null;
            }
        })();
        return createInflightRef.current;
    }, [api, state.automationId, state.draft, serverAutomation, hydrate]);

    /**
     * Visual-editor write path. Updates the local draft immediately so the
     * canvas stays responsive, then debounces the actual PUT so a 5-pixel
     * drag doesn't fire five round-trips. Mirrors the saving pill states
     * used by onSaveAutomation so the user sees the same feedback.
     *
     * When no automation exists yet we lazy-create one (the user clicked
     * a node in the palette but never sent a chat message). After creation
     * subsequent edits flow through the normal PUT round-trip.
     *
     * `applyVisualDraft` is the shared apply path used by both onVisualEdit
     * and the undo/redo history hook — every local-edit path goes through
     * here so undos auto-persist to the server too. A save failure surfaces
     * as a toast; the local draft stays so the user doesn't lose work.
     */
    const visualSaveTimer = useRef(null);
    // Set for the duration of ONE draftHistory.commit whose caller persists the
    // definition itself (onSaveStep). applyVisualDraft then updates the draft
    // but skips its debounced PUT — see the comment at that commit.
    const suppressVisualPersistRef = useRef(false);
    // Serialize saves so overlapping PUTs can't reorder: a stale (older) draft's
    // response arriving AFTER a newer one would otherwise overwrite the newer
    // definition on the server. If a save is in flight, stash only the LATEST
    // pending def and run it once the current PUT resolves (coalescing).
    const saveInFlightRef = useRef(false);
    const queuedSaveRef = useRef(undefined);
    const _doVisualSave = useCallback(async (nextDef) => {
        // Belt-and-braces with applyVisualDraft's guard — this is the last hop
        // before the wire, and a null here becomes a stored `{}` (BFSF-318).
        if (!nextDef) return;
        try {
            const aid = await ensureAutomationCreated(nextDef);
            if (!aid) { setSavingState('error'); return; }
            const r = await api.updateAutomation(aid, { definition: nextDef });
            const persisted = r.automation || r;
            setServerAutomation(persisted);
            markServerConfirmed(persisted?.definition || nextDef);
            adoptSaveValidation(r);
            setSavingState('saved');
            if (savedTimer.current) clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSavingState('idle'), 1500);
        } catch (e) {
            console.warn('[BuilderShell] visual save failed:', e.message);
            noteManagedRefusal(e);
            adoptSaveRejection(e);
            setSavingState('error');
            toast.error(`Save failed — your edits are still on the canvas. ${e.message || ''}`.trim());
        }
    }, [api, ensureAutomationCreated, markServerConfirmed, adoptSaveValidation, adoptSaveRejection, noteManagedRefusal]);
    const performVisualSave = useCallback(async (nextDef) => {
        if (saveInFlightRef.current) { queuedSaveRef.current = nextDef; return; }
        saveInFlightRef.current = true;
        try {
            await _doVisualSave(nextDef);
        } finally {
            saveInFlightRef.current = false;
            if (queuedSaveRef.current !== undefined) {
                const q = queuedSaveRef.current;
                queuedSaveRef.current = undefined;
                performVisualSave(q); // drain the latest queued def
            }
        }
    }, [_doVisualSave]);

    // Holds the last draft that has a debounced save in flight but not yet
    // persisted, plus the current save fn — so the unmount effect (which has
    // stale [] closures) can FLUSH it instead of silently dropping the last
    // <500ms of edits when the user navigates away in-app.
    const pendingSaveRef = useRef({ def: null, perform: performVisualSave });
    pendingSaveRef.current.perform = performVisualSave;

    const applyVisualDraft = useCallback((nextDef) => {
        // Never apply/persist an absent definition. `forceSaveNow` and
        // `syncServerRow` already guard this; without the same guard here an
        // undo back to the pre-first-edit state pushed `definition: null` to
        // the server, which stored it as `{}` and wedged the builder
        // (BFSF-318).
        if (!nextDef) return;
        // Read-only: the canvas hands nothing through, but undo/redo, the
        // flowlet agent and a stale scheduled edit all land here too.
        if (readOnlyRef.current) return;
        setDraft(nextDef);
        // History-only apply: the committing caller writes this same definition
        // to the server itself, so don't schedule a second (and, for Steps,
        // wrongly-routed) PUT for it.
        if (suppressVisualPersistRef.current) return;
        if (visualSaveTimer.current) clearTimeout(visualSaveTimer.current);
        setSavingState('saving');
        pendingSaveRef.current.def = nextDef;
        visualSaveTimer.current = setTimeout(() => {
            pendingSaveRef.current.def = null; // save is firing — nothing left pending
            performVisualSave(nextDef);
        }, 500);
    }, [setDraft, performVisualSave]);

    const draftHistory = useAutomationDraftHistory({
        currentDraft: effectiveDef,
        apply: applyVisualDraft,
    });

    /**
     * Whole-document commit (history entry + debounced persist). Used by
     * scope-spanning edits (create flowlet + insert call_layer, delete flowlet,
     * rename flowlet) that already operate on the full definition.
     */
    const onVisualEditRoot = useCallback((nextDef) => {
        draftHistory.commit(nextDef);
    }, [draftHistory]);

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

    // ── AI flowlet builder (separate from chat) ─────────────────────────────
    // Drives the Flowlets panel's "Build a flowlet with AI" / "Refine with AI".
    // The endpoint already persists the new def server-side; we mirror it
    // into the local draft + history via onVisualEditRoot (one undo entry),
    // exactly like every other flowlet edit. Returns true on success so the
    // panel can collapse its composer.
    const layerAgent = useFlowletAgentStream();
    const onBuildLayer = useCallback(async (instruction) => {
        if (!instruction || !instruction.trim() || readOnlyRef.current) return false;
        const aid = await ensureAutomationCreated();
        if (!aid) { toast.error('Could not save the automation. Try again.'); return false; }
        const r = await layerAgent.send({ automationId: aid, instruction, mode: 'create' });
        if (r.error) { toast.error(`Couldn't build the flowlet. ${r.error}`.trim()); return false; }
        if (r.draft) {
            onVisualEditRoot(r.draft);
            if (r.layerKey) setScopeKey(r.layerKey); // drill into the new flowlet
            toast.success('Flowlet built.');
            return true;
        }
        return false;
    }, [ensureAutomationCreated, layerAgent, onVisualEditRoot]);

    const onRefineLayer = useCallback(async (layerKey, instruction) => {
        if (!layerKey || !instruction || !instruction.trim() || readOnlyRef.current) return false;
        const aid = await ensureAutomationCreated();
        if (!aid) { toast.error('Could not save the automation. Try again.'); return false; }
        const r = await layerAgent.send({ automationId: aid, instruction, mode: 'refine', layerKey });
        if (r.error) { toast.error(`Couldn't refine the flowlet. ${r.error}`.trim()); return false; }
        if (r.draft) { onVisualEditRoot(r.draft); toast.success('Flowlet updated.'); return true; }
        return false;
    }, [ensureAutomationCreated, layerAgent, onVisualEditRoot]);

    /**
     * Canvas write path. The diagram/palette hand us the graph for the
     * CURRENT scope — wrap it back into the whole document before the
     * history commit so one undo entry covers the edit and persistence
     * always sees complete definitions.
     */
    const onVisualEdit = useCallback((nextGraph) => {
        draftHistory.commit(setScopedGraph(effectiveDef, scopeKey, nextGraph));
    }, [draftHistory, effectiveDef, scopeKey]);

    /**
     * Sync local state after an out-of-band whole-document replacement
     * (raw JSON save, version restore). Without setDraft the stale SSE
     * draft keeps overriding the saved definition on the canvas, and
     * undoing across a wholesale replacement is incoherent — so the
     * history resets too.
     */
    const syncServerRow = useCallback((a) => {
        if (!a) return;
        setServerAutomation(a);
        adoptPersistedDefinition(a.definition);
        draftHistory.reset();
        // A wholesale replacement may have removed the flowlet we were
        // looking at — exit to root rather than risk a dead scope.
        setScopeKey(null);
    }, [adoptPersistedDefinition, draftHistory]);

    /**
     * Force-flush any pending debounced save. Lets Cmd+S behave the way
     * users expect ("save it now") without waiting for the 500ms timer
     * to elapse. No-op when nothing is dirty.
     */
    const forceSaveNow = useCallback(() => {
        if (!visualSaveTimer.current) return;
        clearTimeout(visualSaveTimer.current);
        visualSaveTimer.current = null;
        pendingSaveRef.current.def = null; // flushing now — nothing left pending
        if (effectiveDef) return performVisualSave(effectiveDef);
    }, [effectiveDef, performVisualSave]);

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

    useEffect(() => () => {
        if (visualSaveTimer.current) {
            clearTimeout(visualSaveTimer.current);
            visualSaveTimer.current = null;
            // Flush the pending debounced save on unmount so an edit made in
            // the last 500ms before in-app navigation isn't silently lost.
            // Fire-and-forget: the component is going away, but the API call
            // still completes (and errors are already toasted inside).
            const { def, perform } = pendingSaveRef.current;
            if (def && typeof perform === 'function') { try { perform(def); } catch (_) { /* best-effort */ } }
        }
    }, []);

    /**
     * Save automation-level fields (title / description / definition).
     * Used by:
     *   - inline rename in BuilderHeader (`onRename` → `onSaveAutomation({title})`)
     *   - SettingsTab apply
     * Drives the saving pill state machine.
     */
    const onSaveAutomation = async (patch) => {
        const aid = await ensureAutomationCreated();
        if (!aid) throw new Error('Could not create automation. Refresh and try again.');
        if (savedTimer.current) { clearTimeout(savedTimer.current); savedTimer.current = null; }
        setSavingState('saving');
        try {
            const r = await apiUpdateOne(aid, patch);
            if (patch?.definition) adoptSaveValidation(r);
            const persisted = unwrapRow(r);
            setServerAutomation(persisted);
            if (persisted?.definition) {
                if (patch?.definition) {
                    // The patch REWROTE the definition (SettingsTab apply). The
                    // local draft has to move with it, or the next canvas edit
                    // is committed on top of the pre-Settings draft and PUTs
                    // the just-saved notificationSettings away again —
                    // silently, with no error anywhere.
                    adoptPersistedDefinition(persisted.definition);
                } else {
                    // Title/description-only PATCH (inline rename). Confirm the
                    // baseline but do NOT touch the draft: a visual edit whose
                    // debounced save hasn't fired yet is newer than the row we
                    // just read back, and adopting it would revert the canvas.
                    markServerConfirmed(persisted.definition);
                }
            }
            setSavingState('saved');
            savedTimer.current = setTimeout(() => setSavingState('idle'), 1500);
        } catch (e) {
            noteManagedRefusal(e);
            if (patch?.definition) adoptSaveRejection(e);
            setSavingState('error');
            throw e;
        }
    };

    const onRename = async (nextTitle) => {
        // While drilled into a flowlet the inline title edits the FLOWLET's
        // title — a definition edit, not an automation-row PATCH.
        if (scopeKey) {
            if (effectiveDef?.layers?.[scopeKey]) {
                onVisualEditRoot(renameLayer(effectiveDef, scopeKey, nextTitle));
            }
            return;
        }
        try { await onSaveAutomation({ title: nextTitle }); }
        catch (e) { console.warn('[BuilderShell] rename failed:', e.message); }
    };

    // Header scope descriptor + delete-flowlet action. refCount blocks the
    // delete button while any call_layer (root or sibling flowlet) still
    // references this flowlet — unless the flowlet is EMPTY, in which case
    // there is nothing to lose and the call sites go with it (BFSF-340).
    const scope = useMemo(() => {
        if (!scopeKey) return null;
        const layer = effectiveDef?.layers?.[scopeKey];
        if (!layer) return null;
        return {
            key: scopeKey,
            title: layer.title || scopeKey,
            refCount: countLayerRefs(effectiveDef, scopeKey),
            empty: isLayerEmpty(effectiveDef, scopeKey),
        };
    }, [scopeKey, effectiveDef]);

    const onExitScope = useCallback(() => setScopeKey(null), []);

    const onDeleteLayer = useCallback(async () => {
        if (!scopeKey || !effectiveDef?.layers?.[scopeKey]) return;
        const refs = countLayerRefs(effectiveDef, scopeKey);
        if (refs > 0) {
            if (!isLayerEmpty(effectiveDef, scopeKey)) return;
            const label = effectiveDef.layers[scopeKey].title || scopeKey;
            const ok = await confirm({
                title: `Delete the empty flowlet “${label}”?`,
                description: `Its ${refs} “Call flowlet” ${refs === 1 ? 'step' : 'steps'} on the canvas ${refs === 1 ? 'is' : 'are'} removed too; the steps around ${refs === 1 ? 'it' : 'them'} reconnect.`,
                confirmLabel: 'Delete',
                destructive: true,
            });
            if (!ok) return;
            onVisualEditRoot(deleteLayerAndCalls(effectiveDef, scopeKey));
            setScopeKey(null);
            return;
        }
        onVisualEditRoot(deleteLayerFromDefinition(effectiveDef, scopeKey));
        setScopeKey(null);
    }, [scopeKey, effectiveDef, onVisualEditRoot, confirm]);

    // ── Step publish / sharing / chat-exposure (mode='step') ──────────────
    const onPublishStep = async () => {
        setBusy(true); setError(null);
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add an input and a return before publishing.'); return; }
            const r = await api.publishStep(aid);
            setServerAutomation(unwrapRow(r));
            onPublished?.(aid);
            toast.success('Step published — automations and chats using it pick up the change.');
        } catch (e) { setError(e.message); }
        setBusy(false);
    };
    const onSetStepSharing = async (sharing) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.setStepSharing(aid, sharing);
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepExpose = async (exposeAsTool) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.setStepExpose(aid, exposeAsTool);
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepIcon = async (icon) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.updateStep(aid, { icon: icon || null });
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepCategory = async (category) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.updateStep(aid, { category: category || '' });
        setServerAutomation(unwrapRow(r));
    };

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

    const clearReview = async (action, revisionId) => {
        try {
        const aid = state.automationId || serverAutomation?.id;
        if (aid && revisionId) {
            const response = await authFetch(`${API_BASE}/api/automation/builder/session/${encodeURIComponent(aid)}/review`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revisionId }),
            });
            if (!response.ok) { toast.error(t('automations.assistant.review_changed', 'The saved review has changed. Reload the latest revision.')); return false; }
        }
        if (action === 'rejectPlan') dismissPlan(); else dismissProposal();
        return true;
        } catch (error) { toast.error(error.message || String(error)); return false; }
    };

    const applyProposal = async (reviewedDefinition) => {
        const proposal = state.proposal;
        if (!proposal || state.running) return;
        if (!deepEqual(effectiveDef, proposal.baseDefinition) && !(isBlankDefinition(effectiveDef) && isBlankDefinition(proposal.baseDefinition))) {
            toast.error(t('automations.assistant.stale_proposal', 'The flow has changed since this proposal. Ask the assistant for an updated proposal.'));
            return;
        }
        if (!await clearReview('discardProposal', proposal.id)) return;
        onVisualEditRoot(reviewedDefinition?.steps ? reviewedDefinition : proposal.definition);
        if (proposal.title || proposal.description != null) await onSaveAutomation({ title: proposal.title || serverAutomation?.title, description: proposal.description || '' });
        toast.success(t('automations.assistant.applied', 'Proposal applied. Undo reverts the flow changes.'));
    };

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
        canDiagnose: isAppEventTrigger, busy, onBack, backLabel, onOpenList, onActivate, onDeactivate,
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
        <BuilderConfirmProvider value={confirm}>
        <div className="flex flex-col h-full min-h-0">
            {/* Every confirmation in the builder renders here, in the product's
                own chrome — `window.confirm` put the question in a browser box
                titled "localhost:5176 says". */}
            {confirmDialog}
            {aiActGate && (serverAutomation?.id || state.automationId) && (
                <AiActQuestionsDialog
                    open
                    automationId={serverAutomation?.id || state.automationId}
                    stamp={readinessStamp(serverAutomation)}
                    action={aiActGate.action}
                    onClose={() => setAiActGate(null)}
                    onAnswered={retryAfterAiAct}
                />
            )}
            {/* On Build, BuildTab renders this same header (with the add-step
                ribbon embedded in it); on the other tabs the shell renders it. */}
            {tab !== 'build' && <BuilderHeader {...headerProps} />}

            {diagnoseOpen && (
                <TriggerDiagnosePanel
                    result={diagnoseResult}
                    loading={diagnoseLoading}
                    error={diagnoseError}
                    onClose={() => setDiagnoseOpen(false)}
                    anchorRef={diagnoseAnchorRef}
                />
            )}

            <div className="flex-1 min-h-0 relative">
                {tab === 'build' && (
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
                {tab === 'settings' && (
                    <SettingsTab
                        automation={serverAutomation}
                        onSave={onSaveAutomation}
                        initialSection={settingsSection}
                        workMode={workMode}
                        onWorkModeChange={isStep ? undefined : setWorkMode}
                        onOpenTab={setTab}
                        onAutomationChange={setServerAutomation}
                    />
                )}
                {/* Its own view rather than the last section of Settings —
                    it needs the room, and buried there nobody found it
                    (BFSF-344). */}
                {tab === 'versions' && (
                    <VersionsTab automation={serverAutomation} onRestored={syncServerRow} />
                )}
                {/* Mounted HIDDEN rather than conditionally: a run open on the
                    canvas view would otherwise unmount and lose its scroll,
                    zoom and filters every time the user peeks at the Editor.
                    `active` gates fetching/streaming, so the hidden panel
                    costs nothing. */}
                <div className={tab === 'history' ? 'h-full' : 'hidden'}>
                    {aidForHistory && !isStep ? (
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
                    ) : (
                        // Never fire GET /api/automation/null/runs for a draft
                        // that has no server row yet.
                        tab === 'history' && (
                            <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
                                <div className="text-sm text-[var(--text-primary)] font-medium">This automation hasn't run yet.</div>
                                <div className="text-xs text-[var(--text-secondary)]">Run a test to see what happens, step by step.</div>
                                <button
                                    type="button"
                                    onClick={() => { setTab('build'); onDryRun?.(); }}
                                    className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
                                >
                                    Run a test
                                </button>
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>
        </BuilderConfirmProvider>
    );
}

// BuilderErrorBanner moved to FloatingValidationPill.jsx — the redesign
// surfaces these records as a sticky bottom-right pill on the Build tab
// instead of a top-of-canvas row that pushes content down.

/**
 * Cheap structural-equality check between two automation definitions.
 * Used by the beforeunload guard to detect unsaved changes without
 * tripping over JSON.stringify's key-ordering instability.
 */
function deepEqualDef(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function noop() { /* the AI builder has no way in on a managed automation */ }
