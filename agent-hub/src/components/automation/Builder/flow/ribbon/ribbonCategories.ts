import type { ComponentType } from 'react';
import { Star, Sparkles, GitFork, Users, Table2, Cloud, LayoutGrid, Grid2x2, Plug, Package } from 'lucide-react';
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

/** The vendor suites with a tab of their own, in tab order. */
export type SuiteTabId = 'nextcloud' | 'google' | 'microsoft';

export type RibbonCategoryId = 'suggested' | 'ai' | 'logic' | 'people' | 'data' | SuiteTabId | 'other_apps' | 'blocks';

/** The integration categories (config/integrationCatalog) that get a tab of their own; every other one is "Other apps". */
export const NEXTCLOUD_CATEGORY = 'Nextcloud';
export const GOOGLE_CATEGORY = 'Google Workspace';
export const MICROSOFT_CATEGORY = 'Microsoft 365';

/** Which integration category each suite tab shows. */
export const SUITE_TABS: Readonly<Record<SuiteTabId, string>> = {
    nextcloud: NEXTCLOUD_CATEGORY,
    google: GOOGLE_CATEGORY,
    microsoft: MICROSOFT_CATEGORY,
};

const SUITE_TAB_IDS = Object.keys(SUITE_TABS) as SuiteTabId[];

export function isSuiteTab(id: string): id is SuiteTabId {
    return (SUITE_TAB_IDS as string[]).includes(id);
}

/**
 * The vendors' brand colours. There is no theme token for them, so they live
 * here, once, as the Tailwind class every element in that colour uses (the
 * same hues as the suites' glyphs in flow/appGlyphs.jsx).
 */
export const NEXTCLOUD_TEXT = 'text-[#0082c9]';
export const GOOGLE_TEXT = 'text-[#4285F4]';
export const MICROSOFT_TEXT = 'text-[#0078D4]';

/** A step tab a Bee Flow tool can live on. */
export type NativeHomeTab = 'ai' | 'logic' | 'data';

/**
 * Bee Flow's own tools (first-party, no outside account to connect) are not
 * "other apps": each one sits on the tab of the job it does, beside the steps
 * it works with. Keyed by catalog app id, plus the integration id the server
 * gives a tool when that differs (`web_search` for agent_search,
 * core/integrations/integrationToolMap.js); dashes and underscores both match
 * (`nativeHomeOf`). Anything not listed here, ElevenLabs or Fireflies say,
 * stays an app on the Other apps tab.
 */
export const NATIVE_APP_HOME: Readonly<Record<string, NativeHomeTab>> = {
    // AI: searching, remembering, listening and generating.
    'agent-search': 'ai',
    'web-search': 'ai',
    'browser-fetch': 'ai',
    memory: 'ai',
    transcription: 'ai',
    'image-gen': 'ai',
    'video-gen': 'ai',
    'music-gen': 'ai',
    // Data & documents: the knowledge base, webpages and presentations Bee Flow keeps.
    'kb-search': 'data',
    'kb-ingest': 'data',
    webpages: 'data',
    presentations: 'data',
    'presentation-builder': 'data',
    // Logic: the automation looking at its own runs and changing itself.
    'automation-evolution': 'logic',
};

/** The tab a Bee Flow tool lives on, or null for an outside app. */
export function nativeHomeOf(appOrIntegrationId: string | null | undefined): NativeHomeTab | null {
    if (!appOrIntegrationId) return null;
    return NATIVE_APP_HOME[String(appOrIntegrationId).toLowerCase().replace(/_/g, '-')] || null;
}

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
    { id: 'suggested', labelKey: 'automations.ribbon.cat_suggested', fallback: 'Suggested', Icon: Star, tone: 'text-[var(--text-secondary)]', origin: null },
    { id: 'ai', labelKey: 'automations.ribbon.cat_ai', fallback: 'AI', Icon: Sparkles, tone: 'text-[var(--type-ai)]', origin: 'section:ai' },
    { id: 'logic', labelKey: 'automations.ribbon.cat_logic', fallback: 'Logic', Icon: GitFork, tone: 'text-[var(--type-branch)]', origin: 'section:flow_control' },
    { id: 'people', labelKey: 'automations.ribbon.cat_people', fallback: 'People', Icon: Users, tone: 'text-[var(--type-pause)]', origin: 'section:people' },
    { id: 'data', labelKey: 'automations.ribbon.cat_data', fallback: 'Data & documents', Icon: Table2, tone: 'text-[var(--type-data)]', origin: 'section:data' },
    { id: 'nextcloud', labelKey: 'automations.ribbon.cat_nextcloud', fallback: 'Nextcloud apps', Icon: Cloud, tone: NEXTCLOUD_TEXT, origin: `cat:${NEXTCLOUD_CATEGORY}` },
    { id: 'google', labelKey: 'automations.ribbon.cat_google', fallback: 'Google Workspace', Icon: LayoutGrid, tone: GOOGLE_TEXT, origin: `cat:${GOOGLE_CATEGORY}` },
    { id: 'microsoft', labelKey: 'automations.ribbon.cat_microsoft', fallback: 'Microsoft 365', Icon: Grid2x2, tone: MICROSOFT_TEXT, origin: `cat:${MICROSOFT_CATEGORY}` },
    // No section stamp: every step on it is an app, and an app's card
    // departs from its own `app:` / `cat:` stamps (flow/ribbonOrigin.js).
    { id: 'other_apps', labelKey: 'automations.ribbon.cat_other_apps', fallback: 'Other apps', Icon: Plug, tone: 'text-[var(--text-secondary)]', origin: null },
    { id: 'blocks', labelKey: 'automations.ribbon.cat_blocks', fallback: 'My building blocks', Icon: Package, tone: 'text-[var(--text-secondary)]', origin: null },
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
    /** The apps of each vendor suite with a tab of its own (empty: no tab). */
    suiteApps: Record<SuiteTabId, RibbonApp[]>;
    /** Bee Flow's own tools, on the tab of the job they do (NATIVE_APP_HOME). */
    nativeApps: Record<NativeHomeTab, RibbonApp[]>;
    /** Every other app category, on the Other apps tab (without the Bee Flow tools). */
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
    const blockSections = blockSectionsOf(byKey('steps'), tr('automations.ribbon.blocks_steps', 'Steps'));
    const suiteCategories = new Set(Object.values(SUITE_TABS));
    const appsOf = (category: string) => appCategories.find(c => c.category === category)?.apps || [];
    const homeOf = (app: RibbonApp) => nativeHomeOf(app.id) || nativeHomeOf(app.integrationId);
    const nativeApps: Record<NativeHomeTab, RibbonApp[]> = { ai: [], logic: [], data: [] };
    for (const { category, apps } of appCategories) {
        if (suiteCategories.has(category)) continue;
        for (const app of apps) {
            const home = homeOf(app);
            if (home) nativeApps[home].push(app);
        }
    }
    const otherAppCategories = appCategories
        .filter(c => !suiteCategories.has(c.category))
        .map(c => ({ ...c, apps: c.apps.filter(app => !homeOf(app)) }))
        .filter(c => c.apps.length > 0);

    return {
        ai: byKey('ai')?.items || [],
        logic: section('flow_control'),
        people: section('people'),
        data: section('data'),
        suiteApps: {
            nextcloud: appsOf(NEXTCLOUD_CATEGORY),
            google: appsOf(GOOGLE_CATEGORY),
            microsoft: appsOf(MICROSOFT_CATEGORY),
        },
        nativeApps,
        otherAppCategories,
        flowlets: byKey('flowlets')?.items || [],
        blockSections,
    };
}

/**
 * The tabs this scope offers: a suite's tab (Nextcloud, Google Workspace,
 * Microsoft 365) only when the org has an app of that suite, and Other apps
 * only when there is an outside app left for it (Bee Flow's own steps and
 * tools all live on the step tabs).
 */
export function availableCategories(sections: RibbonSections, suggestedEnabled = SUGGESTED_TAB_ENABLED): CategoryDef[] {
    return CATEGORY_DEFS.filter(c => (!isSuiteTab(c.id) || sections.suiteApps[c.id].length > 0)
        && (c.id !== 'other_apps' || sections.otherAppCategories.length > 0)
        // Disabled by design; see SUGGESTED_TAB_ENABLED.
        && (c.id !== 'suggested' || suggestedEnabled));
}

/**
 * The tab the build film opens: the apps, because that is where most of the
 * cards it deals come from. The first suite tab present (Nextcloud, Google
 * Workspace, Microsoft 365), else Other apps, else (an org without apps) the
 * AI tab. A card from another suite departs from that suite's tab, which
 * carries its `cat:` stamp.
 */
export function presentingCategory(categories: CategoryDef[]): RibbonCategoryId {
    return categories.find(c => isSuiteTab(c.id))?.id
        || (categories.some(c => c.id === 'other_apps') ? 'other_apps' : 'ai');
}

/**
 * The `data-ribbon-origin` stamp of the tab a Bee Flow tool lives on, so the
 * build film still deals its card from that tab when the tool's own pill is
 * not on screen; null for an outside app.
 */
export function nativeHomeOrigin(appOrIntegrationId: string | null | undefined): string | null {
    const home = nativeHomeOf(appOrIntegrationId);
    return home ? CATEGORY_DEFS.find(c => c.id === home)?.origin || null : null;
}

/**
 * How many suite tabs the row carries, which sets where the row starts to fold
 * (flow/ribbon/CategoryTabs.tsx): each one is about 140px of tab.
 */
export function suiteTabCount(categories: CategoryDef[]): number {
    return categories.filter(c => isSuiteTab(c.id)).length;
}
