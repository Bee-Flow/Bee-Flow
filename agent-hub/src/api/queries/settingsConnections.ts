// The named-connections list (Settings → Connections): the connections the
// person owns plus the grants they lent out. A failed connections list throws
// (the card shows the server's error text with a retry, never "No named
// connections yet", which would read as "your credentials are gone"); a failed
// grants list is just empty. An empty `message` means the answer carried no
// error text: the card then shows its own, translated fallback.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

const connectionsKeys = {
    list: ['settings', 'named-connections'] as const,
};

const CONNECTIONS_URL = `${API_BASE}/api/integrations/connections`;

export function useNamedConnections<C, G>() {
    return useQuery<{ connections: C[]; grants: G[] }, Error>({
        queryKey: connectionsKeys.list,
        queryFn: async () => {
            try {
                const [cRes, gRes] = await Promise.all([
                    authFetch(CONNECTIONS_URL),
                    authFetch(`${CONNECTIONS_URL}/grants?mine=outgoing`),
                ]);
                if (!cRes.ok) {
                    let message = '';
                    try {
                        const body = await cRes.json();
                        if (body && typeof body.error === 'string') message = body.error;
                    } catch { /* empty or non-JSON body */ }
                    throw new Error(message);
                }
                const c = await cRes.json();
                const g = gRes.ok ? await gRes.json() : { grants: [] };
                return { connections: c.connections || [], grants: g.grants || [] };
            } catch (e) {
                console.error('[ConnectionsManager]', e);
                throw e;
            }
        },
        staleTime: 0,
        retry: false,
    });
}
