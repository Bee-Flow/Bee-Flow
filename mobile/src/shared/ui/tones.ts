/**
 * The status tones, as the web paints them: every tone is a PAIR.
 *
 * Port of agent-hub/src/components/shared/statusTone.js and the colour rules
 * of statusTokens.ts. The RAW colour (`--success`, `--error`, …) draws
 * borders, dots, stripes and tints; the INK (`--success-ink`, …) is the TEXT
 * and the glyph, because the raw colour as text on its own tint measures
 * 2.7–3.8:1 on a light card. A chip is the raw colour at 15% under the ink.
 *
 * The tones beyond the web's four statuses:
 *   - `ai`      the builder's step-family blue (`--type-ai`), which a RUNNING
 *               run wears in every organisation — not the brandable accent.
 *   - `accent`  the org's accent; its ink is `accentText`, the first accent
 *               shade that is readable on a card.
 *   - `info`    `--info` / `--info-ink`, for notes and links.
 *   - `pinned`  `--pinned`, the cyan a frozen or hand-edited payload wears.
 *   - `neutral` "nothing to say": no status colour at all — the bgTertiary
 *               bar and tertiary ink of statusTone.js. Its chip is the web's
 *               count-pill tint (text at 8%, which stays visible on every
 *               surface a chip sits on) under textSecondary, the web's
 *               NEUTRAL_BADGE ink.
 */

import type { Palette } from '@/core/theme/tokens';

import { tint } from './tint';

export type Tone = 'neutral' | 'accent' | 'ai' | 'success' | 'warning' | 'error' | 'info' | 'pinned';

export const TONES: readonly Tone[] = ['neutral', 'accent', 'ai', 'success', 'warning', 'error', 'info', 'pinned'];

export interface TonePair {
    /** Borders, dots, stripes, fills. */
    raw: string;
    /** Words and glyphs. */
    ink: string;
}

export function tonePair(colors: Palette, tone: Tone): TonePair {
    switch (tone) {
        case 'accent':
            return { raw: colors.accentPrimary, ink: colors.accentText };
        case 'ai':
            return { raw: colors.typeAi, ink: colors.typeAi };
        case 'success':
            return { raw: colors.success, ink: colors.successInk };
        case 'warning':
            return { raw: colors.warning, ink: colors.warningInk };
        case 'error':
            return { raw: colors.error, ink: colors.errorInk };
        case 'info':
            return { raw: colors.info, ink: colors.infoInk };
        case 'pinned':
            return { raw: colors.pinned, ink: colors.pinned };
        default:
            return { raw: colors.bgTertiary, ink: colors.textTertiary };
    }
}

/** The web's status chip: the raw colour at 15% under the ink. */
export function chipColors(colors: Palette, tone: Tone): { bg: string; fg: string } {
    if (tone === 'neutral') return { bg: tint(colors.textPrimary, 8), fg: colors.textSecondary };
    const { raw, ink } = tonePair(colors, tone);
    return { bg: tint(raw, 15), fg: ink };
}
