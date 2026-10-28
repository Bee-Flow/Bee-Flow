/**
 * kindColors — the ONE place that turns an object KIND in Studio into a
 * colour, an icon and a tile shape (Bee Flow Builder redesign, Sep 2026;
 * Studio Home artboard 1b "Gedeelde patronen").
 *
 * A kind is a thing you MAKE in Studio: automation, table, app, webpage,
 * form, agent, skill, knowledge base, meeting note, solution. Nine of them
 * share one legend (the nine tiles of artboard 1b); the tenth, solution, is
 * a container and deliberately carries no colour of its own. The rail, the
 * "Nieuw" menu, every section header, the "Gebruikt door" rows and the
 * reference pills all read this module, so a kind cannot be blue on the
 * rail and teal in a pill.
 *
 * Modelled on automation/Builder/flow/nodeTypeColors.js, under the same
 * contract:
 *   - A LEAF module. It imports lucide icons and nothing else, so shared/,
 *     the Studio sections, the sidebar and the builder can all read it
 *     without a cycle.
 *   - Emits CSS custom properties only (`var(--kind-kb)`, `var(--type-ai)`),
 *     never a hex — src/index.css owns the values, per theme: the --kind-*
 *     two-set block and the --type-* block above it.
 *   - Four kinds reuse a step family's token ON PURPOSE (artboard 1b:
 *     "Agent — blauw · zelfde als AI-stap"): automation → --type-trigger,
 *     datatable → --type-data, form → --type-pause, agent → --type-ai. A
 *     user who learns "teal = automation" in the builder meets the same
 *     teal on the Studio rail.
 *   - One kind is not a thing you make: COMPLIANCE is an AREA you
 *     administer (checks, registers, evidence — the Compliance Center,
 *     Sep 2026). It is in this register anyway, so that
 *     `StudioSectionHeader kind="compliance"`, the settings-nav tile and the
 *     Compliance Center's own rail read ONE token (--kind-compliance)
 *     instead of each choosing a teal. Same tile recipe, plain 8px radius.
 *     It is deliberately NOT on the Studio map — it lives in organisation
 *     settings — which admin/Studio/map/studioMap.js declares in
 *     KINDS_OFF_MAP so the map's drift test stays honest.
 *   - Lives in components/shared/: not under AppStudio (the noPurple scan
 *     roots) and not under Builder/flow/ (a kind is not a step).
 */
import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import { BookOpen, Bot, ClipboardList, FileText, Globe, LayoutGrid, Mic, Package, Scale, Table, Workflow, Zap, Clapperboard } from 'lucide-react';
import { KIND_ALIASES, KIND_KEYS, KIND_VARS } from './kindKeys';
import type { KindKey } from './kindKeys';

export type { KindKey };

/** A per-kind table: every kind has an entry, any other string reads as undefined. */
type KindTable<T> = Readonly<Record<KindKey, T> & Record<string, T | undefined>>;

/** What `kindOf` reads: a usage row, an API record or a resource reference. */
export interface KindSource {
    kind?: unknown;
    objectType?: unknown;
    resourceType?: unknown;
    type?: unknown;
}

export interface KindTileOptions {
    size?: number;
    pct?: number;
}

export interface KindTileStyle {
    tile: CSSProperties;
    glyph: CSSProperties;
}

export { KIND_KEYS };

const KIND_VAR: KindTable<string> = KIND_VARS;

/**
 * The glyph of each kind — the exact lucide names artboard 1b draws. Exported
 * for render code: a component read from a static table is one React can see
 * is never created during render (a call to kindIcon() is opaque to it).
 */
export const KIND_ICON: KindTable<LucideIcon> = Object.freeze({
    automation: Workflow,
    datatable: Table,
    app: LayoutGrid,
    webpage: Globe,
    document: FileText,
    form: ClipboardList,
    agent: Bot,
    skill: Zap,
    kb: BookOpen,
    meeting: Mic,
    playbook: Clapperboard,
    solution: Package,
    compliance: Scale,
});

/**
 * The kind of an object, or of a bare kind string. Takes the whole object so
 * a usage row (`{ kind }`), an API record (`{ type }`) or a resource
 * reference (`{ objectType }` / `{ resourceType }`) all resolve without the
 * caller unpacking them. Unknown input → null, never a throw.
 */
export function kindOf(objOrKind?: string | KindSource | null): KindKey | null {
    if (!objOrKind) return null;
    const raw = typeof objOrKind === 'string'
        ? objOrKind
        : (objOrKind.kind ?? objOrKind.objectType ?? objOrKind.resourceType ?? objOrKind.type ?? null);
    if (typeof raw !== 'string' || !raw) return null;
    const key = raw.trim().toLowerCase();
    if ((KIND_KEYS as readonly string[]).includes(key)) return key as KindKey;
    return KIND_ALIASES[key] ?? null;
}

/** `var(--kind-kb)` for a kind; a neutral ink when there is none. */
export function kindColorVar(kind?: string | null): string {
    return (kind == null ? undefined : KIND_VAR[kind]) ?? 'var(--text-tertiary)';
}

/**
 * A tint of the kind colour for fills. Artboard 1b: 16% on the 30px legend
 * tile and the reference pills, 18% on the 28px header tile (a smaller tile
 * needs a touch more fill to read as a tile at all). `color-mix` so it
 * follows the theme's own value at paint time.
 */
export function kindTint(kind?: string | null, pct = 16): string {
    return `color-mix(in srgb, ${kindColorVar(kind)} ${pct}%, transparent)`;
}

/**
 * Corner radius per kind, from the artboard's 30px legend tile: an
 * automation is trigger-shaped (rounded on its leading edge, like a trigger
 * card on the canvas), a form is a circle (like a form page's tile), every
 * other kind is a plain 8px tile.
 */
export function cardRadius(kind?: string | null): string {
    if (kind === 'automation') return '15px 8px 8px 15px';
    if (kind === 'form') return '999px';
    return '8px';
}

/** cardRadius at any tile size: the trigger's leading edge stays a half-circle. */
function tileRadius(kind: string | null | undefined, size: number): string {
    if (kind === 'automation') {
        const r = Math.round(size / 2);
        return `${r}px 8px 8px ${r}px`;
    }
    return cardRadius(kind);
}

/**
 * The icon tile: 28px in a section header (18% tint, 15px glyph — artboard
 * 1b's header), 30px in the legend, 36/48px on cards and empty states. Shape
 * encodes the kind a second time for anyone who cannot rely on colour.
 * Returns `{ tile, glyph }` inline-style objects. Accepts `size` as a bare
 * number too (`kindTileStyle('kb', 36)`).
 */
export function kindTileStyle(kind?: string | null, opts: number | KindTileOptions = {}): KindTileStyle {
    const { size = 30, pct } = typeof opts === 'number' ? { size: opts } : opts;
    const tintPct = pct ?? (size <= 28 ? 18 : 16);
    const glyphPx = size === 28 ? 15 : Math.round(size / 2);
    const tile = {
        width: size, height: size, flexShrink: 0,
        borderRadius: tileRadius(kind, size),
        display: 'grid', placeItems: 'center',
        background: kindTint(kind, tintPct),
        color: kindColorVar(kind),
    };
    const glyph = { width: glyphPx, height: glyphPx, display: 'inline-flex' };
    return { tile, glyph };
}

/** The lucide component for a kind; null for an unknown kind. */
export function kindIcon(kind: KindKey): LucideIcon;
export function kindIcon(kind?: string | null): LucideIcon | null;
export function kindIcon(kind?: string | null): LucideIcon | null {
    return (kind == null ? undefined : KIND_ICON[kind]) ?? null;
}
