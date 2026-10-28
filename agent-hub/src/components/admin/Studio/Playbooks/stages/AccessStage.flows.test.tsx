import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslateFn } from '@/hooks/useTranslation';
import AccessStage from './AccessStage';
import { playbooksApi } from '../playbooksApi';
import { studioAppsApi } from '../../AppStudio/studioAppsApi';

/**
 * The hand-driven paths of the access phase that AccessStage.test.jsx leaves
 * open: the keyboard shortcut and the failure lines of the sentence box, the
 * group and person pickers, and what Approve and Discard do to what is on
 * screen. They pin the behaviour the screen had before it was split into cards.
 */
vi.mock('../playbooksApi', () => {
    const playbooksApi = { accessPlan: vi.fn() };
    return { playbooksApi, default: playbooksApi };
});
vi.mock('../../AppStudio/studioAppsApi', () => ({
    studioAppsApi: {
        getApp: vi.fn(async (id: string) => ({ app: { id, name: 'Invoice Dashboard' } })),
        publish: vi.fn(async () => ({ success: true })),
        setNextcloudMenu: vi.fn(async () => ({ success: true, ncConnected: true, ncSync: 'synced' })),
    },
}));
const saveRoles = vi.fn(async () => ({}));
const assignMember = vi.fn(async () => ({}));
vi.mock('../../AppStudio/rbac/useAppRoles', () => ({
    default: () => ({ roles: [{ key: 'viewer', label: 'Viewer' }], roleMapping: { default: 'app', byGroup: {} }, tables: [], members: [], saveRoles, assignMember, isLoading: false }),
    useOrgDirectory: () => ({ groups: [{ id: 'g_fin', name: 'Finance' }], users: [{ id: 'u_ann', name: 'Ann Blok', email: 'ann@x.nl' }], available: true, isLoading: false }),
}));

const t: TranslateFn = (_key, fallback, params) => Object.entries(params ?? {}).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), String(fallback));
const PB = { id: 'pb_1', title: 'Invoice Dashboard', phases: [] };
const PHASE = { key: 'access', kind: 'access', status: 'running', attempt: 0, artifacts: { appId: 'app_1' } };
const EMPTY_PLAN = { audience: null, roles: [], byGroup: {}, members: [], unresolved: [], note: '', empty: true };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

function renderStage(dispatch = vi.fn()) {
    render(<AccessStage playbook={PB} phase={PHASE} dispatch={dispatch} t={t} />);
    return { dispatch, user: userEvent.setup() };
}

describe('AccessStage — the sentence box', () => {
    it('Ctrl+Enter asks, and a proposal clears the box', async () => {
        vi.mocked(playbooksApi.accessPlan).mockResolvedValue({ plan: { ...EMPTY_PLAN, audience: { kind: 'organisation' }, empty: false } });
        const { user } = renderStage();
        await user.type(screen.getByTestId('playbook-access-ask'), 'everyone');
        await user.keyboard('{Control>}{Enter}{/Control}');
        await waitFor(() => expect(playbooksApi.accessPlan).toHaveBeenCalledWith('pb_1', 'access', 'everyone'));
        await waitFor(() => expect((screen.getByTestId('playbook-access-ask') as HTMLTextAreaElement).value).toBe(''));
        expect(screen.getByTestId('playbook-access-approve')).toHaveProperty('disabled', false);
    });

    it('a plain Enter does not ask, and an empty box cannot be sent', async () => {
        const { user } = renderStage();
        expect(screen.getByTestId('playbook-access-ask-send')).toHaveProperty('disabled', true);
        await user.type(screen.getByTestId('playbook-access-ask'), 'everyone{Enter}');
        expect(playbooksApi.accessPlan).not.toHaveBeenCalled();
    });

    it('a failed ask shows the error message and keeps the sentence', async () => {
        vi.mocked(playbooksApi.accessPlan).mockRejectedValue(new Error('Assistant is down'));
        const { user } = renderStage();
        await user.type(screen.getByTestId('playbook-access-ask'), 'everyone');
        await user.click(screen.getByTestId('playbook-access-ask-send'));
        expect((await screen.findByRole('alert')).textContent).toBe('Assistant is down');
        expect((screen.getByTestId('playbook-access-ask') as HTMLTextAreaElement).value).toBe('everyone');
        expect(screen.getByTestId('playbook-access-ask-send')).toHaveProperty('disabled', false);
    });

    it('a failed ask without a message says to put it in other words', async () => {
        vi.mocked(playbooksApi.accessPlan).mockRejectedValue(new Error(''));
        const { user } = renderStage();
        await user.type(screen.getByTestId('playbook-access-ask'), 'everyone');
        await user.click(screen.getByTestId('playbook-access-ask-send'));
        expect((await screen.findByRole('alert')).textContent).toBe('The assistant could not read that — say it in other words.');
    });
});

describe('AccessStage — pickers and the gate', () => {
    it('chosen groups are published with the audience, and a group role lands in the mapping', async () => {
        const { user, dispatch } = renderStage();
        await user.click(screen.getByTestId('playbook-access-audience-groups'));
        const finance = within(screen.getByTestId('playbook-access-groups')).getByRole('button', { name: 'Finance' });
        expect(finance.getAttribute('aria-pressed')).toBe('false');
        await user.click(finance);
        expect(finance.getAttribute('aria-pressed')).toBe('true');
        await user.selectOptions(screen.getByLabelText('Role for Finance'), 'viewer');
        expect(screen.getByTestId('playbook-access-group-roles').textContent).toContain('Viewer');
        await user.click(screen.getByTestId('playbook-access-approve'));
        await waitFor(() => expect(dispatch).toHaveBeenCalled());
        expect(saveRoles).toHaveBeenCalledWith([{ key: 'viewer', label: 'Viewer' }], { default: 'app', byGroup: { g_fin: 'viewer' } }, undefined);
        expect(studioAppsApi.publish).toHaveBeenCalledWith('app_1', { isPublished: true, sharedGroups: ['g_fin'] });
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'finished', summary: expect.stringContaining('Shared with Finance') }));
    });

    it('a person with a role is assigned it on Approve, and picking "No access" takes it back', async () => {
        const { user, dispatch } = renderStage();
        const select = screen.getAllByLabelText('Role for Ann Blok')[0];
        await user.selectOptions(select, 'viewer');
        expect(screen.getByTestId('playbook-access-changes').textContent).toContain('Give Ann Blok the role "Viewer"');
        await user.selectOptions(select, '');
        expect(screen.queryByTestId('playbook-access-changes')).toBeNull();
        await user.selectOptions(select, 'viewer');
        await user.click(screen.getByTestId('playbook-access-approve'));
        await waitFor(() => expect(dispatch).toHaveBeenCalled());
        expect(assignMember).toHaveBeenCalledWith('u_ann', 'viewer');
    });

    it('a failed write is named under Approve, and the phase does not land', async () => {
        assignMember.mockRejectedValueOnce(new Error('nope'));
        const { user, dispatch } = renderStage();
        await user.selectOptions(screen.getAllByLabelText('Role for Ann Blok')[0], 'viewer');
        await user.click(screen.getByTestId('playbook-access-approve'));
        expect((await screen.findByRole('alert')).textContent).toBe('Could not apply: member:Ann Blok');
        expect(screen.queryByTestId('playbook-access-blockers')).toBeNull();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('Discard also takes away what Nextcloud answered', async () => {
        const { user, dispatch } = renderStage();
        await waitFor(() => expect(studioAppsApi.getApp).toHaveBeenCalled());
        await user.click(screen.getByTestId('playbook-access-audience-organisation'));
        await user.click(screen.getByTestId('playbook-access-nc-menu'));
        await user.click(screen.getByTestId('playbook-access-approve'));
        expect(await screen.findByTestId('playbook-access-nc-result')).toBeTruthy();
        expect(dispatch).toHaveBeenCalled();
        await user.click(screen.getByTestId('playbook-access-discard'));
        expect(screen.queryByTestId('playbook-access-nc-result')).toBeNull();
    });

    it('an app that is already published says so, with its version', async () => {
        vi.mocked(studioAppsApi.getApp).mockResolvedValueOnce({ app: { id: 'app_1', name: 'Live App', isPublished: true, publishedVersion: 3, sharedGroups: [] } });
        renderStage();
        await waitFor(() => expect(screen.getByTestId('playbook-access-publish-state').textContent).toMatch(/Published now · v3\./));
        expect(screen.getByTestId('playbook-access-now-who').textContent).toBe('Everyone in the organisation can open it');
        expect(screen.getByTestId('playbook-access-now').getAttribute('data-tone')).toBe('open');
    });
});
