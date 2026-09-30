/**
 * Meeting-source writes: the per-meeting record switches and the imports.
 *
 * A switch flips at once (optimistic), then takes the server's EFFECTIVE
 * answer, not an echo of the request: one "off" always wins — an org-wide
 * rule, or the other id space of the same meeting — so asking for "on" can
 * come back "off". The web used to show "Record" until the next load; the
 * row here settles on what will really happen, and the screen says why.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { importFromMeet, importFromNextcloud, setMeetRecord, setTalkRecord } from '../api/endpoints';
import { sourceKeys } from '../api/keys';
import { applyRecordAnswer } from '../model/rows';
import type { MeetMeeting, MeetRecording, RecordAnswer, TalkMeeting } from '../model/types';

type WithMeetings<M> = { meetings: M[] };

function patchMeetings<M>(
    queryClient: QueryClient,
    key: readonly unknown[],
    match: (m: M) => boolean,
    change: (m: M) => M,
): void {
    queryClient.setQueryData<WithMeetings<M>>(key, (data) =>
        data ? { ...data, meetings: data.meetings.map((m) => (match(m) ? change(m) : m)) } : data,
    );
}

interface ToggleSpec<M extends TalkMeeting | MeetMeeting> {
    key: readonly unknown[];
    same: (a: M, b: M) => boolean;
    write: (m: M, record: boolean) => Promise<RecordAnswer>;
}

function useToggle<M extends TalkMeeting | MeetMeeting>(spec: ToggleSpec<M>) {
    const queryClient = useQueryClient();
    return useMutation({
        // `excluded` → the person is switching it ON.
        mutationFn: (m: M) => spec.write(m, m.excluded),
        onMutate: (m: M) => {
            patchMeetings<M>(queryClient, spec.key, (x) => spec.same(x, m), (x) => ({ ...x, excluded: !m.excluded }));
        },
        onSuccess: (answer: RecordAnswer, m: M) => {
            patchMeetings<M>(queryClient, spec.key, (x) => spec.same(x, m), (x) => applyRecordAnswer(x, answer.effectiveRecord));
        },
        // Put the list back the way the server has it.
        onError: () => void queryClient.invalidateQueries({ queryKey: spec.key }),
    });
}

export function useToggleTalkRecord() {
    return useToggle<TalkMeeting>({
        key: sourceKeys.talkMeetings,
        same: (a, b) => a.talkToken === b.talkToken,
        write: (m, record) => setTalkRecord(m.talkToken, record, m.uid),
    });
}

export function useToggleMeetRecord() {
    return useToggle<MeetMeeting>({
        key: sourceKeys.meetMeetings,
        same: (a, b) => a.eventId === b.eventId,
        write: (m, record) => setMeetRecord(m.eventId, record, m.meetingCode),
    });
}

/** A Nextcloud file (Talk recording or any audio) into Meeting Notes. */
export function useImportFromNextcloud(onDone: () => void) {
    return useMutation({
        mutationFn: ({ path, title }: { path: string; title: string }) => importFromNextcloud(path, title),
        onSuccess: onDone,
    });
}

/** A Meet recording into Meeting Notes; the recordings list learns it was imported. */
export function useImportFromMeet(onDone: () => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (recording: MeetRecording) => importFromMeet(recording),
        onSuccess: () => {
            onDone();
            void queryClient.invalidateQueries({ queryKey: sourceKeys.meetRecordings });
            void queryClient.invalidateQueries({ queryKey: sourceKeys.meetImports });
        },
    });
}
