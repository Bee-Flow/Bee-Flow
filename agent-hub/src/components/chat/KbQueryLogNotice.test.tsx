import { screen, waitFor } from '@testing-library/react';
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
});
