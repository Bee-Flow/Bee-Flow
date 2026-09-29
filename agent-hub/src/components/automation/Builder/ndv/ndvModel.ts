// The words the step drawer puts in its header and column headers (round 4,
// artboards 4a/4b/4c). Pure and React-free, so every sentence has a test of
// its own and the header component only arranges them.
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { actionDisplayLabel } from '../flow/displayHelpers';
import { nodeDesc, nodeTypeLabel, stepFamily } from '../flow/nodeDefs';
import { defaultTriggerLabel, triggerTypeLabel } from '../flow/triggerLabels';
import type { DataSummary, FlowStep } from '../flow/types';

type Catalog = { apps?: Array<{ label?: string; actions?: Array<{ name: string; label?: string; description?: string }> }> } | null;

/** The raw node-type label ("Schedule trigger", "Remove duplicates"). */
export function stepTypeLabel(step: FlowStep | null, t: TranslateFn | null = null): string {
    if (!step) return '';
    if (step.type === 'trigger') return (triggerTypeLabel as (s: FlowStep) => string)(step);
    return (nodeTypeLabel as (type: unknown, t: unknown) => string)(step.type, t) || String(step.type || '').replace(/_/g, ' ');
}

/**
 * What the header calls this node: the user's own name first, then the
 * catalog's name for the action, never a bare tool id or `trg` (BFSF-333).
 */
export function headerTitle(step: FlowStep | null, catalog: Catalog): string {
    if (!step) return '';
    if (step.label) return String(step.label);
    if (step.type === 'trigger') return (defaultTriggerLabel as (k: string) => string)(String(step.kind || 'manual'));
    if (step.tool) return (actionDisplayLabel as (tool: unknown, c: unknown) => string)(step.tool, catalog);
    return stepTypeLabel(step) || step.id;
}

const FAMILY_WORD: Record<string, string> = {
    trigger: 'Trigger', ai: 'AI step', app: 'Action', branch: 'Logic', loop: 'Loop',
    data: 'Data', pause: 'People', guard: 'Privacy', end: 'End',
};

/** The family of a step for colour and kicker ("Action", "AI step", …). */
export function familyOf(step: FlowStep | null): string | null {
    if (!step) return null;
    return step.type === 'trigger' ? 'trigger' : (stepFamily as (t: unknown) => string | null)(step.type);
}

/**
 * The kicker word above the title: the family ("Action", "AI step"), not the
 * implementation type. A trigger keeps its KIND ("Form trigger"): a bare
 * "Trigger" said nothing about which one you opened.
 */
export function familyWord(step: FlowStep | null, t: TranslateFn): string {
    if (step?.type === 'trigger') return stepTypeLabel(step, t);
    const fam = familyOf(step);
    if (fam && FAMILY_WORD[fam]) return t(`routines.ndv.family.${fam}`, FAMILY_WORD[fam]);
    return stepTypeLabel(step, t);
}

export type PillTone = 'error' | 'success' | 'running' | 'warning' | 'muted' | 'pinned';

export interface StatusPill {
    tone: PillTone;
    label: string;
}

/**
 * "Failed on last run" / "Worked · 23 files" — how the LAST run of this step
 * went, in one pill. Null when there is nothing to say (never ran, not
 * pinned): an empty pill would read as a state.
 */
export function lastRunPill(
    runStep: { status?: unknown } | null | undefined,
    outSummary: DataSummary | null,
    pinned: { pinned: boolean; edited: boolean },
    t: TranslateFn,
): StatusPill | null {
    const status = String(runStep?.status || '');
    if (status === 'error' || status === 'failed') {
        return { tone: 'error', label: t('routines.ndv.pill_failed', 'Failed on last run') };
    }
    if (status === 'success' || status === 'completed') {
        return outSummary?.label
            ? { tone: 'success', label: t('routines.ndv.pill_worked_n', 'Worked · {summary}', { summary: outSummary.label }) }
            : { tone: 'success', label: t('routines.ndv.pill_worked', 'Worked on last run') };
    }
    if (status === 'running') return { tone: 'running', label: t('routines.ndv.pill_running', 'Running…') };
    if (status === 'awaiting_approval') return { tone: 'warning', label: t('routines.ndv.pill_waiting', 'Waiting for approval') };
    if (status === 'skipped') return { tone: 'muted', label: t('routines.ndv.pill_skipped', 'Skipped on last run') };
    if (!runStep && pinned.pinned) {
        return pinned.edited
            ? { tone: 'pinned', label: t('routines.ndv.pill_edited', 'Output written by hand') }
            : { tone: 'pinned', label: t('routines.ndv.pill_pinned', 'Output pinned') };
    }
    return null;
}

/** Tailwind classes per pill tone. The tint is the tone colour at 10%. */
export const PILL_CLASS: Record<PillTone, string> = {
    error: 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)]',
    success: 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]',
    running: 'bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)] text-[var(--type-ai)]',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)]',
    muted: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
    pinned: 'bg-[color-mix(in_srgb,var(--pinned)_12%,transparent)] text-[var(--pinned)]',
};

/** "1.2 s" / "340 ms" from a run step's timestamps; null without both. */
export function stepDuration(runStep: { startedAt?: unknown; finishedAt?: unknown; durationMs?: unknown } | null | undefined): string | null {
    if (!runStep) return null;
    let ms = typeof runStep.durationMs === 'number' ? runStep.durationMs : null;
    if (ms == null && runStep.startedAt && runStep.finishedAt) {
        const a = Date.parse(String(runStep.startedAt));
        const b = Date.parse(String(runStep.finishedAt));
        if (Number.isFinite(a) && Number.isFinite(b) && b >= a) ms = b - a;
    }
    if (ms == null) return null;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

/** The first sentence of a longer description, for a one-line header. */
export function firstSentence(text: unknown, max = 90): string {
    const s = String(text || '').trim().replace(/\s+/g, ' ');
    if (!s) return '';
    const cut = s.match(/^(.+?[.!?])(\s|$)/);
    const one = (cut ? cut[1] : s).replace(/[.]$/, '');
    return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Column 2's one-line summary: what this step DOES. For an app action the
 * catalog's own description; otherwise the node type's description.
 */
export function whatItDoes(step: FlowStep | null, catalog: Catalog, t: TranslateFn): string {
    if (!step) return '';
    if (step.type === 'integration_action' && step.tool) {
        for (const app of catalog?.apps || []) {
            const action = (app.actions || []).find(a => a.name === step.tool);
            if (action?.description) return firstSentence(action.description);
        }
    }
    if (step.type === 'trigger') return t('routines.ndv.col_trigger_does', 'Starts the automation');
    return firstSentence((nodeDesc as (type: unknown, t: unknown) => string)(step.type, t));
}

/** Column 3's one-line summary: what came out, how long it took. */
export function continuesSummary(
    runStep: { status?: unknown; startedAt?: unknown; finishedAt?: unknown; durationMs?: unknown } | null | undefined,
    outSummary: DataSummary | null,
    isTrigger: boolean,
    t: TranslateFn,
): string {
    const status = String(runStep?.status || '');
    if (status === 'error' || status === 'failed') return t('routines.ndv.col_out_stopped', 'Nothing, the step stopped');
    if (!outSummary?.label) {
        return isTrigger
            ? t('routines.ndv.col_out_trigger_none', 'What the start passes on')
            : t('routines.ndv.col_out_not_run', 'Not run yet, this is what it will give');
    }
    const dur = stepDuration(runStep);
    return dur ? `${outSummary.label} · ${dur}` : outSummary.label;
}

const HEADLINE_KEYS = ['name', 'filename', 'fileName', 'title', 'subject', 'path', 'label'];

/**
 * Column 1's one-line summary: "New file · Invoice-2026-001.pdf". The nearest
 * source step's name, plus the one value that says WHICH record came in,
 * when the last run gave us one.
 */
export function incomingSummary(
    groups: Array<{ label: string; basePath: string; sample?: unknown }>,
    previewSample: unknown,
    inSummary: DataSummary | null,
    walk: (path: string, root: unknown) => unknown,
    t: TranslateFn,
): string {
    if (!groups.length) return t('routines.ndv.col_in_nothing', 'Nothing yet, this step comes first');
    const nearest = groups[groups.length - 1];
    let data = previewSample ? walk(nearest.basePath, previewSample) : undefined;
    if (data === undefined) data = nearest.sample;
    const rec = Array.isArray(data) ? data[0] : data;
    let headline: string | null = null;
    if (rec && typeof rec === 'object') {
        for (const k of HEADLINE_KEYS) {
            const v = (rec as Record<string, unknown>)[k];
            if (typeof v === 'string' && v.trim() && !/^<[a-z_ ]+>$/i.test(v.trim())) {
                headline = k === 'path' ? v.split('/').filter(Boolean).pop() || v : v;
                break;
            }
        }
    }
    const parts = [nearest.label, headline || inSummary?.label || null].filter(Boolean);
    return parts.join(' · ');
}
