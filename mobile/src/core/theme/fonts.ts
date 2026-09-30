/**
 * Fonts: the org's font choice mapped to faces Android can draw, and the type
 * scale built on them.
 *
 * The choice is `branding.font` from /api/branding, the same four names as the
 * web's FONT_STACKS (applyTheme.js; generated into WEB_FONT_STACKS). The web
 * defaults to `system` — the platform face — and so does the phone. Each web
 * stack falls back to Inter and then the platform face, and so does
 * resolveFonts, while a family is still loading or failed to.
 *
 * A face is EITHER a family name (a bundled font: one family per weight, as
 * expo-font registers them) OR a weight (the platform face). Never both: on
 * Android, a `fontWeight` of 700 on a single-weight custom family makes React
 * Native give up on the family and draw Roboto Bold.
 */

import type { TextStyle } from 'react-native';

import { WEB_FONT_STACKS } from './generated/webTokens.generated';

export type FontChoice = keyof typeof WEB_FONT_STACKS;

/** What the web paints when the server names no font (ThemeContext DEFAULTS). */
export const DEFAULT_FONT: FontChoice = 'system';

export function isFontChoice(value: unknown): value is FontChoice {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(WEB_FONT_STACKS, value);
}

export type FontWeightName = 'regular' | 'medium' | 'semibold' | 'bold';

/** A bundled family, one registered name per weight. */
export type BundledFont = Exclude<FontChoice, 'system'>;

/**
 * Family names as expo-font registers them (core/providers/fonts.ts loads the
 * files under exactly these names; its test holds the two lists together).
 */
export const FONT_FAMILIES: Record<BundledFont, Record<FontWeightName, string>> = {
    inter: {
        regular: 'Inter_400Regular',
        medium: 'Inter_500Medium',
        semibold: 'Inter_600SemiBold',
        bold: 'Inter_700Bold',
    },
    plex: {
        regular: 'IBMPlexSans_400Regular',
        medium: 'IBMPlexSans_500Medium',
        semibold: 'IBMPlexSans_600SemiBold',
        bold: 'IBMPlexSans_700Bold',
    },
    geist: {
        regular: 'Geist_400Regular',
        medium: 'Geist_500Medium',
        semibold: 'Geist_600SemiBold',
        bold: 'Geist_700Bold',
    },
};

/** Code, as on the web (Fira Code); the platform monospace until it loads. */
export const MONO_FAMILY = 'FiraCode_400Regular';

const WEIGHTS: Record<FontWeightName, NonNullable<TextStyle['fontWeight']>> = {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
};

/** The part of a text style that picks the face. */
export interface FontFace {
    fontFamily?: string;
    fontWeight?: TextStyle['fontWeight'];
}

export type FontSet = Record<FontWeightName, FontFace> & { mono: FontFace };

/**
 * The faces for a font choice. `available` says whether a family name is
 * registered yet; an unknown or missing choice is the web's default.
 */
export function resolveFonts(choice: unknown, available: (family: string) => boolean): FontSet {
    const wanted = isFontChoice(choice) ? choice : DEFAULT_FONT;
    const chain: BundledFont[] = wanted === 'system' ? [] : [wanted, 'inter'];
    const family = chain.find((c) => available(FONT_FAMILIES[c].regular));
    const face = (weight: FontWeightName): FontFace =>
        family ? { fontFamily: FONT_FAMILIES[family][weight] } : { fontWeight: WEIGHTS[weight] };
    return {
        regular: face('regular'),
        medium: face('medium'),
        semibold: face('semibold'),
        bold: face('bold'),
        mono: { fontFamily: available(MONO_FAMILY) ? MONO_FAMILY : 'monospace' },
    };
}

export interface TypeStyle extends FontFace {
    fontSize: number;
    lineHeight: number;
    letterSpacing?: number;
}

interface ScaleStep {
    fontSize: number;
    lineHeight: number;
    face: keyof FontSet;
    letterSpacing?: number;
}

/**
 * The type scale. The web's page titles are 18–24px semibold, its section
 * headings 16–18, its card titles and body 14; a phone reads body at 15 and
 * never goes under 11.
 */
const SCALE = {
    /** Screen titles. */
    title: { fontSize: 22, lineHeight: 28, face: 'semibold', letterSpacing: -0.3 },
    /** Section headers and sheet titles. */
    heading: { fontSize: 18, lineHeight: 24, face: 'semibold', letterSpacing: -0.2 },
    /** Card titles, list row primary text. */
    subheading: { fontSize: 15, lineHeight: 20, face: 'semibold' },
    /** Default reading size. Chat message text lives here. */
    body: { fontSize: 15, lineHeight: 22, face: 'regular' },
    /** List row secondary text, timestamps. */
    caption: { fontSize: 13, lineHeight: 18, face: 'regular' },
    /** Badges, meta. Never smaller than this: 11px is the floor on a phone. */
    label: { fontSize: 11, lineHeight: 15, face: 'medium', letterSpacing: 0.2 },
    /** Code blocks and inline code. */
    code: { fontSize: 13, lineHeight: 20, face: 'mono' },
} as const satisfies Record<string, ScaleStep>;

export type TypeVariant = keyof typeof SCALE;
export type TypeScale = Record<TypeVariant, TypeStyle>;

export function typeScale(fonts: FontSet): TypeScale {
    const out = {} as TypeScale;
    for (const [variant, { face, ...size }] of Object.entries(SCALE)) {
        out[variant as TypeVariant] = { ...size, ...fonts[face] };
    }
    return out;
}
