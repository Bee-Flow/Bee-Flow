// Icon tiles and label style: the enum -> CSS custom property tables.
//
// Nothing here builds CSS from stored text. A stored value only selects an
// entry of a fixed table (an unknown value, including a prototype key like
// 'constructor', selects nothing); the identity value 'default' has no entry,
// so a site that never set these renders exactly as before.

export interface TileSettings {
    tileShape?: string;
    tileFill?: string;
    tileSize?: string;
    tileIconColor?: string;
}

const HEXAGON = 'polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)';

const SHAPES = new Map<string, Record<string, string>>([
    ['square', { '--tile-radius': '0px' }],
    ['rounded', { '--tile-radius': '12px' }],
    ['circle', { '--tile-radius': '999px' }],
    // A clip-path cuts the border away, so the hexagon has no ring.
    ['hexagon', { '--tile-radius': '0px', '--tile-clip': HEXAGON, '--tile-border': '0 none' }],
]);

const FILLS = new Map<string, Record<string, string>>([
    ['tint', {
        '--tile-bg': 'color-mix(in srgb, var(--tile-color, var(--accent)) 12%, transparent)',
        '--tile-bg-hover': 'color-mix(in srgb, var(--tile-color, var(--accent)) 22%, transparent)',
        '--tile-border': '1px solid color-mix(in srgb, var(--tile-color, var(--accent)) 30%, transparent)',
    }],
    ['solid', {
        '--tile-bg': 'var(--tile-color, var(--accent))',
        '--tile-bg-hover': 'var(--tile-color, var(--accent))',
        '--tile-border': '0 none',
        '--tile-fg': 'var(--btn-primary-fg, #fff)',
    }],
    ['none', { '--tile-bg': 'transparent', '--tile-bg-hover': 'transparent', '--tile-border': '0 none' }],
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
    '--tile-radius', '--tile-clip', '--tile-border', '--tile-bg', '--tile-bg-hover', '--tile-fg', '--tile-scale',
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
