/**
 * Everything that waits for the owner as cards (./coworkNeedsModel.ts): "Needs you" from the server, then the desks'
 * invitations and hand-offs. Each desk is read once (the same query as the desk panel), only while the owner is on a
 * desk at all. A source that cannot be read adds no cards; the others still show.
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { deskViewQuery, useMyDesks, type DeskView } from '@/api/coworkDesks';
import { useCoworkNeedsYou } from '@/api/coworkNeedsYou';
import { deskNeedCards, needCards, type NeedCardData } from './coworkNeedsModel';
import type { CoworkItem } from '@/api/cowork.types';

export default function useCoworkNeedCards(items: readonly CoworkItem[]): NeedCardData[] {
    const needs = useCoworkNeedsYou().data;
    const desks = useMyDesks().data;
    const views = useQueries({
        queries: (desks ?? []).map((d) => deskViewQuery(d.id)),
        combine: (results) => results.map((r) => r.data as DeskView | undefined).filter((v): v is DeskView => !!v),
    });
    return useMemo(() => [...needCards(needs ?? [], items), ...deskNeedCards(views)], [needs, items, views]);
}
