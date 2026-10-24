import { useCallback, useEffect, useRef, useState } from 'react';
import scopedStorage from '../../../utils/scopedStorage';
import type { TranslateFn } from '../../../hooks/useTranslation';
import type { BuilderTab } from './useBuilderTabUrl';

const WORK_MODES: readonly string[] = ['discuss', 'approve', 'plan', 'build'];

interface WorkModePrefsArgs {
    automationId: string | null;
    /** The id the stream knows (a lazily created automation), once it has one. */
    streamAutomationId: string | null | undefined;
    /** A host that drives the build (auto-send, forced tier) opens in 'build'. */
    startInBuild: boolean;
}

/** The work mode and the "always plan large builds" choice, remembered per automation. */
export function useWorkModePrefs({ automationId, streamAutomationId, startInBuild }: WorkModePrefsArgs) {
    const modeStorageKey = `automationWorkMode:${automationId || 'new'}`;
    const [workMode, setWorkMode] = useState<string>(() => {
        if (startInBuild) return 'build';
        const saved = scopedStorage.getItem(modeStorageKey);
        return saved !== null && WORK_MODES.includes(saved) ? saved : 'approve';
    });
    useEffect(() => { scopedStorage.setItem(`automationWorkMode:${streamAutomationId || automationId || 'new'}`, workMode); }, [workMode, streamAutomationId, automationId]);
    const [alwaysPlanLarge, setAlwaysPlanLarge] = useState(() => scopedStorage.getItem(`automationLargePlan:${automationId || 'new'}`) !== 'false');
    useEffect(() => { scopedStorage.setItem(`automationLargePlan:${streamAutomationId || automationId || 'new'}`, String(alwaysPlanLarge)); }, [alwaysPlanLarge, streamAutomationId, automationId]);
    return { workMode, setWorkMode, alwaysPlanLarge, setAlwaysPlanLarge };
}

/** A step as the assistant context names it. */
interface AssistantStep {
    id: string;
    label?: string;
    type?: string;
    kind?: string;
}

/** The field a "help me map this" request is about. */
export interface AssistantField {
    label?: string | null;
    expectKind?: string | null;
    value?: unknown;
}

export interface AssistantContext {
    id: string;
    label: string | undefined;
}

interface AssistantAskArgs {
    readOnlyRef: { current: boolean };
    ndvStepId: string | null;
    setTab: (tab: BuilderTab) => void;
    setAssistantOpen: (open: boolean) => void;
    setChatInput: (text: string) => void;
    t: TranslateFn;
}

/**
 * "Ask the assistant about this step / field": opens the chat on the Editor,
 * pins the step as the chat's context and seeds the mapping prompt. The step
 * lookup arrives later through `stepByIdForAssistant` (the shell fills it once
 * the scoped definition exists).
 */
export function useAssistantAsk({ readOnlyRef, ndvStepId, setTab, setAssistantOpen, setChatInput, t }: AssistantAskArgs) {
    const [assistantContext, setAssistantContext] = useState<AssistantContext | null>(null);
    const askAssistant = useCallback((stepId: string | null = null, field: AssistantField | null = null) => {
        // The AI builder writes the definition: not on a managed automation.
        if (readOnlyRef.current) return;
        setTab('build');
        setAssistantOpen(true);
        const step = stepByIdForAssistant.current?.(stepId || ndvStepId);
        if (step) setAssistantContext({ id: step.id, label: step.label || step.type || step.kind });
        if (field) setChatInput(t('automations.assistant.map_prompt', 'Help me map the field "{field}". It expects {kind}. Current binding: {binding}.', {
            field: field.label || '', kind: field.expectKind || 'a value', binding: JSON.stringify(field.value ?? null),
        }));
    }, [ndvStepId, setTab, setAssistantOpen, setChatInput, t, readOnlyRef]);
    const stepByIdForAssistant = useRef<((id: string | null) => AssistantStep | null) | null>(null);
    return { assistantContext, setAssistantContext, askAssistant, stepByIdForAssistant };
}

/**
 * The Settings section to open at (handoff 5): a 409 ai_act_check_required from
 * Activate / Make vN live sends the person to the AI Act section. Cleared when
 * they leave Settings.
 */
export function useSettingsSection(tab: string, setTab: (tab: BuilderTab) => void) {
    const [settingsSection, setSettingsSection] = useState<string | null>(null);
    useEffect(() => {
        if (tab !== 'settings') setSettingsSection(null);
    }, [tab]);
    // Open Settings at one section: the AI Act refusal below, and the
    // canvas's "Not in Files yet · add" tip (Start, with the Files dialog open).
    const openSettingsAt = useCallback((section?: string | null) => {
        setSettingsSection(section || null);
        setTab('settings');
    }, [setTab]);
    return { settingsSection, openSettingsAt };
}
