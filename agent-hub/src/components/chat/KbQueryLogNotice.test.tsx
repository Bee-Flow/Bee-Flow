import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import KbQueryLogNotice from './KbQueryLogNotice';
import { renderWithClient } from '@/test/render';
import { asMock } from '@/test/mocks';

const fetchMock = vi.fn();
const rel = (u: unknown) => String(u).replace(/^https?:\/\/[^/]+/, '');

const answer = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('KbQueryLogNotice', () => {
    it('names the bases that log', async () => {
        asMock(fetchMock).mockResolvedValue(answer({ active: true, kbs: [{ id: 'a', name: 'HR' }, { id: 'b', name: 'IT' }] }));
        renderWithClient(<KbQueryLogNotice kbIds={['b', 'a']} />);
        const line = await screen.findByTestId('kb-query-log-notice');
        expect(line.textContent).toContain('Questions to HR, IT are logged for quality control');
        expect(rel(asMock(fetchMock).mock.calls[0][0])).toBe('/api/kb/query-log/notice?kbIds=a%2Cb');
    });

    it('renders nothing when nothing logs, when the read fails, and without ids', async () => {
        asMock(fetchMock).mockResolvedValue(answer({ active: false, kbs: [] }));
        const first = renderWithClient(<KbQueryLogNotice kbIds={['a']} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByTestId('kb-query-log-notice')).toBeNull();
        first.unmount();
        asMock(fetchMock).mockResolvedValue(answer({ error: 'x' }, false));
        renderWithClient(<KbQueryLogNotice kbIds={['z']} />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(screen.queryByTestId('kb-query-log-notice')).toBeNull();
        asMock(fetchMock).mockClear();
        renderWithClient(<KbQueryLogNotice kbIds={[]} />);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('asks an unacknowledged base for its acknowledgement, posts it, then shows the one-liner', async () => {
        const user = userEvent.setup();
        const open = { active: true, kbs: [{ id: 'a', name: 'HR', acknowledged: false, retentionDays: 180, showNames: false }] };
        const done = { active: true, kbs: [{ id: 'a', name: 'HR', acknowledged: true, retentionDays: 180, showNames: false }] };
        let acknowledged = false;
        asMock(fetchMock).mockImplementation(async (url: string, init?: { method?: string }) => {
            if (init?.method === 'POST') { acknowledged = true; return answer(done); }
            void url;
            return answer(acknowledged ? done : open);
        });
        renderWithClient(<KbQueryLogNotice kbIds={['a']} />);
        const banner = await screen.findByTestId('kb-query-log-ack');
        expect(banner.textContent).toContain('pseudonym');
        expect(banner.textContent).toContain('180 days');
        expect(screen.getByTestId('kb-query-log-not-yet').textContent).toContain('not logged');
        expect(screen.queryByTestId('kb-query-log-notice')).toBeNull();
        await user.click(screen.getByTestId('kb-query-log-ack-button'));
        const post = asMock(fetchMock).mock.calls.find(([, init]) => init?.method === 'POST');
        expect(rel(post?.[0])).toBe('/api/kb/query-log/acknowledge');
        expect(JSON.parse(post?.[1].body as string)).toEqual({ kbIds: ['a'] });
        expect((await screen.findByTestId('kb-query-log-notice')).textContent).toContain('HR');
        expect(screen.queryByTestId('kb-query-log-ack')).toBeNull();
    });

    it('says the manager sees the name when the base shows names', async () => {
        asMock(fetchMock).mockResolvedValue(answer({ active: true, kbs: [{ id: 'a', name: 'HR', acknowledged: false, retentionDays: 90, showNames: true }] }));
        renderWithClient(<KbQueryLogNotice kbIds={['a']} />);
        expect((await screen.findByTestId('kb-query-log-ack')).textContent).toContain('see your name');
    });
});
