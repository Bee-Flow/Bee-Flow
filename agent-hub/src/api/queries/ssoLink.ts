// The sign-in providers an account can link to itself (server
// auth/oauth/ssoLinkFlow.mts): which are configured, and the address that
// starts a link. The link itself is a full-page redirect through the provider.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { fetchSetupStatus } from './coreAuthSession';

/** Providers the server links (SSO_IDENTITY_PROVIDERS); Microsoft is bound by an administrator. */
export type LinkableProvider = 'google' | 'nextcloud';

/** The configured linkable providers, from GET /auth/setup-status. */
export function useLinkableProvidersQuery() {
    return useQuery<LinkableProvider[], Error>({
        queryKey: ['auth', 'linkable-providers'],
        queryFn: async () => {
            const res = await fetchSetupStatus();
            if (!res.ok) return [];
            const data = await res.json() as { isGoogleConfigured?: boolean; isOAuthConfigured?: boolean };
            const out: LinkableProvider[] = [];
            if (data.isGoogleConfigured) out.push('google');
            if (data.isOAuthConfigured) out.push('nextcloud');
            return out;
        },
        retry: false,
        staleTime: 5 * 60_000,
    });
}

/** Where the browser goes to link `provider` to the signed-in account. */
export function linkStartUrl(provider: LinkableProvider): string {
    return `${API_BASE}/auth/login/${provider}?intent=link`;
}
