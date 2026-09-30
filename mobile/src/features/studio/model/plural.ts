/**
 * The web's two-form plural (KnowledgeStudio/plural.js nOf): `key` for one,
 * `key_plural` for any other count — the pair the web's dictionaries carry
 * (studio.makers / studio.makers_plural), so a Dutch catalogue translates both.
 */

import type { TranslateFn } from '@/core/i18n';

/** `forms` is the English pair: `[one, many]`, each with `{count}`. */
export function nOf(t: TranslateFn, key: string, count: number, forms: readonly [string, string]): string {
    const n = Number.isFinite(count) ? count : 0;
    return n === 1 ? t(key, forms[0], { count: n }) : t(`${key}_plural`, forms[1], { count: n });
}
