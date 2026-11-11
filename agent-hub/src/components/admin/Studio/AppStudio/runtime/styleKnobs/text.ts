/**
 * App Studio runtime: the text knob group (server/appStudio/componentSpecs/styleKnobGroups/text.js).
 *
 * font, textSize, lineHeight, tracking and transform are written as inline style on the grid
 * cell and inherited by the component's text. text.css hands them to the component's root for
 * the knobs that are set. The first value of each knob is the identity and emits nothing.
 */

import './text.css';
import { fontKnobFamily } from '../fonts/fontRoles';
import type { StyleKnobContext, StyleKnobHandler } from '../styleKnobHandlers';
import type { InlineStyle, StyleKnobs } from '../styleResolver.types';

/** Tailwind's type scale in rem; md is the body size. */
const TEXT_SIZE: Record<string, string> = {
    xs: '0.75rem', sm: '0.875rem', md: '1rem', lg: '1.125rem', xl: '1.25rem', '2xl': '1.5rem', '3xl': '1.875rem', '4xl': '2.25rem',
};

/** The line height a size brings along, so a large size does not keep the leading of a small one. */
const SIZE_LEADING: Record<string, number> = {
    xs: 1.5, sm: 1.5, md: 1.5, lg: 1.45, xl: 1.35, '2xl': 1.3, '3xl': 1.2, '4xl': 1.15,
};

const LEADING: Record<string, number> = { tight: 1.25, normal: 1.5, relaxed: 1.625 };

const TRACKING: Record<string, string> = { tight: '-0.025em', normal: '0em', wide: '0.05em' };

const FONT_STACK: Record<string, string> = {
    heading: 'inherit',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
};

type TextKnobs = StyleKnobs & { font?: string; textSize?: string; lineHeight?: string; tracking?: string; transform?: string };

const has = <V,>(table: Record<string, V>, key: string | undefined): key is string =>
    typeof key === 'string' && Object.hasOwn(table, key);

/**
 * The font knob. In an app whose design sets font roles (design.fonts, fonts/fontRoles.ts) a
 * role follows the design's variable and the cell keeps its font for the headings and code
 * inside it (.app-tk-font); in any other app it writes what it always wrote.
 */
function applyFont(k: TextKnobs, style: InlineStyle, classes: string[], context?: StyleKnobContext): void {
    const followed = typeof k.font === 'string' ? fontKnobFamily(k.font, context?.design) : null;
    if (followed) {
        style.fontFamily = followed;
        classes.push('app-tk-font');
    } else if (has(FONT_STACK, k.font)) {
        style.fontFamily = FONT_STACK[k.font];
    }
}

function resolveText(s: StyleKnobs, style: InlineStyle, context?: StyleKnobContext): string {
    const k = s as TextKnobs;
    const classes: string[] = [];
    applyFont(k, style, classes, context);
    if (has(TEXT_SIZE, k.textSize)) {
        style.fontSize = TEXT_SIZE[k.textSize];
        style.lineHeight = SIZE_LEADING[k.textSize];
        classes.push('app-tk-size');
    }
    if (has(LEADING, k.lineHeight)) {
        style.lineHeight = LEADING[k.lineHeight];
        classes.push(k.textSize ? 'app-tk-size' : 'app-tk-lh');
    }
    if (has(TRACKING, k.tracking)) {
        style.letterSpacing = TRACKING[k.tracking];
        classes.push('app-tk-tracking');
    }
    if (k.transform === 'uppercase') style.textTransform = 'uppercase';
    return [...new Set(classes)].join(' ');
}

/**
 * The classes a component puts on the inner part whose own size, line height, letter spacing or
 * case would otherwise beat the value the knob wrote on the cell (a button, a header title, a
 * badge, an input label), for the knobs this style sets. Nothing for a style that sets none,
 * so a component without text knobs keeps its class string. text.css hands the value back to
 * the part. The part is chosen by the component, with a class of its own, because no product
 * stylesheet may name the stable bfa-<type>__<part> classes.
 */
export function textPartClasses(style: StyleKnobs | null | undefined): string {
    const k = (style ?? {}) as TextKnobs;
    const classes: string[] = [];
    if (has(TEXT_SIZE, k.textSize)) classes.push('app-tkp-size');
    else if (has(LEADING, k.lineHeight)) classes.push('app-tkp-lh');
    if (has(TRACKING, k.tracking)) classes.push('app-tkp-tracking');
    if (k.transform === 'uppercase') classes.push('app-tkp-case');
    return classes.length ? ` ${classes.join(' ')}` : '';
}

const text: StyleKnobHandler = {
    labels: {
        font: ['studio_apps_text.knobs.font', 'Font'],
        textSize: ['studio_apps_text.knobs.text_size', 'Text size'],
        lineHeight: ['studio_apps_text.knobs.line_height', 'Line spacing'],
        tracking: ['studio_apps_text.knobs.tracking', 'Letter spacing'],
        transform: ['studio_apps_text.knobs.transform', 'Letter case'],
    },
    node: resolveText,
};

export default text;
