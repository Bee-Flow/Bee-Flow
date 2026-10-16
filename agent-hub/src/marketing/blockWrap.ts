// The design part of a block's style wrapper: background placement, the
// built-in brand motif and the look switches (hero decor, card fill, label style, icon tiles). The renderer (ProductWebsite) calls these two
// functions and adds the result to the wrapper; nothing here ever builds CSS
// from a stored value. Every class name is assembled from a value that
// survived the shared whitelist (blockStyleEnums.generated.mjs, the same file
// the server store and the MCP validator use), and the single custom
// property is rebuilt from a validated whole number of pixels.

import { blockTileVars } from './designTiles';
import { sanitizeBlockDesignStyle, backgroundSizePx } from './blockStyleEnums.generated.mjs';

type BlockStyle = object | null | undefined;

function clean(style: BlockStyle): Record<string, unknown> {
    return style && typeof style === 'object' ? sanitizeBlockDesignStyle(style as Record<string, unknown>) : {};
}

/** Class names for background size / position / repeat / hide-on-mobile and the brand motif. */
export function designStyleClasses(style: BlockStyle): string[] {
    const s = clean(style);
    const out: string[] = [];
    if (typeof s.backgroundSize === 'string') {
        out.push(backgroundSizePx(s.backgroundSize) !== null ? 'cms-bg-size-px' : `cms-bg-size-${s.backgroundSize}`);
    }
    if (typeof s.backgroundPosition === 'string') out.push(`cms-bg-pos-${s.backgroundPosition}`);
    if (typeof s.backgroundRepeat === 'string') out.push(`cms-bg-repeat-${s.backgroundRepeat}`);
    if (s.backgroundHideMobile === true) out.push('cms-bg-hide-mobile');
    if (s.motif === 'honeycomb') {
        out.push('cms-motif', 'cms-motif--honeycomb');
        out.push(`cms-motif--${typeof s.motifSide === 'string' ? s.motifSide : 'right'}`);
        if (s.motifTiles === true) out.push('cms-motif--tiles');
    }
    if (s.decor === 'none') out.push('cms-decor-none');
    if (s.cardFill === 'white' || s.cardFill === 'none') out.push(`cms-cardfill-${s.cardFill}`);
    if (s.labelStyle === 'plain' || s.labelStyle === 'mono') out.push(`cms-label-${s.labelStyle}`);
    return out;
}

/** The custom properties: the pixel width of the background image, and the block's icon tile overrides. */
export function designStyleVars(style: BlockStyle): Record<string, string> {
    const s = clean(style);
    const px = backgroundSizePx(s.backgroundSize);
    return { ...(px === null ? {} : { '--cms-bg-size': `${px}px auto` }), ...blockTileVars(s) };
}

const DISPLAY_TRACKING_EM = new Map<string, string>([
    ['tight', '-0.03em'],
    ['tighter', '-0.045em'],
    ['tightest', '-0.06em'],
]);

/** The letter-spacing for a display tracking name; undefined for 'default' and anything unknown. */
export function displayTrackingEm(name: unknown): string | undefined {
    return typeof name === 'string' ? DISPLAY_TRACKING_EM.get(name) : undefined;
}

/**
 * `style.band: 'default'` means a flat background. Legacy block types
 * (steps, integrations, techStats, pricing) paint their own grey when
 * content.backgroundVariant is missing, so an explicit default band is handed
 * to them as backgroundVariant 'default'. An explicit variant in the content wins.
 */
export function withFlatBand<T extends { style?: { band?: unknown } | null; content?: unknown }>(block: T): T {
    if (block.style?.band !== 'default') return block;
    const content = block.content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) return block;
    const current = (content as { backgroundVariant?: unknown }).backgroundVariant;
    if (current !== undefined && current !== null && current !== '') return block;
    return { ...block, content: { ...content, backgroundVariant: 'default' } };
}
