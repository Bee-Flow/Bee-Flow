import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mutate } from '@/api/mutate';
import { confirmPublishDespiteBrokenLinks, describeLinkErrors, fetchLinkErrors } from './publishLinkCheck';

vi.mock('@/api/mutate', () => ({ mutate: vi.fn() }));

const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;
const error = { where: 'site > footer', url: '/terms', code: 'path_not_found', problem: 'No page.', severity: 'error' };

describe('publish link pre-check', () => {
    beforeEach(() => { vi.mocked(mutate).mockReset(); });

    it('returns the errors and drops warnings and malformed rows', async () => {
        vi.mocked(mutate).mockResolvedValue(reply({ problems: [error, { ...error, severity: 'warning' }, 'x'] }));
        expect(await fetchLinkErrors('pj_aaaa')).toEqual([error]);
        expect(vi.mocked(mutate).mock.calls[0][0]).toContain('/sites/pj_aaaa/link-check');
    });

    it('never blocks publishing: a failing check yields no problems', async () => {
        vi.mocked(mutate).mockImplementation(async () => { throw new Error('HTTP 500'); });
        expect(await fetchLinkErrors('pj_aaaa')).toEqual([]);
        vi.mocked(mutate).mockImplementation(async () => { throw new Error('offline'); });
        expect(await fetchLinkErrors('pj_aaaa')).toEqual([]);
    });

    it('gives the request a timeout, and an abort means no problems', async () => {
        vi.mocked(mutate).mockImplementation(async () => { throw new DOMException('timed out', 'TimeoutError'); });
        expect(await fetchLinkErrors('pj_aaaa')).toEqual([]);
        const init = vi.mocked(mutate).mock.calls[0][1];
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('lists at most five problems, comma separated', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ ...error, url: `/p${i}`, severity: 'error' as const }));
        expect(describeLinkErrors(many).split(', ')).toHaveLength(5);
    });
});

describe('confirmPublishDespiteBrokenLinks', () => {
    const t = (_key: string, fallback: string) => fallback;

    it('asks only when something is broken', async () => {
        const confirm = vi.fn(async () => false);
        vi.mocked(mutate).mockResolvedValue(reply({ problems: [] }));
        expect(await confirmPublishDespiteBrokenLinks('pj_aaaa', confirm, t)).toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        vi.mocked(mutate).mockResolvedValue(reply({ problems: [error] }));
        expect(await confirmPublishDespiteBrokenLinks('pj_aaaa', confirm, t)).toBe(false);
        expect(confirm).toHaveBeenCalledOnce();
    });
});
