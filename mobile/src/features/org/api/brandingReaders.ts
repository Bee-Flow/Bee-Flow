/**
 * Contract readers for the organisation theme (`/api/branding/admin`) and the
 * icon packs (`/api/icons`). Unknown values read as the server's defaults
 * (brandingStore.js DEFAULTS); nothing is sent back unless the admin changes
 * it, so a fallback here never overwrites what the server holds.
 */

import { field, shapeListOf, shapeOf } from '@/core/api/contract';

import { FONT_IDS, THEME_DEFAULTS, THEME_PRESET_IDS, type OrgTheme } from '../model/theme';

export const readOrgTheme: (raw: unknown) => OrgTheme = shapeOf({
    preset: field.oneOf(THEME_PRESET_IDS, THEME_DEFAULTS.preset),
    accent: field.str(THEME_DEFAULTS.accent),
    radiusScale: field.num(THEME_DEFAULTS.radiusScale),
    font: field.oneOf(FONT_IDS, THEME_DEFAULTS.font),
    allowUserOverride: field.bool(THEME_DEFAULTS.allowUserOverride),
});

export interface IconPack {
    id: string;
    name: string;
    /** How many icons the pack overrides. */
    iconCount: number;
}

export interface IconPacks {
    packs: IconPack[];
    /** Null: the built-in set. */
    activeIconPackId: string | null;
}

const readPackRows = shapeListOf({ id: field.str(''), name: field.str(''), icons: field.record({}) });

/** GET /api/icons: the caller's own packs, and which one they use. */
export function readIconPacks(raw: unknown): IconPacks {
    const { packs, activeIconPackId } = shapeOf({ packs: readPackRows, activeIconPackId: field.strOrNull })(raw);
    return {
        packs: packs
            .filter((p) => p.id)
            .map((p) => ({ id: p.id, name: p.name, iconCount: Object.keys(p.icons).length })),
        activeIconPackId,
    };
}
