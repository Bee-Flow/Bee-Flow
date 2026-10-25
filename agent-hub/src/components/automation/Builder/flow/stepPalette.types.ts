import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { AppCategory, ItemSection, PaletteItem, RibbonApp, StepPayload } from './ribbon/ribbonCategories';

export type { PaletteItem, TranslateFn };

/** An action of a catalog app, as the server sends it. */
interface CatalogAction {
    name: string;
    label?: string;
    description?: string;
    integrationId?: string;
    sideEffect?: unknown;
}

/** An app of the tool catalog. */
export interface CatalogApp {
    id: string;
    label: string;
    available?: boolean;
    connected?: boolean;
    actions?: CatalogAction[];
}

/** A reusable Step (block) of the catalog. */
export interface CatalogStep {
    id: string | number;
    title?: string;
    description?: string;
    icon?: string | null;
    category?: string;
    available?: boolean;
    params?: unknown[];
    outputFields?: unknown[];
}

/** The tool catalog as far as the palette reads it. */
export interface PaletteCatalog {
    flags?: { code?: boolean; codeReason?: string };
    apps?: CatalogApp[];
    steps?: CatalogStep[];
}

/** A flowlet that can be called from the current graph. */
export interface PaletteLayer {
    key: string;
    title?: string;
    params?: unknown[];
}

/** The scope the palette is built for. */
export interface PaletteScope {
    catalog?: PaletteCatalog | null;
    mode?: string;
    layers?: PaletteLayer[] | null;
    inLayer?: boolean;
    canAddLayerOutput?: boolean;
    isBlockRoot?: boolean;
    canCreateLayer?: boolean;
    hasFormTrigger?: boolean | null;
    t?: TranslateFn | null;
}

/** An entry that may carry its own i18n keys instead of its type's name. */
export interface Localisable {
    label: string;
    desc?: string;
    i18n?: { label: string; desc: string };
    payload?: { kind?: string };
}

/** The shape every item handed to the gate has. */
export interface GateItem {
    payload?: { kind?: string };
}

/** One group of the Add-step menu. */
export interface StepGroup {
    key: string;
    title: string;
    kind?: 'apps' | 'sections';
    items?: PaletteItem[];
    categories?: AppCategory[];
    sections?: ItemSection[];
}

/** A catalog app with its actions, grouped under an integration category. */
export type AppEntry = Omit<RibbonApp, 'shortLabel'> & { shortLabel: string; rank: number; connected: boolean };

/** nodeDefs.js accessors, as callers use them. */
export type NodeTextFn = (kind?: string, t?: TranslateFn | null) => string;

/** A flat search/suggestion row. */
export interface SearchCandidate {
    key: string;
    Icon: LucideIcon | PaletteItem['icon'];
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
}
