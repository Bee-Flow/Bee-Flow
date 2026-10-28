// Manual meeting imports (Teams, Google Meet) run in the background on the
// server: POST /from-teams and /from-gmeet answer 202 { jobId } at once and the
// job row carries the outcome. This is the polling side: read the job list
// (/teams-imports, /gmeet-imports) until the job is done, failed or waiting for
// the provider.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../client';
import { importJobPhase, type MeetingImportJob } from '@/utils/meetingImportJob';

export type MeetingImportProvider = 'teams' | 'gmeet';

const IMPORT_POLL_MS = 3000;
/** A job still running after this long is reported as failed: nothing is going to finish it. */
const IMPORT_GIVE_UP_MS = 2 * 60 * 60 * 1000;

const importJobKeys = {
    job: (provider: MeetingImportProvider, jobId: string) => ['meetingImportJob', provider, jobId] as const,
};

/**
 * Poll one import job. `data` is the job, or `null` when the list no longer
 * has it. Polling stops by itself once the job is done, failed or waiting.
 * `timedOut` turns true after IMPORT_GIVE_UP_MS of polling.
 */
export function useMeetingImportJob(
    provider: MeetingImportProvider | null,
    jobId: string | null,
    { intervalMs = IMPORT_POLL_MS, giveUpMs = IMPORT_GIVE_UP_MS }: { intervalMs?: number; giveUpMs?: number } = {},
) {
    // The id the time limit ran out for; a new job id starts with a clean slate.
    const [timedOutFor, setTimedOutFor] = useState<string | null>(null);
    useEffect(() => {
        if (!jobId) return undefined;
        const timer = setTimeout(() => setTimedOutFor(jobId), giveUpMs);
        return () => clearTimeout(timer);
    }, [jobId, giveUpMs]);
    const timedOut = !!jobId && timedOutFor === jobId;

    const query = useQuery<MeetingImportJob | null, Error>({
        queryKey: importJobKeys.job(provider ?? 'teams', jobId ?? ''),
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ items?: Array<MeetingImportJob & Record<string, unknown>> }>(
                `/api/transcriptions/${provider}-imports`, { signal, retry: false },
            );
            const row = body?.items?.find((j) => j.id === jobId);
            return row
                ? { id: row.id, status: row.status, errorCode: row.errorCode ?? null, transcriptionId: row.transcriptionId ?? null }
                : null;
        },
        enabled: !!provider && !!jobId && !timedOut,
        retry: false,
        gcTime: 0,
        refetchIntervalInBackground: true,
        refetchInterval: (q) => (importJobPhase(q.state.data) === 'running' ? intervalMs : false),
    });
    return { ...query, timedOut };
}
