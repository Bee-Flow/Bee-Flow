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

    it('a retry after a failure follows the new attempt, not the failed row it got the same job id for', async () => {
        // The server reuses the job row on a retry: the second 202 carries the same id.
        let attempt = 1;
        let pollsAfterRetry = 0;
        fetchMock.mockImplementation(async (url: string) => {
            if (String(url).includes('/from-teams')) return json(202, { jobId: 'j1', status: 'pending' });
            if (attempt === 1) return jobs({ id: 'j1', status: 'failed', errorCode: 'graph_error', transcriptionId: null });
            pollsAfterRetry += 1;
            return pollsAfterRetry < 2
                ? jobs({ id: 'j1', status: 'pending', errorCode: null, transcriptionId: null })
                : jobs({ id: 'j1', status: 'ingested', errorCode: null, transcriptionId: 'n2' });
        });
        mount();
        let first: Promise<UploadOutcome> | undefined;
        act(() => { first = recorder.importFromTeams({ eventId: 'e1' }); });
        expect((await first)?.ok).toBe(false);

        attempt = 2;
        let second: Promise<UploadOutcome> | undefined;
        act(() => { second = recorder.importFromTeams({ eventId: 'e1' }); });
        const result = await second;
        expect(result).toMatchObject({ ok: true, result: { id: 'n2' } });
        expect(pollsAfterRetry).toBeGreaterThanOrEqual(2);
        await waitFor(() => expect(recorder.uploading).toBe(false));
        expect(recorder.consumeLastResult().id).toBe('n2');
    }, 15000);
});

describe('the language of a manual Teams / Meet import', () => {
    const bodyOf = (path: string) => {
        const call = fetchMock.mock.calls.filter(([url]) => String(url).includes(path)).at(-1);
        return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body ?? '{}')) as Record<string, unknown>;
    };
    beforeEach(() => { fetchMock.mockImplementation(async () => json(201, { id: 'n1' })); });

    it('is left to the Teams / Meet notes settings while the user has not picked one', async () => {
        mount();
        await act(async () => { await recorder.importFromTeams({ eventId: 'e1' }); });
        expect(bodyOf('/from-teams')).not.toHaveProperty('language');
        await act(async () => { await recorder.importFromGoogleMeet({ eventId: 'e2' }); });
        expect(bodyOf('/from-gmeet')).not.toHaveProperty('language');
    });

    it('is the capture language once the user picked one', async () => {
        mount();
        act(() => { recorder.setSettings((s) => ({ ...s, language: 'en' })); });
        await act(async () => { await recorder.importFromTeams({ eventId: 'e1' }); });
        expect(bodyOf('/from-teams').language).toBe('en');
        await act(async () => { await recorder.importFromGoogleMeet({ eventId: 'e2' }); });
        expect(bodyOf('/from-gmeet').language).toBe('en');
    });
});
