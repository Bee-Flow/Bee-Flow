/**
 * The step picker's groups, in the web's order — a port of the grouping half
 * of the web builder's flow/stepPalette.js, pinned by palette.lockstep.test.ts.
 *
 * Triggers (once there is one), AI, Action (every connected app's actions,
 * by category), Flow (Flow control · People & waiting · Data & lists ·
 * Integrations), Flowlets, and the reusable Steps.
 */

import type { Translate } from '../types';
import { appPlacement, INTEGRATION_CATEGORY_ORDER, OTHER_CATEGORY, resolveIntegrationFromTool } from './appCatalog';
import { shortAppLabel, uiDescription } from './appLabels';
import { codeItemFor, gated, localised, NOT_INSIDE_A_LAYER } from './gating';
import {
    additionalTriggerItems, AI_ITEMS, COLLECTION_ITEMS, CREATE_LAYER_ITEM, DATA_ITEMS, FLOW_CONTROL_ITEMS,
    INTEGRATION_ITEMS, LAYER_OUTPUT_ITEM, PEOPLE_ITEMS, TRIGGERS,
} from './items';
import { isStepIcon } from './stepIcons';
import type { PaletteApp, PaletteBlock, PaletteCatalog, PaletteGroup, PaletteItem, PaletteLayer, PaletteScope, PaletteSection } from './types';

export const CATEGORY_ORDER: readonly string[] = [...INTEGRATION_CATEGORY_ORDER, OTHER_CATEGORY];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function inlineLayerItem(l: PaletteLayer): PaletteItem {
    return {
        id: l.key, icon: 'Layers', label: l.title || l.key,
        desc: `${plural((l.params || []).length, 'input')}`,
        keywords: 'flowlet subflow sub-automation reusable group',
        payload: { kind: 'call_layer', layerKey: l.key, label: l.title || l.key },
    };
}

/** A reusable Step: the author's own sentence first, the arity after it. */
export function blockItem(b: PaletteBlock): PaletteItem {
    const blurb = uiDescription(b.description);
    const arity = `${plural((b.params || []).length, 'input')} · ${plural((b.outputFields || []).length, 'output')}`;
    return {
        id: `block_${b.id}`, icon: isStepIcon(b.icon) ? b.icon : 'Box', label: b.title || 'Step',
        desc: blurb ? `${blurb} · ${arity}` : arity,
        keywords: `step block reusable building-block call ${b.title || ''} ${blurb}`.trim(),
        payload: { kind: 'call_block', blockId: b.id as string, label: b.title || 'Step', icon: b.icon || null },
    };
}

export function prettifyToolName(name: unknown): string {
    return name ? String(name).replace(/_/g, ' ') : '';
}

const UNCATEGORISED = 'Uncategorised';

/** Reusable Steps by their user-set category: named ones A→Z, the catch-all last. */
export function groupBlocksByCategory(blocks: PaletteBlock[]): PaletteSection[] {
    const map = new Map<string, PaletteBlock[]>();
    for (const b of blocks) {
        const cat = (b.category && b.category.trim()) || UNCATEGORISED;
        map.set(cat, [...(map.get(cat) ?? []), b]);
    }
    const cats = [...map.keys()].sort((a, c) => (a === UNCATEGORISED ? 1 : c === UNCATEGORISED ? -1 : a.localeCompare(c)));
    return cats.map((cat) => ({
        key: `step_cat_${cat}`,
        title: cat,
        items: (map.get(cat) as PaletteBlock[]).slice().sort((x, y) => (x.title || '').localeCompare(y.title || '')).map(blockItem),
    }));
}

const UNRANKED = 1000;

type CatalogApp = NonNullable<PaletteCatalog['apps']>[number];

function actionsOf(a: CatalogApp): PaletteApp['actions'] {
    return (a.actions || []).map((act) => ({
        kind: 'integration_action' as const,
        tool: act.name,
        label: act.label || prettifyToolName(act.name),
        description: act.description,
        integrationId: act.integrationId || resolveIntegrationFromTool(act.name) || a.id,
        sideEffect: act.sideEffect,
    }));
}

/** One app as the Action group lists it, with the category it belongs in. */
function appEntry(a: CatalogApp, actions: PaletteApp['actions']): { category: string; app: PaletteApp } {
    const integrationId = actions[0]?.integrationId || a.id;
    const known = appPlacement(a.id, integrationId);
    const category = known?.category || OTHER_CATEGORY;
    const app: PaletteApp = {
        id: a.id,
        label: a.label,
        shortLabel: shortAppLabel(a.label, category, String(a.id || '').toLowerCase().replace(/-/g, '_')),
        rank: known?.rank != null && Number.isFinite(known.rank) ? known.rank : UNRANKED,
        integrationId,
        actions,
        connected: a.connected !== false,
    };
    return { category, app };
}

/** The catalog's apps by integration category, ranked, then A→Z by the label on screen. */
export function groupAppsByCategory(catalog: PaletteCatalog | null | undefined): Record<string, PaletteApp[]> {
    if (!catalog?.apps) return {};
    const out: Record<string, PaletteApp[]> = {};
    for (const a of catalog.apps) {
        if (!a.available) continue;
        const actions = actionsOf(a);
        if (actions.length === 0) continue;
        const { category, app } = appEntry(a, actions);
        (out[category] = out[category] || []).push(app);
    }
    for (const k of Object.keys(out)) {
        (out[k] as PaletteApp[]).sort((x, y) => x.rank - y.rank || x.shortLabel.localeCompare(y.shortLabel));
    }
    return out;
}

/** The apps in category order, empty categories dropped. */
export function orderedAppCategories(catalog: PaletteCatalog | null | undefined): { category: string; apps: PaletteApp[] }[] {
    const grouped = groupAppsByCategory(catalog);
    return CATEGORY_ORDER.map((category) => ({ category, apps: grouped[category] || [] })).filter((g) => g.apps.length > 0);
}

const title = (t: Translate | null | undefined, key: string, english: string) => (t ? t(key, english) : english);
const allowedHere = (inLayer: boolean) => (it: PaletteItem) => !inLayer || !NOT_INSIDE_A_LAYER.has(it.payload.kind);

/** The four content sections of the Flow group; every step has exactly one home. */
function flowSections({ catalog = null, inLayer = false, hasFormTrigger = null, t = null }: PaletteScope): PaletteSection[] {
    const codeItem = codeItemFor(catalog);
    return [
        {
            key: 'flow_control', title: title(t, 'routines.node.group.flow_control', 'Flow control'),
            items: FLOW_CONTROL_ITEMS.filter(allowedHere(inLayer)).map((it) => localised(it, t)),
        },
        {
            key: 'people', title: title(t, 'routines.node.group.people', 'People & waiting'),
            items: PEOPLE_ITEMS.filter(allowedHere(inLayer)).map((it) => localised(gated(it, hasFormTrigger), t)),
        },
        {
            key: 'data', title: title(t, 'routines.node.group.data_lists', 'Data & lists'),
            items: [...DATA_ITEMS, ...COLLECTION_ITEMS].map((it) => localised(it, t)),
        },
        {
            key: 'integrations', title: title(t, 'routines.node.group.integrations', 'Integrations'),
            items: [...INTEGRATION_ITEMS, ...(codeItem ? [codeItem] : [])].map((it) => localised(it, t)),
        },
    ];
}

/** The group headings, by key: the web's own key where it has one, else `mobile.flow.palette.group_*`. */
const GROUP_TITLES: Readonly<Record<string, readonly [string, string]>> = {
    triggers: ['routines.ribbon.trigger', 'Trigger'],
    ai: ['routines.ribbon.ai', 'AI'],
    action: ['mobile.flow.palette.group_action', 'Action'],
    flow: ['mobile.flow.palette.group_flow', 'Flow'],
    flowlets: ['mobile.flow.palette.group_flowlets', 'Flowlets'],
    steps: ['mobile.flow.palette.group_steps', 'Steps'],
};

const groupTitle = (key: string, t: Translate | null | undefined) => {
    const [i18nKey, english] = GROUP_TITLES[key] as readonly [string, string];
    return title(t, i18nKey, english);
};

function stepsGroup(blocks: PaletteBlock[], t: Translate | null | undefined): PaletteGroup {
    const sections = groupBlocksByCategory(blocks);
    const only = sections[0];
    // A single uncategorised bucket reads better flat.
    if (sections.length === 1 && only && only.title === UNCATEGORISED) return { key: 'steps', title: groupTitle('steps', t), items: only.items };
    return { key: 'steps', title: groupTitle('steps', t), kind: 'sections', sections };
}

/** Flowlet output (inside a flowlet), "Create flowlet", and every flowlet. */
function flowletItems({ layers = [], canAddLayerOutput = false, canCreateLayer = true, t = null }: PaletteScope): PaletteItem[] {
    return [
        ...(canAddLayerOutput ? [localised(LAYER_OUTPUT_ITEM, t)] : []),
        ...(canCreateLayer ? [localised(CREATE_LAYER_ITEM, t)] : []),
        ...(layers || []).map(inlineLayerItem),
    ];
}

/** The reusable Steps the scope may call; none at a Step's own root. */
export function scopeBlocks({ catalog = null, isBlockRoot = false }: PaletteScope): PaletteBlock[] {
    return isBlockRoot ? [] : (catalog?.steps || []).filter((s) => s && s.available !== false);
}

/**
 * The ordered groups the picker renders. `mode: 'trigger'` (the empty
 * canvas) offers only triggers: nothing else can go first.
 */
export function buildStepGroups(scope: PaletteScope = {}): PaletteGroup[] {
    const { t } = scope;
    if (scope.mode === 'trigger') return [{ key: 'triggers', title: groupTitle('triggers', t), items: TRIGGERS.map((it) => localised(it, t)) }];
    const flowlets = flowletItems(scope);
    const blocks = scopeBlocks(scope);
    const offerTriggers = !scope.inLayer && !scope.isBlockRoot;
    const groups: PaletteGroup[] = [
        ...(offerTriggers ? [{ key: 'triggers', title: groupTitle('triggers', t), items: additionalTriggerItems().map((it) => localised(it, t)) }] : []),
        { key: 'ai', title: groupTitle('ai', t), items: AI_ITEMS.map((it) => localised(it, t)) },
        { key: 'action', title: groupTitle('action', t), kind: 'apps', categories: orderedAppCategories(scope.catalog) },
        { key: 'flow', title: groupTitle('flow', t), kind: 'sections', sections: flowSections(scope) },
        ...(flowlets.length ? [{ key: 'flowlets', title: groupTitle('flowlets', t), items: flowlets }] : []),
    ];
    if (blocks.length > 0) groups.push(stepsGroup(blocks, t));
    return groups;
}

/** An item by id from a flat list. */
export function pickItem(items: readonly PaletteItem[] | null | undefined, id: string): PaletteItem | null {
    return (items || []).find((it) => it.id === id) || null;
}
