/** The short status lines under the Settings rows, and the server's host. */

import { translate } from '@/core/i18n';

/** "beeflow.nl" from "https://beeflow.nl" — the host is the recognisable part. */
export function hostOf(url: string | null): string | null {
    if (!url) return null;
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
}

/** Two-factor's state for the Security row, or nothing while it is unknown. */
export function twoFactorLabel(mfa: { enabled: boolean } | null | undefined): string | undefined {
    if (!mfa) return undefined;
    return mfa.enabled
        ? translate('mobile.settings.two_factor_on', 'Two-factor on')
        : translate('mobile.settings.two_factor_off', 'Two-factor off');
}
