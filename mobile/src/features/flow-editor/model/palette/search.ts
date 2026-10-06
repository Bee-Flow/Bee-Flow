/**
 * Search across every addable thing, and the usage-key lookup behind
 * "Suggested" / "Frequently used" — a port of the search half of the web
 * builder's flow/stepPalette.js, pinned by palette.lockstep.test.ts.
 *
 * Ranking buckets: 0 exact label · 1 label starts with · 2 label contains ·
 * 3 description / keywords / tool contains · 4 every (non-connective) word
 * of a phrase lands somewhere. Bucket 4 only ADDS results.
 */

import { resolveIntegrationFromTool } from './appCatalog';
import { actionLabelMap } from './appLabels';
import { codeItemFor, gated, localised, NOT_INSIDE_A_LAYER } from './gating';
import { blockItem, inlineLayerItem, prettifyToolName, scopeBlocks } from './groups';
import {
    additionalTriggerItems, AI_ITEMS, ALL_STATIC_ITEMS, COLLECTION_ITEMS, CREATE_LAYER_ITEM, DATA_ITEMS,
    EDIT_DATA_ITEM, INTEGRATION_ITEMS, LAYER_OUTPUT_ITEM, LOGIC_ITEMS, PRIVACY_SHIELD_ITEM, ROUTE_ITEM, TRIGGERS,
} from './items';
import type { Translate } from '../types';
import type { PaletteCatalog, PaletteItem, PaletteLayer, PaletteResult, PaletteScope } from './types';

type App = NonNullable<PaletteCatalog['apps']>[number];
type Action = NonNullable<App['actions']>[number];

const asResult = (item: PaletteItem | null | undefined, t: Translate | null = null): PaletteResult | null => {
    const it = item && localised(item, t);
    return it ? { key: it.id, Icon: it.icon, label: it.label, secondary: it.desc, payload: it.payload } : null;
};

function actionResult(a: App, act: Action, labels: Map<string, string>): PaletteResult {
    const integrationId = act.integrationId || resolveIntegrationFromTool(act.name) || a.id;
    const label = act.label || prettifyToolName(act.name);
    return {
        key: act.name, Icon: null, integrationId, tool: act.name,
        label: labels.get(act.name) || label,
        secondary: a.label,
        payload: { kind: 'integration_action', tool: act.name, label, appId: integrationId, sideEffect: act.sideEffect },
    };
}

const labelsOf = (a: App) => actionLabelMap((a.actions || []).map((x) => ({ tool: x.name, label: x.label })));

/** A merged or retired step type still resolves to what the picker offers now. */
function stepForKey(rest: string, { catalog, t }: KeyScope): PaletteResult | null {
    if (['condition', 'switch', 'filter', 'filter_route'].includes(rest)) return asResult(ROUTE_ITEM, t);
    if (rest === 'parse_json') return asResult(EDIT_DATA_ITEM, t);
    if (['guard', 'tokenize', 'untokenize'].includes(rest)) return asResult(PRIVACY_SHIELD_ITEM, t);
    if (rest === 'code') {
        // Dropped rather than disabled: not every surface honours the stamp.
        const code = codeItemFor(catalog);
        return !code || code.disabled ? null : asResult(code, t);
    }
    return asResult(ALL_STATIC_ITEMS.find((x) => x.id === rest) || ALL_STATIC_ITEMS.find((x) => x.payload.kind === rest), t);
}

function actionForKey(rest: string, catalog: PaletteCatalog | null): PaletteResult | null {
    for (const a of catalog?.apps || []) {
        if (a.available === false) continue;
        const act = (a.actions || []).find((x) => x.name === rest);
        if (act) return actionResult(a, act, labelsOf(a));
    }
    return null;
}

/**
 * A usage key (`step:loop`, `action:gmail_send`, `flowlet:<key>`,
 * `block:<id>`, `layer:create`, `trigger:<kind>`) → a render-ready result,
 * or null when it does not resolve in this scope.
 */
type KeyScope = { catalog: PaletteCatalog | null; layers: PaletteLayer[]; t: Translate | null };

const KEY_RESOLVERS: Record<string, (rest: string, s: KeyScope) => PaletteResult | null> = {
    trigger: (rest, s) => asResult(additionalTriggerItems().find((it) => it.payload.triggerKind === rest), s.t),
    step: (rest, s) => stepForKey(rest, s),
    layer: (rest, s) => (rest === 'create' ? asResult(CREATE_LAYER_ITEM, s.t) : null),
    flowlet: (rest, s) => {
        const l = s.layers.find((x) => x.key === rest);
        return l ? asResult(inlineLayerItem(l)) : null;
    },
    block: (rest, s) => {
        const b = (s.catalog?.steps || []).find((x) => String(x.id) === rest && x.available !== false);
        return b ? asResult(blockItem(b)) : null;
    },
    action: (rest, s) => actionForKey(rest, s.catalog),
};

export function itemForKey(
    key: unknown,
    { catalog = null, layers = [], t = null }: { catalog?: PaletteCatalog | null; layers?: PaletteLayer[]; t?: Translate | null } = {},
): PaletteResult | null {
    if (!key || typeof key !== 'string') return null;
    const i = key.indexOf(':');
    if (i < 0) return null;
    const type = key.slice(0, i);
    const resolve = Object.prototype.hasOwnProperty.call(KEY_RESOLVERS, type) ? KEY_RESOLVERS[type] : undefined;
    return resolve ? resolve(key.slice(i + 1), { catalog, layers: layers || [], t }) : null;
}

/** Connectives a phrase may contain without having to match anything. */
const SEARCH_STOP_WORDS = new Set('a an the to of in on at for and or with from into by een de het naar van op voor en met uit bij om dat die'.split(' '));

/** A phrase matches when EVERY non-connective word lands; false for a single word. */
function wordMatcher(q: string): (hay: string) => boolean {
    const all = q.split(/\s+/).filter(Boolean);
    const words = all.filter((tok) => !SEARCH_STOP_WORDS.has(tok));
    if (all.length < 2 || !words.length) return () => false;
    return (hay) => words.every((tok) => hay.includes(tok));
}

function bucketOf(c: PaletteResult, q: string, byWord: (hay: string) => boolean): number {
    const label = (c.label || '').toLowerCase();
    const desc = (c.secondary || c.description || '').toLowerCase();
    const tool = (c.tool || '').toLowerCase();
    const kw = (c.keywords || '').toLowerCase();
    if (label === q) return 0;
    if (label.startsWith(q)) return 1;
    if (label.includes(q)) return 2;
    if (desc.includes(q) || kw.includes(q) || tool.includes(q)) return 3;
    return byWord(`${label} ${desc} ${kw} ${tool}`) ? 4 : -1;
}

function rank(candidates: PaletteResult[], q: string): PaletteResult[] {
    const byWord = wordMatcher(q);
    const ranked: PaletteResult[] = [];
    for (const c of candidates) {
        const bucket = bucketOf(c, q, byWord);
        if (bucket !== -1) ranked.push({ ...c, _bucket: bucket });
    }
    return ranked.sort((a, b) => (a._bucket as number) - (b._bucket as number));
}

const toCandidate = (it: PaletteItem, context: string): PaletteResult => ({
    key: it.id, Icon: it.icon, label: it.label, secondary: it.desc,
    keywords: it.keywords, context, payload: it.payload,
    ...(it.disabled ? { disabled: true, disabledReason: it.disabledReason } : null),
});

function appCandidates(catalog: PaletteCatalog | null): PaletteResult[] {
    const out: PaletteResult[] = [];
    for (const a of catalog?.apps || []) {
        if (!a.available) continue;
        const labels = labelsOf(a);
        for (const act of a.actions || []) {
            out.push({ ...actionResult(a, act, labels), description: act.description, context: a.label });
        }
    }
    return out;
}

/** The built-in steps, in the web's order, each tagged with its context. */
function staticCandidates({ inLayer = false, isBlockRoot = false, hasFormTrigger = null, t = null }: PaletteScope): PaletteResult[] {
    const tagged = (items: readonly PaletteItem[], context: string) => items.map((it) => toCandidate(localised(it, t), context));
    const logic = LOGIC_ITEMS.filter((it) => !inLayer || !NOT_INSIDE_A_LAYER.has(it.payload.kind)).map((it) => gated(it, hasFormTrigger));
    return [
        ...(!inLayer && !isBlockRoot ? tagged(additionalTriggerItems(), 'Trigger') : []),
        ...tagged(AI_ITEMS, 'AI'),
        ...tagged(DATA_ITEMS, 'Data'),
        ...tagged(INTEGRATION_ITEMS, 'Flow'),
        ...tagged(COLLECTION_ITEMS, 'Collection'),
        ...tagged(logic, 'Flow'),
    ];
}

/** Code (as the server allows it), flowlets and reusable Steps. */
function dynamicCandidates(scope: PaletteScope): PaletteResult[] {
    const codeItem = codeItemFor(scope.catalog);
    return [
        ...(codeItem ? [toCandidate(localised(codeItem, scope.t), 'Code')] : []),
        ...(scope.layers || []).map((l) => toCandidate(inlineLayerItem(l), 'Flowlet')),
        ...scopeBlocks(scope).map((b) => toCandidate(blockItem(b), (b.category && b.category.trim()) || 'Step')),
    ];
}

function stepCandidates(scope: PaletteScope): PaletteResult[] {
    return [...staticCandidates(scope), ...dynamicCandidates(scope), ...appCandidates(scope.catalog ?? null)];
}

/** Flat ranked search across every addable thing in this scope. */
export function buildSearchResults(query: unknown, scope: PaletteScope = {}): PaletteResult[] {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const head = scope.canAddLayerOutput ? [toCandidate(localised(LAYER_OUTPUT_ITEM, scope.t), 'Flowlet')] : [];
    if (scope.mode === 'trigger') return rank([...head, ...TRIGGERS.map((tr) => toCandidate(localised(tr, scope.t), 'Trigger'))], q);
    return rank([...head, ...stepCandidates(scope)], q);
}
