// One spacing step in px (multiplied by the --app-space density var).
export const SPACE_STEP_PX = 4;

// Role → color. primary follows the theme var; neutral uses the platform
// text token; the status roles use the house emerald/amber/red/sky hexes
// (see shared/statusTokens.ts / shared/Toast.tsx for the same family).
export const ROLE_COLORS: Record<string, string> = {
    primary: 'var(--app-primary)',
    neutral: 'var(--text-secondary)',
    success: '#10b981',
    warning: '#f59e0b',
    danger: '#ef4444',
    info: '#0ea5e9',
};

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

// radius knob: null inherits the theme radius; 'full' is the pill shape.
export const RADIUS_VALUES: Record<string, string> = { none: '0px', sm: '4px', md: '8px', lg: '12px', full: '9999px' };

export const ALIGN_VALUES: Record<string, 'left' | 'center' | 'right'> = { start: 'left', center: 'center', end: 'right' };

export const WEIGHT_VALUES: Record<string, number> = { regular: 400, medium: 500, semibold: 600 };

export const SIZE_FONT: Record<string, string | null> = { sm: '0.875em', md: null, lg: '1.125em' };

// 'xl' is the document-viewer tier: a PDF at 320px is a postage stamp, and
// 'fill' collapses inside a tab whose ancestors are not full-height.
export const HEIGHT_PX: Record<string, string> = { sm: '120px', md: '200px', lg: '320px', xl: '620px' };

/**
 * `flex: 1 1 0` — as LONGHANDS, deliberately.
 *
 * jsdom's cssstyle does not implement the `flex` shorthand: assigning it drops
 * the declaration on the floor, so the rule was invisible to every DOM-level
 * test and the height chain could break without a single test noticing (it did,
 * for as long as height:'fill' has existed). Longhands are identical in a
 * browser and actually observable in a test.
 */
export const FLEX_FILL = Object.freeze({ flexGrow: 1, flexShrink: 1, flexBasis: 0 });

/**
 * background: 'gradient' — a very soft wash out of the app's primary.
 *
 * Built from color-mix over transparent (NEVER a hex) so it follows whatever
 * primary the author picked and sits harmlessly over the host light/dark
 * ground; at 12% → 2% the text on it stays var(--text-primary) in both.
 */
export const SOFT_PRIMARY_GRADIENT =
    'linear-gradient(135deg, color-mix(in srgb, var(--app-primary) 12%, transparent), color-mix(in srgb, var(--app-primary) 2%, transparent))';

/**
 * hideBelow/hideAbove knob -> media-query classes (rules in runtime.css). A
 * class rather than an inline style for the same reason the span rides along
 * as one: only a stylesheet can read the viewport. 'none'/absent emits
 * nothing, so a definition without the knobs keeps its exact className.
 */
export const HIDE_BANDS: Array<string | undefined> = ['sm', 'md', 'lg'];
