import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FormAudienceCard from './FormAudienceCard';

/**
 * Who can fill the form in: a new form is the owner's alone and says so;
 * adding a person or a group PUTs the whole audience; removing is one
 * click; widening to the organisation asks first and keeps the list; a
 * refusal is shown and the list stays as the server has it; a viewer gets
 * no controls.
 */

const { api, directory } = vi.hoisted(() => ({
    api: { setFormAudience: vi.fn() },
    directory: {
        users: [{ id: 'u-pat', name: 'Pat Jansen' }, { id: 'u-sam', name: 'Sam de Boer' }],
        groups: [{ id: 'g-fin', name: 'Finance' }],
    },
}));
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));
vi.mock('../../AppStudio/rbac/useAppRoles', () => ({ useOrgDirectory: () => directory }));

const FORM = (audience: unknown) => ({ automationId: 'au1', mine: true, audience });

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    api.setFormAudience.mockImplementation(async (id, body) => ({ audience: { mode: body.audience, groups: body.sharedGroups, users: body.sharedUserIds } }));
});

describe('<FormAudienceCard>', () => {
    it('a new form: restricted, nobody yet — and adding a person and a group PUTs the whole audience', async () => {
        const user = userEvent.setup();
        render(<FormAudienceCard form={FORM({ mode: 'restricted', groups: [], users: [] })} canEdit onChanged={vi.fn()} />);
        expect((screen.getByTestId('form-audience-restricted').querySelector('input') as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText(/Nobody yet — only you can open the form/)).toBeTruthy();

        await user.click(screen.getByTestId('form-audience-add-open'));
        await user.selectOptions(screen.getByTestId('form-audience-pick'), 'u-pat');
        await user.click(screen.getByTestId('form-audience-add'));
        await waitFor(() => expect(api.setFormAudience).toHaveBeenCalledWith('au1', { audience: 'restricted', sharedGroups: [], sharedUserIds: ['u-pat'] }));
        expect((await screen.findAllByTestId('form-audience-row'))[0].textContent).toContain('Pat Jansen');

        await user.click(screen.getByTestId('form-audience-add-open'));
        await user.selectOptions(screen.getByLabelText('A person or a group'), 'group');
        await user.selectOptions(screen.getByTestId('form-audience-pick'), 'g-fin');
        await user.click(screen.getByTestId('form-audience-add'));
        await waitFor(() => expect(api.setFormAudience).toHaveBeenLastCalledWith('au1', { audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: ['u-pat'] }));
        const rows = await screen.findAllByTestId('form-audience-row');
        expect(rows.map(r => r.textContent)).toEqual([expect.stringContaining('Finance'), expect.stringContaining('Pat Jansen')]);
        expect(within(rows[0]).getByText('A group — every member')).toBeTruthy();
    });

    it('removing is one click; widening to the organisation asks first and keeps the list', async () => {
        const user = userEvent.setup();
        const onChanged = vi.fn();
        render(<FormAudienceCard form={FORM({ mode: 'restricted', groups: ['g-fin'], users: ['u-pat'] })} canEdit onChanged={onChanged} />);
        await user.click(screen.getByRole('button', { name: 'Remove Pat Jansen' }));
        await waitFor(() => expect(api.setFormAudience).toHaveBeenCalledWith('au1', { audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: [] }));
        expect(onChanged).toHaveBeenCalled();

        await user.click(screen.getByTestId('form-audience-org').querySelector('input')!);
        expect(await screen.findByText('Open the form to the whole organisation?')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Keep the list' }));
        expect(api.setFormAudience).toHaveBeenCalledTimes(1);
        expect((screen.getByTestId('form-audience-restricted').querySelector('input') as HTMLInputElement).checked).toBe(true);

        await user.click(screen.getByTestId('form-audience-org').querySelector('input')!);
        await user.click(await screen.findByRole('button', { name: 'Open to everyone' }));
        await waitFor(() => expect(api.setFormAudience).toHaveBeenLastCalledWith('au1', { audience: 'org', sharedGroups: ['g-fin'], sharedUserIds: [] }));
        // the list is hidden, not lost
        expect(screen.queryByTestId('form-audience-list')).toBeNull();
        // narrowing again needs no confirm and the group is still there
        await user.click(screen.getByTestId('form-audience-restricted').querySelector('input')!);
        await waitFor(() => expect(api.setFormAudience).toHaveBeenLastCalledWith('au1', { audience: 'restricted', sharedGroups: ['g-fin'], sharedUserIds: [] }));
        expect((await screen.findAllByTestId('form-audience-row')).length).toBe(1);
    });

    it('a refusal is shown and nothing changes on screen', async () => {
        const user = userEvent.setup();
        api.setFormAudience.mockRejectedValueOnce(Object.assign(new Error('"u-sam" is not a member of this organisation.'), { status: 400, code: 'audience_user_unknown' }));
        render(<FormAudienceCard form={FORM({ mode: 'restricted', groups: [], users: [] })} canEdit onChanged={vi.fn()} />);
        await user.click(screen.getByTestId('form-audience-add-open'));
        await user.selectOptions(screen.getByTestId('form-audience-pick'), 'u-sam');
        await user.click(screen.getByTestId('form-audience-add'));
        expect((await screen.findByRole('alert')).textContent).toContain('not a member');
        expect(screen.queryByTestId('form-audience-row')).toBeNull();
    });

    it('a viewer sees the answer but gets no controls', () => {
        render(<FormAudienceCard form={FORM({ mode: 'restricted', groups: ['g-fin'], users: [] })} canEdit={false} />);
        expect((screen.getByTestId('form-audience-restricted').querySelector('input') as HTMLInputElement).disabled).toBe(true);
        expect(screen.queryByTestId('form-audience-add-open')).toBeNull();
        expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    });
});
