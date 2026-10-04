/**
 * How a step's input and output read in one line each: the timeline card's
 * result, the "Got in / Passed on" rows, and which list gets the table.
 */
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import { stepPayload } from '../flow/stepPayload';

export type IoKind = 'number' | 'list' | 'record' | 'text' | 'flag' | 'empty';

export interface IoField {
    key: string;
    label: string;
    kind: IoKind;
    preview: string;
}

/** "fileName" / "file_name" → "File name". */
export function humanKey(key: string): string {
    const words = String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : key;
}

function kindOf(v: unknown): IoKind {
    if (v == null || v === '') return 'empty';
    if (Array.isArray(v)) return 'list';
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'flag';
    if (typeof v === 'object') return 'record';
    return 'text';
}

/** One value as a short phrase. */
export function previewValue(t: TranslateFn, v: unknown): string {
    switch (kindOf(v)) {
        case 'empty': return t('runs.io.empty', 'empty');
        case 'list': return t('runs.io.rows', 'table · {n} rows', { n: (v as unknown[]).length });
        case 'record': return t('runs.io.fields', '{n} fields', { n: Object.keys(v as object).length });
        case 'flag': return v ? t('runs.io.yes', 'yes') : t('runs.io.no', 'no');
        case 'number': return String(v);
        default: {
            const s = String(v).replace(/\s+/g, ' ').trim();
            return s.length > 40 ? `${s.slice(0, 39)}…` : s;
        }
    }
}

const MAX_FIELDS = 6;

/** Up to six named fields of a value, lists and counts first. */
export function ioFields(t: TranslateFn, value: unknown): IoField[] {
    if (value == null) return [];
    if (typeof value !== 'object' || Array.isArray(value)) {
        return [{ key: '', label: t('runs.io.value', 'Value'), kind: kindOf(value), preview: previewValue(t, value) }];
    }
    const rank: Record<IoKind, number> = { list: 0, number: 1, text: 2, flag: 3, record: 4, empty: 5 };
    return Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => ({ key: k, label: humanKey(k), kind: kindOf(v), preview: previewValue(t, v) }))
        .sort((a, b) => rank[a.kind] - rank[b.kind])
        .slice(0, MAX_FIELDS);
}

/**
 * The list worth a table: the output itself, or its longest list field.
 *
 * With the step type known, only what the step PASSES ON is looked at (a Code
 * step's `result`, not its `logs`). Without it, the console lines of a Code
 * step are still skipped: they are never the payload.
 */
export function mainList(value: unknown, stepType?: string | null): { key: string; rows: unknown[] } | null {
    const payload = stepType ? stepPayload(stepType, value) : value;
    if (Array.isArray(payload)) return { key: '', rows: payload };
    if (!payload || typeof payload !== 'object') return null;
    let best: { key: string; rows: unknown[] } | null = null;
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
        if (k === 'logs' || !Array.isArray(v)) continue;
        if (!best || v.length > best.rows.length) best = { key: k, rows: v };
    }
    return best;
}

/** The step's result in a few words: "23 files", "3 fields", the error. */
export function stepResult(t: TranslateFn, step: RunStepRecord): string {
    if (step.error) return String(step.error).replace(/\s+/g, ' ').slice(0, 120);
    const list = mainList(step.output, step.stepType);
    if (list) {
        return list.key
            ? t('runs.io.result_named', '{n} {what}', { n: list.rows.length, what: humanKey(list.key).toLowerCase() })
            : t('runs.io.result_items', '{n} items', { n: list.rows.length });
    }
    if (step.output == null) return '';
    return previewValue(t, stepPayload(step.stepType, step.output));
}

/** One record per top-level step, the latest attempt, in first-seen order. */
export function latestSteps(steps: RunStepRecord[]): RunStepRecord[] {
    const byId = new Map<string, RunStepRecord>();
    for (const s of steps) {
        if (s.parentStepId) continue;
        byId.set(s.stepId, s);
    }
    return [...byId.values()];
}

/** Duration of one step record: its own field, else its timestamps. */
export function stepDuration(step: RunStepRecord): number | null {
    if (step.durationMs != null) return step.durationMs;
    if (step.startedAt && step.finishedAt) return new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime();
    return null;
}
