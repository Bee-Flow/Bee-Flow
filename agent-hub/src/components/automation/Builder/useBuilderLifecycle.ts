import { useRef, useState } from 'react';
import type { MutableRefObject, Dispatch, SetStateAction } from 'react';
import { publishAutomation, isAiActRefusal } from '../../../api/queries/automation/meta';
import { toast } from '../../shared/Toast';
import type { unwrapRow } from './unwrapRow';
import type useAutomationApi from '../../../hooks/useAutomationApi';
import type useAutomationBuilderStream from '../../../hooks/useAutomationBuilderStream';
import type useBuilderHydration from './useBuilderHydration';
import type { AutomationRow } from './useBuilderHydration';
import type { RowAnswer } from './unwrapRow';
import type { FlowDefinition } from './flow/types';


export interface UseBuilderLifecycleOptions {
    api: ReturnType<typeof useAutomationApi>;
    state: ReturnType<typeof useAutomationBuilderStream>['state'];
    serverAutomation: ReturnType<typeof useBuilderHydration>['serverAutomation'];
    setServerAutomation: ReturnType<typeof useBuilderHydration>['setServerAutomation'];
    unwrapRow: typeof unwrapRow;
    ensureAutomationCreated: (defForCreate?: FlowDefinition | null) => Promise<string | undefined>;
    markPatternBuilt: () => void;
    noteManagedRefusal: (e: unknown) => boolean;
    openSettingsAt: (section: string | null) => void;
    readOnlyRef: MutableRefObject<boolean>;
    setBusy: (busy: boolean) => void;
    setError: Dispatch<SetStateAction<string | null>>;
    onPublished?: ((automationId: string) => void) | null;
}

/**
 * The automation's life outside the canvas: Activate / Make live / Pause with
 * the AI Act gate in front of going live, the trigger health check, and a
 * Step's publish, sharing, chat exposure, icon and category. Split out of
 * BuilderShell without a change in behaviour.
 */
export default function useBuilderLifecycle({
    api, state, serverAutomation, setServerAutomation, unwrapRow, ensureAutomationCreated,
    markPatternBuilt, noteManagedRefusal, openSettingsAt, readOnlyRef, setBusy, setError, onPublished,
}: UseBuilderLifecycleOptions) {
    // The AI Act gate on Activate / Make live. Bee checks the automation itself
    // and the server refuses only with the questions it could not answer:
    // those open in a dialog (AiActQuestionsDialog) whose "Save and make
    // live" retries the same call. A prohibited practice, or a second refusal
    // right after the dialog, sends the person to Settings instead.
    const [aiActGate, setAiActGate] = useState<{ action: string } | null>(null);
    const aiActRetryRef = useRef(false);
    const openAiActOnRefusal = (e: unknown, action: string) => {
        if (!isAiActRefusal(e)) return false;
        if ((e as { code?: string }).code === 'ai_act_check_required' && !aiActRetryRef.current) {
            setAiActGate({ action });
            return true;
        }
        openSettingsAt('ai-act');
        toast.info((e as Error).message || 'Complete the AI Act check before this automation goes live.');
        return true;
    };

    // Diagnose button anchor — the popover positions itself just below
    // this element instead of floating in a fixed top-right corner.
    const diagnoseAnchorRef = useRef<HTMLButtonElement | null>(null);

    const onActivate = async () => {
        setBusy(true);
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before activating.'); return; }
            const r = await api.activate<{ automation?: AutomationRow }>(aid);
            setServerAutomation(r.automation);
            markPatternBuilt();
        }
        catch (e: unknown) { noteManagedRefusal(e); if (!openAiActOnRefusal(e, 'activate')) setError((e as Error).message); }
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
            const r = await publishAutomation(aid, (serverAutomation?.version as number | null | undefined) ?? null);
            if (r?.automation) setServerAutomation(r.automation);
            markPatternBuilt();
        }
        catch (e: unknown) { noteManagedRefusal(e); if (!openAiActOnRefusal(e, 'publish')) setError((e as Error).message); }
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
            const r = await api.deactivate<{ automation?: AutomationRow }>(aid);
            setServerAutomation(r.automation);
        }
        catch (e: unknown) { noteManagedRefusal(e); setError((e as Error).message); }
        setBusy(false);
    };

    // Trigger health-check panel state. Only shown when the user opens it,
    // so a healthy automation never has visual noise.
    const [diagnoseOpen, setDiagnoseOpen] = useState(false);
    const [diagnoseLoading, setDiagnoseLoading] = useState(false);
    const [diagnoseError, setDiagnoseError] = useState<string | null>(null);
    const [diagnoseResult, setDiagnoseResult] = useState<unknown>(null);
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
        } catch (e: unknown) {
            setDiagnoseError((e as Error).message);
        }
        setDiagnoseLoading(false);
    };

    // ── Step publish / sharing / chat-exposure (mode='step') ──────────────
    const onPublishStep = async () => {
        setBusy(true); setError(null);
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add an input and a return before publishing.'); return; }
            const r = await api.publishStep<RowAnswer>(aid);
            setServerAutomation(unwrapRow(r));
            onPublished?.(aid);
            toast.success('Step published — automations and chats using it pick up the change.');
        } catch (e: unknown) { setError((e as Error).message); }
        setBusy(false);
    };
    const onSetStepSharing = async (sharing: unknown) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.setStepSharing<RowAnswer>(aid, sharing);
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepExpose = async (exposeAsTool: boolean) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.setStepExpose<RowAnswer>(aid, exposeAsTool);
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepIcon = async (icon: string | null | undefined) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.updateStep<RowAnswer>(aid, { icon: icon || null });
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepCategory = async (category: string | null | undefined) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.updateStep<RowAnswer>(aid, { category: category || '' });
        setServerAutomation(unwrapRow(r));
    };

    return {
        aiActGate, setAiActGate, retryAfterAiAct, diagnoseAnchorRef,
        onActivate, onPublish, onDeactivate,
        diagnoseOpen, setDiagnoseOpen, diagnoseLoading, diagnoseError, diagnoseResult, onDiagnose,
        onPublishStep, onSetStepSharing, onSetStepExpose, onSetStepIcon, onSetStepCategory,
    };
}
