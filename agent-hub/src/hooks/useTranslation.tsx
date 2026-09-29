/**
 * useTranslation — React hook for i18n
 * 
 * Usage:
 *   const { t, locale, setLocale, isLoading } = useTranslation();
 *   t('admin.dashboard_title')         → "Admin Dashboard" (en)
 *   t('admin.dashboard_title')         → "Beheerdersdashboard" (nl)
 *   t('welcome_user', { name: 'Tom' }) → "Welcome, Tom" (if value is "Welcome, {name}")
 */

import { createContext, useContext, useState, useEffect, useEffectEvent, useCallback, useRef, type ReactNode } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';
import { isPublicMarketingPath } from '../utils/cmsPublicRouting';
import {
    buildStampedCacheKey,
    I18N_CACHE_PREFIX,
    I18N_LOCALES_CACHE_KEY,
} from '../utils/storageMigrations';

/*
 * EN_DEFAULTS is loaded ASYNCHRONOUSLY, on purpose. The static import put the
 * whole English catalogue — ~400 KB raw, ~106 KB gzipped, 55% of the entry
 * chunk — on the first-load path of every page, including the marketing site,
 * which contains not a single t() call. The catalogue now arrives via
 * `ensureI18nDefaults()`:
 *
 *   - every lazy surface that DOES translate (AuthedApp, the public pages)
 *     is imported through `lazyWithI18n` (utils/lazyWithReload.js), which
 *     awaits this promise alongside the chunk — so by the time any of their
 *     t() calls run, DEFAULTS is populated and nothing ever renders a raw key;
 *   - the provider also kicks the load on mount as a safety net and bumps a
 *     state counter when it resolves, re-rendering any t() consumer that
 *     somehow raced ahead of it.
 *
 * DEFAULTS is a live module-scope binding rather than React state because the
 * provider-less fallback path in useTranslation() has no state to subscribe
 * to — it reads whatever has arrived, which for every real surface is the
 * full catalogue (see lazyWithI18n above).
 */
/** A catalogue as the server sends it. Values are `unknown` on purpose: a
 *  malformed payload can land a non-string at a key, and t() has to notice. */
export type Catalogue = Record<string, unknown>;

export type TranslateParams = Record<string, unknown>;

export type TranslateFn = (
    key: string,
    fallbackOrParams?: string | TranslateParams,
    params?: TranslateParams,
) => string;

export interface TranslationValue {
    t: TranslateFn;
    locale: string;
    /** The language actually on screen — see readingLocale. */
    resolvedLocale: string;
    setLocale: (locale: string) => void;
    isLoading: boolean;
    strings: Catalogue;
}

let DEFAULTS: Catalogue = {};
let defaultsPromise: Promise<void> | null = null;
const defaultsListeners = new Set<() => void>();
export function ensureI18nDefaults(): Promise<void> {
    if (!defaultsPromise) {
        defaultsPromise = import('../i18n/en-defaults').then((m) => {
            DEFAULTS = m.default || {};
            defaultsListeners.forEach((fn) => fn());
            defaultsListeners.clear();
        }).catch((e) => {
            // A failed chunk leaves keys resolving to their string fallbacks —
            // degraded but readable. Reset so a later surface can retry.
            console.warn('[i18n] defaults chunk failed to load:', e instanceof Error ? e.message : e);
            defaultsPromise = null;
        });
    }
    return defaultsPromise;
}

const TranslationContext = createContext<TranslationValue | null>(null);

// The user's CHOICE of language. Deliberately deploy-spanning — never stamp
// it with the build sha (see utils/storageMigrations.js for the full list of
// keys that must survive deploys).
const STORAGE_KEY = 'beeflow_locale';
const LOCALES_CACHE_KEY = I18N_LOCALES_CACHE_KEY;
const LOCALES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// The catalogue CACHE, by contrast, is stamped with the build sha
// (`beeflow_i18n_<loc>_<sha>`): the stored timestamp was never checked, so an
// unstamped cache kept serving last release's translations after a deploy —
// and kept them forever when the fetch behind it failed or the locale fell
// out of the available list. A new build now simply misses the cache and
// fetches cold; storageMigrations sweeps other builds' keys at app start.
const stringsCacheKey = (loc: string) => buildStampedCacheKey(I18N_CACHE_PREFIX, loc);

// Resolve which locales the server actually has configured. Without this gate
// the boot path fires a 404 in DevTools every time the browser is set to a
// language the org hasn't added (e.g. `nl` against an English-only seed).
// Cached for 24h in localStorage so we don't pay the round-trip on every load.
async function fetchAvailableLocaleCodes(apiBase: string): Promise<string[] | null> {
    try {
        const cached = localStorage.getItem(LOCALES_CACHE_KEY);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && Array.isArray(parsed.codes) && Date.now() - (parsed.at || 0) < LOCALES_CACHE_TTL_MS) {
                return parsed.codes;
            }
        }
    } catch { /* fall through */ }
    try {
        const res = await fetch(`${apiBase}/api/languages/public/locales`);
        if (!res.ok) return null;
        const list = await res.json();
        const codes: string[] = Array.isArray(list)
            ? list.map((l: { code?: string }) => l.code).filter((c: string | undefined): c is string => !!c)
            : [];
        try { localStorage.setItem(LOCALES_CACHE_KEY, JSON.stringify({ codes, at: Date.now() })); } catch { /* quota */ }
        return codes;
    } catch {
        return null;
    }
}

/**
 * TranslationProvider — wrap your app with this to enable translations
 */
export function TranslationProvider({ children }: { children: ReactNode }) {
    const hasStoredLocale = useRef(!!localStorage.getItem(STORAGE_KEY));
    const [locale, setLocaleState] = useState(() => {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) return stored;
        // Auto-detect browser language (nl, nl-NL → nl)
        const nav: Navigator & { userLanguage?: string } = navigator;
        const browserLang = (nav.language || nav.userLanguage || 'en').split('-')[0].toLowerCase();
        return browserLang || 'en';
    });
    // Server strings only — the EN catalogue is layered underneath inside t()
    // (`strings[key] ?? DEFAULTS[key]`), which makes the old `{...EN_DEFAULTS,
    // ...data}` spreads unnecessary and lets the defaults arrive at any time.
    const [strings, setStrings] = useState<Catalogue>({});
    const [isLoading, setIsLoading] = useState(false);
    const loadedLocaleRef = useRef('en'); // defaults are already loaded

    // Safety net for anything not routed through lazyWithI18n; bumping state
    // re-renders every t() consumer once the catalogue lands.
    const [, setDefaultsTick] = useState(0);
    useEffect(() => {
        let cancelled = false;
        // …but not on the public marketing surface. Nothing under src/marketing
        // calls t(), and every genuine consumer arrives through lazyWithI18n,
        // which resolves the catalogue alongside its own chunk. Left ungated,
        // this net pulled ~100 KB gzipped into the LCP window of a page that
        // never reads a single key.
        if (typeof window !== 'undefined' && isPublicMarketingPath(window.location.pathname)) {
            return undefined;
        }
        if (Object.keys(DEFAULTS).length === 0) {
            const bump = () => { if (!cancelled) setDefaultsTick((n) => n + 1); };
            defaultsListeners.add(bump);
            ensureI18nDefaults();
            return () => { cancelled = true; defaultsListeners.delete(bump); };
        }
        return undefined;
    }, []);

    const loadStrings = useCallback(async (loc: string) => {
        // Check the (build-stamped) cache first. Shape is allow-listed: only a
        // plain object under `data` is applied — JSON validity alone doesn't
        // make it a catalogue.
        let cached = null;
        try { cached = localStorage.getItem(stringsCacheKey(loc)); } catch { /* storage unavailable */ }
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed && typeof parsed.data === 'object' && parsed.data !== null && !Array.isArray(parsed.data)) {
                    setStrings(parsed.data);
                    loadedLocaleRef.current = loc;
                }
            } catch { /* corrupt entry — fetch it cold */ }
        }

        // Skip the server round-trip if the org doesn't have this locale —
        // avoids a console-noisy 404 for stored locales that were dropped on
        // the server side (or were never added in this deployment).
        const available = await fetchAvailableLocaleCodes(API_BASE);
        if (available && !available.includes(loc)) {
            loadedLocaleRef.current = loc;
            return;
        }

        // Fetch from server
        setIsLoading(true);
        try {
            const res = await authFetch(`${API_BASE}/api/languages/user/strings/${loc}`);
            if (res.ok) {
                const data = await res.json();
                setStrings(data);
                loadedLocaleRef.current = loc;
                // Cache under this build's key — the next deploy misses it by
                // construction. `timestamp` is informational only.
                try {
                    localStorage.setItem(stringsCacheKey(loc), JSON.stringify({
                        data,
                        timestamp: Date.now(),
                    }));
                } catch { /* quota */ }
            }
        } catch (err) {
            console.warn('[i18n] Failed to load translations:', err instanceof Error ? err.message : err);
            // Keep the EN catalogue (layered in t()) as fallback — no need to set empty strings
        }
        setIsLoading(false);
    }, []);

    // Load strings via public endpoint for pre-auth (login page) when locale is non-English.
    // Probes /public/locales first so we don't fire a console-noisy 404 when the browser
    // is set to a language the org hasn't configured.
    const loadPublicStrings = useCallback(async (loc: string) => {
        if (loc === 'en' || loadedLocaleRef.current === loc) return;
        const available = await fetchAvailableLocaleCodes(API_BASE);
        if (available && !available.includes(loc)) {
            // Server doesn't have this locale; stay on EN defaults and mark loaded
            // so the useEffect below doesn't keep re-triggering loadStrings().
            loadedLocaleRef.current = loc;
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/api/languages/public/strings/${loc}`);
            if (res.ok) {
                const data = await res.json();
                setStrings(data);
                loadedLocaleRef.current = loc;
                try { localStorage.setItem(stringsCacheKey(loc), JSON.stringify({ data, timestamp: Date.now() })); } catch { /* quota */ }
                return;
            }
        } catch { /* handled below: fall through to the authenticated endpoint */ }
        // Network error (not a 404) — try authenticated endpoint after login resolves.
        loadStrings(loc);
    }, [loadStrings]);

    // On first load: try the public endpoint for the detected browser locale.
    // Once — a later locale change is handled by the loadStrings effect below.
    const probeBrowserLocale = useEffectEvent(() => {
        if (!hasStoredLocale.current && locale !== 'en') loadPublicStrings(locale);
    });
    useEffect(() => { probeBrowserLocale(); }, []);

    // Post-auth: check for org default locale
    useEffect(() => {
        if (!hasStoredLocale.current) {
            authFetch(`${API_BASE}/api/languages/user/locales`)
                .then(r => r.json())
                .then(data => {
                    if (Array.isArray(data)) {
                        const orgDefault = data.find((l: { isOrgDefault?: boolean; code?: string }) => l.isOrgDefault);
                        if (orgDefault && orgDefault.code !== 'en') {
                            localStorage.setItem(STORAGE_KEY, orgDefault.code);
                            setLocaleState(orgDefault.code);
                        }
                    }
                })
                .catch(e => console.warn('[useTranslation] org-default locale probe failed', e));
        }
    }, []);

    useEffect(() => {
        if (locale !== loadedLocaleRef.current) {
            loadStrings(locale);
        }
    }, [locale, loadStrings]);

    const setLocale = useCallback((newLocale: string) => {
        localStorage.setItem(STORAGE_KEY, newLocale);
        setLocaleState(newLocale);
    }, []);

    /**
     * t(key, fallbackOrParams?, params?) — translate a key.
     *
     * Supported signatures:
     *   t('org.cost')                          → strings['org.cost'] || DEFAULTS['org.cost'] || 'org.cost'
     *   t('org.cost', 'Cost')                  → string fallback used when key is missing in both server strings AND the EN catalogue
     *   t('hello', { name: 'Tom' })            → interpolate "{name}" placeholders
     *   t('greet', 'Hi {name}', { name: 'T' }) → fallback + interpolation
     *
     * Resolution order: server strings → EN catalogue (DEFAULTS) → string fallback → raw key.
     */
    const t = useCallback<TranslateFn>((key, fallbackOrParams, paramsArg) => {
        const hasStringFallback = typeof fallbackOrParams === 'string';
        const params = hasStringFallback ? paramsArg : fallbackOrParams;
        let value: unknown = strings[key] || DEFAULTS[key];
        if (value === undefined || value === null) {
            value = hasStringFallback ? fallbackOrParams : key;
        }
        // Guard: a malformed server payload could land a non-string at this key
        // (e.g. an object). Returning it would crash React with the
        // "Objects are not valid as a React child" reconciler throw. Coerce
        // to the fallback or raw key instead so the UI keeps rendering.
        if (typeof value !== 'string') {
            value = hasStringFallback ? fallbackOrParams : key;
        }
        return interpolate(value as string, params);
    }, [strings]);

    // WHICH LANGUAGE THE PERSON IS READING — not the same question as `locale`.
    // `locale` is a preference: the browser's language, or a choice stored per
    // ORIGIN (the Nextcloud-embedded app has its own localStorage, so a choice
    // made in the standalone hub is not there). When the deployment has no
    // catalogue for it, every t() falls through to the English defaults and the
    // screen is English while `locale` still says 'nl'. Anything that ACTS in
    // the user's language — a Playbook is built in it, labels and all — must
    // follow the screen, not the preference.
    const resolvedLocale = readingLocale(locale, strings);
    const value: TranslationValue = { t, locale, resolvedLocale, setLocale, isLoading, strings };

    return (
        <TranslationContext.Provider value={value}>
            {children}
        </TranslationContext.Provider>
    );
}

/**
 * useTranslation — access translations from any component
 */
/**
 * `{name}` → de waarde, LETTERLIJK.
 *
 * Eén implementatie voor de provider en voor de terugval eronder, en met een
 * vervang-FUNCTIE in plaats van een vervang-STRING. In een vervangingsstring
 * zijn `$&`, `` $` ``, `$'` en `$1`..`$9` speciaal, en de waarden die hier
 * langskomen zijn gebruikersinvoer: een bestandsnaam, een tabelnaam, een pad.
 * `t('Unsupported characters in "{segment}"', { segment: 'a$&b.txt' })` gaf
 * daardoor `Unsupported characters in "a{segment}b.txt"` — precies de melding
 * die bestaat omdat de naam rare tekens bevat, met de naam eruit gesloopt.
 * Een functie als tweede argument van `replace` kent die tekens niet.
 */
export function interpolate(value: string, params?: TranslateParams | string): string {
    if (!params || typeof params !== 'object') return value;
    let out = value;
    for (const [k, v] of Object.entries(params)) {
        const literal = String(v);
        out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => literal);
    }
    return out;
}

/**
 * The language on SCREEN: the chosen locale when its catalogue is actually in
 * use, English otherwise (that is what t() then renders). See the comment at
 * the provider's `resolvedLocale`.
 *
 * `anchors` makes the answer EXACT for one surface. "The catalogue is loaded"
 * is too weak on its own: a deployment can have a Dutch catalogue with a few
 * hundred keys, none of which the screen in front of you uses — every t()
 * there falls through to English, the screen is English, and `locale` still
 * says 'nl'. Measured 2026-09-16: a playbook described on a fully English
 * dialog came back with Dutch columns and Dutch phase labels for exactly that
 * reason. A surface that ACTS in the user's language passes the keys IT
 * renders; if the catalogue does not have them, the screen is English and so
 * is what gets built.
 */
export function readingLocale(locale: string, strings: Catalogue | null | undefined, anchors: string[] = []): string {
    if (!locale || locale === 'en') return 'en';
    const dict = strings && typeof strings === 'object' ? strings : null;
    if (!dict || Object.keys(dict).length === 0) return 'en';
    const keys = Array.isArray(anchors) ? anchors.filter((k) => typeof k === 'string' && k) : [];
    if (keys.length && !keys.every((k) => typeof dict[k] === 'string' && dict[k].length > 0)) return 'en';
    return locale;
}

/**
 * The provider-less fallback (embeds, isolated tests): resolves against the EN
 * catalogue and interpolates exactly like the real t(). ONE module-level object,
 * so `t` keeps its identity across renders and can be a hook dependency.
 */
const NO_PROVIDER: TranslationValue = {
    t: (key, fallbackOrParams, paramsArg) => {
        const hasStringFallback = typeof fallbackOrParams === 'string';
        const params = hasStringFallback ? paramsArg : fallbackOrParams;
        let value: unknown = DEFAULTS[key];
        if (typeof value !== 'string') value = hasStringFallback ? fallbackOrParams : key;
        return interpolate(value as string, params);
    },
    locale: 'en',
    resolvedLocale: 'en',
    setLocale: () => { },
    isLoading: false,
    strings: {},
};

export function useTranslation(): TranslationValue {
    return useContext(TranslationContext) || NO_PROVIDER;
}

export default useTranslation;
