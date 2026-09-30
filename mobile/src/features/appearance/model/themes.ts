/**
 * The words for the three theme choices: "Match my phone", Day and Night.
 *
 * Day and Night are the web's `light` and `dark` palettes; the phone offers
 * nothing else (core/theme/tokens.ts, PICKABLE_THEMES). Plain functions over
 * `translate`, so the Settings row and the Appearance screen say the same.
 */

import { translate } from '@/core/i18n';
import type { ThemePreference } from '@/core/theme/ThemeProvider';
import type { DayNight } from '@/core/theme/tokens';

/** "Day" or "Night". */
export function themeName(name: DayNight): string {
    return name === 'light'
        ? translate('mobile.appearance.day', 'Day')
        : translate('mobile.appearance.night', 'Night');
}

/** One line per theme, describing what it is FOR rather than what it is. */
export function themeHint(name: DayNight): string {
    return name === 'light'
        ? translate('mobile.appearance.day_hint', 'Light and crisp, for daylight')
        : translate('mobile.appearance.night_hint', 'Dark and calm, easy at night');
}

/** A preference as the Settings row shows it. */
export function themeLabel(preference: ThemePreference): string {
    return preference === 'system'
        ? translate('mobile.appearance.match_phone', 'Match my phone')
        : themeName(preference);
}
