/**
 * Deleting a meeting: the bare request first, `?confirm=1` only when asked.
 *
 * The server refuses every first DELETE of a meeting today (the notebook scan
 * cannot answer — see src/core/api/deleteGuard.ts), so a phone that never sent the
 * confirmation could not delete one at all, and one that always sent it would
 * skip the check the refusal exists for.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/recording/api/endpoints.test.ts
 */

import { api } from '@/core/api/client';
import { downloadToCache } from '@/core/api/downloadFile';

import {
    deleteTranscription,
    downloadMeetingAudio,
    listTranscriptions,
    listTranscriptionTags,
    reportMeetings,
    setTranscriptionTags,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { ...actual.api, delete: jest.fn(), get: jest.fn(), post: jest.fn(), patch: jest.fn() } };
});
jest.mock('@/core/api/downloadFile', () => ({ downloadToCache: jest.fn() }));

const del = api.delete as jest.Mock;

beforeEach(() => {
    del.mockReset();
    del.mockResolvedValue({ success: true });
});

describe('deleteTranscription', () => {
    it('sends the first request without a confirmation', async () => {
        await deleteTranscription('t 1');
        expect(del).toHaveBeenCalledWith('/api/transcriptions/t%201', undefined);
    });

    it('sends ?confirm=1 once the guard’s answer has been confirmed', async () => {
        await deleteTranscription('t1', { confirmedBreaking: true });
        expect(del).toHaveBeenCalledWith('/api/transcriptions/t1', { query: { confirm: '1' } });
    });
});

describe('listTranscriptions', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}`, title: `Meeting ${i + 1}` }));
    /** Pages like routes/transcriptions/notes.js: limit 50 by default, at most 100, offset. */
    const serve = (all: ReturnType<typeof rows>, { ignoreOffset = false } = {}) =>
        (api.get as jest.Mock).mockImplementation(async (_path: string, opts: { query?: { limit?: number; offset?: number } }) => {
            const limit = Math.min(opts?.query?.limit ?? 50, 100);
            const offset = ignoreOffset ? 0 : opts?.query?.offset ?? 0;
            return { transcriptions: all.slice(offset, offset + limit) };
        });

    beforeEach(() => (api.get as jest.Mock).mockReset());
    afterEach(() => (api.get as jest.Mock).mockReset());

    it('reads every page, so notes past the newest 50 reach the library', async () => {
        serve(rows(230));
        const list = await listTranscriptions();
        expect(list).toHaveLength(230);
        expect(list.map((n) => n.id)).toContain('n171');
        expect((api.get as jest.Mock).mock.calls.map((c) => c[1].query)).toEqual([
            { limit: 100, offset: 0 }, { limit: 100, offset: 100 }, { limit: 100, offset: 200 },
        ]);
    });

    it('stops on a page that adds nothing new (a server that ignores offset)', async () => {
        serve(rows(300), { ignoreOffset: true });
        expect(await listTranscriptions()).toHaveLength(100);
        expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('with a limit reads only the newest page', async () => {
        serve(rows(300));
        expect(await listTranscriptions(undefined, 100)).toHaveLength(100);
        expect(api.get).toHaveBeenCalledTimes(1);
    });
});

describe('the library calls', () => {
    it('reads the tag vocabulary', async () => {
        (api.get as jest.Mock).mockResolvedValue([{ tag: 'sales', count: 3 }]);
        expect(await listTranscriptionTags()).toEqual([{ tag: 'sales', count: 3 }]);
        expect((api.get as jest.Mock).mock.calls[0][0]).toBe('/api/transcriptions/tags');
    });

    it('replaces the tags with one PATCH', async () => {
        (api.patch as jest.Mock).mockResolvedValue({ success: true, tags: ['a'] });
        await setTranscriptionTags('m 1', ['a']);
        expect(api.patch).toHaveBeenCalledWith('/api/transcriptions/m%201', { tags: ['a'] });
    });

    it('asks for a report with the long deadline and no retry', async () => {
        (api.post as jest.Mock).mockResolvedValue({ report: '# R', usedTranscripts: true, truncatedNotes: 0 });
        expect(await reportMeetings(['a', 'b'], 'What was decided?')).toEqual({
            report: '# R',
            usedTranscripts: true,
            truncatedNotes: 0,
        });
        expect(api.post).toHaveBeenCalledWith(
            '/api/transcriptions/report',
            { ids: ['a', 'b'], prompt: 'What was decided?' },
            { retry: false, timeoutMs: 300_000 },
        );
    });

    it('downloads the audio once into a per-note cache file', async () => {
        (downloadToCache as jest.Mock).mockResolvedValue({ uri: 'file:///cache/meeting-audio-m1', contentType: null });
        expect(await downloadMeetingAudio('m1')).toBe('file:///cache/meeting-audio-m1');
        expect(downloadToCache).toHaveBeenCalledWith('/api/transcriptions/m1/audio', 'meeting-audio-m1', {
            signal: undefined,
            reuse: true,
            sessionScoped: true,
        });
    });
});
