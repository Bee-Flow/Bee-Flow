/**
 * Before sign-in, fetch the server's public catalogue and install it, so the
 * sign-in screens speak the person's language (model/publicLocale.ts says
 * which one).
 *
 * An effect rather than a query, because the answer is not rendered — it is
 * installed into the i18n store — and because the rule that matters is about
 * WHEN it may land: never after the stage has become signed-in, whose own
 * catalogue must win. Turning `active` off aborts the fetch and drops its
 * result, which no cached query answer could promise. It runs again when the
 * server changes or a sign-out brings the login back.
 *
 * Any failure (offline, a captive portal, an old server) leaves the cached
 * catalogue on screen: that is the right language more often than English is.
 */

import { useEffect } from 'react';

import { getServerUrl } from '@/core/api/server';
import { deviceLocale, ensureHydrated, renderedLocale, setCatalogue, storedLocale } from '@/core/i18n';

import { getPublicLocaleStrings, listPublicLocales } from '../api/endpoints';
import { loadPublicCatalogue } from '../model/publicLocale';

async function install(signal: AbortSignal): Promise<void> {
    // A cached catalogue read off disk after this one landed would put the
    // older copy back; hydrating first rules that out.
    await ensureHydrated();
    const result = await loadPublicCatalogue({
        stored: await storedLocale(),
        lastRendered: await renderedLocale(),
        device: deviceLocale(),
        listLocales: () => listPublicLocales(signal),
        fetchStrings: (locale) => getPublicLocaleStrings(locale, signal),
    });
    if (result && !signal.aborted) setCatalogue(result.locale, result.strings);
}

/** `active`: the stage is one before a full session (`wantsPublicCatalogue`). */
export function usePublicCatalogue(active: boolean): void {
    // Read on every render: the stage changes right after a server is chosen,
    // so the render that turns this on already sees the new address.
    const server = getServerUrl();

    useEffect(() => {
        if (!active || !server) return;
        const controller = new AbortController();
        install(controller.signal).catch(() => undefined);
        return () => controller.abort();
    }, [active, server]);
}
