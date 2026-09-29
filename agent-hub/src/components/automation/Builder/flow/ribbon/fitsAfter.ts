import {
    AI_STEP, DATA_EXTRACTION, EDIT_DATA_ITEM, ROUTE_ITEM, DATA_ITEMS, FLOW_CONTROL_ITEMS, PEOPLE_ITEMS,
    itemForKey, gated, pickItem,
} from '../stepPalette';
import { topFrequentKeys } from '../stepUsage';
import type { IconType, StepPayload, PaletteItem } from './ribbonCategories';
import type { OrgStepUsage } from '../../../../../api/queries/automation/usage';

/**
 * The Suggested tab (design 5a): "Fits after <step>" cards read off what the
 * selected step hands on, and a "Frequently used" grid that blends this
 * organisation's counts with the author's own history.
 */

interface StepLike {
    id?: string;
    type?: string;
    kind?: string;
    tool?: string;
    label?: string;
    [key: string]: unknown;
}

interface CatalogLike {
    apps?: Array<{ actions?: Array<{ name: string; outputSample?: unknown }> }>;
    [key: string]: unknown;
}

// Steps whose output is a list by construction.
const LIST_KINDS = new Set(['filter', 'limit', 'dedupe', 'aggregate']);

/**
 * Best-effort guess whether a step's output is a list. Heuristic only:
 * collection ops emit lists; an app action is list-shaped when its catalog
 * outputSample is, or holds, an array.
 */
export function stepOutputIsArray(step: StepLike | null | undefined, catalog: CatalogLike | null | undefined): boolean {
    if (!step) return false;
    const kind = step.kind || step.type;
    if (kind && LIST_KINDS.has(kind)) return true;
    if (kind === 'integration_action' && step.tool) {
        for (const a of catalog?.apps || []) {
            const act = (a.actions || []).find(x => x.name === step.tool);
            if (!act) continue;
            const s = act.outputSample;
            if (Array.isArray(s)) return true;
            if (s && typeof s === 'object') return Object.values(s as Record<string, unknown>).some(v => Array.isArray(v));
            return false;
        }
    }
    return false;
}

export type OutputShape = 'start' | 'list' | 'record';

export function outputShapeOf(step: StepLike | null | undefined, catalog: CatalogLike | null | undefined): OutputShape {
    if ((step?.type || step?.kind) === 'trigger') return 'start';
    return stepOutputIsArray(step, catalog) ? 'list' : 'record';
}

export interface FitCard {
    id: string;
    family: string;
    Icon: IconType;
    titleKey: string;
    title: string;
    whyKey: string;
    why: string;
    payload: StepPayload;
    disabled?: boolean;
    disabledReason?: string;
}

const itemOf = (items: PaletteItem[], id: string): PaletteItem => pickItem(items, id) as PaletteItem;

interface CardSpec {
    item: () => PaletteItem;
    family: string;
    key: string;
    title: string;
    why: string;
    label?: string;
}

const AI = (key: string, title: string, why: string, label?: string): CardSpec => ({ item: () => AI_STEP as PaletteItem, family: 'ai', key, title, why, label });
const ROUTE = (key: string, title: string, why: string): CardSpec => ({ item: () => ROUTE_ITEM as PaletteItem, family: 'branch', key, title, why });

const CARDS: Record<OutputShape, CardSpec[]> = {
    list: [
        { item: () => itemOf(FLOW_CONTROL_ITEMS as PaletteItem[], 'loop'), family: 'loop', key: 'for_each', title: 'For each item', why: 'Repeat the next steps for every item in the list' },
        ROUTE('filter_list', 'Filter the list', 'For example only PDFs, or only this week'),
        { item: () => itemOf(DATA_ITEMS as PaletteItem[], 'datatable'), family: 'data', key: 'to_datatable', title: 'Put in a datatable', why: 'One row per item' },
        AI('summarise', 'Summarise with AI', 'What is in this list?', 'Summarise with AI'),
    ],
    record: [
        AI('ai_step', 'AI step', 'Let AI read, sort or write something with it'),
        ROUTE('if_then', 'If… then…', 'Take another path depending on a value'),
        { item: () => EDIT_DATA_ITEM as PaletteItem, family: 'data', key: 'edit_data', title: 'Edit data', why: 'Pick, rename or calculate fields' },
        { item: () => itemOf(PEOPLE_ITEMS as PaletteItem[], 'notification'), family: 'pause', key: 'notify', title: 'Send a notification', why: 'Tell someone what happened' },
    ],
    start: [
        AI('ai_start', 'AI step', 'Let AI handle what came in'),
        { item: () => DATA_EXTRACTION as PaletteItem, family: 'ai', key: 'extract', title: 'Extract data', why: 'Read fields from a document or an email' },
        ROUTE('if_then', 'If… then…', 'Take another path depending on a value'),
        { item: () => itemOf(PEOPLE_ITEMS as PaletteItem[], 'approval'), family: 'pause', key: 'approve', title: 'Ask for approval', why: 'A person checks before the run goes on' },
    ],
};

/** The four "Fits after" cards for a step, or none when there is no step. */
export function fitsAfterCards(
    step: StepLike | null | undefined,
    catalog: CatalogLike | null | undefined,
    { hasFormTrigger = null }: { hasFormTrigger?: boolean | null } = {},
): FitCard[] {
    if (!step) return [];
    const shape = outputShapeOf(step, catalog);
    const out: FitCard[] = [];
    for (const spec of CARDS[shape]) {
        const item = spec.item();
        if (!item) continue;
        const g = gated(item, hasFormTrigger, catalog) as PaletteItem;
        out.push({
            id: `${shape}:${spec.key}`,
            family: spec.family,
            Icon: (item.icon || AI_STEP.icon) as IconType,
            titleKey: `routines.ribbon.fit_${spec.key}`,
            title: spec.title,
            whyKey: `routines.ribbon.fit_${spec.key}_why`,
            why: spec.why,
            payload: spec.label ? { ...item.payload, label: spec.label } : item.payload,
            ...(g.disabled ? { disabled: true, disabledReason: g.disabledReason } : null),
        });
    }
    return out;
}

/**
 * Blend the org's counts with the author's own history into one ranked list
 * of usage-keys. Both halves are scaled to 0..1 first (org: share of the top
 * count; personal: rank decay), so neither drowns the other. Triggers are
 * left out: the ribbon adds steps, a trigger is changed on the start card.
 */
export function mergeFrequentKeys(
    orgRows: OrgStepUsage[] | null | undefined,
    personalUsage: Record<string, unknown> | null | undefined,
    n = 8,
    now = Date.now(),
): string[] {
    const score = new Map<string, number>();
    const add = (key: string, v: number) => {
        if (!key || key.startsWith('trigger:')) return;
        score.set(key, (score.get(key) || 0) + v);
    };
    const rows = orgRows || [];
    const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
    if (max > 0) for (const r of rows) add(r.key, r.count / max);
    (topFrequentKeys(personalUsage || {}, 12, now) as string[]).forEach((key, i) => add(key, Math.pow(0.85, i)));
    return [...score.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, n * 2)
        .map(([key]) => key);
}

/** A resolved "Frequently used" entry (the shape stepPalette.itemForKey returns). */
export interface FrequentItem {
    key: string;
    Icon?: IconType | null;
    integrationId?: string | null;
    tool?: string | null;
    label: string;
    secondary?: string;
    payload: StepPayload;
    disabled?: boolean;
    disabledReason?: string;
}

// stepPalette.itemForKey, typed: its `= null` defaults read as `null` from TypeScript.
const lookupItem = itemForKey as unknown as (key: string, opts: { catalog: unknown; layers: unknown[] }) => FrequentItem | null;

/** Resolve merged keys to addable items in this scope, `n` at most. */
export function resolveFrequent(
    keys: string[],
    { catalog = null, layers = [], hasFormTrigger = null, n = 8 }: { catalog?: unknown; layers?: unknown[]; hasFormTrigger?: boolean | null; n?: number } = {},
): FrequentItem[] {
    const out: FrequentItem[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
        const it = lookupItem(key, { catalog, layers });
        if (!it) continue;
        const id = `${it.payload?.kind}:${it.key}:${it.label}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(gated(it, hasFormTrigger, catalog) as FrequentItem);
        if (out.length >= n) break;
    }
    return out;
}
