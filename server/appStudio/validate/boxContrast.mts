/**
 * App Studio validator: a warning when a hex `backgroundColor` (style knob group "box")
 * leaves the text on it hard to read.
 *
 * A hex fill stays exactly as written in every theme, while the text on it follows the
 * theme: with `theme.appearance` "auto" (the default) the same fill carries dark text in
 * the light theme and light text in the dark one, and one of the two is nearly always
 * unreadable. A role fill is a wash over the theme surface and is not checked.
 *
 * The text colour is computable when the node's own `color` knob is a hex or a fixed role,
 * or when it inherits the theme text, whose light and dark values are the ones the runtime
 * re-declares for `appearance` light and dark (runtime/app-tokens.css). The high-contrast
 * host theme is not modelled. Only a warning: the definition saves and publishes.
 */

export interface Finding { code: string; severity: string; path: string; message: string; hint: string }
type Push = (rec: Finding) => void;
export type Mode = 'light' | 'dark';
type Obj = Record<string, unknown>;

/** WCAG AA for body text. */
export const MIN_CONTRAST = 4.5;
/** Deeper than any legal definition (componentSpecs LIMITS.MAX_DEPTH); a bound on the walk only. */
const MAX_WALK_DEPTH = 32;

export const THEME_TEXT: Record<Mode, { primary: string; secondary: string }> = {
    light: { primary: '#0f172a', secondary: '#334155' },
    dark: { primary: '#f8fafc', secondary: '#94a3b8' },
};
/** The fixed role colours of runtime/styleResolver.constants.ts ROLE_COLORS. */
const ROLE_HEX: Record<string, string> = { success: '#10b981', warning: '#f59e0b', danger: '#ef4444', info: '#0ea5e9' };
const DEFAULT_PRIMARY = '#0F766E';
/** Types that carry no text of their own: a fill there is a colour band, not a ground. */
const NO_TEXT_TYPES = new Set(['image', 'spacer', 'divider']);
/** Card looks whose own fill hides the knob (runtime/components/AppCard.css paints them !important). */
const CARD_FILL_LOOKS = new Set(['flat', 'tinted', 'solid', 'gradient']);
const HEX_DIGITS = '0123456789abcdefABCDEF';

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isHexColor(v: unknown): v is string {
    if (typeof v !== 'string' || v.length !== 7 || v[0] !== '#') return false;
    for (const ch of v.slice(1)) if (!HEX_DIGITS.includes(ch)) return false;
    return true;
}

function channel(hex: string, at: number): number {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
    return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** The WCAG contrast ratio of two #rrggbb colours (1..21). */
export function contrastRatio(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

export function modesOf(theme: unknown): Mode[] {
    const appearance = isObj(theme) ? theme.appearance : undefined;
    if (appearance === 'light' || appearance === 'dark') return [appearance];
    return ['light', 'dark'];
}

/** The text colour on the node per theme mode, or null where it cannot be computed. */
export function textColour(color: unknown, mode: Mode, theme: unknown): string | null {
    if (color === undefined || color === null) return THEME_TEXT[mode].primary;
    if (isHexColor(color)) return color;
    if (color === 'neutral') return THEME_TEXT[mode].secondary;
    if (color === 'primary') {
        const primary = isObj(theme) ? theme.primary : undefined;
        return isHexColor(primary) ? primary : DEFAULT_PRIMARY;
    }
    return typeof color === 'string' && Object.hasOwn(ROLE_HEX, color) ? ROLE_HEX[color] : null;
}

/**
 * Does the node paint its backgroundColor knob behind text of its own? Not for the types without
 * text, nor for a card whose look or variant (outlined: transparent, AppCardVariants.css) paints
 * its own surface over the knob.
 */
export function nodeShowsFill(node: Obj): boolean {
    if (typeof node.type !== 'string' || NO_TEXT_TYPES.has(node.type)) return false;
    if (node.type !== 'card' || !isObj(node.props)) return true;
    return !CARD_FILL_LOOKS.has(String(node.props.look)) && node.props.variant !== 'outlined';
}

/** The worst contrast of the text `color` on `fill` over the theme modes, or null when every mode reads. */
export function pairFailure(fill: string, color: unknown, theme: unknown): { ratio: number; modes: Mode[] } | null {
    let ratio = Infinity;
    const failing: Mode[] = [];
    for (const mode of modesOf(theme)) {
        const text = textColour(color, mode, theme);
        if (!text) continue;
        const r = contrastRatio(fill, text);
        if (r < MIN_CONTRAST) failing.push(mode);
        ratio = Math.min(ratio, r);
    }
    return failing.length ? { ratio, modes: failing } : null;
}

const FILL_HINT = 'A hex fill stays the same in every theme while the text follows the theme. Use a role (a wash that follows the theme), pick a lighter or darker hex, set the text color knob where the type has one, or fix theme.appearance to light or dark.';

/** The style.low_contrast warning for `fill` at `path`; `label` names the fill in the message. */
export function lowContrastWarning(path: string, label: string, fill: string, failure: { ratio: number; modes: Mode[] }, hint: string = FILL_HINT): Finding {
    const where = failure.modes.length === 2 ? 'in the light theme and in the dark one' : `in the ${failure.modes[0]} theme`;
    return {
        code: 'style.low_contrast',
        severity: 'warning',
        path,
        message: `${label} ${fill} leaves the text on it at ${failure.ratio.toFixed(1)}:1 ${where}; body text needs ${MIN_CONTRAST}:1.`,
        hint,
    };
}

function warnNode(node: Obj, path: string, theme: unknown, pushW: Push): void {
    const style = node.style;
    if (!isObj(style) || !isHexColor(style.backgroundColor) || !nodeShowsFill(node)) return;
    const failure = pairFailure(style.backgroundColor, style.color, theme);
    if (failure) pushW(lowContrastWarning(`${path}.style.backgroundColor`, 'backgroundColor', style.backgroundColor, failure));
}

type Visit = (node: Obj, path: string, theme: unknown) => void;

function walk(nodes: unknown, path: string, depth: number, theme: unknown, visit: Visit): void {
    if (!Array.isArray(nodes) || depth > MAX_WALK_DEPTH) return;
    nodes.forEach((node, i) => {
        if (!isObj(node)) return;
        const p = `${path}[${i}]`;
        visit(node, p, theme);
        walk(node.children, `${p}.children`, depth + 1, theme, visit);
    });
}

/** The theme a section's nodes see: the app theme under the screen's and the section's override (schema 3). */
export function scopedTheme(theme: unknown, screen: Obj, section: Obj): unknown {
    if (!isObj(screen.theme) && !isObj(section.theme)) return theme;
    return { ...(isObj(theme) ? theme : {}), ...(isObj(screen.theme) ? screen.theme : {}), ...(isObj(section.theme) ? section.theme : {}) };
}

/** Call `visit` for every node of every section, with its path and the theme its section sees. */
export function eachSectionNode(def: Obj, screens: unknown, visit: Visit): void {
    if (!Array.isArray(screens)) return;
    screens.forEach((screen, si) => {
        if (!isObj(screen) || !Array.isArray(screen.sections)) return;
        screen.sections.forEach((section, ci) => {
            if (isObj(section)) walk(section.children, `screens[${si}].sections[${ci}].children`, 0, scopedTheme(def.theme, screen, section), visit);
        });
    });
}

/** Warn for every node whose hex backgroundColor leaves its text below the AA contrast. */
export function checkBoxContrast(def: Obj, screens: unknown, pushW: Push): void {
    eachSectionNode(def, screens, (node, path, theme) => warnNode(node, path, theme, pushW));
}
