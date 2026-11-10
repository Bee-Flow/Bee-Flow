/**
 * The Upcoming screen's state: both providers' meetings as one list, which
 * switches are in flight, and which rows a wider rule overrode — the only case
 * in which an "off" switch needs explaining.
 */

import { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';

import { useToggleMeetRecord, useToggleTalkRecord } from './mutations';
import { useMeetMeetings, useNextcloudConnected, useTalkMeetings } from './queries';
import { upcomingRows, type UpcomingRow } from '../model/rows';
import type { RecordAnswer } from '../model/types';
import { attendeeNotices, autoRecordingHint } from '../model/upcomingMeta';

export function useUpcoming() {
    const t = useTranslation();
    const talk = useTalkMeetings();
    const meet = useMeetMeetings();
    const nextcloud = useNextcloudConnected();
    const toggleTalk = useToggleTalkRecord();
    const toggleMeet = useToggleMeetRecord();
    // Every row whose switch is in flight: two rows can be, of one provider or both.
    const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
    const [overridden, setOverridden] = useState<Record<string, boolean>>({});
    const [errors, setErrors] = useState<Record<string, unknown>>({});
    // rowKey → what the PATCH did to Meet's own auto-recording, when the person must know it.
    const [autoRecording, setAutoRecording] = useState<Record<string, string>>({});

    const rows = upcomingRows(talk.data ?? null, meet.data ?? null);
    const connection = meet.data?.connection ?? null;

    /*
     * The row's feedback hangs on this call's own promise, not on mutate()'s
     * per-call callbacks: one useMutation serves every row of a provider, and
     * a second row's mutate() detaches the first one's callbacks, so the first
     * row's "kept off by a wider rule" or its error would never show.
     */
    const toggle = (row: UpcomingRow) => {
        const rowKey = row.key;
        setBusy((prev) => new Set(prev).add(rowKey));
        setErrors(({ [rowKey]: _dropped, ...rest }) => rest);
        const write: Promise<RecordAnswer> =
            row.provider === 'talk' ? toggleTalk.mutateAsync(row.meeting) : toggleMeet.mutateAsync(row.meeting);
        write
            .then(
                (answer) => {
                    setOverridden((prev) => ({ ...prev, [rowKey]: answer.overridden }));
                    const hint = row.provider === 'gmeet' ? autoRecordingHint(answer.autoRecordingConfig, 'gmeet', t) : undefined;
                    setAutoRecording(({ [rowKey]: _old, ...rest }) => (hint ? { ...rest, [rowKey]: hint } : rest));
                },
                (err: unknown) => setErrors((prev) => ({ ...prev, [rowKey]: err })),
            )
            .finally(() =>
                setBusy((prev) => {
                    const next = new Set(prev);
                    next.delete(rowKey);
                    return next;
                }),
            );
    };

    const pull = useUserRefresh(() => {
        setOverridden({});
        setErrors({});
        setAutoRecording({});
        return Promise.all([talk.refetch(), meet.refetch(), nextcloud.refetch()]);
    });

    return {
        talk,
        meet,
        rows,
        connection,
        /** `true` only once the server said this account has Nextcloud; undefined while unknown. */
        talkConnected: nextcloud.data,
        loading: talk.isLoading || meet.isLoading,
        refreshing: pull.refreshing,
        refresh: pull.onRefresh,
        toggle,
        isBusy: (rowKey: string) => busy.has(rowKey),
        overridden,
        errors,
        autoRecording,
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
