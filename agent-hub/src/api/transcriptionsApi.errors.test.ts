// @vitest-environment node
/**
 * What the user is told when an upload is refused.
 *
 * A 413 is normally produced by the reverse proxy, not the API, so the
 * response has no JSON body — the error panel showed "HTTP 413" and nothing
 * else: no cause, no way forward, and a "Retry" button that could only fail
 * the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(), isDemoMode: () => false }));

import { uploadAudio, getTranscription, listTranscriptions } from './transcriptionsApi';
import { authFetch } from '../utils/helpers';
import { asMock } from '@/test/mocks';

/** A proxy rejection: HTML body, so `res.json()` throws. */
const proxyRejection = (status: number) => ({
    ok: false,
    status,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
});

const apiError = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const upload = () => uploadAudio({ file: new File(['x'], 'recording.webm'), language: 'nl', title: 'Meeting' });

describe('upload errors', () => {
    beforeEach(() => vi.clearAllMocks());

    it('explains a bodyless 413 instead of surfacing "HTTP 413"', async () => {
        asMock(authFetch).mockResolvedValue(proxyRejection(413));
        const err = await upload().catch((e) => e);
        expect(err.status).toBe(413);
        expect(err.code).toBe('payload_too_large');
        expect(err.message).not.toBe('HTTP 413');
        expect(err.message).toMatch(/too large/i);
        // Both ways out: shorten the recording, or have the limit raised.
        expect(err.message).toMatch(/shorter/i);
        expect(err.message).toMatch(/administrator/i);
    });

    it('prefers the API\'s own 413 message over the generic one', async () => {
        asMock(authFetch).mockResolvedValue(apiError(413, { error: 'File too large. Maximum size is 500 MB.', code: 'recording_too_large' }));
        const err = await upload().catch((e) => e);
        expect(err.message).toBe('File too large. Maximum size is 500 MB.');
        expect(err.code).toBe('recording_too_large');
    });

    it('leaves other bodyless failures alone', async () => {
        asMock(authFetch).mockResolvedValue(proxyRejection(502));
        const err = await getTranscription('m1').catch((e) => e);
        expect(err.message).toBe('HTTP 502');
        expect(err.code).toBeUndefined();
    });
});

describe('upload attempt id', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sends client_upload_id when the attempt has one, so a repeated POST dedups', async () => {
        asMock(authFetch).mockResolvedValue({ ok: true, status: 202, json: async () => ({ id: 't1' }) });
        await uploadAudio({ file: new File(['x'], 'recording.webm'), language: 'nl', title: 'Meeting', clientUploadId: 'attempt-1234' });
        const body = asMock(authFetch).mock.calls[0][1].body as FormData;
        expect(body.get('client_upload_id')).toBe('attempt-1234');
    });

    it('sends none without one', async () => {
        asMock(authFetch).mockResolvedValue({ ok: true, status: 202, json: async () => ({ id: 't1' }) });
        await upload();
        const body = asMock(authFetch).mock.calls[0][1].body as FormData;
        expect(body.has('client_upload_id')).toBe(false);
    });
});

type Row = { id: string; title: string };

/** A server that pages like routes/transcriptions/notes.js: limit 50 by default, capped at 100. */
function pagingServer(rows: Row[], { ignoreOffset = false } = {}) {
    return async (url: string) => {
        const q = new URL(url, 'http://x').searchParams;
        const limit = Math.min(Number(q.get('limit') ?? 50), 100);
        const offset = ignoreOffset ? 0 : Number(q.get('offset') ?? 0);
        const page = rows.slice(offset, offset + limit);
        return { ok: true, status: 200, json: async () => ({ transcriptions: page }) };
    };
}

const notes = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, title: `Note ${i}` }));

/*
 * The notes list reaches past the server's first page. `GET /api/transcriptions`
 * answers one page (50 by default, 100 at most, newest first); the library
 * searches, filters and picks notes for a report over what `listTranscriptions()`
 * returns, so reading only the first page made every note past the newest 50
 * unreachable there.
 */
describe('listTranscriptions', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns every readable note, not only the newest 50', async () => {
        asMock(authFetch).mockImplementation(pagingServer(notes(230)));
        const list = await listTranscriptions();
        expect(list).toHaveLength(230);
        expect(list.at(-1).title).toBe('Note 229');
        expect(authFetch).toHaveBeenCalledTimes(3);
    });

    it('stops after one request when the first page is short', async () => {
        asMock(authFetch).mockImplementation(pagingServer(notes(7)));
        expect(await listTranscriptions()).toHaveLength(7);
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    it('drops a note seen twice when the pages shift under it', async () => {
        const rows = notes(150);
        const server = pagingServer(rows);
        asMock(authFetch).mockImplementation(async (url: string) => {
            const res = await server(url);
            // A new note arrives after the first page: everything moves down one.
            if (!url.includes('offset=100')) rows.unshift({ id: 'new', title: 'New' });
            return res;
        });
        const list = await listTranscriptions();
        expect(new Set(list.map((n: Row) => n.id)).size).toBe(list.length);
        expect(list).toHaveLength(150);
    });

    it('ends the walk on a server that ignores the offset', async () => {
        asMock(authFetch).mockImplementation(pagingServer(notes(300), { ignoreOffset: true }));
        expect(await listTranscriptions()).toHaveLength(100);
        expect(authFetch).toHaveBeenCalledTimes(2);
    });

    it('stops at the page cap on an instance with more notes than that', async () => {
        asMock(authFetch).mockImplementation(pagingServer(notes(2500)));
        expect(await listTranscriptions()).toHaveLength(2000);
        expect(authFetch).toHaveBeenCalledTimes(20);
    });

    it('with a limit reads one page of that size', async () => {
        asMock(authFetch).mockImplementation(pagingServer(notes(230)));
        expect(await listTranscriptions({ limit: 8 })).toHaveLength(8);
        expect(authFetch).toHaveBeenCalledTimes(1);
        expect(String(asMock(authFetch).mock.calls[0][0])).toContain('limit=8');
    });
});
