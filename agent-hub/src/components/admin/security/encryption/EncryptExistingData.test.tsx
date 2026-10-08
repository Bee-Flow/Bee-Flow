import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '/api', authFetch }));

import EncryptExistingData from './EncryptExistingData';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const IDLE = { status: 'idle', dryRun: null, startedAt: null, finishedAt: null, surfaces: {}, error: null };
const DONE = {
    status: 'done', dryRun: true, startedAt: 'x', finishedAt: 'y', error: null,
    surfaces: { messages: { encrypted: 7, skipped: 3, noKey: 2, failed: 1 } },
};

function posts() {
    return authFetch.mock.calls.filter(([, o]) => o?.method === 'POST').map(([, o]) => JSON.parse(o.body));
}

beforeEach(() => { authFetch.mockReset(); });

describe('EncryptExistingData', () => {
    it('Preview posts dryRun true at once', async () => {
        authFetch.mockImplementation(async (_u, o) => (o?.method === 'POST' ? json({ ...IDLE, status: 'running', dryRun: true }, 202) : json(IDLE)));
        const user = userEvent.setup();
        render(withQueryClient(<EncryptExistingData orgId="o1" dirty={false} />));
        await user.click(await screen.findByRole('button', { name: 'Preview' }));
        await waitFor(() => expect(posts()).toEqual([{ dryRun: true }]));
    });

    it('the live run needs the confirmation, then posts dryRun false', async () => {
        authFetch.mockImplementation(async (_u, o) => (o?.method === 'POST' ? json({ ...IDLE, status: 'running', dryRun: false }, 202) : json(IDLE)));
        const user = userEvent.setup();
        render(withQueryClient(<EncryptExistingData orgId="o1" dirty={false} />));
        await user.click(await screen.findByRole('button', { name: 'Encrypt existing data' }));
        expect(posts()).toEqual([]);
        await user.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(posts()).toEqual([{ dryRun: false }]));
    });

    it('cancelling the confirmation starts nothing', async () => {
        authFetch.mockResolvedValue(json(IDLE));
        const user = userEvent.setup();
        render(withQueryClient(<EncryptExistingData orgId="o1" dirty={false} />));
        await user.click(await screen.findByRole('button', { name: 'Encrypt existing data' }));
        await user.click(await screen.findByTestId('confirm-dialog-cancel'));
        expect(posts()).toEqual([]);
    });

    it('shows the counts per surface with a humanised label', async () => {
        authFetch.mockResolvedValue(json(DONE));
        render(withQueryClient(<EncryptExistingData orgId="o1" dirty={false} />));
        const row = await screen.findByTestId('backfill-surface-messages');
        expect(row.textContent).toContain('Chat messages');
        expect(row.textContent).toMatch(/would encrypt 7.*already done 3.*no key 2.*failed 1/);
    });

    it('disables both buttons while running and while the tier is unsaved', async () => {
        authFetch.mockResolvedValue(json({ ...IDLE, status: 'running', dryRun: false }));
        const { unmount } = render(withQueryClient(<EncryptExistingData orgId="o1" dirty={false} />));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeDisabled());
        expect(screen.getByRole('button', { name: 'Encrypt existing data' })).toBeDisabled();
        unmount();
        authFetch.mockResolvedValue(json(IDLE));
        render(withQueryClient(<EncryptExistingData orgId="o1" dirty />));
        expect(await screen.findByRole('button', { name: 'Preview' })).toBeDisabled();
    });
});
