/**
 * Studio object kinds: the ONE place a kind becomes a colour, a glyph and a
 * tile shape. Port of agent-hub/src/components/shared/kindColors.js, pinned to
 * it by kinds.lockstep.test.ts (keys, rail order, tokens, glyphs, aliases).
 *
 * A kind is a thing you MAKE in Studio — automation, table, app, webpage,
 * document, form, agent, skill, knowledge base, meeting note, playbook,
 * solution — plus compliance, an area you administer that shares the tile
 * recipe. The web keeps these colours as CSS variables; here each kind names
 * the SAME variable (`--type-trigger`, `--kind-kb`, …) and `kindColor`
 * resolves it against the theme, whose tokens are generated from the web's
 * index.css. Four kinds borrow a flow-step family on purpose (automation →
 * trigger, datatable → data, form → pause, agent → ai), so the teal a user
 * learns in the builder is the teal on the Studio rail.
 *
 * Pure: no React, so lists, headers and the nav can all read it.
 */

import type { Theme } from '@/core/theme/ThemeProvider';

import type { IconName } from './icons/Icon';

/** The thirteen kinds, in rail order: build, AI, bundle — then the one area you administer. */
export const KIND_KEYS = [
    'automation', 'datatable', 'app', 'webpage', 'document', 'form',
    'agent', 'skill', 'kb', 'meeting',
    'playbook', 'solution',
    'compliance',
] as const;

export type KindKey = (typeof KIND_KEYS)[number];

/** The web's CSS variable per kind (kindColors.js KIND_VAR, without the `var()`). */
export const KIND_TOKEN: Record<KindKey, string> = {
    automation: '--type-trigger',
    datatable: '--type-data',
    app: '--kind-app',
    webpage: '--kind-web',
    document: '--kind-doc',
    form: '--type-pause',
    agent: '--type-ai',
    skill: '--kind-skill',
    kb: '--kind-kb',
    meeting: '--kind-meet',
    playbook: '--kind-playbook',
    // A container, deliberately neutral.
    solution: '--text-secondary',
    compliance: '--kind-compliance',
};

/** The glyph of each kind — the Lucide names the web's artboard draws. */
export const KIND_ICON: Record<KindKey, IconName> = {
    automation: 'Workflow',
    datatable: 'Table',
    app: 'LayoutGrid',
    webpage: 'Globe',
    document: 'FileText',
    form: 'ClipboardList',
    agent: 'Bot',
    skill: 'Zap',
    kb: 'BookOpen',
    meeting: 'Mic',
    playbook: 'Clapperboard',
    solution: 'Package',
    compliance: 'Scale',
};

/** The names the rest of the product uses for these objects, folded onto the keys. */
export const KIND_ALIASES: Readonly<Record<string, KindKey>> = {
    automations: 'automation', routine: 'automation', routines: 'automation', flow: 'automation',
    datatables: 'datatable', table: 'datatable', tables: 'datatable', data_table: 'datatable',
    apps: 'app', application: 'app',
    webpages: 'webpage', web: 'webpage', page: 'webpage', pages: 'webpage', website: 'webpage',
    documents: 'document', doc: 'document', invoice: 'document', quote: 'document', letter: 'document',
    forms: 'form', form_page: 'form',
    agents: 'agent', assistant: 'agent',
    skills: 'skill',
    kbs: 'kb', knowledge: 'kb', knowledge_base: 'kb', knowledge_bases: 'kb', knowledgebase: 'kb',
    meetings: 'meeting', meet: 'meeting', meeting_note: 'meeting', meeting_notes: 'meeting',
    transcription: 'meeting', transcriptions: 'meeting',
    playbooks: 'playbook', recipe: 'playbook',
    solutions: 'solution', bundle: 'solution',
    compliance_hub: 'compliance', gdpr: 'compliance', privacy: 'compliance',
};

export type KindInput =
    | string
    | { kind?: unknown; objectType?: unknown; resourceType?: unknown; type?: unknown }
    | null
    | undefined;

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * The kind of an object or of a bare kind string: `{ kind }`, `{ objectType }`,
 * `{ resourceType }` or `{ type }` all resolve. Unknown input → null, never a throw.
 */
export function kindOf(input: KindInput): KindKey | null {
    if (!input) return null;
    const raw = typeof input === 'string' ? input : (input.kind ?? input.objectType ?? input.resourceType ?? input.type);
    if (typeof raw !== 'string' || !raw) return null;
    const key = raw.trim().toLowerCase();
    if ((KIND_KEYS as readonly string[]).includes(key)) return key as KindKey;
    return own(KIND_ALIASES, key) ?? null;
}

type KindTheme = Pick<Theme, 'colors' | 'stepType' | 'kind'>;

/** A web colour variable, read from the theme; the neutral ink for one it does not know. */
export function tokenColor(theme: KindTheme, cssVar: string): string {
    const step = /^--type-(\w+)$/.exec(cssVar)?.[1];
    if (step && own(theme.stepType as unknown as Record<string, string>, step)) {
        return (theme.stepType as unknown as Record<string, string>)[step] as string;
    }
    const kind = /^--kind-(\w+)$/.exec(cssVar)?.[1];
    if (kind && own(theme.kind as unknown as Record<string, string>, kind)) {
        return (theme.kind as unknown as Record<string, string>)[kind] as string;
    }
    if (cssVar === '--text-secondary') return theme.colors.textSecondary;
    return theme.colors.textTertiary;
}

/** The kind's colour in this theme; the neutral ink (textTertiary) when there is no kind. */
export function kindColor(theme: KindTheme, kind: KindKey | null): string {
    return kind ? tokenColor(theme, KIND_TOKEN[kind]) : theme.colors.textTertiary;
}

export interface TileMetrics {
    /** % of the kind colour in the fill: 18 at 28dp and under, 16 above (a small tile needs more). */
    tintPercent: number;
    /** The glyph's edge: 15 on the 28dp header tile, half the tile otherwise. */
    glyph: number;
    /** Corners: automation is trigger-shaped, form is a circle, the rest a plain 8. */
    radius: { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };
}

/** kindTileStyle's numbers: tint, glyph size and corner radii at a tile size. */
export function tileMetrics(kind: KindKey | null, size: number, tintPercent?: number): TileMetrics {
    const all = (r: number) => ({ topLeft: r, topRight: r, bottomRight: r, bottomLeft: r });
    let radius = all(8);
    if (kind === 'automation') {
        const r = Math.round(size / 2);
        radius = { topLeft: r, topRight: 8, bottomRight: 8, bottomLeft: r };
    } else if (kind === 'form') {
        radius = all(size / 2);
    }
    return {
        tintPercent: tintPercent ?? (size <= 28 ? 18 : 16),
        glyph: size === 28 ? 15 : Math.round(size / 2),
        radius,
    };
}
