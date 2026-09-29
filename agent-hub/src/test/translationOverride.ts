// A switchable dictionary over the REAL useTranslation.
//
// With the English defaults live (src/test/setup.js loads them) a hardcoded
// label and a translated one render identically, so a test cannot tell from
// the English whether a word went through t() at all. Switching one test to
// another dictionary can: only a word that goes through t() changes.
//
// Off by default, so every other test in a file keeps reading the shipped
// English. vi.mock stays in the test file (it is hoisted there); only its
// factory comes from here:
//
//   const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
//   vi.mock('../../hooks/useTranslation', async (importOriginal) =>
//       (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));
//
//   transOverride.current = { 'skills.badge_shared': 'gedeeld' };   // this test reads Dutch
//   transOverride.current = null;                                   // back to the shipped English
//
// A key missing from the dictionary falls through to the real t().

import type { TranslateFn, TranslateParams, TranslationValue } from '../hooks/useTranslation';

export interface TranslationOverride { current: Record<string, string> | null }

// Interpolate like the real t() does: a phrase with {n} in it is exactly the
// kind an override needs to reach (a hardcoded English sentence and a
// translated one are hardest to tell apart when both carry numbers), so the
// substitute cannot be the one that drops them.
function fill(text: string, params?: TranslateParams): string {
    return String(text).replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));
}

/** The mocked module: the real one, with a useTranslation that reads `override` first. */
export function overrideTranslation<M extends { useTranslation: () => TranslationValue }>(actual: M, override: TranslationOverride) {
    const useTranslation = (): TranslationValue => {
        const real = actual.useTranslation();
        const over = override.current;
        if (!over) return real;
        const t: TranslateFn = (key, fallback, params) => (key in over ? fill(over[key], params) : real.t(key, fallback, params));
        return { ...real, t };
    };
    return { ...actual, useTranslation, default: useTranslation };
}
