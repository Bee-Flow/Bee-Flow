/**
 * Small per-device preferences that have no server counterpart.
 *
 * The language choice is one of them, and deliberately so: the web app stores
 * its locale in `localStorage` under `beeflow_locale` (agent-hub's
 * useTranslation hook) — there is no per-user locale column and no endpoint to
 * write one. `/api/languages/user/locales` lists what the WORKSPACE has
 * configured and marks the org default; which one a given person reads in is a
 * client-side choice on both platforms.
 *
 * Keeping the two apps consistent matters more than centralising the value
 * would: a setting that syncs on one client and not the other is worse than
 * one that honestly never syncs.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const LOCALE_KEY = 'beeflow.locale';

/** The stored language code, or null to follow the phone's own language. */
export async function loadLocalePreference(): Promise<string | null> {
    try {
        return await AsyncStorage.getItem(LOCALE_KEY);
    } catch {
        return null;
    }
}

export async function saveLocalePreference(code: string | null): Promise<void> {
    try {
        if (code) await AsyncStorage.setItem(LOCALE_KEY, code);
        else await AsyncStorage.removeItem(LOCALE_KEY);
    } catch {
        // A preference that fails to persist still applies for this launch;
        // it is not worth interrupting the user over.
    }
}
