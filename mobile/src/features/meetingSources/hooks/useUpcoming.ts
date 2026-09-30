/**
 * The Upcoming screen's state: both providers' meetings as one list, which
 * switch is in flight, and which rows a wider rule overrode — the only case
 * in which an "off" switch needs explaining.
 */

import { useState } from 'react';

import { useUserRefresh } from '@/shared/patterns';

import { useToggleMeetRecord, useToggleTalkRecord } from './mutations';
import { useMeetMeetings, useTalkMeetings } from './queries';
import { upcomingRows, type UpcomingRow } from '../model/rows';
import type { RecordAnswer } from '../model/types';
import { attendeeNotices } from '../model/upcomingMeta';

export function useUpcoming() {
    const talk = useTalkMeetings();
    const meet = useMeetMeetings();
    const toggleTalk = useToggleTalkRecord();
    const toggleMeet = useToggleMeetRecord();
    const [busy, setBusy] = useState<string | null>(null);
    const [overridden, setOverridden] = useState<Record<string, boolean>>({});
    const [errors, setErrors] = useState<Record<string, unknown>>({});

    const rows = upcomingRows(talk.data ?? null, meet.data ?? null);
    const connection = meet.data?.connection ?? null;

    const toggle = (row: UpcomingRow) => {
        setBusy(row.key);
        setErrors(({ [row.key]: _dropped, ...rest }) => rest);
        const handlers = {
            onSuccess: (answer: RecordAnswer) => setOverridden((prev) => ({ ...prev, [row.key]: answer.overridden })),
            onError: (err: unknown) => setErrors((prev) => ({ ...prev, [row.key]: err })),
            onSettled: () => setBusy(null),
        };
        if (row.provider === 'talk') toggleTalk.mutate(row.meeting, handlers);
        else toggleMeet.mutate(row.meeting, handlers);
    };

    const pull = useUserRefresh(() => {
        setOverridden({});
        setErrors({});
        return Promise.all([talk.refetch(), meet.refetch()]);
    });

    return {
        talk,
        meet,
        rows,
        connection,
        loading: talk.isLoading || meet.isLoading,
        refreshing: pull.refreshing,
        refresh: pull.onRefresh,
        toggle,
        busy,
        overridden,
        errors,
        notices: attendeeNotices({
            rows: rows.map((r) => ({
                provider: r.provider,
                status: r.status,
                organizerSelf: r.provider === 'gmeet' ? r.meeting.organizerSelf : undefined,
            })),
            postSummaryBack: talk.data?.postSummaryBack,
            // Can THIS switch turn on Meet's own auto-recording? Only then may
            // the sentence about Meet's recording announcement appear.
            meetAutoRecordArmed: meet.data?.autoRecordConfig === true && connection?.hasSettingsScope === true,
        }),
    };
}

export type Upcoming = ReturnType<typeof useUpcoming>;
