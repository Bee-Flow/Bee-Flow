// The icon packs (GET /api/icons): the list with every pack's icons, the active
// pack id and the catalogue's categories. The appearance editors read it, and
// the icon provider reads it once per pack it switches to (its own key, so a
// switch asks again). The body is read whatever the status, as the editors
// always did: an error body is a list without packs.

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../typedRequest';
import { READ_ONCE } from './readOnce';

export interface IconPackList<P, C> {
    packs?: P[];
    activeIconPackId?: string | null;
    categories?: C[];
}

export const iconPackKeys = {
    all: ['icons', 'packs'] as const,
    /** The editors' list. */
    list: () => [...iconPackKeys.all, 'list'] as const,
    /** The provider's read for one active pack. */
    forPack: (packId: string) => [...iconPackKeys.all, 'for', packId] as const,
};

async function readIconPacks<P, C>(): Promise<IconPackList<P, C>> {
    const res = await apiFetch('GET /api/icons');
    return (await res.json()) as IconPackList<P, C>;
}

/** The editors' pack list; a network failure (or an unreadable body) is the query's error. */
export function useIconPackListQuery<P, C = unknown>() {
    return useQuery<IconPackList<P, C>, Error>({
        queryKey: iconPackKeys.list(),
        ...READ_ONCE,
        queryFn: () => readIconPacks<P, C>(),
    });
}
