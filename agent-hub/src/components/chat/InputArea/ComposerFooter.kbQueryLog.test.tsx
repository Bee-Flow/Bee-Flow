import { screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ComposerFooter from './ComposerFooter';
import { renderWithClient } from '@/test/render';
import { asMock } from '@/test/mocks';

const fetchMock = vi.fn();

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('ComposerFooter query-log notice', () => {
    it('shows the notice under the box for bases that log', async () => {
        asMock(fetchMock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ active: true, kbs: [{ id: 'a', name: 'HR' }] }) });
        renderWithClient(<ComposerFooter kbNoticeIds={['a']} footerLine="x" />);
        expect((await screen.findByTestId('kb-query-log-notice')).textContent).toContain('HR');
    });

    it('asks nothing and shows nothing without bases', () => {
        renderWithClient(<ComposerFooter kbNoticeIds={[]} footerLine="x" />);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.queryByTestId('kb-query-log-notice')).toBeNull();
    });
});
