import { useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { publishAutomation, isAiActRefusal } from '../../../api/queries/automation/meta';
import { toast } from '../../shared/Toast';


export interface UseBuilderLifecycleOptions {
    api: any;
    state: any;
    serverAutomation: any;
    setServerAutomation: (row: any) => void;
    unwrapRow: (r: any) => any;
    ensureAutomationCreated: (defForCreate?: any) => Promise<any>;
    markPatternBuilt: () => void;
    noteManagedRefusal: (e: any) => boolean;
    openSettingsAt: (section: string | null) => void;
    readOnlyRef: MutableRefObject<boolean>;
    setBusy: (busy: boolean) => void;
    setError: (error: any) => void;
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
    const [aiActGate, setAiActGate] = useState<any>(null);
    const aiActRetryRef = useRef(false);
    const openAiActOnRefusal = (e: any, action: any) => {
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
    const diagnoseAnchorRef = useRef<any>(null);

    const onActivate = async () => {
        setBusy(true);
        try {
            const aid = await ensureAutomationCreated();
            if (!aid) { setError('Add a trigger and at least one step before activating.'); return; }
            const r = await api.activate(aid);
            setServerAutomation(r.automation);
            markPatternBuilt();
        }
        catch (e: any) { noteManagedRefusal(e); if (!openAiActOnRefusal(e, 'activate')) setError(e.message); }
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
        catch (e: any) { noteManagedRefusal(e); if (!openAiActOnRefusal(e, 'publish')) setError(e.message); }
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
        catch (e: any) { noteManagedRefusal(e); setError(e.message); }
        setBusy(false);
    };

    // Trigger health-check panel state. Only shown when the user opens it,
    // so a healthy automation never has visual noise.
    const [diagnoseOpen, setDiagnoseOpen] = useState(false);
    const [diagnoseLoading, setDiagnoseLoading] = useState(false);
    const [diagnoseError, setDiagnoseError] = useState<any>(null);
    const [diagnoseResult, setDiagnoseResult] = useState<any>(null);
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
        } catch (e: any) {
            setDiagnoseError(e.message);
        }
        setDiagnoseLoading(false);
    };

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
        } catch (e: any) { setError(e.message); }
        setBusy(false);
    };
    const onSetStepSharing = async (sharing: any) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.setStepSharing(aid, sharing);
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepExpose = async (exposeAsTool: any) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.setStepExpose(aid, exposeAsTool);
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepIcon = async (icon: any) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.updateStep(aid, { icon: icon || null });
        setServerAutomation(unwrapRow(r));
    };
    const onSetStepCategory = async (category: any) => {
        const aid = await ensureAutomationCreated();
        if (!aid) return;
        const r = await api.updateStep(aid, { category: category || '' });
        setServerAutomation(unwrapRow(r));
    };

    return {
        aiActGate, setAiActGate, retryAfterAiAct, diagnoseAnchorRef,
        onActivate, onPublish, onDeactivate,
        diagnoseOpen, setDiagnoseOpen, diagnoseLoading, diagnoseError, diagnoseResult, onDiagnose,
        onPublishStep, onSetStepSharing, onSetStepExpose, onSetStepIcon, onSetStepCategory,
    };
}
