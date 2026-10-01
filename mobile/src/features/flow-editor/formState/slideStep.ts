/**
 * The Slide step's draft and patch. The visual picker is a VIEW over the
 * stored fields (a chart object → chart, stats → stats, an image → image,
 * layout timeline → timeline), and the patch keeps exactly one of them. From
 * agent-hub `Builder/flow/settings/formState.js`; pinned by
 * formState.lockstep.test.ts.
 */

import { applyForEachPatch } from './common';
import { or } from './read';
import type { Extractor, FormDraft, Patcher, StepPatch } from './types';
import { isObj } from '../bindings/json';

function chartDataText(chart: Record<string, unknown> | null): string {
    if (!chart) return '';
    if (typeof chart.data === 'string') return chart.data;
    return chart.data !== undefined ? JSON.stringify(chart.data) : '';
}

function statsText(stats: unknown): string {
    if (Array.isArray(stats)) return stats.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    return typeof stats === 'string' ? stats : '';
}

function visualOf(step: Record<string, unknown>, chart: unknown, stats: string): string {
    if (chart || typeof step.chart === 'string') return 'chart';
    if (stats) return 'stats';
    if (step.image) return 'image';
    return step.layout === 'timeline' ? 'timeline' : 'none';
}

function chartDraft(step: Record<string, unknown>, chart: Record<string, unknown> | null): FormDraft {
    const chartType = chart ? or(chart.type, 'column') : typeof step.chart === 'string' ? step.chart : 'column';
    return {
        chartType,
        chartData: chartDataText(chart),
        chartLabels: chart && typeof chart.labels === 'string' ? chart.labels : '',
        chartValues: chart && typeof chart.values === 'string' ? chart.values : '',
        chartStacked: !!chart?.stacked,
        chartUnit: chart && typeof chart.unit === 'string' ? chart.unit : '',
    };
}

export const extractSlide: Extractor = (step, base) => {
    const chart = isObj(step.chart) ? step.chart : null;
    const stats = statsText(step.stats);
    return {
        ...base,
        title: or(step.title, ''),
        content: or(step.content, ''),
        notes: or(step.notes, ''),
        image: or(step.image, ''),
        layout: or(step.layout, 'auto'),
        visual: visualOf(step, chart, stats),
        ...chartDraft(step, chart),
        stats,
        style: step.style === 'accent' || step.style === 'dark' ? step.style : '',
        forEach: or(step.forEach, null),
        repeat: or(step.repeat, null),
    };
};

function trimmed(v: unknown): string {
    return String(v || '').trim();
}

/** The chart object, or undefined when the picker holds another visual. */
function chartPatch(draft: FormDraft): Record<string, unknown> | undefined {
    const chartData = trimmed(draft.chartData);
    if ((draft.visual || 'none') !== 'chart' || (!chartData && !draft.chartType)) return undefined;
    let data: unknown = chartData;
    if (/^\s*[[{]/.test(chartData)) {
        try {
            data = JSON.parse(chartData);
        } catch {
            data = chartData;
        }
    }
    return {
        type: draft.chartType || 'column',
        ...(chartData ? { data } : {}),
        ...(trimmed(draft.chartLabels) ? { labels: trimmed(draft.chartLabels) } : {}),
        ...(trimmed(draft.chartValues) ? { values: trimmed(draft.chartValues) } : {}),
        ...(draft.chartStacked ? { stacked: true } : {}),
        ...(trimmed(draft.chartUnit) ? { unit: trimmed(draft.chartUnit) } : {}),
    };
}

/** Absent, not '', when nothing is set; the visual decides which field survives. */
function visualPatch(patch: StepPatch, draft: FormDraft): void {
    const visual = draft.visual || 'none';
    // A composed image (a value from an earlier step) is kept as it is.
    patch.image = (typeof draft.image === 'string' ? draft.image.trim() : draft.image) || undefined;
    patch.layout = draft.layout && draft.layout !== 'auto' ? draft.layout : undefined;
    patch.chart = chartPatch(draft);
    patch.stats = visual === 'stats' && trimmed(draft.stats) ? trimmed(draft.stats) : undefined;
    if (visual !== 'image') patch.image = undefined;
    if (visual === 'timeline') patch.layout = 'timeline';
    else if (patch.layout === 'timeline') patch.layout = undefined;
}

export const patchSlide: Patcher = (patch, step, draft) => {
    patch.title = or(draft.title, '');
    patch.content = or(draft.content, '');
    patch.notes = or(draft.notes, '');
    visualPatch(patch, draft);
    patch.style = draft.style === 'accent' || draft.style === 'dark' ? draft.style : undefined;
    applyForEachPatch(patch, step, draft);
};
