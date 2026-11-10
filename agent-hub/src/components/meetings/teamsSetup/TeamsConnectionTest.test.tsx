import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { renderWithClient } from '@/test/render';
import TeamsConnectionTest from './TeamsConnectionTest';

const fetchMock = vi.fn();
const answer = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status,
    json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers({ 'content-type': 'application/json' }),
});

const REPORT = {
    level: 'user', ranAt: '2026-11-10T10:00:00.000Z', overall: 'fail',
    checks: [
        { id: 'a.connection', option: 'A', status: 'fail', code: 'not_connected', params: {}, remediation: 'teams_setup.fix.connect_microsoft', fixer: 'user', dependsOn: ['app.configured'] },
        { id: 'a.scope_calendar', option: 'A', status: 'skipped', code: 'prerequisite_failed', params: { prerequisite: 'a.connection' }, remediation: null, fixer: null, dependsOn: ['a.connection'] },
    ],
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

describe('TeamsConnectionTest', () => {
    it('runs the test on click and shows the checklist', async () => {
        fetchMock.mockResolvedValue(answer(REPORT));
        const user = userEvent.setup();
        renderWithClient(<TeamsConnectionTest />);
        expect(fetchMock).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Test my connection' }));
        expect(await screen.findByText('Your Microsoft 365 account is connected')).toBeTruthy();
        expect(screen.getByText('Microsoft 365 is not connected for your account.')).toBeTruthy();
        expect(screen.getByText('Connect Microsoft 365 under Settings, Connections.')).toBeTruthy();
        expect(screen.getByText('Skipped (1)')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Test again' })).toBeTruthy();
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(String(url)).toMatch(/\/api\/teams-setup\/me\/diagnostics$/);
        expect(init.method).toBe('POST');
    });

    it('a 429 says to wait a few seconds', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'Wait a few seconds before you test again', code: 'diagnostics_rate_limited' }, 429));
        const user = userEvent.setup();
        renderWithClient(<TeamsConnectionTest />);
        await user.click(screen.getByRole('button', { name: 'Test my connection' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Wait a few seconds before you test again.');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('any other failure says the test could not run', async () => {
        fetchMock.mockResolvedValue(answer({ error: 'boom' }, 500));
        const user = userEvent.setup();
        renderWithClient(<TeamsConnectionTest />);
        await user.click(screen.getByRole('button', { name: 'Test my connection' }));
        expect((await screen.findByRole('alert')).textContent).toBe('The test could not run. Try again.');
    });
});
