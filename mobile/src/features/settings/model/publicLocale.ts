/**
 * The language the sign-in screens speak, before there is a session.
 *
 * The account's catalogue (/api/languages/user/strings) needs a session, so
 * until sign-in the phone used to render English to a Dutch colleague whose
 * browser, on the same server, showed the web's login in Dutch. The web gets
 * there through two public endpoints (agent-hub useTranslation, the pre-auth
 * probe); this is the phone's port of that step.
 *
 * Resolution is the signed-in order with the one input a session provides
 * swapped out. The organisation's default is not served without a session, so
 * its place is taken by the locale this phone last rendered: that is what the
 * account resolved to the last time someone was signed in here, so the login
 * after a sign-out (or on the MFA step) stays in the language the app will be
 * in a moment later, rather than flipping to the phone's language and back. A
 * fresh install has rendered nothing, and falls through to the phone.
 */

import type { AuthStage } from '@/core/auth/types';
import { resolveLocale, type Catalogue } from '@/core/i18n';

export interface PublicCatalogue {
    locale: string;
    strings: Catalogue;
}

export interface PublicCatalogueSources {
    /** What the person chose on the Language screen, if anything. */
    stored: string | null;
    /** The locale this phone last rendered; null on a fresh install. */
    lastRendered: string | null;
    /** The phone's language as a bare code. */
    device: string;
    listLocales: () => Promise<readonly { code: string }[]>;
    /** Null when the server has no strings for that locale (a 404). */
    fetchStrings: (locale: string) => Promise<Catalogue | null>;
}

/** English carries its own words: every `t()` has them as its fallback. */
const ENGLISH: PublicCatalogue = { locale: 'en', strings: {} };

/**
 * The stages that render before a full session, where only the public
 * catalogue can be fetched.
 *
 * Left out on purpose: `loading` (nothing is known yet), `needs-server` (no
 * server to ask — the cached catalogue is all there is), `unreachable` (the
 * server cannot be asked), `locked` (a signed-in user's lock screen; the cached
 * catalogue IS the account's, and re-resolving without the organisation's
 * default could only get it wrong), and `signed-in`, which has its own.
 */
const PRE_LOGIN: ReadonlySet<AuthStage['kind']> = new Set<AuthStage['kind']>([
    'signed-out',
    'mfa-required',
    'mfa-setup-required',
    'email-verification-required',
    'encryption-setup-required',
    'encryption-pin-required',
    'pending-approval',
]);

export function wantsPublicCatalogue(stage: AuthStage['kind']): boolean {
    return PRE_LOGIN.has(stage);
}

/**
 * Which locale to render and its strings, or null for "no answer": leave
 * whatever is on screen (the cached catalogue) alone.
 *
 * The server always lists English, Dutch, German and French at least
 * (languageStore seeds them), so an empty list is not the server's answer —
 * it is a captive portal's page or a proxy's, and it must not install English
 * over a catalogue that was right.
 */
export async function loadPublicCatalogue(sources: PublicCatalogueSources): Promise<PublicCatalogue | null> {
    const available = (await sources.listLocales()).map((l) => l.code).filter(Boolean);
    if (available.length === 0) return null;
    const locale = resolveLocale({
        stored: sources.stored,
        orgDefault: sources.lastRendered,
        device: sources.device,
        available,
    });
    if (locale === 'en') return ENGLISH;
    const strings = await sources.fetchStrings(locale);
    // Listed a moment ago and gone now: the server has no strings for it, so English.
    return strings ? { locale, strings } : ENGLISH;
}
