import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithClient } from '@/test/render';
import OrgNcPairingPanel from './OrgNcPairingPanel';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

// Written in two halves so this file does not contain the command it bans.
const ABSENT_COMMAND = ['app_api:app:', 'setenv'].join('');

describe('OrgNcPairingPanel', () => {
    beforeEach(() => {
        cleanup();
        fetchMock.mockReset();
        const expiresAt = new Date(Date.now() + 12 * 60_000 + 5_000).toISOString();
        fetchMock.mockImplementation(async () => answer({ codes: [{ id: 'p1', code: null, expiresAt }] }));
        vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('sends the administrator to the setup page, or the install-time value, never to a command AppAPI lacks', async () => {
        const user = userEvent.setup();
        const { container } = renderWithClient(<OrgNcPairingPanel />);
        await user.click(screen.getByText('How to use this code on the new Nextcloud'));
        expect(screen.getByText(/Enter the code under Bind to existing organisation/)).toBeTruthy();
        expect(container.textContent).toContain('https://<your-nextcloud>/exapps/bee_flow/setup');
        expect(container.textContent).toContain('occ app_api:app:register bee_flow <daemon> --env BEEFLOW_PAIRING_CODE=<CODE>');
        expect(container.textContent).not.toContain(ABSENT_COMMAND);
        expect(container.textContent).not.toContain('app_api:app:disable');
    });

    it('counts a stored code down', async () => {
        renderWithClient(<OrgNcPairingPanel />);
        expect(await screen.findByText(/^1[12]m \d\ds remaining/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Generate pairing code' })).toBeTruthy();
    });
});
