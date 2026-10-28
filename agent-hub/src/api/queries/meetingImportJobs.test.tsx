import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';
import { useMeetingImportJob } from './meetingImportJobs';
import { importJobPhase, type MeetingImportJob } from '@/utils/meetingImportJob';

const fetchMock = vi.fn();

const job = (over: Partial<MeetingImportJob> = {}): MeetingImportJob => ({ id: 'j1', status: 'pending', errorCode: null, transcriptionId: null, ...over });
const listOf = (...items: MeetingImportJob[]) => ({ ok: true, status: 200, json: async () => ({ items }), text: async () => JSON.stringify({ items }), headers: new Headers({ 'content-type': 'application/json' }) });

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('importJobPhase', () => {
    it('reads the job row', () => {
        expect(importJobPhase(job())).toBe('running');
        expect(importJobPhase(job({ status: 'awaiting_artifacts' }))).toBe('waiting');
        expect(importJobPhase(job({ status: 'ingested', transcriptionId: 'n1' }))).toBe('done');
        expect(importJobPhase(job({ status: 'no_recording', errorCode: 'no_recording' }))).toBe('failed');
        expect(importJobPhase(job({ status: 'pending', errorCode: 'failed' }))).toBe('failed');
        expect(importJobPhase(null)).toBe('failed');
        expect(importJobPhase(undefined)).toBe('running');
    });
});

describe('useMeetingImportJob', () => {
    it('polls the job list until the job is done, then stops', async () => {
        fetchMock
            .mockResolvedValueOnce(listOf(job()))
            .mockResolvedValueOnce(listOf(job()))
            .mockResolvedValue(listOf(job({ status: 'ingested', transcriptionId: 'n1' })));
        const { result } = renderHook(() => useMeetingImportJob('teams', 'j1', { intervalMs: 10 }), { wrapper: queryWrapper() });
        await waitFor(() => expect(importJobPhase(result.current.data)).toBe('done'));
        expect(result.current.data?.transcriptionId).toBe('n1');
        const calls = fetchMock.mock.calls.length;
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/transcriptions/teams-imports');
        await new Promise((r) => setTimeout(r, 60));
        expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it('stops on a failed job and exposes the error code', async () => {
        fetchMock.mockResolvedValue(listOf(job({ status: 'recording_too_large', errorCode: 'recording_too_large' })));
        const { result } = renderHook(() => useMeetingImportJob('gmeet', 'j1', { intervalMs: 10 }), { wrapper: queryWrapper() });
        await waitFor(() => expect(importJobPhase(result.current.data)).toBe('failed'));
        expect(result.current.data?.errorCode).toBe('recording_too_large');
        const calls = fetchMock.mock.calls.length;
        await new Promise((r) => setTimeout(r, 60));
        expect(fetchMock.mock.calls.length).toBe(calls);
        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/transcriptions/gmeet-imports');
    });

    it('stops while Teams is still processing the recording', async () => {
        fetchMock.mockResolvedValue(listOf(job({ status: 'awaiting_artifacts' })));
        const { result } = renderHook(() => useMeetingImportJob('teams', 'j1', { intervalMs: 10 }), { wrapper: queryWrapper() });
        await waitFor(() => expect(importJobPhase(result.current.data)).toBe('waiting'));
        const calls = fetchMock.mock.calls.length;
        await new Promise((r) => setTimeout(r, 60));
        expect(fetchMock.mock.calls.length).toBe(calls);
    });

    it('gives up after the time limit instead of polling for ever', async () => {
        fetchMock.mockResolvedValue(listOf(job()));
        const { result } = renderHook(() => useMeetingImportJob('teams', 'j1', { intervalMs: 10, giveUpMs: 80 }), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.timedOut).toBe(true));
        const calls = fetchMock.mock.calls.length;
        await new Promise((r) => setTimeout(r, 60));
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(calls + 1);
    });

    it('does nothing without a job id', async () => {
        renderHook(() => useMeetingImportJob('teams', null), { wrapper: queryWrapper() });
        await new Promise((r) => setTimeout(r, 30));
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
