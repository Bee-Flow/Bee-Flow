/**
 * The Adoption reads: the URL each hook asks for, "nothing to show" on a
 * refusal, the typed audit error on a refused reveal, and the people pages
 * merged by `nextCursor`. A revealed read is never retried: every request
 * with `reveal=true` writes an access-audit row.
 */
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHookWithClient } from '@/test/render';
import {
    AdoptionAuditUnavailableError, adoptionKeys, pseudonymousPlaceholder, useAdoptionAreas, useAdoptionGroups, useAdoptionPeople,
    useAdoptionStudio, useAdoptionStudioItems, useAdoptionSummary,
} from './usageAdoption';

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});
const urls = () => fetchMock.mock.calls.map(c => new URL(String(c[0]), 'http://x'));

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('adoption keys', () => {
    it('live under settings › usage › adoption, revealed and pseudonymous people apart', () => {
        expect(adoptionKeys.summary('days=30')).toEqual(['settings', 'usage', 'adoption', 'summary', 'days=30']);
        expect(adoptionKeys.people('days=30', true)).not.toEqual(adoptionKeys.people('days=30', false));
    });
});

describe('the simple reads', () => {
    it.each([
        ['summary', useAdoptionSummary, '/api/usage/adoption/summary'],
        ['areas', useAdoptionAreas, '/api/usage/adoption/areas'],
        ['studio', useAdoptionStudio, '/api/usage/adoption/studio'],
        ['groups', useAdoptionGroups, '/api/usage/adoption/groups'],
    ] as const)('%s asks its route with the query and returns the body', async (_name, hook, path) => {
        fetchMock.mockResolvedValue(json({ ok: 1 }));
        const { result } = renderHookWithClient(() => hook<{ ok: number }>('days=30&group=g1'));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toEqual({ ok: 1 });
        const [u] = urls();
        expect(u.pathname).toBe(path);
        expect(u.searchParams.get('days')).toBe('30');
        expect(u.searchParams.get('group')).toBe('g1');
    });

    it('reads a refusal as null, not as an error', async () => {
        fetchMock.mockResolvedValue(json({ error: 'Forbidden' }, 403));
        const { result } = renderHookWithClient(() => useAdoptionSummary<object>('days=30'));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toBeNull();
    });

    it('asks for a kind\'s items only once a kind is open', async () => {
        fetchMock.mockResolvedValue(json({ kind: 'agent', items: [] }));
        const idle = renderHookWithClient(() => useAdoptionStudioItems<object>('days=30', null));
        expect(idle.result.current.fetchStatus).toBe('idle');
        const open = renderHookWithClient(() => useAdoptionStudioItems<object>('days=30', 'agent'));
        await waitFor(() => expect(open.result.current.isSuccess).toBe(true));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [u] = urls();
        expect(u.pathname).toBe('/api/usage/adoption/studio/items');
        expect(u.searchParams.get('kind')).toBe('agent');
    });
});

describe('useAdoptionPeople', () => {
    const page = (ids: string[], nextCursor: number | null, reveal = false) => ({ reveal, auditRecorded: reveal, people: ids.map(id => ({ id, name: id })), total: 3, nextCursor });

    it('is pseudonymous by default: no reveal parameter is sent', async () => {
        fetchMock.mockResolvedValue(json(page(['Member · AAAA'], null)));
        const { result } = renderHookWithClient(() => useAdoptionPeople<{ id: string }>('days=30', false));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(urls()[0].searchParams.has('reveal')).toBe(false);
        expect(result.current.data?.reveal).toBe(false);
    });

    it('merges the pages it is asked for, following nextCursor', async () => {
        fetchMock
            .mockResolvedValueOnce(json(page(['a', 'b'], 2)))
            .mockResolvedValueOnce(json(page(['c'], null)));
        const { result } = renderHookWithClient(() => useAdoptionPeople<{ id: string }>('days=30', false));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.hasNextPage).toBe(true);
        await result.current.fetchNextPage();
        await waitFor(() => expect(result.current.data?.people.map(p => p.id)).toEqual(['a', 'b', 'c']));
        expect(urls()[1].searchParams.get('cursor')).toBe('2');
        expect(result.current.hasNextPage).toBe(false);
    });

    it('sends reveal=true only when asked, and surfaces a refused audit as the typed error, once', async () => {
        fetchMock.mockResolvedValue(json({ code: 'audit_unavailable' }, 503));
        const { result } = renderHookWithClient(() => useAdoptionPeople<{ id: string }>('days=30', true));
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.error).toBeInstanceOf(AdoptionAuditUnavailableError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(urls()[0].searchParams.get('reveal')).toBe('true');
    });

    it('never hands a hidden read the revealed answer as its placeholder', async () => {
        let release: (v: unknown) => void = () => {};
        fetchMock
            .mockResolvedValueOnce(json(page(['Alex Morgan'], null, true)))
            .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const { result, rerender } = renderHookWithClient(
            ({ qs, reveal }: { qs: string; reveal: boolean }) => useAdoptionPeople<{ id: string }>(qs, reveal),
            { initialProps: { qs: 'days=30', reveal: true } },
        );
        await waitFor(() => expect(result.current.data?.reveal).toBe(true));
        rerender({ qs: 'days=30&group=g1', reveal: false });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(result.current.data?.people.map(p => p.id) ?? []).not.toContain('Alex Morgan');
        release(json(page(['Member · AAAA'], null)));
        await waitFor(() => expect(result.current.data?.people.map(p => p.id)).toEqual(['Member · AAAA']));
    });

    it('keeps a pseudonymous answer as the placeholder of the next hidden read', () => {
        const hidden = { pages: [page(['Member · AAAA'], null)], pageParams: [0] };
        const named = { pages: [page(['Alex Morgan'], null, true)], pageParams: [0] };
        expect(pseudonymousPlaceholder(hidden)).toBe(hidden);
        expect(pseudonymousPlaceholder(named)).toBeUndefined();
        expect(pseudonymousPlaceholder(undefined)).toBeUndefined();
    });

    it('asks the server again on a second reveal: the revealed answer is not kept once hidden', async () => {
        fetchMock.mockImplementation(async (url: string) => {
            const reveal = new URL(String(url), 'http://x').searchParams.get('reveal') === 'true';
            return json(page([reveal ? 'Alex Morgan' : 'Member · AAAA'], null, reveal));
        });
        const { result, rerender } = renderHookWithClient(
            ({ reveal }: { reveal: boolean }) => useAdoptionPeople<{ id: string }>('days=30', reveal),
            { initialProps: { reveal: true } },
        );
        await waitFor(() => expect(result.current.data?.reveal).toBe(true));
        rerender({ reveal: false });
        await waitFor(() => expect(result.current.data?.reveal).toBe(false));
        rerender({ reveal: true });
        await waitFor(() => expect(urls().filter(u => u.searchParams.get('reveal') === 'true')).toHaveLength(2));
        await waitFor(() => expect(result.current.data?.reveal).toBe(true));
    });

    it('reads any other 503 as nothing to show', async () => {
        fetchMock.mockResolvedValue(json({ code: 'other' }, 503));
        const { result } = renderHookWithClient(() => useAdoptionPeople<{ id: string }>('days=30', true));
        await waitFor(() => expect(result.current.isSuccess).toBe(true));
        expect(result.current.data).toBeNull();
    });
});
