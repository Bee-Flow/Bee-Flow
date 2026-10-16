// Icon tiles and label style: the enum -> CSS custom property tables.
//
// Nothing here builds CSS from stored text. A stored value only selects an
// entry of a fixed table (an unknown value, including a prototype key like
// 'constructor', selects nothing); the identity value 'default' has no entry,
// so a site that never set these renders exactly as before.

export interface TileSettings {
    tileShape?: unknown;
    tileFill?: unknown;
    tileSize?: unknown;
    tileIconColor?: unknown;
}

const HEXAGON = 'polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)';

// The ring of a hexagon: the outline polygon minus the same polygon scaled to
// 92%, drawn as one even-odd contour (a bridge back to the start joins them).
const HEXAGON_RING = 'polygon(evenodd, 25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%, 25% 4%, '
    + '27% 7.7%, 73% 7.7%, 96% 50%, 73% 92.3%, 27% 92.3%, 4% 50%, 27% 7.7%, 25% 4%)';

const SHAPES = new Map<string, Record<string, string>>([
    ['square', { '--tile-radius': '0px' }],
    ['rounded', { '--tile-radius': '12px' }],
    ['circle', { '--tile-radius': '999px' }],
    // A clip-path cuts the border away, so the ring is a clipped layer of its own (::after).
    ['hexagon', {
        '--tile-radius': '0px',
        '--tile-clip': HEXAGON,
        '--tile-border': '0 none',
        '--tile-ring-clip': HEXAGON_RING,
        '--tile-ring-bg': 'var(--hairline-accent)',
    }],
]);

const TINT_EDGE = 'color-mix(in srgb, var(--tile-color, var(--accent)) 30%, transparent)';

const FILLS = new Map<string, Record<string, string>>([
    ['tint', {
        '--tile-bg': 'color-mix(in srgb, var(--tile-color, var(--accent)) 12%, transparent)',
        '--tile-bg-hover': 'color-mix(in srgb, var(--tile-color, var(--accent)) 22%, transparent)',
        '--tile-border': `1px solid ${TINT_EDGE}`,
        '--tile-ring-bg': TINT_EDGE,
    }],
    ['solid', {
        '--tile-bg': 'var(--tile-color, var(--accent))',
        '--tile-bg-hover': 'var(--tile-color, var(--accent))',
        '--tile-border': '0 none',
        '--tile-fg': 'var(--btn-primary-fg, #fff)',
        '--tile-ring-bg': 'transparent',
    }],
    ['none', { '--tile-bg': 'transparent', '--tile-bg-hover': 'transparent', '--tile-border': '0 none', '--tile-ring-bg': TINT_EDGE }],
]);

const SIZES = new Map<string, Record<string, string>>([
    ['sm', { '--tile-scale': '0.8' }],
    ['lg', { '--tile-scale': '1.3' }],
]);

const ICON_COLORS = new Map<string, Record<string, string>>([
    ['light', { '--tile-fg': '#fff' }],
    ['dark', { '--tile-fg': '#0B0B0C' }],
]);

/** Every custom property the tables can set (so a cleared design can remove them). */
export const TILE_VAR_PROPS: string[] = [
    '--tile-radius', '--tile-clip', '--tile-ring-clip', '--tile-ring-bg', '--tile-border', '--tile-bg', '--tile-bg-hover', '--tile-fg', '--tile-scale',
];

function pick(table: Map<string, Record<string, string>>, name: unknown): Record<string, string> {
    return typeof name === 'string' ? table.get(name) ?? {} : {};
}

/** The tile custom properties for a design's component settings. Later tables win (fill before icon colour). */
export function tileVars(c: TileSettings | null | undefined): Record<string, string> {
    if (!c || typeof c !== 'object') return {};
    return {
        ...pick(SHAPES, c.tileShape),
        ...pick(FILLS, c.tileFill),
        ...pick(SIZES, c.tileSize),
        ...pick(ICON_COLORS, c.tileIconColor),
    };
}

// What a block's own shape / fill must reset so it does not inherit the theme's.
const SHAPE_RESETS = ['--tile-clip', '--tile-ring-clip', '--tile-border'];
const FILL_RESETS = ['--tile-fg', '--tile-ring-bg'];

function withResets(resets: string[], entry: Record<string, string>): Record<string, string> {
    if (Object.keys(entry).length === 0) return {};
    return { ...Object.fromEntries(resets.map(prop => [prop, 'initial'])), ...entry };
}

/**
 * The tile custom properties for one block's own overrides (style.tileShape,
 * tileFill, tileSize, tileIconColor). They sit on the block wrapper, so they
 * win over the root's theme-wide ones inside the block. 'default' or a missing
 * key follows the theme; a property the theme set but the override does not
 * is reset with `initial`, which makes the stylesheet fallback apply.
 */
export function blockTileVars(c: TileSettings | null | undefined): Record<string, string> {
    if (!c || typeof c !== 'object') return {};
    return {
        ...withResets(SHAPE_RESETS, pick(SHAPES, c.tileShape)),
        ...withResets(FILL_RESETS, pick(FILLS, c.tileFill)),
        ...pick(SIZES, c.tileSize),
        ...pick(ICON_COLORS, c.tileIconColor),
    };
}

/** Apply the tile properties to the root, first removing the ones a previous design set. */
export function applyTileVars(style: CSSStyleDeclaration, c: TileSettings | null | undefined): void {
    for (const prop of TILE_VAR_PROPS) style.removeProperty(prop);
    for (const [prop, value] of Object.entries(tileVars(c))) style.setProperty(prop, value);
}

/** The legal names per setting, for the lockstep test against the server enums. */
export const TILE_ENUMS = {
    tileShape: [...SHAPES.keys()],
    tileFill: [...FILLS.keys()],
    tileSize: [...SIZES.keys()],
    tileIconColor: [...ICON_COLORS.keys()],
};
