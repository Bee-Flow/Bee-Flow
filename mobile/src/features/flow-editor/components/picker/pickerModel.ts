/**
 * The step picker's rows: the palette (model/palette — the port of the web's
 * stepPalette.js) for the place a "+" was tapped, flattened into sections a
 * SectionList renders, with the palette's own rules applied as the web
 * applies them: inside a loop body or a parallel branch the three kinds the
 * validator refuses there are gone, and so are triggers, flowlets and
 * published Steps (NOT_INSIDE_A_LAYER, and the scope of the web's
 * LoopBodyEditor); a form page needs a form trigger (shown, disabled, with
 * the reason); an app as the catalog's `available` says; Code as the
 * server's `flags.code` allows it. Nothing else is gated: the web palette
 * checks no licence, and neither does the server's validator.
 *
 * Browsing lists the groups in the web's order; a query lists the ranked hits
 * (the web's buildSearchResults). Pure.
 */

import {
    buildSearchResults, buildStepGroups, layerKeysThatReach,
    type FlowDefinition, type PaletteCatalog, type PaletteGroup, type PaletteItem, type PaletteLayer, type PaletteResult,
    type PaletteScope, type StepPayload, type Translate,
} from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';
import { isIconName, type IconName } from '@/shared/ui';


export interface PickerItemRow {
    kind: 'item';
    key: string;
    icon: IconName;
    label: string;
    secondary: string;
    payload: StepPayload;
    disabled: boolean;
    reason: string | null;
}

/** An app's name over its actions. */
export interface PickerAppRow {
    kind: 'app';
    key: string;
    label: string;
}

export type PickerRow = PickerItemRow | PickerAppRow;

export interface PickerSection {
    key: string;
    title: string;
    data: PickerRow[];
}

/**
 * The routine's flowlets, as the picker lists them. Inside a flowlet, every
 * flowlet whose calls reach it (itself included) is left out: calling one
 * from there would be a cycle (the web's paletteLayers).
 */
export function layersOf(def: FlowDefinition | null | undefined, flowlet: string | null = null): PaletteLayer[] {
    const blocked = flowlet ? layerKeysThatReach(def, flowlet) : null;
    return Object.entries(def?.layers || {}).filter(([key]) => !blocked?.has(key)).map(([key, layer]) => ({
        key,
        title: typeof layer?.title === 'string' ? layer.title : undefined,
        params: Array.isArray(layer?.params) ? layer.params : [],
    }));
}

/**
 * The palette scope for one "+": what the graph around it allows. A step held
 * in a loop's body or a parallel branch gets the web LoopBodyEditor's scope:
 * no flowlets, no published Steps (`isBlockRoot`), no triggers. Inside a
 * flowlet (`flowlet`, its key) the web BuildTab's: no triggers, the steps a
 * flowlet cannot hold left out, and its one "Return" offered while it has none.
 */
export function pickerScope(
    def: FlowDefinition,
    target: AddTarget,
    { catalog = null, t = null, flowlet = null }: { catalog?: PaletteCatalog | null; t?: Translate | null; flowlet?: string | null } = {},
): PaletteScope {
    const hasTrigger = !!def.trigger?.id;
    const held = target.kind === 'inline';
    return {
        catalog,
        mode: hasTrigger ? 'step' : 'trigger',
        layers: held ? [] : layersOf(def, flowlet),
        inLayer: held || !!flowlet,
        canAddLayerOutput: !held && !!flowlet && !def.steps.some((s) => s?.type === 'layer_output'),
        isBlockRoot: held,
        canCreateLayer: !held,
        hasFormTrigger: hasTrigger ? def.trigger?.kind === 'form' : null,
        t,
    };
}

/** The item's Lucide name (the web's spelling, in the registry); an app action has none. */
const iconOf = (name: string | null | undefined): IconName => (name && isIconName(name) ? name : 'Wrench');

function itemRow(it: PaletteItem, prefix: string): PickerItemRow {
    return {
        kind: 'item', key: `${prefix}:${it.id}`, icon: iconOf(it.icon), label: it.label, secondary: it.desc, payload: it.payload,
        disabled: !!it.disabled, reason: it.disabled ? (it.disabledReason ?? null) : null,
    };
}

function resultRow(r: PaletteResult, index: number): PickerItemRow {
    return {
        kind: 'item', key: `hit:${index}:${r.key}`, icon: iconOf(r.Icon), label: r.label,
        secondary: [r.context, r.secondary].filter(Boolean).join(' · '), payload: r.payload,
        disabled: !!r.disabled, reason: r.disabled ? (r.disabledReason ?? null) : null,
    };
}

function itemsSection(key: string, title: string, items: readonly PaletteItem[]): PickerSection {
    return { key, title, data: items.map((it) => itemRow(it, key)) };
}

function sectionsOf(group: PaletteGroup): PickerSection[] {
    if (group.kind === 'sections') {
        return group.sections.map((s) => itemsSection(`${group.key}:${s.key}`, s.title, s.items));
    }
    if (group.kind === 'apps') {
        return group.categories.map(({ category, apps }) => ({
            key: `${group.key}:${category}`,
            title: `${group.title} · ${category}`,
            data: apps.flatMap((app): PickerRow[] => [
                { kind: 'app', key: `app:${app.id}`, label: app.shortLabel || app.label || app.id },
                ...app.actions.map((a): PickerItemRow => ({
                    kind: 'item', key: `action:${app.id}:${a.tool}`, icon: 'Wrench', label: a.label, secondary: a.description ?? '',
                    payload: { kind: 'integration_action', tool: a.tool, label: a.label, appId: a.integrationId, sideEffect: a.sideEffect },
                    disabled: false, reason: null,
                })),
            ]),
        }));
    }
    return [itemsSection(group.key, group.title, group.items)];
}

/**
 * Does this "+" take a trigger? Only the flow's own start (the empty
 * canvas, the canvas's Add, the trigger block's "+"). A "+" between two
 * steps or after one is a place in the flow, and a trigger picked there
 * never landed there: it went to the top, unwired — and one of the primary's
 * kind replaced it, settings and all.
 */
export function takesTriggers(target: AddTarget): boolean {
    return target.kind === 'root';
}

const isTriggerRow = (r: PickerRow) => r.kind === 'item' && r.payload.kind === 'trigger';

/**
 * The sections to render: every group while browsing, the ranked hits for a
 * query. Empty sections are dropped; `triggers: false` leaves the triggers
 * out (a "+" in the middle of the flow).
 */
export function pickerSections(scope: PaletteScope, query: string, { triggers = true }: { triggers?: boolean } = {}): PickerSection[] {
    const q = query.trim();
    const sections: PickerSection[] = q
        ? [{ key: 'results', title: '', data: buildSearchResults(q, scope).map(resultRow) }]
        : buildStepGroups(scope).flatMap(sectionsOf);
    return sections
        .map((s) => (triggers ? s : { ...s, data: s.data.filter((r) => !isTriggerRow(r)) }))
        .filter((s) => s.data.some((r) => r.kind === 'item'));
}
