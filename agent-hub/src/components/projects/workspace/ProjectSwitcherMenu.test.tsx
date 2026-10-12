import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import ProjectSwitcherMenu from './ProjectSwitcherMenu';
import { makeFakeApi, makeProject } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

beforeEach(() => { fetchMock.mockReset(); });

function renderMenu(current: ReturnType<typeof makeProject>) {
    render(withQueryClient(<ProjectSwitcherMenu current={current} projects={[current]} onOpenProject={vi.fn()} onBack={vi.fn()} folded={false} />));
}

describe('ProjectSwitcherMenu: mute', () => {
    it('mutes the open project from the menu', async () => {
        const api = makeFakeApi({ 'PUT /api/projects/p1/mute': { muted: true } });
        fetchMock.mockImplementation(api.fetchImpl);
        const user = userEvent.setup();
        renderMenu(makeProject());

        await user.click(screen.getByTestId('project-rail-switch'));
        await user.click(await screen.findByRole('menuitem', { name: 'Mute this project' }));
        await waitFor(() => expect(api.callsTo('PUT', '/api/projects/p1/mute')).toHaveLength(1));
    });

    it('offers to unmute when the project row says it is muted (after a reload)', async () => {
        const api = makeFakeApi({ 'DELETE /api/projects/p1/mute': { muted: false } });
        fetchMock.mockImplementation(api.fetchImpl);
        const user = userEvent.setup();
        renderMenu(makeProject({ muted: true }));

        await user.click(screen.getByTestId('project-rail-switch'));
        await user.click(await screen.findByRole('menuitem', { name: 'Unmute this project' }));
        await waitFor(() => expect(api.callsTo('DELETE', '/api/projects/p1/mute')).toHaveLength(1));
    });
});
