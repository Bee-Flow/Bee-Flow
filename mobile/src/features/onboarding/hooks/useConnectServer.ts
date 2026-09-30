/**
 * Choosing a server, with the two rules the first screen enforces rather than
 * trusts:
 *
 *   1. Nothing is remembered until /api/health has answered. Storing an
 *      unverified URL means every later failure — a login that hangs, a chat
 *      that will not load — presents as a bug in the app rather than as a typo.
 *   2. Cleartext to a public host is refused unless the user says so in as
 *      many words. `http://` on 192.168.x.x is a self-hoster on their own LAN;
 *      `http://` on a public name is a password sent in the clear to whoever
 *      is on the path, and this is a privacy product.
 */

import { useState } from 'react';

import { checkHealth, isInsecure, isPrivateHost, normaliseServerUrl } from '@/core/api/server';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';

/** What the address field shows as an example, and the error names. A host name, not words. */
export const EXAMPLE_HOST = 'beeflow.example.com';

export function useConnectServer() {
    const { chooseServer } = useAuth();
    const t = useTranslation();
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** A normalised cleartext URL awaiting an explicit "yes, I mean it". */
    const [insecureUrl, setInsecureUrl] = useState<string | null>(null);

    const connect = async (raw: string, allowInsecure = false) => {
        setError(null);
        setInsecureUrl(null);

        const url = normaliseServerUrl(raw);
        if (!url) {
            setError(
                t(
                    'mobile.onboarding.server_not_address',
                    'That does not look like a web address. Try something like {example}.',
                    { example: EXAMPLE_HOST },
                ),
            );
            return;
        }
        if (isInsecure(url) && !isPrivateHost(url) && !allowInsecure) {
            setInsecureUrl(url);
            return;
        }

        setChecking(true);
        try {
            const health = await checkHealth(url);
            if (!health.ok) {
                setError(health.error ?? t('mobile.onboarding.server_no_answer', 'That address did not answer.'));
                return;
            }
            // Only now is it worth remembering. chooseServer persists it and
            // re-resolves the auth stage, which moves the user on.
            await chooseServer(url);
        } finally {
            setChecking(false);
        }
    };

    return { checking, error, insecureUrl, connect, dismissInsecure: () => setInsecureUrl(null) };
}
