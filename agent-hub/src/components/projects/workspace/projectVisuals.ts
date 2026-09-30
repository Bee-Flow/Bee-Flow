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
export function initialsOf(name?: string | null): string {
    const clean = (name || '').trim();
    if (!clean) return '?';
    const words = clean.split(/[\s@._-]+/).filter(Boolean);
    const letters = words.length > 1 && !clean.includes('@')
        ? `${words[0][0]}${words[words.length - 1][0]}`
        : words[0][0];
    return letters.toUpperCase();
}
