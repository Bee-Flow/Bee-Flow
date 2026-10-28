import { act, render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';

const fetchMock = vi.fn();

import { RecorderProvider, useRecorder, type RecorderValue, type UploadOutcome } from './RecorderContext';

const json = (status: number, body: unknown) => ({
    ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});
const jobs = (...items: Array<Record<string, unknown>>) => json(200, { items });

let recorder: RecorderValue;
function Probe() { recorder = useRecorder(); return null; }
function mount() {
    const Wrapper = queryWrapper();
    render(<Wrapper><RecorderProvider><Probe /></RecorderProvider></Wrapper>);
}

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('a Teams import answered with 202', () => {
    it('shows the importing state, polls the job, and finishes with the note when it is ingested', async () => {
        let polls = 0;
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/from-teams')) return json(202, { jobId: 'j1', status: 'pending' });
            polls += 1;
            return polls < 3
                ? jobs({ id: 'j1', status: 'pending', errorCode: null, transcriptionId: null })
                : jobs({ id: 'j1', status: 'ingested', errorCode: null, transcriptionId: 'n1' });
        });
        mount();
        let outcome: Promise<UploadOutcome> | undefined;
        act(() => { outcome = recorder.importFromTeams({ eventId: 'e1' }, { language: 'nl' }); });
        await waitFor(() => expect(recorder.uploading).toBe(true));
        await waitFor(() => expect(recorder.uploadStage).toMatch(/Importing the meeting/));
        const result = await outcome;
        expect(result?.ok).toBe(true);
        expect(result?.result?.id).toBe('n1');
        await waitFor(() => expect(recorder.uploading).toBe(false));
        expect(recorder.consumeLastResult().id).toBe('n1');
        expect(polls).toBeGreaterThanOrEqual(3);
    }, 15000);

    it('a failed job ends the import with the classified message, not an HTTP status', async () => {
        fetchMock.mockImplementation(async (url: string) => (String(url).includes('/from-teams')
            ? json(202, { jobId: 'j1', status: 'pending' })
            : jobs({ id: 'j1', status: 'recording_too_large', errorCode: 'recording_too_large', transcriptionId: null })));
        mount();
        let outcome: Promise<UploadOutcome> | undefined;
        act(() => { outcome = recorder.importFromTeams({ eventId: 'e1' }); });
        const result = await outcome;
        expect(result?.ok).toBe(false);
        expect((result?.error as Error).message).toBe('The recording is too large to import.');
        await waitFor(() => expect(recorder.uploadError).toBeTruthy());
        expect(recorder.uploading).toBe(false);
    }, 15000);

    it('a job still waiting for Teams ends as pending', async () => {
        fetchMock.mockImplementation(async (url: string) => (String(url).includes('/from-teams')
            ? json(202, { jobId: 'j1', status: 'pending' })
            : jobs({ id: 'j1', status: 'awaiting_artifacts', errorCode: null, transcriptionId: null })));
        mount();
        let outcome: Promise<UploadOutcome> | undefined;
        act(() => { outcome = recorder.importFromTeams({ eventId: 'e1' }); });
        const result = await outcome;
        expect(result).toMatchObject({ ok: false, pending: true });
    }, 15000);
});
