// The three calendars the Upcoming meetings list reads (Talk, Google Meet,
// Teams), each on its own: one failing leaves the other two on screen. A row's
// record toggle writes its answer into the cached list.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { listGoogleMeetMeetings, listTalkMeetings, listTeamsMeetings } from '../transcriptionsApi';
import { READ_ONCE } from './readOnce';

/** One calendar as the list renders it: loading while a read is under way, the error of the last read, the data. */
interface SourceRead<D> {
    loading: boolean;
    error: unknown;
    data: D | null;
}

type SourceUpdate<D> = (prev: SourceRead<D>) => SourceRead<D>;

const upcomingKeys = {
    talk: ['meeting-notes', 'upcoming', 'talk'] as const,
    gmeet: ['meeting-notes', 'upcoming', 'gmeet'] as const,
    teams: ['meeting-notes', 'upcoming', 'teams'] as const,
};

function useSourceRead<D>(key: readonly string[], read: () => Promise<unknown>) {
    const qc = useQueryClient();
    const query = useQuery<D, Error>({ queryKey: key, ...READ_ONCE, queryFn: async () => (await read()) as D });
    const loading = query.isFetching || query.isPending;
    const state = useMemo<SourceRead<D>>(() => ({
        loading,
        error: loading ? null : query.error,
        data: query.data ?? null,
    }), [loading, query.error, query.data]);
    const update = useCallback((change: SourceUpdate<D>) => {
        qc.setQueryData<D>(key, (prev) => change({ loading: false, error: null, data: prev ?? null }).data ?? prev);
    }, [qc, key]);
    return [state, update, query.refetch] as const;
}

export function useUpcomingTalkMeetings<D>() { return useSourceRead<D>(upcomingKeys.talk, () => listTalkMeetings()); }
export function useUpcomingGmeetMeetings<D>() { return useSourceRead<D>(upcomingKeys.gmeet, () => listGoogleMeetMeetings()); }
export function useUpcomingTeamsMeetings<D>() { return useSourceRead<D>(upcomingKeys.teams, () => listTeamsMeetings()); }
