import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import useCmsPanelState from './useCmsPanelState';
import useCmsAutosave from './useCmsAutosave';
import { toast } from '@/components/shared/Toast';
import { noteSavedRev, resetSavedRevs } from './cmsRevisions';

interface SavedRequest {
    url: string;
    body: { page?: { rev?: number; title?: string }; site?: { rev?: number } };
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup() {
    return renderHook(() => {
        const state = useCmsPanelState();
        return { state, autosave: useCmsAutosave(state) };
    });
}

describe('useCmsAutosave revisions', () => {
    const requests: SavedRequest[] = [];
    let answer: (req: SavedRequest) => Response;
    /** When set, the first request is held until this resolves. */
    let holdFirst: Promise<void> | null;

    beforeEach(() => {
        requests.length = 0;
        resetSavedRevs();
        answer = () => jsonResponse(200, {});
        holdFirst = null;
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
            const req: SavedRequest = { url: String(input), body: JSON.parse(String(init?.body ?? '{}')) };
            requests.push(req);
            if (holdFirst && requests.length === 1) await holdFirst;
            return answer(req);
        });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('names the revision a page was loaded at, then the one the server just stored', async () => {
        answer = (req) => jsonResponse(200, { page: { rev: (req.body.page?.rev ?? 0) + 1 } });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';

        // The panel state still holds the revision it loaded (4) for both edits.
        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'A', rev: 4 } };
        await act(async () => { await result.current.autosave.flushSaves(); });
        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'B', rev: 4 } };
        await act(async () => { await result.current.autosave.flushSaves(); });

        expect(requests.map((r) => r.body.page?.rev)).toEqual([4, 5]);
    });

    it('queues a second save behind the first so it is based on the revision the first produced', async () => {
        answer = (req) => jsonResponse(200, { page: { rev: (req.body.page?.rev ?? 0) + 1 } });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';

        let release = () => {};
        holdFirst = new Promise<void>((resolve) => { release = resolve; });

        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'A', rev: 1 } };
        const first = result.current.autosave.flushSaves();
        await waitFor(() => expect(requests).toHaveLength(1));
        // The user types again while the first save is still on its way.
        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'B', rev: 1 } };
        const second = result.current.autosave.flushSaves();
        release();
        await act(async () => { await Promise.all([first, second]); });

        expect(requests.map((r) => r.body.page?.rev)).toEqual([1, 2]);
    });

    it('treats a 409 as "changed elsewhere": reports it, does not keep the batch for a doomed retry', async () => {
        answer = () => jsonResponse(409, {
            code: 'cms_conflict',
            error: 'This page was changed elsewhere since you opened it. Reload to get the latest version, then make your change again.',
        });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';
        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'Mine', rev: 1 } };

        let saved: boolean | undefined;
        await act(async () => { saved = await result.current.autosave.flushSaves(); });

        expect(saved).toBe(false);
        expect(result.current.state.failedSavesRef.current).toBeNull();
        expect(result.current.state.error).toMatch(/changed elsewhere/);
        expect(result.current.state.saveStatus).toBe('error');
    });

    it('keeps the batch for the Retry button when the failure is not a conflict', async () => {
        answer = () => jsonResponse(500, { error: 'boom' });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';
        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'Mine', rev: 1 } };

        await act(async () => { await result.current.autosave.flushSaves(); });

        expect(result.current.state.failedSavesRef.current).toEqual({ pg_one: { id: 'pg_one', title: 'Mine', rev: 1 } });
    });

    it('sends the site chrome with its revision', async () => {
        answer = (req) => jsonResponse(200, { site: { rev: (req.body.site?.rev ?? 0) + 1 } });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';
        result.current.state.pendingSaves.current = { site: { id: 'pj_site', name: 'N', rev: 7 } };

        await act(async () => { await result.current.autosave.flushSaves(); });

        expect(requests[0].body.site?.rev).toBe(7);
    });

    it('names the revision a page-settings save stored, not the stale one the panel still holds', async () => {
        answer = (req) => jsonResponse(200, { page: { rev: (req.body.page?.rev ?? 0) + 1 } });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';
        noteSavedRev('pj_site', 'pg_one', 6);   // PUT /meta answered pageRev 6

        result.current.state.pendingSaves.current = { pg_one: { id: 'pg_one', title: 'A', rev: 5 } };
        await act(async () => { await result.current.autosave.flushSaves(); });

        expect(requests[0].body.page?.rev).toBe(6);
    });

    it('tells the translator when the server dropped a media address of a translation', async () => {
        const warn = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        answer = () => jsonResponse(200, { success: true, mediaWarning: 'Some media addresses were not accepted' });
        const { result } = setup();
        result.current.state.activeSiteIdRef.current = 'pj_site';
        result.current.state.pendingSaves.current = { 'locale:page:pg_one:nl': { blocks: {} } };

        await act(async () => { await result.current.autosave.flushSaves(); });

        expect(requests[0].url).toContain('/pages/pg_one/locale/nl');
        expect(warn).toHaveBeenCalledWith('Some media addresses were not accepted');
    });
});
