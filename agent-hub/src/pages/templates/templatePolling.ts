import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { templatesApi } from '../../api/templatesApi';
import type { ModelTiers, TemplateRecord } from './templateTypes';

/** What a background poll needs from the page: its interval registry and the setters it feeds. */
export interface PollDeps {
    pollersRef: MutableRefObject<Set<ReturnType<typeof setInterval>>>;
    setParameterizing: (value: boolean) => void;
    setFillTemplate: Dispatch<SetStateAction<TemplateRecord | null>>;
    setEditInstructions: (value: string) => void;
    loadTemplates: () => Promise<void>;
}

/**
 * Polls a template that is still being analysed (no parameters and no
 * description yet) until the AI has filled them in. Returns the cleanup.
 */
export function startProcessingPoll(templateId: string, { pollersRef, setParameterizing, setFillTemplate, setEditInstructions, loadTemplates }: PollDeps): () => void {
    let polls = 0;
    const pollers = pollersRef.current;
    const processingPoller = setInterval(async () => {
        polls++;
        if (polls > 30) { clearInterval(processingPoller); pollers.delete(processingPoller); setParameterizing(false); return; }
        try {
            const r = await templatesApi.get(templateId);
            if (r.ok) {
                const { template: updated } = await r.json();
                if (updated?.parameters?.length > 0 || updated?.description) {
                    setFillTemplate(prev => prev?.id === templateId ? { ...prev, ...updated } : prev);
                    if (updated.instructions) setEditInstructions(updated.instructions);
                    if (updated.parameters?.length > 0) setParameterizing(false);
                    await loadTemplates();
                    if (updated.parameters?.length > 0 && updated.description && updated.instructions) {
                        clearInterval(processingPoller);
                        pollers.delete(processingPoller);
                    }
                }
            }
        } catch (e) {
            console.warn('[TemplatesPage] processing poll failed', e);
        }
    }, 3000);
    pollers.add(processingPoller);
    return () => { clearInterval(processingPoller); pollers.delete(processingPoller); };
}

/**
 * Polls a freshly uploaded template while the server generates its context
 * (description, instructions, knowledge, parameters) in the background.
 */
export function startUploadPoll(template: TemplateRecord, origParamCount: number, { pollersRef, setParameterizing, setFillTemplate, setEditInstructions, loadTemplates }: PollDeps): void {
    const templateId = template.id;
    let polls = 0;
    const pollers = pollersRef.current;
    const poller = setInterval(async () => {
        polls++;
        if (polls > 20) { clearInterval(poller); pollers.delete(poller); setParameterizing(false); return; } // max 60s (parameterization takes longer)
        try {
            const r = await templatesApi.get(templateId);
            if (r.ok) {
                const { template: updated } = await r.json();
                const hasNew = updated?.description || updated?.instructions ||
                    (updated?.knowledgeBaseIds?.length > (template.knowledgeBaseIds?.length || 0)) ||
                    (updated?.parameters?.length > origParamCount);
                if (hasNew) {
                    setFillTemplate(prev => prev?.id === templateId ? { ...prev, ...updated } : prev);
                    if (updated.instructions) setEditInstructions(updated.instructions);
                    if (updated.parameters?.length > origParamCount) setParameterizing(false);
                    await loadTemplates();
                    // Stop when all background tasks completed
                    const allDone = updated.description && updated.instructions &&
                        (updated.parameters?.length > origParamCount);
                    if (allDone) { clearInterval(poller); pollers.delete(poller); }
                }
            }
        } catch (e) {
            console.warn('[TemplatesPage] upload context poll failed', e);
        }
    }, 3000);
    pollers.add(poller);
}

/** Loads the template list into the page's state; the loading flag clears whatever the answer. */
export async function fetchTemplateList(setTemplates: (templates: TemplateRecord[]) => void, setLoading: (loading: boolean) => void): Promise<void> {
    try {
        const res = await templatesApi.list();
        if (res.ok) {
            const data = await res.json();
            setTemplates(data.templates || []);
        }
    } catch (err) {
        console.error('Failed to load templates:', err);
    } finally {
        setLoading(false);
    }
}

/**
 * Active polling intervals, cleared on unmount so navigating away mid-upload
 * or mid-template-detect doesn't leak repeating fetches.
 */
export function usePollersRef(): MutableRefObject<Set<ReturnType<typeof setInterval>>> {
    const pollersRef = useRef<Set<ReturnType<typeof setInterval>>>(new Set());
    useEffect(() => () => {
        pollersRef.current.forEach(clearInterval);
        pollersRef.current.clear();
    }, []);
    return pollersRef;
}

/** Loads the chat model tiers once (a failed load leaves them empty). */
export function useModelTiersLoader(setModelTiers: (tiers: ModelTiers) => void): void {
    useEffect(() => {
        templatesApi.chatModels()
            .then(r => r.ok ? r.json() : {})
            .then(data => setModelTiers(data))
            .catch(e => console.warn('[TemplatesPage] load model tiers failed', e));
    }, []);
}
