import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url: string) => {
        if (url.endsWith('/shares')) {
            return { ok: true, status: 200, json: async () => ({ owner: { userId: 'u1', name: 'admin' }, shares: [], runsAs: { userId: 'u1', name: 'admin' } }) };
        }
        if (url.endsWith('/approvals/directory')) {
            return { ok: true, status: 200, json: async () => ({ groups: [{ id: 'g1', name: 'Finance', memberCount: 8 }], members: [] }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
    }),
}));

import NotificationsSection from './NotificationsSection';

const automation = { id: 'a1', title: 'Collect files', definition: { steps: [] } };

function setup(def: Record<string, unknown> = automation.definition) {
    const onSave = vi.fn(async () => undefined);
    render(withQueryClient(<NotificationsSection automation={{ ...automation, definition: def }} onSave={onSave} />));
    return { onSave, user: userEvent.setup() };
}

const lastSettings = (onSave: ReturnType<typeof vi.fn>) =>
    (onSave.mock.calls.at(-1)?.[0] as { definition: { notificationSettings: Record<string, any> } }).definition.notificationSettings;

describe('NotificationsSection', () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it('shows the overview with the quiet defaults and the note', async () => {
        setup();
        expect(screen.getByText('default: only on errors and approvals, so your bell stays quiet')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Something goes wrong via Bell in Nextcloud' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Something goes wrong via Email' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Something goes wrong via Talk' })).not.toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'Someone must approve via Talk' })).toBeChecked();
        expect(screen.getByRole('checkbox', { name: 'It worked via Bell in Nextcloud' })).not.toBeChecked();
        expect(await screen.findByText('admin (owner)')).toBeInTheDocument();
        expect(screen.getByText('The approver')).toBeInTheDocument();
    });

    it('saves the new shape into the definition when a box is ticked, keeping the rest', async () => {
        const { onSave, user } = setup();
        await user.click(screen.getByRole('checkbox', { name: 'It worked via Email' }));
        expect(onSave).toHaveBeenCalledTimes(1);
        const arg = (onSave.mock.calls[0] as unknown[])[0] as { definition: Record<string, unknown> };
        expect(arg.definition.steps).toEqual([]);
        expect(lastSettings(onSave).onSuccess).toMatchObject({ enabled: true, channels: ['email'] });
    });

    it('opens the per-event details: urgency and repeat limit save, the example names the automation', async () => {
        const { onSave, user } = setup();
        await user.click(screen.getByRole('button', { name: /How urgent \(silent/ }));
        const error = screen.getByTestId('notify-event-onError');
        expect(within(error).getByText('Collect files has stopped')).toBeInTheDocument();
        await user.click(within(error).getByRole('radio', { name: 'Normal' }));
        expect(lastSettings(onSave).onError.urgency).toBe('normal');
        await user.selectOptions(within(error).getByRole('combobox', { name: 'On repeat' }), '');
        expect(lastSettings(onSave).onError.throttle).toEqual({ maxPerHour: null });
        await user.click(within(error).getByRole('button', { name: 'Talk' }));
        expect(lastSettings(onSave).onError.channels).toEqual(['bell', 'email', 'talk']);
    });

    it('adds a group as a recipient from the people search', async () => {
        const { onSave, user } = setup();
        await user.click(screen.getByRole('button', { name: /How urgent \(silent/ }));
        const error = screen.getByTestId('notify-event-onError');
        await user.click(within(error).getByRole('button', { name: '+ add' }));
        await user.type(within(error).getByRole('combobox', { name: 'Add a person or group' }), 'fin');
        await user.click(await within(error).findByRole('button', { name: /Finance/ }));
        expect(lastSettings(onSave).onError.recipients).toEqual([{ type: 'owner' }, { type: 'group', id: 'g1' }]);
    });

    it('turns the daily summary on', async () => {
        const { onSave, user } = setup();
        await user.click(screen.getByRole('button', { name: /How urgent \(silent/ }));
        expect(screen.getByText('At 17:00 one message: how many runs, what failed, what is still waiting')).toBeInTheDocument();
        await user.click(screen.getByRole('switch', { name: 'Daily summary' }));
        expect(lastSettings(onSave).digest).toEqual({ enabled: true, time: '17:00' });
    });

    it('says so when a save fails', async () => {
        const onSave = vi.fn(async () => { throw new Error('Server said no'); });
        render(withQueryClient(<NotificationsSection automation={automation} onSave={onSave} />));
        await userEvent.setup().click(screen.getByRole('checkbox', { name: 'It worked via Talk' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Server said no');
    });
});
