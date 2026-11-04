// Reading the job row of a background meeting import (Teams, Google Meet).
// Pure, so effects and components can call it without touching the network.

export interface MeetingImportJob {
    id: string;
    status: string;
    errorCode: string | null;
    transcriptionId: string | null;
}

/**
 * running  the server is importing (or about to), also when it retries an
 *          attempt that failed: a `pending` row is still in the queue, and its
 *          `errorCode` only counts the attempts
 * waiting  the provider has not finished the recording yet; the server keeps checking
 * done     the note exists (`transcriptionId`)
 * failed   `errorCode` says why
 */
export type MeetingImportPhase = 'running' | 'waiting' | 'done' | 'failed';

/** `undefined` is "not read yet" (running), `null` is "the list no longer has the job" (failed). */
export function importJobPhase(job: MeetingImportJob | null | undefined): MeetingImportPhase {
    if (job === undefined) return 'running';
    if (job === null) return 'failed';
    if (job.transcriptionId || job.status === 'ingested') return 'done';
    // Status first: a terminal failure moves the row out of `pending` (to its
    // error code, `skipped`, `needs_reauth`, ...), a retry keeps it there.
    if (job.status === 'awaiting_artifacts') return 'waiting';
    if (job.status === 'pending') return 'running';
    return 'failed';
}
