import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch }));

import StartSection from './StartSection';

const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });

const manual = {
    id: 'a1',
    title: 'Collect files',
    isActive: false,
    definition: { trigger: { id: 't1', type: 'trigger', kind: 'manual', label: 'Manual' }, steps: [{ id: 's1' }] },
};

describe('Settings › Start', () => {
    beforeEach(() => {
        authFetch.mockReset();
        authFetch.mockImplementation((url: string) => (url.endsWith('/_schedule/preview')
            ? json({ valid: true, next: ['2026-09-29T05:00:00.000Z', '2026-09-30T05:00:00.000Z', '2026-10-01T05:00:00.000Z'] })
            : json({ triggers: [] })));
    });

    it('shows the current start, and offers nothing about Nextcloud Files', () => {
        render(withQueryClient(<StartSection automation={manual} onSave={vi.fn()} />));
        expect(screen.getByText('Start: manual')).toBeTruthy();
        expect(screen.getByText('Only when someone starts it', { exact: false })).toBeTruthy();
        expect(screen.queryByText('Start from Nextcloud Files')).toBeNull();
    });

    it('changes the start to a weekday schedule in words, with the next runs and holidays skipped', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(withQueryClient(<StartSection automation={manual} onSave={onSave} />));
        await user.click(screen.getByRole('button', { name: 'change' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText('When should this start?')).toBeTruthy();
        expect(within(dialog).getAllByRole('radio')).toHaveLength(6);
        await user.click(within(dialog).getByRole('radio', { name: /At a set time/ }));
        expect(within(dialog).getByRole('combobox', { name: 'How often' })).toHaveProperty('value', 'weekday');
        expect(await within(dialog).findByText(/Next runs: Tue 29 Sept? 07:00 · Wed 30 Sept? 07:00/)).toBeTruthy();
        const previewBody = JSON.parse(authFetch.mock.calls.find(([u]) => String(u).endsWith('/_schedule/preview'))![1].body);
        expect(previewBody).toEqual({ cron: '0 7 * * 1,2,3,4,5', tz: 'Europe/Amsterdam', count: 3 });

        await user.click(within(dialog).getByRole('checkbox', { name: 'Skip public holidays' }));
        await user.click(within(dialog).getByRole('button', { name: 'Show cron notation' }));
        expect(within(dialog).getByRole('textbox', { name: 'Cron notation' })).toHaveProperty('value', '0 7 * * 1,2,3,4,5');
        expect(within(dialog).getByText('The start card on the canvas changes too')).toBeTruthy();
        await user.click(within(dialog).getByRole('button', { name: 'Set start' }));

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        const trigger = onSave.mock.calls[0][0].definition.trigger;
        expect(trigger).toMatchObject({ id: 't1', kind: 'schedule', label: 'Schedule' });
        expect(trigger.schedule).toEqual({ cron: '0 7 * * 1,2,3,4,5', tz: 'Europe/Amsterdam', skipHolidays: true });
        // The rest of the definition travels along untouched.
        expect(onSave.mock.calls[0][0].definition.steps).toEqual([{ id: 's1' }]);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

});
