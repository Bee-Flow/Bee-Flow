import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok } from '@/test/http';
import InboxesTab from './InboxesTab';
import { authFetch } from '../../../../utils/helpers';
import { asMock, stub } from '@/test/mocks';
import type { ComponentProps } from 'react';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../../hooks/useTranslation', () => import('@/test/useTranslationMock'));

describe('InboxesTab mailbox OAuth popup', () => {
    beforeEach(() => { cleanup(); asMock(authFetch).mockReset(); vi.restoreAllMocks(); });

    async function startConnect(onChanged: ComponentProps<typeof InboxesTab>['onChanged']) {
        asMock(authFetch).mockImplementation(() => ok({ url: 'https://idp.example/auth' }));
        const popup = { close: vi.fn() };
        vi.spyOn(window, 'open').mockReturnValue(stub<Window>(popup));
        render(<InboxesTab inboxes={[{ id: 'i1', provider: 'gmail', connected: false }]} onChanged={onChanged} />);
        fireEvent.click(screen.getByText('Connect'));
        await waitFor(() => expect(window.open).toHaveBeenCalled());
        return popup;
    }

    it('ignores a message from a foreign origin', async () => {
        const onChanged = vi.fn();
        const popup = await startConnect(onChanged);
        act(() => {
            window.dispatchEvent(new MessageEvent('message', { data: 'support-mailbox-oauth', origin: 'https://evil.example' }));
        });
        expect(popup.close).not.toHaveBeenCalled();
        await new Promise(r => setTimeout(r, 800));
        expect(onChanged).not.toHaveBeenCalled();
    });

    it('accepts the same message from the app origin', async () => {
        const onChanged = vi.fn();
        const popup = await startConnect(onChanged);
        act(() => {
            window.dispatchEvent(new MessageEvent('message', { data: 'support-mailbox-oauth', origin: window.location.origin }));
        });
        expect(popup.close).toHaveBeenCalled();
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });
});
