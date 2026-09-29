import type { ComponentType } from 'react';
import { Star, Sparkles, GitFork, Users, Table2, Cloud, Plug, Package } from 'lucide-react';
import { buildStepGroups, orderedAppCategories } from '../stepPalette';

/**
 * The ribbon's eight categories (design 5a) and what each one holds.
 *
 * Pure data: which tabs exist, their colour and build-film origin, and the
 * palette split into those tabs. Everything is read off buildStepGroups, so a
 * flowlet or loop scope, the form gate and the code gate filter the ribbon
 * exactly as they filter search and the edge-drop menu.
 */

export type IconType = ComponentType<{ size?: number; className?: string }>;

export interface StepPayload {
    kind: string;
    label?: string;
    [key: string]: unknown;
}

/** A palette entry as stepPalette.js builds it. */
export interface PaletteItem {
    id: string;
    icon?: IconType | null;
    label: string;
    desc?: string;
    keywords?: string;
    payload: StepPayload;
    disabled?: boolean;
    disabledReason?: string;
}

/** An app with its actions, as groupAppsByCategory builds it. */
export interface RibbonApp {
    id: string;
    label: string;
    shortLabel?: string;
    integrationId: string;
    actions: Array<{ kind: string; tool: string; label: string; description?: string; integrationId: string; sideEffect?: unknown }>;
}

export interface AppCategory {
    category: string;
    apps: RibbonApp[];
}

export interface ItemSection {
    key: string;
    title: string;
    items: PaletteItem[];
}

export type RibbonCategoryId = 'suggested' | 'ai' | 'logic' | 'people' | 'data' | 'nextcloud' | 'other_apps' | 'blocks';

/** The integration category the Nextcloud tab shows; every other one is "Other apps". */
export const NEXTCLOUD_CATEGORY = 'Nextcloud';

/**
 * Nextcloud's brand blue. There is no theme token for it, so it lives here,
 * once, as the Tailwind class every Nextcloud-coloured element uses.
 */
export const NEXTCLOUD_TEXT = 'text-[#0082c9]';

export interface CategoryDef {
    id: RibbonCategoryId;
    labelKey: string;
    fallback: string;
    Icon: IconType;
    /** Text colour class of the tab at rest. */
    tone: string;
    /** `data-ribbon-origin` stamp: the build film deals a card from this tab when its own command is not on screen. */
    origin: string | null;
}

/**
 * The "Suggested" tab (design 5a: "Fits after <step>" cards plus "Frequently
 * used in your organisation") is SWITCHED OFF BY DESIGN, at the owner's
 * request (2026-09-28): "remove the suggestion feature. We might want to use
 * something like this, for now disabled it." Everything behind it stays in
 * place (SuggestedPanel, fitsAfter, the org usage query, GET /_usage/steps) so
 * it can come back by flipping this flag; the ribbon then opens on the first
 * real category instead. Do not delete the code, and do not switch it back on
 * without asking the owner.
 */
export const SUGGESTED_TAB_ENABLED = false;

export const CATEGORY_DEFS: readonly CategoryDef[] = [
    { id: 'suggested', labelKey: 'routines.ribbon.cat_suggested', fallback: 'Suggested', Icon: Star, tone: 'text-[var(--text-secondary)]', origin: null },
    { id: 'ai', labelKey: 'routines.ribbon.cat_ai', fallback: 'AI', Icon: Sparkles, tone: 'text-[var(--type-ai)]', origin: 'section:ai' },
    { id: 'logic', labelKey: 'routines.ribbon.cat_logic', fallback: 'Logic', Icon: GitFork, tone: 'text-[var(--type-branch)]', origin: 'section:flow_control' },
    { id: 'people', labelKey: 'routines.ribbon.cat_people', fallback: 'People', Icon: Users, tone: 'text-[var(--type-pause)]', origin: 'section:people' },
    { id: 'data', labelKey: 'routines.ribbon.cat_data', fallback: 'Data & documents', Icon: Table2, tone: 'text-[var(--type-data)]', origin: 'section:data' },
    { id: 'nextcloud', labelKey: 'routines.ribbon.cat_nextcloud', fallback: 'Nextcloud apps', Icon: Cloud, tone: NEXTCLOUD_TEXT, origin: `cat:${NEXTCLOUD_CATEGORY}` },
    { id: 'other_apps', labelKey: 'routines.ribbon.cat_other_apps', fallback: 'Other apps', Icon: Plug, tone: 'text-[var(--text-secondary)]', origin: 'section:integrations' },
    { id: 'blocks', labelKey: 'routines.ribbon.cat_blocks', fallback: 'My building blocks', Icon: Package, tone: 'text-[var(--text-secondary)]', origin: null },
];

/**
 * Tile and icon colours per node family. Literal class strings, because
 * Tailwind only generates what it can read in the source.
 */
export const FAMILY_TILE: Record<string, string> = {
    ai: 'bg-[color-mix(in_srgb,var(--type-ai)_16%,transparent)] text-[var(--type-ai)]',
    loop: 'bg-[color-mix(in_srgb,var(--type-loop)_16%,transparent)] text-[var(--type-loop)]',
    branch: 'bg-[color-mix(in_srgb,var(--type-branch)_16%,transparent)] text-[var(--type-branch)]',
    data: 'bg-[color-mix(in_srgb,var(--type-data)_16%,transparent)] text-[var(--type-data)]',
    pause: 'bg-[color-mix(in_srgb,var(--type-pause)_16%,transparent)] text-[var(--type-pause)]',
    app: 'bg-[color-mix(in_srgb,var(--type-app)_16%,transparent)] text-[var(--type-app)]',
    guard: 'bg-[color-mix(in_srgb,var(--type-guard)_16%,transparent)] text-[var(--type-guard)]',
};

export const FAMILY_TEXT: Record<string, string> = {
    ai: 'text-[var(--type-ai)]',
    loop: 'text-[var(--type-loop)]',
    branch: 'text-[var(--type-branch)]',
    data: 'text-[var(--type-data)]',
    pause: 'text-[var(--type-pause)]',
    app: 'text-[var(--type-app)]',
    guard: 'text-[var(--type-guard)]',
    end: 'text-[var(--type-end)]',
};

export interface RibbonSections {
    ai: PaletteItem[];
    logic: PaletteItem[];
    people: PaletteItem[];
    /** Records, documents and lists; flow/ribbon/ribbonRows.ts groups them into pills. */
    data: PaletteItem[];
    /** HTTP request and Code: reaching outside, without an app. */
    webAndCode: PaletteItem[];
    nextcloudApps: RibbonApp[];
    otherAppCategories: AppCategory[];
    flowlets: PaletteItem[];
    blockSections: ItemSection[];
}

type Translate = (key: string, fallback?: string, params?: Record<string, unknown>) => string;

interface GroupLike {
    key: string;
    title?: string;
    kind?: string;
    items?: PaletteItem[];
    sections?: ItemSection[];
}

/** Reusable Steps by category; one flat section when the catalog has no categories. */
function blockSectionsOf(steps: GroupLike | undefined, flatTitle: string): ItemSection[] {
    if (!steps) return [];
    if (steps.kind === 'sections') return (steps.sections || []).filter(s => (s.items || []).length > 0);
    const items = steps.items || [];
    return items.length > 0 ? [{ key: 'steps', title: flatTitle, items }] : [];
}

/** The palette, split into the ribbon's tabs. */
export function ribbonSections(scope: Record<string, unknown> = {}, t: Translate | null = null): RibbonSections {
    const groups = buildStepGroups({ ...scope, mode: 'step' }) as GroupLike[];
    const byKey = (k: string) => groups.find(g => g.key === k);
    const flow = byKey('flow')?.sections || [];
    const section = (k: string) => flow.find(s => s.key === k)?.items || [];
    const tr = (key: string, fallback: string) => (t ? t(key, fallback) : fallback);

    const appCategories = orderedAppCategories((scope as { catalog?: unknown }).catalog) as AppCategory[];
    const blockSections = blockSectionsOf(byKey('steps'), tr('routines.ribbon.blocks_steps', 'Steps'));

    return {
        ai: byKey('ai')?.items || [],
        logic: section('flow_control'),
        people: section('people'),
        data: section('data'),
        webAndCode: section('integrations'),
        nextcloudApps: appCategories.find(c => c.category === NEXTCLOUD_CATEGORY)?.apps || [],
        otherAppCategories: appCategories.filter(c => c.category !== NEXTCLOUD_CATEGORY),
        flowlets: byKey('flowlets')?.items || [],
        blockSections,
    };
}

/** The tabs this scope offers: Nextcloud only when the org has a Nextcloud app. */
export function availableCategories(sections: RibbonSections, suggestedEnabled = SUGGESTED_TAB_ENABLED): CategoryDef[] {
    return CATEGORY_DEFS.filter(c => (c.id !== 'nextcloud' || sections.nextcloudApps.length > 0)
        // Disabled by design; see SUGGESTED_TAB_ENABLED.
        && (c.id !== 'suggested' || suggestedEnabled));
}

/**
 * The tab the build film opens: the apps, because that is where most of the
 * cards it deals come from. Nextcloud when present, else the other apps.
 */
export function presentingCategory(categories: CategoryDef[]): RibbonCategoryId {
    return categories.some(c => c.id === 'nextcloud') ? 'nextcloud' : 'other_apps';
}
