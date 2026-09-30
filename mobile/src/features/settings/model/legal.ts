/**
 * The publisher's privacy policy, as stamped into the build by app.config.ts
 * (`extra.privacyPolicyUrl`, from BEEFLOW_PRIVACY_POLICY_URL). Google Play
 * wants it reachable inside the app, not only on the store listing.
 *
 * Only an https:// address is returned: the row opens it in a browser tab, and
 * a policy served over plain http (or a typo that is not a URL at all) is
 * better hidden than shown broken.
 */

import Constants from 'expo-constants';

export function privacyPolicyUrl(extra: unknown = Constants.expoConfig?.extra): string | null {
    const raw = (extra as { privacyPolicyUrl?: unknown } | null | undefined)?.privacyPolicyUrl;
    if (typeof raw !== 'string') return null;
    const url = raw.trim();
    return /^https:\/\/[^\s/]+\.[^\s]+$/i.test(url) ? url : null;
}
