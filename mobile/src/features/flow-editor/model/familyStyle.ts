/**
 * A step's family and run status as colours, tile shapes and card chrome, on
 * the mobile theme — a port of the web builder's flow/nodeTypeColors.js,
 * pinned by familyStyle.lockstep.test.ts.
 *
 * The web's contract, kept: the family colour (`theme.stepType[family]`, the
 * web's `--type-<family>`) is confined to the card's 4px bar and its icon
 * tile; status ALWAYS beats type on the border and ring, so a running or
 * failed step reads at a glance whatever it is. The tile's SHAPE encodes the
 * family a second time, for anyone who cannot rely on colour.
 */

import type { Theme } from '@/core/theme/types';
import { tint } from '@/shared/ui/tint';

import { NODE_FAMILIES, stepFamily, type NodeFamily } from './nodeDefs';

export { CARD_H, CARD_W, cardHeightForPorts } from './geometry';

export type FamilyTheme = Pick<Theme, 'colors' | 'stepType'>;
export const TYPE_GROUPS = NODE_FAMILIES;

/** The visual family of a step, or of a bare type string. */
export function typeGroupOf(stepOrType: string | { type?: string } | null | undefined): NodeFamily | null {
    if (!stepOrType) return null;
    return stepFamily(typeof stepOrType === 'string' ? stepOrType : stepOrType.type);
}

const isFamily = (group: unknown): group is NodeFamily => (NODE_FAMILIES as readonly unknown[]).includes(group);

/** The family's colour; the neutral ink when there is none. */
export function familyColor(theme: FamilyTheme, group: NodeFamily | string | null | undefined): string {
    return isFamily(group) ? theme.stepType[group] : theme.colors.textTertiary;
}

/** A tint of the family colour for fills: the icon tile (18%), a hover wash (8%). */
export function familyTint(theme: FamilyTheme, group: NodeFamily | string | null | undefined, pct = 18): string {
    return tint(familyColor(theme, group), pct);
}

/** The tones a status can paint a card with (`tones.ts` names). */
export type StatusTone = 'success' | 'error' | 'ai' | 'warning' | 'pinned';

/** Every status a step row on the canvas can carry (the web's CANVAS_STATUSES). */
export const CANVAS_STATUSES = Object.freeze([
    'success', 'error', 'running', 'handled_error',
    'awaiting_approval', 'awaiting_confirm', 'awaiting_form',
    'paused', 'pinned', 'queued', 'skipped', 'cancelled',
] as const);

/** Status → tone, from the shared status table; null paints no chrome. */
const STATUS_TONE: Readonly<Record<string, StatusTone | null>> = {
    success: 'success',
    error: 'error',
    failed: 'error',
    running: 'ai',
    queued: null,
    paused: null,
    paused_breakpoint: null,
    cancelled: null,
    awaiting_approval: 'warning',
    awaiting_confirm: 'warning',
    awaiting_form: 'warning',
    skipped: null,
    nothing_to_do: 'warning',
    handled_error: 'warning',
    pinned: 'pinned',
    edited: 'pinned',
    warning: 'warning',
    info: 'ai',
    idle: null,
};

/** The tone a run status paints with; null for none, or a word never heard of. */
export function statusTone(status: string | null | undefined): StatusTone | null {
    if (!status) return null;
    const key = String(status).toLowerCase();
    return Object.prototype.hasOwnProperty.call(STATUS_TONE, key) ? (STATUS_TONE[key] as StatusTone | null) : null;
}

/** The colour a status paints a border, ring and minimap swatch with. */
export function statusColor(theme: FamilyTheme, status: string | null | undefined): string | null {
    const tone = statusTone(status);
    if (!tone) return null;
    return tone === 'ai' ? theme.colors.typeAi : theme.colors[tone];
}

/** The short word on a status badge — only statuses that paint chrome have one. */
export const STATUS_BADGE: Readonly<Record<string, { key: string; en: string }>> = Object.freeze({
    running: { key: 'routines.card.badge_running', en: 'running' },
    success: { key: 'routines.card.badge_done', en: 'done' },
    error: { key: 'routines.card.badge_failed', en: 'failed' },
    handled_error: { key: 'routines.card.badge_recovered', en: 'recovered' },
    awaiting_approval: { key: 'routines.card.badge_waiting', en: 'waiting' },
    awaiting_confirm: { key: 'routines.card.badge_waiting', en: 'waiting' },
    awaiting_form: { key: 'routines.card.badge_waiting', en: 'waiting' },
    pinned: { key: 'routines.card.badge_pinned', en: 'pinned' },
});

/**
 * The icon tile's shape: a branch is a diamond, the shield a shield, a form
 * page a circle, an end card a solid ink block. The web applies them in that
 * precedence (a later rule overrides an earlier radius).
 */
export type TileShape = 'rounded' | 'circle' | 'shield' | 'diamond' | 'block';

export interface TileStyle {
    shape: TileShape;
    background: string;
    color: string;
}

function tileShape(group: string | null | undefined, type: string | null): TileShape {
    if (group === 'branch') return 'diamond';
    if (group === 'guard') return 'shield';
    if (type === 'form_page') return 'circle';
    return group === 'end' ? 'block' : 'rounded';
}

/** The 34px icon tile: shape, fill and glyph colour. */
export function typeTile(
    theme: FamilyTheme,
    group: NodeFamily | string | null | undefined,
    { type = null, error = false }: { type?: string | null; error?: boolean } = {},
): TileStyle {
    const shape = tileShape(group, type);
    if (group === 'end') {
        return { shape, background: error ? theme.colors.error : theme.colors.textPrimary, color: error ? '#fff' : theme.colors.bgPrimary };
    }
    return {
        shape,
        background: error ? tint(theme.colors.error, 18) : familyTint(theme, group),
        color: error ? theme.colors.error : familyColor(theme, group),
    };
}

export interface CardInput {
    group: NodeFamily | string | null | undefined;
    type?: string | null;
    status?: string | null;
    pinned?: boolean;
    disabled?: boolean;
    selected?: boolean;
    error?: boolean;
}

export interface CardChrome {
    /** The 4px family bar on the leading edge. */
    bar: string;
    borderColor: string;
    borderWidth: number;
    borderStyle: 'solid' | 'dashed';
    /** A 4px ring outside the border, or null. */
    ring: string | null;
    opacity: number;
    /** The running pulse. */
    pulse: boolean;
    badge: { key: string; en: string; bg: string; fg: string } | null;
    /** Which edge is fully rounded: a trigger leads, an end card trails. */
    roundedEdge: 'leading' | 'trailing' | null;
}

/** The neutral card: the family bar, and the dashed border a loop wears. */
function baseChrome(theme: FamilyTheme, { group, type = null, error = false }: CardInput): CardChrome {
    const loop = group === 'loop' && type !== 'loop_item';
    return {
        bar: error ? theme.colors.error : familyColor(theme, group),
        borderColor: loop ? theme.stepType.loop : theme.colors.borderDefault,
        borderWidth: loop ? 1.5 : 1,
        borderStyle: loop ? 'dashed' : 'solid',
        ring: null, opacity: 1, pulse: false, badge: null,
        roundedEdge: group === 'trigger' ? 'leading' : group === 'end' ? 'trailing' : null,
    };
}

/** The run status's border, ring, pulse and badge. */
function withStatus(out: CardChrome, theme: FamilyTheme, effective: string | null): CardChrome {
    const sc = statusColor(theme, effective);
    if (!sc || !effective) return out;
    const b = Object.prototype.hasOwnProperty.call(STATUS_BADGE, effective) ? STATUS_BADGE[effective] : undefined;
    return {
        ...out, borderColor: sc, borderWidth: 1.5, borderStyle: 'solid', ring: tint(sc, 22), pulse: effective === 'running',
        badge: b ? { ...b, bg: sc, fg: '#fff' } : null,
    };
}

/**
 * A card's outline. Precedence, highest first: selected → run status →
 * pinned → disabled / skipped / dashed loop → neutral.
 */
export function cardChrome(theme: FamilyTheme, input: CardInput): CardChrome {
    const effective = input.status || (input.pinned ? 'pinned' : null);
    let out = withStatus(baseChrome(theme, input), theme, effective);
    const { colors } = theme;
    if (effective === 'skipped') out = { ...out, borderColor: colors.borderDefault, borderWidth: 1, borderStyle: 'dashed', opacity: 0.7 };
    if (input.disabled) out = { ...out, borderColor: colors.textTertiary, borderWidth: 1, borderStyle: 'dashed', opacity: 0.55 };
    if (input.selected) out = { ...out, borderColor: colors.textPrimary, borderWidth: 2, borderStyle: 'solid', ring: tint(colors.textPrimary, 14) };
    return out;
}

/** The minimap swatch: its status colour when it has one, else its family colour. */
export function miniMapColor(theme: FamilyTheme, group: NodeFamily | string | null | undefined, status: string | null = null): string {
    return statusColor(theme, status) || familyColor(theme, group);
}
