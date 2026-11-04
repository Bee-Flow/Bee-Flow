/**
 * A hosted form's `form.style` → CSS custom properties and class modifiers.
 *
 * `style` is the form-only sibling of `form.theme` (the theme is App Studio's
 * shared THEME_SPEC, mirrored in themeVars.ts; form-only knobs never go there).
 * The server owns the model (server/core/forms/formStyle.mts: FORM_STYLE_SPEC,
 * canonicalizeFormStyle, sanitizeFormCss); this is its client mirror, pure and
 * tolerant: a value it does not know is simply not applied.
 *
 * Everything is CSS VARIABLES on the form's root (the `style` prop carries the
 * variable map and nothing else), read by Tailwind classes with a fallback, so
 * a form without a style looks exactly as it did. The class modifiers
 * (`bf-form--inputs-filled`, …) are hooks for the author's custom CSS.
 */
import { bestContrast } from '../admin/Studio/AppStudio/runtime/themeVars';
import { sanitizeFormCssClient, FORM_CSS_MAX } from './formCssSanitizer';

export { sanitizeFormCssClient, FORM_CSS_MAX };

export const FORM_FONTS = ['system', 'inter', 'serif', 'mono', 'rounded'] as const;
export const FORM_WIDTHS = ['narrow', 'medium', 'wide'] as const;
export const FORM_ALIGNS = ['left', 'center'] as const;
export const FORM_LABEL_STYLES = ['above', 'inside'] as const;
export const FORM_INPUT_STYLES = ['outlined', 'filled', 'underlined'] as const;
export const FORM_BUTTON_WIDTHS = ['auto', 'full'] as const;
export const FORM_BUTTON_SHAPES = ['square', 'rounded', 'pill'] as const;

export const FORM_LOGO_URL_MAX = 512;
export const FORM_FOOTER_MAX = 300;

interface FormButtonStyle {
    width?: typeof FORM_BUTTON_WIDTHS[number];
    shape?: typeof FORM_BUTTON_SHAPES[number];
    textColor?: string | null;
}

export interface FormStyle {
    font?: typeof FORM_FONTS[number];
    width?: typeof FORM_WIDTHS[number];
    align?: typeof FORM_ALIGNS[number];
    cardColor?: string | null;
    textColor?: string | null;
    labelColor?: string | null;
    labelStyle?: typeof FORM_LABEL_STYLES[number];
    inputStyle?: typeof FORM_INPUT_STYLES[number];
    button?: FormButtonStyle;
    logoUrl?: string | null;
    footerText?: string | null;
    customCss?: string | null;
}

/** Curated families only: every one is installed or bundled, so a form never loads a font from elsewhere. */
const FONT_STACKS: Record<string, string> = {
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    inter: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
    serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif',
};

const WIDTH_PX: Record<string, string> = { narrow: '480px', medium: '640px', wide: '860px' };

/**
 * The page container's max-width per form width. Literal class strings, so
 * Tailwind generates them; an unset width keeps the page's old max-w-xl.
 */
const WIDTH_CLASS: Record<string, string> = { narrow: 'max-w-[480px]', medium: 'max-w-[640px]', wide: 'max-w-[860px]' };

const BUTTON_RADIUS: Record<string, string> = { square: '0px', rounded: 'max(var(--app-radius), 8px)', pill: '999px' };

const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const oneOf = <T extends string>(values: readonly T[], v: unknown): T | undefined => (values as readonly unknown[]).includes(v) ? v as T : undefined;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Only a same-origin path ('/x'), never '//x' or '/\x', at most 512 characters; anything else is no logo. */
export function safeLogoUrl(url: unknown): string | null {
    if (typeof url !== 'string' || !url || url.length > FORM_LOGO_URL_MAX) return null;
    if (!/^\/(?![/\\])/.test(url) || /[\s\\]/.test(url)) return null;
    return url;
}

function readButton(raw: unknown): FormButtonStyle | undefined {
    if (!isPlainObject(raw)) return undefined;
    const out: FormButtonStyle = {};
    const width = oneOf(FORM_BUTTON_WIDTHS, raw.width);
    const shape = oneOf(FORM_BUTTON_SHAPES, raw.shape);
    if (width) out.width = width;
    if (shape) out.shape = shape;
    if (isHex(raw.textColor)) out.textColor = raw.textColor;
    return Object.keys(out).length ? out : undefined;
}

function readText(v: unknown, max: number): string | undefined {
    return typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
}

/**
 * The style as the renderer reads it: known keys with valid values only, never
 * a key that was not set (like canonicalizeFormStyle on the server).
 */
export function readFormStyle(raw: unknown): FormStyle {
    if (!isPlainObject(raw)) return {};
    const out: Record<string, unknown> = {
        font: oneOf(FORM_FONTS, raw.font),
        width: oneOf(FORM_WIDTHS, raw.width),
        align: oneOf(FORM_ALIGNS, raw.align),
        cardColor: isHex(raw.cardColor) ? raw.cardColor : undefined,
        textColor: isHex(raw.textColor) ? raw.textColor : undefined,
        labelColor: isHex(raw.labelColor) ? raw.labelColor : undefined,
        labelStyle: oneOf(FORM_LABEL_STYLES, raw.labelStyle),
        inputStyle: oneOf(FORM_INPUT_STYLES, raw.inputStyle),
        button: readButton(raw.button),
        logoUrl: safeLogoUrl(raw.logoUrl) ?? undefined,
        footerText: readText(raw.footerText, FORM_FOOTER_MAX),
        // Not cut short: an over-long sheet is refused whole by the sanitiser, never applied half.
        customCss: typeof raw.customCss === 'string' && raw.customCss.trim() ? raw.customCss : undefined,
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out as FormStyle;
}

/** A later page's own style laid over the first page's (the `button` object merged key by key). */
export function mergeFormStyle(base: unknown, own: unknown): FormStyle {
    const b = readFormStyle(base);
    const o = readFormStyle(own);
    const button = b.button || o.button ? { ...b.button, ...o.button } : undefined;
    return readFormStyle({ ...b, ...o, button });
}

/** Text that reads on a card colour the author picked without picking a text colour. */
const readableOn = (hex: string): string => (bestContrast(hex) === '#000000' ? '#111827' : '#f8fafc');
const tone = (hex: string, pct: number): string => `color-mix(in srgb, ${hex} ${pct}%, transparent)`;

/** The text tokens, re-pointed at one colour so every field under the form follows it. */
function textVars(text: string): Record<string, string> {
    return {
        '--bf-text': text,
        '--text-primary': text,
        '--text-secondary': tone(text, 78),
        '--text-tertiary': tone(text, 62),
        '--text-muted': tone(text, 62),
    };
}

const INPUT_VARS: Record<string, Record<string, string>> = {
    outlined: {},
    filled: {
        '--bf-input-bg': 'color-mix(in srgb, var(--text-primary) 6%, transparent)',
        '--bf-input-border-width': '0 0 2px 0',
        '--bf-input-radius': 'var(--app-radius) var(--app-radius) 0 0',
    },
    underlined: {
        '--bf-input-bg': 'transparent',
        '--bf-input-border-width': '0 0 1px 0',
        '--bf-input-radius': '0px',
    },
};

function buttonVars(style: FormStyle): Record<string, string> {
    const vars: Record<string, string> = {};
    const b = style.button || {};
    if (b.shape) vars['--bf-button-radius'] = BUTTON_RADIUS[b.shape];
    if (b.textColor) vars['--bf-button-text'] = b.textColor;
    if (b.width === 'auto') vars['--bf-button-align'] = style.align === 'center' ? 'center' : 'flex-start';
    return vars;
}

/**
 * formStyleVars(style) → the CSS custom properties to spread next to
 * themeVars(theme). An empty object for an empty style.
 */
export function formStyleVars(raw: unknown): Record<string, string> {
    const style = readFormStyle(raw);
    const vars: Record<string, string> = {};
    if (style.font) vars['--bf-font'] = FONT_STACKS[style.font];
    if (style.width) vars['--bf-form-width'] = WIDTH_PX[style.width];
    if (style.align) {
        vars['--bf-align'] = style.align;
        vars['--bf-align-self'] = style.align === 'center' ? 'center' : 'flex-start';
    }
    if (style.cardColor) vars['--bf-card-bg'] = style.cardColor;
    const text = style.textColor || (style.cardColor ? readableOn(style.cardColor) : null);
    if (text) Object.assign(vars, textVars(text));
    if (style.labelColor) vars['--bf-label'] = style.labelColor;
    if (style.inputStyle) Object.assign(vars, INPUT_VARS[style.inputStyle]);
    return Object.assign(vars, buttonVars(style));
}

/** The class modifiers on the form's root: hooks for custom CSS, one per chosen option. */
export function formStyleClasses(raw: unknown): string {
    const style = readFormStyle(raw);
    const mods = [
        style.font && `bf-form--font-${style.font}`,
        style.width && `bf-form--width-${style.width}`,
        style.align && `bf-form--align-${style.align}`,
        style.labelStyle && `bf-form--labels-${style.labelStyle}`,
        style.inputStyle && `bf-form--inputs-${style.inputStyle}`,
        style.button?.width && `bf-form--button-${style.button.width}`,
        style.button?.shape && `bf-form--button-${style.button.shape}`,
    ];
    return mods.filter(Boolean).join(' ');
}

/**
 * The page ground around the form: the theme's canvas as `--app-canvas`, or
 * nothing (the platform ground). For a host that paints
 * `var(--app-canvas, var(--bg-primary))` behind the form.
 */
export function canvasVars(theme: unknown): Record<string, string> {
    const canvas = isPlainObject(theme) ? theme.canvas : null;
    return isHex(canvas) ? { '--app-canvas': canvas } : {};
}

/** The page container's width class for this style (max-w-xl when the author never chose one). */
export function formWidthClass(raw: unknown): string {
    const width = readFormStyle(raw).width;
    return width ? WIDTH_CLASS[width] : 'max-w-xl';
}

/**
 * Whether the browser's own parser reads the wrapped sheet as ONE rule. A
 * second check behind the sanitiser's brace count: when the scope could be
 * closed early, the parser sees a second rule and nothing is applied. Where
 * the browser cannot tell (no constructable sheets, as in a test DOM), the
 * sanitiser's count stands.
 */
function parsesAsOneRule(sheet: string): boolean {
    const Ctor = typeof CSSStyleSheet === 'function' ? CSSStyleSheet : null;
    if (!Ctor || typeof Ctor.prototype.replaceSync !== 'function') return true;
    try {
        const probe = new Ctor();
        probe.replaceSync(sheet);
        return probe.cssRules.length <= 1;
    } catch {
        return false;
    }
}

/**
 * The `<style>` text for the author's custom CSS, nested inside this form's
 * scope (`.bf-form-scope[data-bf-scope="…"] { … }`), or '' when there is none
 * or it does not survive the checks.
 */
export function scopedFormCss(raw: unknown, scopeId: string): string {
    const { css } = sanitizeFormCssClient(readFormStyle(raw).customCss);
    if (!css) return '';
    const sheet = `.bf-form-scope[data-bf-scope="${scopeId.replace(/["\\]/g, '')}"] {\n${css}\n}`;
    return parsesAsOneRule(sheet) ? sheet : '';
}
