import { Calculator, Database, Pencil, Play, Plug, Sigma, Table2 } from 'lucide-react';
import React from 'react';
import type { TranslateParams } from '../../../../../../../hooks/useTranslation';
import type { BindingDraft } from '../BindingField.types';
import { logger } from '../../../../../../../utils/logger';

// The four everyday sources, in the order they are offered.
export const sourceChoices = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { kind: 'records', icon: Table2, title: t('studio_apps_panels.binding.choice_records_title', 'A table in this app'), blurb: t('studio_apps_panels.binding.choice_records_blurb', 'Rows straight out of one of this app’s tables.') },
    { kind: 'dataset', icon: Database, title: t('studio_apps_panels.binding.choice_dataset_title', 'A saved view'), blurb: t('studio_apps_panels.binding.choice_dataset_blurb', 'A question you saved earlier — or build a new one here.') },
    { kind: 'actionResult', icon: Play, title: t('studio_apps_panels.binding.choice_action_title', 'The result of an automation'), blurb: t('studio_apps_panels.binding.choice_action_blurb', 'Whatever an automation hands back when it finishes.') },
    { kind: 'static', icon: Pencil, title: t('studio_apps_panels.binding.choice_static_title', 'Type the values myself'), blurb: t('studio_apps_panels.binding.choice_static_blurb', 'Write the values in by hand.') },
];

// Two rarer sources, one click deeper.
export const moreSourceChoices = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    { kind: 'aggregate', icon: Sigma, title: t('studio_apps_panels.binding.choice_aggregate_title', 'A count or total'), blurb: t('studio_apps_panels.binding.choice_aggregate_blurb', 'How many, or the total — optionally split by a column.') },
    { kind: 'formula', icon: Calculator, title: t('studio_apps_panels.binding.choice_formula_title', 'Worked out on the page'), blurb: t('studio_apps_panels.binding.choice_formula_blurb', 'Built from other things on the screen, like who is signed in.') },
    { kind: 'connector', icon: Plug, title: t('studio_apps_panels.binding.choice_connector_title', 'Another system'), blurb: t('studio_apps_panels.binding.choice_connector_blurb', 'Rows fetched from a system outside this app.') },
];

const KINDS = ['records', 'dataset', 'actionResult', 'static', 'aggregate', 'formula', 'connector'];

/** Fills `{slot}` markers in an already translated sentence with React nodes. */
export function slotted(text: string, slots: Record<string, React.ReactNode>) {
    return text.split(/(\{[a-z]+\})/).map((part, i) => {
        const m = part.match(/^\{([a-z]+)\}$/);
        return m && m[1] in slots ? <React.Fragment key={i}>{slots[m[1]]}</React.Fragment> : part;
    });
}

export function modeOf(binding: BindingDraft | null | undefined) {
    const kind = binding?.kind;
    // record + records share one card (a "Single row" toggle picks between them).
    if (kind === 'record') return 'records';
    if (kind && KINDS.includes(kind)) return kind;
    return 'static';
}

/** Nothing chosen yet: no binding at all, or the untouched default literal. */
export function isUnset(binding: BindingDraft | null | undefined) {
    if (!binding || binding.kind !== 'static') return false;
    const v = binding.value;
    if (v == null || v === '') return true;
    return Array.isArray(v) && v.length === 0;
}

/** The empty binding each card drops the user into. */
export function skeletonFor(kind: string, runActions: [string, unknown][]): BindingDraft | null {
    switch (kind) {
        case 'static': return { kind: 'static', value: null };
        case 'formula': return { kind: 'formula', expr: '' };
        case 'records': return { kind: 'records', tableId: '' };
        // Starts as a plain row count — the most common thing anyone wants, and
        // valid on its own so the tile renders something immediately.
        case 'aggregate': return { kind: 'aggregate', tableId: '', aggregates: [{ fn: 'count', as: 'count' }] };
        case 'dataset': return { kind: 'dataset', datasetId: null };
        case 'connector': return { kind: 'connector', connectorId: null, params: {} };
        case 'actionResult': return { kind: 'actionResult', actionId: runActions[0]?.[0] || null, path: '' };
        default: return null;
    }
}

export function staticDisplay(value: unknown) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

export function parseStatic(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') return raw;
    if (/^[[{"]|^-?\d+(\.\d+)?$|^(true|false|null)$/.test(trimmed)) {
        try { return JSON.parse(trimmed); } catch (err) { logger.debug('keep raw', err); }
    }
    return raw;
}

export function normSort(sort: unknown): { field?: string; dir?: string } | null {
    if (Array.isArray(sort)) return sort[0] || null;
    if (sort && typeof sort === 'object') return sort as { field?: string; dir?: string };
    return null;
}

export function isFormulaVal(v: unknown) { return !!v && typeof v === 'object' && (v as { kind?: unknown }).kind === 'formula'; }
