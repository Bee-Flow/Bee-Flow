/**
 * The translation entry point.
 *
 * Two ways in, on purpose:
 *
 *   `useTranslation()` inside a component, so the screen re-renders when the
 *   catalogue arrives mid-session.
 *
 *   `translate()` from module scope, for pure functions that have no hook —
 *   `matchesSearch` in the sitemap is the one that forced this, and it is the
 *   reason the catalogue is an external store rather than context.
 */

import { translate, useLocale } from './store';
import type { TranslateParams } from './store';

export {
    translate,
    currentLocale,
    deviceLocale,
    resolveLocale,
    setCatalogue,
    storedLocale,
    hydrate,
    parseCatalogue,
    useLocale,
    _reset,
} from './store';
export type { Catalogue, TranslateParams } from './store';

export type TranslateFn = (
    key: string,
    fallback: string,
    params?: TranslateParams,
) => string;

/**
 * `const t = useTranslation()` then `t('settings.appearance', 'Appearance')`.
 *
 * The English literal is the second argument rather than a lookup in a bundled
 * catalogue, so the call site still reads as the sentence it renders and a
 * missing key is invisible to the user.
 */
export function useTranslation(): TranslateFn {
    // Subscribing is the point — the returned function closes over nothing, but
    // the hook re-renders the caller when the catalogue lands.
    useLocale();
    return translate;
}
