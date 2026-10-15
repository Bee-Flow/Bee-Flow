import { useCallback, useEffect, useState } from 'react';
import { getDocument, updateDocument } from '../documentsApi';
import type { StudioDocument } from '../documentQueries';
import type { SheetChartConfig } from './sheetCharts';

export default function useSheetCharts(initial: StudioDocument) {
    const [charts, setCharts] = useState<SheetChartConfig[]>(() => initial.settings?.sheet?.charts || []);
    const [error, setError] = useState<Error | null>(null);

    /**
     * Apply `change` to the STORED list (not this editor's copy, which may be
     * stale: a chart the AI added from the chat, a tab deleted with its
     * charts) and save that, on the version just read.
     */
    const saveCharts = useCallback(async (change: (stored: SheetChartConfig[]) => SheetChartConfig[]) => {
        setError(null);
        try {
            const latest = await getDocument(initial.id) as StudioDocument;
            const stored: SheetChartConfig[] = latest.settings?.sheet?.charts || [];
            const next = change(stored);
            const saved = await updateDocument(initial.id, {
                settings: { ...latest.settings, sheet: { ...latest.settings?.sheet, charts: next } },
                expectedVersionId: latest.versionId,
            }) as StudioDocument;
            setCharts(saved.settings?.sheet?.charts || next);
            return saved;
        } catch (e) {
            setError(e instanceof Error ? e : new Error(String(e)));
            throw e;
        }
    }, [initial.id]);

    /** Take the stored list again (after the AI or a tab change touched it). */
    const reload = useCallback(async () => {
        try {
            const doc = await getDocument(initial.id) as StudioDocument;
            setCharts(doc.settings?.sheet?.charts || []);
        } catch (e) {
            setError(e instanceof Error ? e : new Error(String(e)));
        }
    }, [initial.id]);

    // The AI added charts from the chat (document_write): take the stored list again.
    useEffect(() => {
        const onUpdated = (e: Event) => {
            if ((e as CustomEvent).detail?.documentId !== initial.id) return;
            void reload();
        };
        window.addEventListener('beeflow:document-updated', onUpdated);
        return () => window.removeEventListener('beeflow:document-updated', onUpdated);
    }, [initial.id, reload]);

    const addChart = useCallback(async (config: SheetChartConfig) => {
        await saveCharts((stored) => [...stored, config]);
    }, [saveCharts]);

    const removeChart = useCallback(async (id: string) => {
        await saveCharts((stored) => stored.filter((c) => c.id !== id));
    }, [saveCharts]);

    const applyCharts = useCallback(async (incoming: SheetChartConfig[]) => {
        if (!incoming.length) return;
        await saveCharts((stored) => {
            const byId = new Map<string, SheetChartConfig>();
            for (const c of stored) byId.set(c.id, c);
            for (const c of incoming) byId.set(c.id, c);
            return [...byId.values()];
        });
    }, [saveCharts]);

    return { charts, error, addChart, removeChart, applyCharts, reload };
}

export type SheetChartsState = ReturnType<typeof useSheetCharts>;
