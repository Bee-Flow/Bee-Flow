/**
 * A form's own look — the author's accent, corners and spacing — applied to
 * the filling screen, from the web's App Studio themeVars.js (the hosted form
 * and an App Studio app share one THEME_SPEC). formLook.lockstep.test.ts
 * reads the web's tables.
 *
 * `appearance` is not applied: the phone has one theme at a time, the
 * person's own, and a form that turned the app dark for one screen would read
 * as a glitch rather than as the author's choice.
 */

import { isHexColor, readableForeground } from '@/core/theme/color';

export const DEFAULT_PRIMARY = '#0F766E';

/** The web's RADIUS_PX, in dp. */
export const RADIUS_PX: Readonly<Record<string, number>> = { none: 0, sm: 4, md: 8, lg: 12, xl: 16 };
/** The web's DENSITY_MULT: how far apart the questions sit. */
export const DENSITY_MULT: Readonly<Record<string, number>> = { compact: 0.75, comfortable: 1, spacious: 1.25 };

export interface FormLook {
    primary: string;
    /** Ink on the accent. */
    onPrimary: string;
    radius: number;
    /** The gap between two questions. */
    gap: number;
}

const BASE_GAP = 20;

export function formLook(theme: Record<string, unknown> | null | undefined): FormLook {
    const primary = isHexColor(theme?.primary) ? (theme?.primary as string) : DEFAULT_PRIMARY;
    const radius = RADIUS_PX[String(theme?.radius)] ?? (RADIUS_PX.md as number);
    const density = DENSITY_MULT[String(theme?.density)] ?? 1;
    return { primary, onPrimary: readableForeground(primary), radius, gap: Math.round(BASE_GAP * density) };
}
