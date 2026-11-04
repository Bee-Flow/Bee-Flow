import { describe, expect, it } from 'vitest';
import { importJobPhase, type MeetingImportJob } from './meetingImportJob';

const job = (over: Partial<MeetingImportJob> = {}): MeetingImportJob => ({ id: 'j1', status: 'pending', errorCode: null, transcriptionId: null, ...over });

describe('importJobPhase', () => {
    it('keeps following a job the server queued for a retry after a failed attempt', () => {
        expect(importJobPhase(job({ status: 'pending', errorCode: 'failed' }))).toBe('running');
    });

    it('waits on the provider even when an earlier attempt left an error code', () => {
        expect(importJobPhase(job({ status: 'awaiting_artifacts', errorCode: 'failed' }))).toBe('waiting');
    });

    it('reports a failure once the row has left the queue', () => {
        expect(importJobPhase(job({ status: 'failed', errorCode: 'failed' }))).toBe('failed');
        expect(importJobPhase(job({ status: 'skipped', errorCode: 'failed' }))).toBe('failed');
        expect(importJobPhase(job({ status: 'needs_reauth', errorCode: 'needs_reauth' }))).toBe('failed');
        expect(importJobPhase(job({ status: 'recording_too_large', errorCode: 'recording_too_large' }))).toBe('failed');
    });

    it('reports done as soon as the note exists', () => {
        expect(importJobPhase(job({ status: 'pending', errorCode: 'failed', transcriptionId: 'n1' }))).toBe('done');
    });
});
