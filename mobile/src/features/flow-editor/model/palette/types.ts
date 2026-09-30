/**
 * The step picker's data shapes (the web's stepPalette.js items and groups).
 */

import type { StepPayload } from '../scaffolds';

/** One addable thing. `icon` is a Lucide name, exactly as the web names it. */
export interface PaletteItem {
    id: string;
    icon: string;
    label: string;
    desc: string;
    keywords: string;
    payload: StepPayload;
    /** Shown but inert, with the reason — the graph or the server says no. */
    disabled?: boolean;
    disabledReason?: string;
    /** The keys `label` and `desc` are the English fallbacks of (see `localised`). */
    labelKey?: string;
    descKey?: string;
    disabledReasonKey?: string;
}

/** The subset of GET /api/automation/catalog the picker reads. */
export interface PaletteCatalog {
    apps?: {
        id: string;
        label?: string;
        available?: boolean;
        connected?: boolean;
        actions?: {
            name: string;
            label?: string;
            description?: string;
            integrationId?: string;
            sideEffect?: boolean;
        }[];
    }[];
    /** Reusable Steps (kind='block'). */
    steps?: PaletteBlock[];
    flags?: { code?: unknown; codeReason?: string | null } & Record<string, unknown>;
}

export interface PaletteBlock {
    id: string | number;
    title?: string;
    description?: string;
    category?: string | null;
    icon?: string | null;
    params?: unknown[];
    outputFields?: unknown[];
    available?: boolean;
}

/** A flowlet as the picker lists it. */
export interface PaletteLayer {
    key: string;
    title?: string;
    params?: unknown[];
}

/** One integration action, grouped under its app. */
export interface PaletteAction {
    kind: 'integration_action';
    tool: string;
    label: string;
    description?: string;
    integrationId: string;
    sideEffect?: boolean;
}

export interface PaletteApp {
    id: string;
    label?: string;
    shortLabel: string;
    rank: number;
    integrationId: string;
    actions: PaletteAction[];
    connected: boolean;
}

export interface PaletteSection {
    key: string;
    title: string;
    items: PaletteItem[];
}

/** A group of the picker: flat, the apps tree, or sub-sections. */
export type PaletteGroup =
    | { key: string; title: string; items: PaletteItem[]; kind?: undefined }
    | { key: string; title: string; kind: 'apps'; categories: { category: string; apps: PaletteApp[] }[] }
    | { key: string; title: string; kind: 'sections'; sections: PaletteSection[] };

/** A search hit or a suggestion, ready to render. */
export interface PaletteResult {
    key: string;
    /** A Lucide name, or null for an app action (drawn by its integration logo). */
    Icon: string | null;
    label: string;
    secondary?: string;
    keywords?: string;
    context?: string;
    description?: string;
    integrationId?: string;
    tool?: string;
    payload: StepPayload;
    disabled?: boolean;
    disabledReason?: string;
    disabledReasonKey?: string;
    _bucket?: number;
}

export interface PaletteScope {
    catalog?: PaletteCatalog | null;
    /** 'trigger' on an empty canvas: only a trigger can go first. */
    mode?: 'step' | 'trigger';
    layers?: PaletteLayer[];
    /** Inside a flowlet or a loop body. */
    inLayer?: boolean;
    canAddLayerOutput?: boolean;
    isBlockRoot?: boolean;
    canCreateLayer?: boolean;
    /** TRI-STATE: only a definite `false` disables the form steps. */
    hasFormTrigger?: boolean | null;
    t?: ((key: string, fallback: string) => string) | null;
}
