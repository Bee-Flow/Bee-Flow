/**
 * The app's own words, in the user's language.
 *
 * The web app is fully localized: the same account that shows "Waar werken we
 * aan?" in a browser showed "Ask Bee Flow anything" on the phone, because
 * `mobile/` had no i18n at all and every string was an English literal. That is
 * not a missing translation — it is the app failing to look like the same
 * product to the person holding both.
 *
 * Modelled on the web's useTranslation (agent-hub/src/hooks/useTranslation.jsx)
 * so the two clients agree by construction:
 *
 *   - The catalogue is the SERVER's, from /api/languages/user/strings/<locale>.
 *     Not a bundled JSON file: an administrator can edit these strings, and a
 *     phone shipping its own copy would drift from the browser the moment they
 *     did.
 *   - Keys are the web's keys. Reusing `settings.appearance` rather than
 *     inventing `mobile.settings.appearance` means every string an admin has
 *     already translated appears on the phone for free.
 *   - `t(key, fallback)` ALWAYS takes an English fallback, and the fallback is
 *     the literal that would otherwise have been hardcoded. So a missing key,
 *     an untranslated locale, a failed fetch and an offline start all degrade
 *     to a working English app rather than to blank labels — and adopting i18n
 *     screen by screen is safe, because an unconverted screen is exactly what
 *     it is today.
 *
 * Deliberately an external store rather than context: `matchesSearch` in the
 * sitemap needs to translate, and it is a pure function called from a module
 * that has no provider above it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import { useSyncExternalStore } from 'react';

const LOCALE_KEY = 'beeflow.i18n.locale';
const CATALOGUE_KEY = (locale: string) => `beeflow.i18n.strings.${locale}`;

export type Catalogue = Record<string, string>;

interface State {
    locale: string;
    strings: Catalogue;
    /** False until the first read off disk lands. */
    ready: boolean;
}

let state: State = { locale: 'en', strings: {}, ready: false };
const listeners = new Set<() => void>();

function emit(next: State): void {
    state = next;
    for (const listener of listeners) listener();
}

/**
 * The device's language as a bare code — 'nl' from 'nl-NL'.
 *
 * The server's locales are bare codes (see /api/languages/user/locales), so a
 * region-tagged device locale must be narrowed or it matches nothing.
 */
export function deviceLocale(): string {
    try {
        const tag = Localization.getLocales()[0]?.languageCode;
        return typeof tag === 'string' && tag ? tag.toLowerCase() : 'en';
    } catch {
        return 'en';
    }
}

/**
 * Which language to render in.
 *
 * Same order as the web: an explicit choice, then the organisation's default,
 * then the device, then English. `available` is what the server actually has —
 * offering a locale it has no strings for is offering a 404, which is the
 * mistake the Language screen's own comment already warns about.
 */
export function resolveLocale({
    stored,
    orgDefault,
    device,
    available,
}: {
    stored: string | null;
    orgDefault: string | null;
    device: string;
    available: readonly string[];
}): string {
    const has = (code: string | null): code is string =>
        Boolean(code) && available.includes(code as string);
    if (has(stored)) return stored;
    if (has(orgDefault)) return orgDefault;
    if (has(device)) return device;
    return 'en';
}

/** Narrow whatever came off disk. A corrupt catalogue is just no catalogue. */
export function parseCatalogue(raw: string | null): Catalogue {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Catalogue = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

/** Values a sentence can carry. Anything else would render as "[object Object]". */
export type TranslateParams = Record<string, string | number>;

/**
 * Translate. The fallback is not optional and not decorative: it is the English
 * literal, so every call site reads as the sentence it renders.
 *
 * `params` fills `{name}`-style placeholders, the same syntax and the same
 * substitution as the web's `interpolate` (agent-hub/src/hooks/
 * useTranslation.jsx). It is not a convenience: the catalogue this phone reads
 * is the web's, and that catalogue already contains sentences like
 * "Rows {from}–{to} of {total}". Borrowing such a key without substitution
 * renders the braces to the user — so the phone could reuse only the
 * placeholder-free half of a dictionary built for both clients.
 *
 * Replacement is literal: a value containing `{other}` is not scanned again,
 * so a person whose name is a placeholder cannot rewrite the sentence around
 * it.
 */
export function translate(key: string, fallback: string, params?: TranslateParams): string {
    const value = state.strings[key] ?? fallback;
    if (!params) return value;
    let out = value;
    for (const [name, raw] of Object.entries(params)) {
        const literal = String(raw);
        out = out.split(`{${name}}`).join(literal);
    }
    return out;
}

/** Current locale, for callers that need to know rather than to render. */
export function currentLocale(): string {
    return state.locale;
}

/** Install a locale and its catalogue. Called by <LocaleSync>, which fetches. */
export function setCatalogue(locale: string, strings: Catalogue): void {
    emit({ locale, strings, ready: true });
    void AsyncStorage.setItem(CATALOGUE_KEY(locale), JSON.stringify(strings)).catch(
        () => undefined,
    );
    void AsyncStorage.setItem(LOCALE_KEY, locale).catch(() => undefined);
}

/** The locale this device last chose, if any. */
export async function storedLocale(): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(LOCALE_KEY);
    } catch {
        return null;
    }
}

/**
 * Paint the last known catalogue before the network answers. Without this a
 * Dutch user reads an English app for the length of a round trip on every cold
 * start — the same flash the theme had.
 */
export async function hydrate(): Promise<void> {
    try {
        const locale = await AsyncStorage.getItem(LOCALE_KEY);
        if (!locale) return emit({ ...state, ready: true });
        const strings = parseCatalogue(await AsyncStorage.getItem(CATALOGUE_KEY(locale)));
        emit({ locale, strings, ready: true });
    } catch {
        emit({ ...state, ready: true });
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): State {
    return state;
}

/** Re-renders the caller when the catalogue arrives or the locale changes. */
export function useLocale(): State {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test seam. */
export function _reset(): void {
    emit({ locale: 'en', strings: {}, ready: false });
}
