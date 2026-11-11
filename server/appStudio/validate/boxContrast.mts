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

interface Finding { code: string; severity: string; path: string; message: string; hint: string }
type Push = (rec: Finding) => void;
type Mode = 'light' | 'dark';
type Obj = Record<string, unknown>;

/** WCAG AA for body text. */
const MIN_CONTRAST = 4.5;
/** Deeper than any legal definition (componentSpecs LIMITS.MAX_DEPTH); a bound on the walk only. */
const MAX_WALK_DEPTH = 32;

const THEME_TEXT: Record<Mode, { primary: string; secondary: string }> = {
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

function modesOf(theme: unknown): Mode[] {
    const appearance = isObj(theme) ? theme.appearance : undefined;
    if (appearance === 'light' || appearance === 'dark') return [appearance];
    return ['light', 'dark'];
}

/** The text colour on the node per theme mode, or null where it cannot be computed. */
function textColour(color: unknown, mode: Mode, theme: unknown): string | null {
    if (color === undefined || color === null) return THEME_TEXT[mode].primary;
    if (isHexColor(color)) return color;
    if (color === 'neutral') return THEME_TEXT[mode].secondary;
    if (color === 'primary') {
        const primary = isObj(theme) ? theme.primary : undefined;
        return isHexColor(primary) ? primary : DEFAULT_PRIMARY;
    }
    return typeof color === 'string' && Object.hasOwn(ROLE_HEX, color) ? ROLE_HEX[color] : null;
}

/** The worst text contrast on this node's hex fill, or null when there is nothing to check. */
function worstContrast(node: Obj, theme: unknown): { ratio: number; modes: Mode[]; fill: string } | null {
    const style = node.style;
    if (!isObj(style) || !isHexColor(style.backgroundColor)) return null;
    if (typeof node.type !== 'string' || NO_TEXT_TYPES.has(node.type)) return null;
    if (node.type === 'card' && isObj(node.props) && CARD_FILL_LOOKS.has(String(node.props.look))) return null;
    const fill = style.backgroundColor;
    let ratio = Infinity;
    const failing: Mode[] = [];
    for (const mode of modesOf(theme)) {
        const text = textColour(style.color, mode, theme);
        if (!text) continue;
        const r = contrastRatio(fill, text);
        if (r < MIN_CONTRAST) failing.push(mode);
        ratio = Math.min(ratio, r);
    }
    return failing.length ? { ratio, modes: failing, fill } : null;
}

function warnNode(node: Obj, path: string, theme: unknown, pushW: Push): void {
    const found = worstContrast(node, theme);
    if (!found) return;
    const where = found.modes.length === 2 ? 'in the light theme and in the dark one' : `in the ${found.modes[0]} theme`;
    pushW({
        code: 'style.low_contrast',
        severity: 'warning',
        path: `${path}.style.backgroundColor`,
        message: `backgroundColor ${found.fill} leaves the text on it at ${found.ratio.toFixed(1)}:1 ${where}; body text needs ${MIN_CONTRAST}:1.`,
        hint: 'A hex fill stays the same in every theme while the text follows the theme. Use a role (a wash that follows the theme), pick a lighter or darker hex, set the text color knob where the type has one, or fix theme.appearance to light or dark.',
    });
}

function walk(nodes: unknown, path: string, depth: number, theme: unknown, pushW: Push): void {
    if (!Array.isArray(nodes) || depth > MAX_WALK_DEPTH) return;
    nodes.forEach((node, i) => {
        if (!isObj(node)) return;
        const p = `${path}[${i}]`;
        warnNode(node, p, theme, pushW);
        walk(node.children, `${p}.children`, depth + 1, theme, pushW);
    });
}

/** Warn for every node whose hex backgroundColor leaves its text below the AA contrast. */
export function checkBoxContrast(def: Obj, screens: unknown, pushW: Push): void {
    if (!Array.isArray(screens)) return;
    screens.forEach((screen, si) => {
        if (!isObj(screen) || !Array.isArray(screen.sections)) return;
        screen.sections.forEach((section, ci) => {
            if (isObj(section)) walk(section.children, `screens[${si}].sections[${ci}].children`, 0, def.theme, pushW);
        });
    });
}
