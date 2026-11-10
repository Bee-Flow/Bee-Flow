/**
 * App Studio runtime: the text knob group (server/appStudio/componentSpecs/styleKnobGroups/text.js).
 *
 * font, textSize, lineHeight, tracking and transform are written as inline style on the grid
 * cell and inherited by the component's text. text.css hands them to the component's root for
 * the knobs that are set. The first value of each knob is the identity and emits nothing.
 */

import './text.css';
import type { StyleKnobHandler } from '../styleKnobHandlers';
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

function resolveText(s: StyleKnobs, style: InlineStyle): string {
    const k = s as TextKnobs;
    const classes: string[] = [];
    if (has(FONT_STACK, k.font)) style.fontFamily = FONT_STACK[k.font];
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
