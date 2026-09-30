/**
 * The interface-language choice on this device: null resolves it (the
 * organisation's default, else the phone's language). Stored locally by
 * core/i18n, like the web's `beeflow_locale` in localStorage — there is no
 * per-user locale column on the server to sync it to.
 *
 * Choosing re-resolves at once: the resolved locale is cached for good
 * (useAccountLocale), so the choice invalidates it and <LocaleSync> installs
 * the new catalogue.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { setStoredLocale, storedLocale } from '@/core/i18n';

import { settingsKeys } from '../api/keys';

export function useLocalePreference() {
    const queryClient = useQueryClient();
    const [preference, setPreference] = useState<string | null>(null);
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        void storedLocale().then((code) => {
            setPreference(code);
            setHydrated(true);
        });
    }, []);

    const choose = async (code: string | null) => {
        setPreference(code);
        await setStoredLocale(code);
        await queryClient.invalidateQueries({ queryKey: settingsKeys.resolvedLocales });
    };

    return { preference, hydrated, choose };
}
