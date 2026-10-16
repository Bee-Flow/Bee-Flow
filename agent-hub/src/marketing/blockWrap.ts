// The design part of a block's style wrapper: background placement and the
// built-in brand motif. The renderer (ProductWebsite) calls these two
// functions and adds the result to the wrapper; nothing here ever builds CSS
// from a stored value. Every class name is assembled from a value that
// survived the shared whitelist (blockStyleEnums.generated.mjs, the same file
// the server store and the MCP validator use), and the single custom
// property is rebuilt from a validated whole number of pixels.

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
    return out;
}

/** The one custom property: the pixel width of the background image, when set. */
export function designStyleVars(style: BlockStyle): Record<string, string> {
    const px = backgroundSizePx(clean(style).backgroundSize);
    return px === null ? {} : { '--cms-bg-size': `${px}px auto` };
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
