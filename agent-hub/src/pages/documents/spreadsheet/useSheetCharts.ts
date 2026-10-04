import { useCallback, useState } from 'react';
import { getDocument, updateDocument } from '../documentsApi';
import type { StudioDocument } from '../documentQueries';
import type { SheetChartConfig } from './sheetCharts';

export default function useSheetCharts(initial: StudioDocument) {
    const [charts, setCharts] = useState<SheetChartConfig[]>(() => initial.settings?.sheet?.charts || []);
    const [error, setError] = useState<Error | null>(null);

    const saveCharts = useCallback(async (next: SheetChartConfig[]) => {
        setError(null);
        try {
            const latest = await getDocument(initial.id) as StudioDocument;
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

    const addChart = useCallback(async (config: SheetChartConfig) => {
        const next = [...charts, config];
        await saveCharts(next);
    }, [charts, saveCharts]);

    const removeChart = useCallback(async (id: string) => {
        const next = charts.filter((c) => c.id !== id);
        await saveCharts(next);
    }, [charts, saveCharts]);

    const applyCharts = useCallback(async (incoming: SheetChartConfig[]) => {
        if (!incoming.length) return;
        const byId = new Map<string, SheetChartConfig>();
        for (const c of charts) byId.set(c.id, c);
        for (const c of incoming) byId.set(c.id, c);
        await saveCharts([...byId.values()]);
    }, [charts, saveCharts]);

    return { charts, error, addChart, removeChart, applyCharts };
}

export type SheetChartsState = ReturnType<typeof useSheetCharts>;
