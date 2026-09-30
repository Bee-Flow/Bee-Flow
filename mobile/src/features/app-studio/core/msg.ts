/**
 * Words that core logic hands to the UI without translating them itself.
 *
 * core/ is pure (no React, no store), so where the web module returned an
 * English sentence the port returns a Msg: the catalogue key, the English
 * literal and its {placeholders}. The UI renders it with `say(msg, t)`;
 * without a `t` it renders the English exactly as the web did, which is what
 * the lockstep tests compare.
 *
 * The data carries the key as `i18nKey`, the name src/core/i18n/i18nGuard
 * reads, so a borrowed web key is checked against both dictionaries. Keys the
 * web does not have live under `mobile.app_studio.*` (the guard requires
 * lower-case key segments).
 */

import type { TranslateFn, TranslateParams } from '@/core/i18n';

export interface Msg {
    i18nKey: string;
    en: string;
    params?: TranslateParams;
}

export type Translate = TranslateFn;

/** The stand-in for t() when a caller has none: the English, placeholders filled. */
export const EN_ONLY: Translate = (_key, en, params) => {
    if (!params) return en;
    let out = String(en);
    for (const [name, value] of Object.entries(params)) out = out.split(`{${name}}`).join(String(value));
    return out;
};

/** Render a Msg with the given translator (English by default). */
export function say(m: Msg, t: Translate = EN_ONLY): string {
    return t(m.i18nKey, m.en, m.params);
}

/** The same Msg with params filled in. */
export function withParams(m: Msg, params: TranslateParams): Msg {
    return { ...m, params: { ...(m.params || {}), ...params } };
}
