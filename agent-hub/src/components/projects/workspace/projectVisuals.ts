// How a project looks: its tile (emoji on a tint of its colour) and the
// initials on a member avatar. Leaf module: no React, no text.

import type { CSSProperties } from 'react';

export const DEFAULT_PROJECT_COLOR = '#3b82f6';
export const DEFAULT_PROJECT_ICON = '📁';

const HEX_RX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * The project's colour, or the default when it is not a plain hex value.
 * The colour is written by any editor and painted in every member's browser,
 * so it goes into CSS only after this check: a crafted value could otherwise
 * close the colour function and add a `url(...)` that makes other members'
 * browsers call out to a third party.
 */
export function safeProjectColor(color?: string | null): string {
    return color && HEX_RX.test(color.trim()) ? color.trim() : DEFAULT_PROJECT_COLOR;
}

export function projectIcon(icon?: string | null): string {
    const trimmed = (icon || '').trim();
    return trimmed || DEFAULT_PROJECT_ICON;
}

/** The square tile behind a project's emoji: a 16% tint of its colour. */
export function projectTileStyle(color: string | null | undefined, size = 36): CSSProperties {
    return {
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: size >= 36 ? 10 : 8,
        display: 'grid',
        placeItems: 'center',
        background: `color-mix(in srgb, ${safeProjectColor(color)} 16%, transparent)`,
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
    };
}

/** A small label in the project's colour (the chat list's "in project" chip). */
export function projectChipStyle(color: string | null | undefined): CSSProperties {
    const safe = safeProjectColor(color);
    return { background: `color-mix(in srgb, ${safe} 14%, transparent)`, color: safe };
}

/** A colour swatch in a picker. */
export function swatchStyle(hex: string): CSSProperties {
    return { background: safeProjectColor(hex) };
}

/** "Ada Lovelace" → "AL", "ada@example.org" → "A". Empty → "?". */
/** The AI's own colour in a chat: violet, so it never reads as a colleague or as the theme's grey. */
export const AI_HUE = 262;

/** The AI's colours in a chat, kept quiet: a hint of the project's own colour on the theme's greys. */
export interface AiTone { ink: string; soft: string; ring: string; card: string; edge: string; bar: string }

const mix = (color: string, pct: number, into = 'transparent') => `color-mix(in srgb, ${color} ${pct}%, ${into})`;

/** Tones from the project's colour (a hex like `#22c55e`); violet when the project has none. */
export function aiToneFor(color?: string | null): AiTone {
    const c = typeof color === 'string' && /^#[0-9a-f]{3,8}$/i.test(color.trim()) ? color.trim() : `hsl(${AI_HUE} 45% 55%)`;
    return {
        // Text keeps the theme's ink with a lean towards the colour, so it stays readable on every theme.
        ink: mix(c, 70, 'var(--text-primary)'),
        soft: mix(c, 14),
        ring: mix(c, 30),
        card: mix(c, 4.5),
        edge: mix(c, 22),
        bar: mix(c, 60),
    };
}

/** Without a project colour to go by. */
export const AI_TONE: AiTone = aiToneFor(null);

/** A stable hue (0-359) for a name, so the same person always gets the same colour. */
export function hueOf(name: string | null | undefined): number {
    let h = 5381;
    for (const ch of String(name || '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    // Spread by the golden angle, so two similar names still land far apart on the wheel.
    return Math.round((h * 137.508) % 360);
}

export function initialsOf(name?: string | null): string {
    const clean = (name || '').trim();
    if (!clean) return '?';
    const words = clean.split(/[\s@._-]+/).filter(Boolean);
    const letters = words.length > 1 && !clean.includes('@')
        ? `${words[0][0]}${words[words.length - 1][0]}`
        : words[0][0];
    return letters.toUpperCase();
}
