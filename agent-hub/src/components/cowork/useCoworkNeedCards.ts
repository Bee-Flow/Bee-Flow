/**
 * Everything that waits for the owner as cards (./coworkNeedsModel.ts): "Needs you" from the server, then the desks'
 * invitations and hand-offs. Each desk is read once (the same query as the desk panel, through the shared cache), only
 * while the owner is on a desk at all. A source that cannot be read adds no cards; the others still show.
 *
 * The desks are read in ONE `useQuery` and not with `useQueries`: the latter pulls query-core's QueriesObserver into
 * this lazy chunk, and the first-load vendor-misc chunk then imports it from here, so every page would preload the
 * Cowork page (the entry bundle budget; ../admin/ai-config/providers/useAiProviderModels.ts has the same note).
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deskViewQuery, useMyDesks, type DeskView } from '@/api/coworkDesks';
import { useCoworkNeedsYou } from '@/api/coworkNeedsYou';
import { deskNeedCards, needCards, type NeedCardData } from './coworkNeedsModel';
import type { CoworkItem } from '@/api/cowork.types';

const NO_VIEWS: DeskView[] = [];

export default function useCoworkNeedCards(items: readonly CoworkItem[]): NeedCardData[] {
    const client = useQueryClient();
    const needs = useCoworkNeedsYou().data;
    const desks = useMyDesks().data;
    const ids = useMemo(() => (desks ?? []).map((d) => d.id), [desks]);
    const views = useQuery({
        queryKey: ['cowork', 'desks', 'views', ids],  // under the desks key, so every desk change reads it again
        enabled: ids.length > 0,
        retry: false,
        queryFn: async () => {
            const read = await Promise.all(ids.map((id) => client.fetchQuery(deskViewQuery(id)).catch(() => null)));
            return read.filter((v): v is DeskView => !!v);
        },
    }).data ?? NO_VIEWS;
    return useMemo(() => [...needCards(needs ?? [], items), ...deskNeedCards(views)], [needs, items, views]);
}
