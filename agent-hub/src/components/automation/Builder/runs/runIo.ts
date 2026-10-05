/**
 * How a step's input and output read in one line each: the timeline card's
 * result, the "Got in / Passed on" rows, and which list gets the table.
 */
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RunStepRecord } from '../../../../api/queries/automation/runs';
import { stepPayload } from '../flow/stepPayload';
import { humanizeExpression as humanizeExpressionJs, humanizeTemplate, humanizeToolName } from '../flow/displayHelpers';

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

/** Keys that shape the flow, not what the step does: never a setting row. */
const STRUCTURAL = new Set([
    'id', 'type', 'label', 'position', 'next', 'edges', 'branches', 'cases', 'onError', 'on_error',
    'notes', 'disabled', 'layerKey', 'outputSchema', 'codeHash', 'inputSchema', 'sideEffect', 'appId',
]);
const SECRET_KEY = /secret|password|passwd|token|api[_-]?key|credential/i;
const MAX_CONFIG = 12;

type LabelMap = Map<string, string> | null;
// The JS helper's JSDoc types its label map as `null`; it takes a Map.
const humanizeExpression = humanizeExpressionJs as (expr: string, labels?: LabelMap) => string;
type Binding = { kind?: string; value?: unknown; path?: string };

function isBinding(v: unknown): v is Binding {
    return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Binding).kind === 'string'
        && ['literal', 'ref', 'template', 'expr'].includes((v as Binding).kind as string);
}

/** A stored value, or binding, the way the editor's chips read it: "Trigger ▸ Subject", "Hello ‹Code›…". */
function settingText(t: TranslateFn, v: unknown, labels: LabelMap): string {
    if (isBinding(v)) {
        if (v.kind === 'literal') return settingText(t, v.value, labels);
        if (v.kind === 'ref') return humanizeTemplate(`{{${v.path || ''}}}`, labels) || String(v.path || '');
        if (v.kind === 'template') return humanizeTemplate(String(v.value ?? ''), labels);
        return humanizeExpression(String(v.value ?? ''), labels);
    }
    if (typeof v === 'string') return v.includes('{{') ? humanizeTemplate(v, labels) : v;
    // Channels, recipients: a short list of words reads as one, not as "table · 1 rows".
    if (Array.isArray(v) && v.every(x => x == null || typeof x !== 'object')) return v.filter(x => x != null && x !== '').join(', ');
    return previewValue(t, v);
}

/**
 * What a step was SET UP to do in this run (BFSF-456), from the run's own
 * version of the definition: one row per setting, its value as the editor's
 * chips read it. A step with named inputs (an app action, a Code step) lists
 * those; any other step its own settings. References to secrets and keys that
 * hold one are never shown.
 */
export function configFields(t: TranslateFn, stepDef: Record<string, unknown> | null | undefined, labels: LabelMap = null): IoField[] {
    if (!stepDef || typeof stepDef !== 'object') return [];
    const slots = ['inputs', 'fields'].map(k => stepDef[k]).find(m => m && typeof m === 'object' && !Array.isArray(m)) as Record<string, unknown> | undefined;
    const entries: Array<[string, unknown]> = [];
    if (typeof stepDef.tool === 'string') entries.push(['tool', humanizeToolName(stepDef.tool)]);
    if (slots) entries.push(...Object.entries(slots));
    else {
        for (const [k, v] of Object.entries(stepDef)) {
            if (STRUCTURAL.has(k) || k === 'tool' || k.startsWith('_') || v == null || v === '') continue;
            if (typeof v === 'object' && !Array.isArray(v) && !isBinding(v)) continue;
            entries.push([k, v]);
        }
    }
    const fe = stepDef.forEach as { overRef?: string } | undefined;
    if (fe?.overRef) entries.push(['forEach', humanizeTemplate(`{{${fe.overRef}}}`, labels)]);
    return entries.slice(0, MAX_CONFIG).map(([k, v]) => {
        const label = k === 'tool' ? t('runs.io.action', 'Action') : k === 'forEach' ? t('runs.io.for_each', 'Once for each') : humanKey(k);
        const secret = SECRET_KEY.test(k) || /\bsecrets\./.test(JSON.stringify(v) || '');
        const preview = secret ? t('runs.io.hidden', 'hidden') : (settingText(t, v, labels) || t('runs.io.empty', 'empty'));
        return { key: k, label, kind: 'text' as IoKind, preview };
    });
}
