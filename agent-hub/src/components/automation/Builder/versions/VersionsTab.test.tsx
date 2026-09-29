import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';
import { BuilderConfirmProvider } from '../BuilderConfirmContext';

const { client } = vi.hoisted(() => ({
    client: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('../../../../api/client', () => ({ apiClient: client, default: client }));
vi.mock('../DiagramPane', () => ({
    default: ({ definition }: { definition: { steps?: unknown[] } }) => <div data-testid="readonly-canvas">{definition.steps?.length ?? 0} steps</div>,
}));

import VersionsTab from './VersionsTab';

const VERSIONS = {
    versions: [
        { id: 'r5', version: 5, savedAt: '2026-09-28T10:55:00Z', savedBy: { name: 'admin' }, isEditing: true, isLive: false,
            descriptionJson: [{ code: 'setting_changed', params: { setting: 'Folder', step: 'Read invoice' } }] },
        { id: 'r4', version: 4, savedAt: '2026-09-28T10:50:00Z', savedBy: { name: 'admin' },
            descriptionJson: [{ code: 'step_added', params: { step: 'Post in Talk' } }] },
        { id: 'r3', version: 3, savedAt: '2026-09-22T09:00:00Z', savedBy: { name: 'admin' }, isLive: true, liveSince: '2026-09-22T09:00:00Z',
            name: 'Approval above 1,000', runs: { total: 36, failed: 1 } },
        { id: 'r2', version: 2, savedAt: '2026-09-20T09:00:00Z', savedBy: { name: 'admin' },
            descriptionJson: [{ code: 'steps_reordered', params: {} }] },
    ],
};

const DEFINITION = {
    trigger: { id: 't1', kind: 'manual' },
    steps: [
        { id: 'n1', type: 'note', title: 'A sticky note' },
        { id: 's1', type: 'integration_action', label: 'Read invoice' },
        { id: 's2', type: 'ai_step', label: 'Extract data' },
        { id: 's7', type: 'integration_action', label: 'Post in Talk' },
    ],
};

const DIFF = {
    changes: [
        { stepId: 's1', stepNumber: 2, stepLabel: 'Read invoice', change: 'changed', setting: 'connection', settingLabel: 'Connection', before: 'Nextcloud · bee-bot', after: 'Nextcloud · finance-service' },
        { stepId: 's7', stepNumber: 7, stepLabel: 'Post in Talk', change: 'added', setting: null, after: 'Post in "Finance"' },
    ],
    stepIds: { added: ['s7'], removed: [], changed: ['s1'] },
};

function routeGet(path: string) {
    if (path.endsWith('/versions')) return Promise.resolve(VERSIONS);
    if (path.includes('/fielddiff/')) return Promise.resolve(DIFF);
    if (/\/versions\/r\d+$/.test(path)) return Promise.resolve({ version: { definition: DEFINITION } });
    return Promise.reject(new Error(`unexpected ${path}`));
}

function renderTab(confirm = vi.fn(async () => true), onRestored = vi.fn()) {
    const Provider = BuilderConfirmProvider as unknown as React.Provider<typeof confirm>;
    render(withQueryClient(
        <Provider value={confirm}>
            <VersionsTab automation={{ id: 'a1', version: 5, liveVersion: 3 }} onRestored={onRestored} />
        </Provider>,
    ));
    return { confirm, onRestored };
}

describe('VersionsTab', () => {
    beforeEach(() => {
        cleanup();
        client.get.mockReset().mockImplementation(routeGet);
        client.put.mockReset().mockResolvedValue({});
        client.post.mockReset().mockResolvedValue({ automation: { id: 'a1', version: 6 } });
    });

    it('groups the history and describes each version in plain language', async () => {
        renderTab();
        const pending = await screen.findByRole('region', { name: 'Not live yet' });
        expect(within(pending).getByText('Folder changed in "Read invoice"')).toBeInTheDocument();
        expect(within(pending).getByText('editing')).toBeInTheDocument();
        expect(within(pending).getByText('Step added: "Post in Talk"')).toBeInTheDocument();
        const live = screen.getByRole('region', { name: 'Live' });
        expect(within(live).getByText('Approval above 1,000')).toBeInTheDocument();
        expect(within(live).getByText(/^live since /)).toBeInTheDocument();
        expect(within(live).getByText(/36 runs, 1 failed/)).toBeInTheDocument();
        const earlier = screen.getByRole('region', { name: 'Earlier' });
        expect(within(earlier).getByText(/works the same/)).toBeInTheDocument();
    });

    it('compares the working copy with the live version, per setting and on the mini canvas', async () => {
        renderTab();
        expect(await screen.findByRole('heading', { name: 'v5 · Folder changed in "Read invoice"' })).toBeInTheDocument();
        expect(screen.getByLabelText('Compared with')).toHaveDisplayValue('v3 · live');
        expect(await screen.findByText('2 changes since the live version')).toBeInTheDocument();
        expect(client.get).toHaveBeenCalledWith('/api/automation/a1/versions/5/fielddiff/3', expect.anything());
        expect(screen.getByRole('columnheader', { name: 'Was (v3)' })).toBeInTheDocument();
        expect(screen.getByRole('columnheader', { name: 'Becomes (v5)' })).toBeInTheDocument();
        expect(screen.getByText('Nextcloud · bee-bot')).toHaveClass('line-through');
        expect(screen.getByText('New step')).toBeInTheDocument();

        const canvas = await screen.findByTestId('version-mini-canvas');
        await within(canvas).findByText('Read invoice');
        expect(within(canvas).getByText('Read invoice').closest('li')).toHaveAttribute('data-mark', 'changed');
        expect(within(canvas).getByText('Post in Talk').closest('li')).toHaveAttribute('data-mark', 'new');
        expect(within(canvas).getByText('Extract data').closest('li')).not.toHaveAttribute('data-mark');
        expect(within(canvas).getByText('Start')).toBeInTheDocument();
        expect(within(canvas).queryByText('A sticky note')).toBeNull();
        expect(screen.getByText(/Layout and position changes don't count as a version/)).toBeInTheDocument();
    });

    it('restores the compared version after the question, into the working copy', async () => {
        const user = userEvent.setup();
        const { confirm, onRestored } = renderTab();
        await user.click(await screen.findByRole('button', { name: 'Restore to v3' }));
        expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Restore v3?' }));
        expect(client.post).toHaveBeenCalledWith('/api/automation/a1/versions/r3/restore');
        expect(onRestored).toHaveBeenCalledWith({ id: 'a1', version: 6 });
    });

    it('does not restore when the question is answered no', async () => {
        const user = userEvent.setup();
        renderTab(vi.fn(async () => false));
        await user.click(await screen.findByRole('button', { name: 'Restore to v3' }));
        expect(client.post).not.toHaveBeenCalled();
    });

    it('names a version as a milestone', async () => {
        const user = userEvent.setup();
        renderTab();
        await user.click(await screen.findByRole('button', { name: /^v2\D/ }));
        await user.click(await screen.findByRole('button', { name: 'Name it' }));
        await user.type(screen.getByRole('textbox', { name: 'Milestone name' }), 'Reordered for review');
        await user.click(screen.getByRole('button', { name: 'Save name' }));
        expect(client.put).toHaveBeenCalledWith('/api/automation/a1/versions/2/name', { name: 'Reordered for review' });
    });

    it('filters to milestones and opens a version read-only', async () => {
        const user = userEvent.setup();
        renderTab();
        await screen.findByText('Approval above 1,000');
        await user.click(screen.getByRole('switch', { name: 'Milestones only' }));
        expect(screen.queryByText('Step added: "Post in Talk"')).toBeNull();
        expect(screen.queryByRole('region', { name: 'Earlier' })).toBeNull();
        expect(screen.getByText('Approval above 1,000')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Open (read-only)' }));
        const dialog = await screen.findByRole('dialog');
        expect(await within(dialog).findByTestId('readonly-canvas')).toHaveTextContent('4 steps');
    });

    it('says so when the routine was never saved', () => {
        render(withQueryClient(<VersionsTab automation={{ id: null }} />));
        expect(screen.getByText(/once this routine has been saved/)).toBeInTheDocument();
        expect(client.get).not.toHaveBeenCalled();
    });
});
