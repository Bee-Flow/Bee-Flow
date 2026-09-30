/**
 * How a finding in the DLP review looks and is named — the port of the web's
 * config/dlpCategoryColors.ts, pinned by dlpCategories.lockstep.test.ts.
 *
 * Colour is per GROUP, not per category: the eight `--pii-cat-*` slots are
 * the seven groups in the catalogue's order, and the eighth for anything
 * that is not one of the 21 categories (a mark of your own, an org's custom
 * term). A shakier match gets a fainter fill, so it does not compete with a
 * certain one.
 */

import { categoryDef, PII_GROUP_KEYS } from '@/features/orgShield';

export type ConfidenceBand = 'high' | 'medium' | 'low' | null;

/** The `theme.pii` slot, 0-based: a group's place, or 7 for "other". */
export function categorySlot(categoryId: string | undefined): number {
    const def = categoryId ? categoryDef(categoryId) : null;
    const at = def ? PII_GROUP_KEYS.findIndex((g) => g.group === def.group) : -1;
    return at >= 0 ? at : 7;
}

/** The fill's strength, in percent: high (and the certain sources) 22, medium 15, low 9. */
export function bandAlpha(band: string | null | undefined): number {
    if (band === 'medium') return 15;
    if (band === 'low') return 9;
    return 22;
}

/** Never a number — "High confidence", not "87%". */
export function confidenceWords(source: string | undefined, band: string | null | undefined): { i18nKey: string; en: string } {
    if (source === 'manual') return { i18nKey: 'dlp.confidence_manual', en: 'Marked by you' };
    if (source === 'custom') return { i18nKey: 'dlp.confidence_custom', en: 'Custom rule' };
    if (band === 'medium') return { i18nKey: 'dlp.confidence_medium', en: 'Possible match' };
    if (band === 'low') return { i18nKey: 'dlp.confidence_low', en: 'Low confidence' };
    return { i18nKey: 'dlp.confidence_high', en: 'High confidence' };
}

/** The category's name as the org shield names it; an unknown id is shown as it came. */
export function categoryWords(categoryId: string | undefined): { i18nKey: string; en: string } | null {
    const def = categoryId ? categoryDef(categoryId) : null;
    return def ? { i18nKey: def.i18nKey, en: def.fallback } : null;
}
