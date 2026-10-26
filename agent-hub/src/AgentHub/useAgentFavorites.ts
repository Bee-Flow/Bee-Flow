import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useCacheSetter } from './useCacheState';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAgentFavorites, postAgentFavoritesBulk } from '../api/queries/hubDataFetches';
import { hubKeys } from '../api/queries/hubData';
import scopedStorage from '../utils/scopedStorage';

const NO_FAVORITES: string[] = [];

/**
 * The user's favourite agent ids, read per user.
 *
 * The server answer renders as soon as it lands. If this browser still holds
 * the legacy local list and the server has none, the migration (one POST of the
 * local list) runs after that answer: it must NOT block first paint, and a
 * failed migration silently leaves the server answer on screen (it is still
 * correct). `setFavorites` writes the query cache, so the toggle's optimistic
 * update and its rollback edit the same copy.
 */
export default function useAgentFavorites(userId: string | undefined): {
    favorites: string[];
    setFavorites: Dispatch<SetStateAction<string[]>>;
} {
    const queryClient = useQueryClient();
    const key = hubKeys.favorites(userId);
    const query = useQuery<string[]>({
        queryKey: key,
        enabled: !!userId,
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            // React runs child effects before the parent's, so the app shell may
            // not have set the current user yet. Setting it here is idempotent.
            if (userId) scopedStorage.setCurrentUser(userId);
            try {
                const res = await fetchAgentFavorites();
                if (!res.ok) return NO_FAVORITES;
                const serverFavs = await res.json();
                // A legacy local list the server does not need is dropped here;
                // one it does need stays until the migration below succeeds.
                const legacy = scopedStorage.getJSON<string[]>('agentFavorites', null);
                if (Array.isArray(legacy) && !(legacy.length && Array.isArray(serverFavs) && serverFavs.length === 0)) {
                    scopedStorage.removeItem('agentFavorites');
                }
                return Array.isArray(serverFavs) ? serverFavs : NO_FAVORITES;
            } catch (e) {
                console.warn('[AgentHub] Failed to load agent favorites from server:', e);
                return NO_FAVORITES;
            }
        },
    });

    const migrate = useMutation({
        mutationFn: async (legacy: string[]) => {
            const res = await postAgentFavoritesBulk(legacy);
            if (!res.ok) return null;
            const merged = await res.json();
            return Array.isArray(merged) ? merged as string[] : NO_FAVORITES;
        },
        onSuccess: (merged) => {
            if (!merged) return;
            queryClient.setQueryData<string[]>(key, merged);
            scopedStorage.removeItem('agentFavorites');
        },
        onError: (e) => console.warn('[AgentHub] favorites migration failed:', e),
    });
    const { mutate: runMigration } = migrate;
    const migrated = useRef(false);
    const answered = query.isSuccess ? query.data : null;
    useEffect(() => {
        if (!answered || answered.length > 0 || migrated.current) return;
        const legacy = scopedStorage.getJSON<string[]>('agentFavorites', null);
        if (!Array.isArray(legacy) || legacy.length === 0) return;
        migrated.current = true;
        runMigration(legacy);
    }, [answered, runMigration]);

    const setFavorites = useCacheSetter<string[]>('favorites', userId ?? null, NO_FAVORITES);
    return { favorites: query.data ?? NO_FAVORITES, setFavorites };
}
