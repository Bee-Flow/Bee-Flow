import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ServerTriggersPanel from './ServerTriggersPanel';
import type { TriggerState, TriggerView, TriggersApi } from './serverTriggersApi';
import { definitionTriggers, setTriggers, withEnabled } from '../state/serverTriggerOps';
import type { AppDefinition } from '../inspector/appDefinition';
import { renderWithClient } from '@/test/render';

const DEF = (triggers?: unknown[]): AppDefinition => ({
    schemaVersion: 2, screens: [], actions: { act_job1: { kind: 'sequence', steps: [] }, act_other: { kind: 'sequence', steps: [] } },
    ...(triggers ? { triggers } : {}),
} as unknown as AppDefinition);
const HOURLY = { id: 'trigger1', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 60 } };
const VIEW = (over: Partial<TriggerView> = {}): TriggerView => ({
    id: 'trigger1', kind: 'schedule', actionId: 'act_job1', armed: true, state: 'armed', pausedCode: null, pausedReason: null, live: true,
    nextFireAt: '2026-11-12T08:00:00.000Z', lastFiredAt: null, lastRunId: null, lastStatus: null, lastError: null, consecutiveFailures: 0, ...over,
});

let api: { list: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> };
const state = (s: TriggerState) => api.list.mockResolvedValue(s);
function mount(definition: AppDefinition) {
    const onCommit = vi.fn();
    renderWithClient(<ServerTriggersPanel appId="app1" definition={definition} onCommit={onCommit} api={api as unknown as TriggersApi} />);
    return onCommit;
}

beforeEach(() => {
    cleanup();
    api = { list: vi.fn(), setEnabled: vi.fn().mockResolvedValue({ trigger: VIEW() }) };
    state({ published: false, triggers: [] });
});

describe('<ServerTriggersPanel>', () => {
    it('says plainly that a trigger runs as the owner and only once the app is published; an app without triggers asks the server nothing', () => {
        mount(DEF());
        expect(screen.getByTestId('triggers-runs-as').textContent).toContain('runs as the owner of this app');
        expect(screen.getByTestId('logic-server-triggers').textContent).toContain('only runs once the app is published');
        expect(api.list).not.toHaveBeenCalled();
    });

    it('adds a schedule to the draft: every hour, on the first action', async () => {
        const onCommit = mount(DEF());
        await userEvent.setup().click(screen.getByRole('button', { name: 'Add a schedule' }));
        expect(definitionTriggers(onCommit.mock.calls[0][0])).toEqual([HOURLY]);
    });

    it('edits the schedule, the action and whether it is on; removing the last trigger removes the key', async () => {
        const user = userEvent.setup();
        const onCommit = mount(DEF([HOURLY]));
        await user.selectOptions(screen.getByLabelText('How the times are given'), 'cron');
        expect(definitionTriggers(onCommit.mock.calls[0][0])[0].schedule).toMatchObject({ cron: '0 8 * * 1-5' });
        await user.selectOptions(screen.getByLabelText('Action to run'), 'act_other');
        expect(definitionTriggers(onCommit.mock.calls[1][0])[0].actionId).toBe('act_other');
        await user.click(screen.getByLabelText('On when published'));
        expect(definitionTriggers(onCommit.mock.calls[2][0])[0].enabled).toBe(false);
        await user.click(screen.getByRole('button', { name: 'Remove this trigger' }));
        expect('triggers' in onCommit.mock.calls[3][0]).toBe(false);
    });

    it('a draft shows the trigger as not armed', async () => {
        mount(DEF([HOURLY]));
        const row = await screen.findByText('Not armed. A trigger only runs once the app is published.');
        expect(row.getAttribute('data-trigger-state')).toBe('none');
        expect(api.list).toHaveBeenCalledWith('app1');
    });

    it('a published app shows armed, the next run and the last one, and switches a trigger off', async () => {
        state({ published: true, triggers: [VIEW({ lastFiredAt: '2026-11-11T08:00:00.000Z', lastStatus: 'success' })] });
        mount(DEF([HOURLY]));
        const row = (await screen.findByText('Armed')).closest('[data-app-trigger]') as HTMLElement;
        expect(row.textContent).toContain('Next run');
        expect(row.textContent).toContain('finished');
        await userEvent.setup().click(within(row).getByRole('button', { name: 'Switch off' }));
        await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith('app1', 'trigger1', false));
    });

    it('a trigger paused after failures says why and can be switched on again; a changed draft says the old one still runs', async () => {
        state({ published: true, triggers: [VIEW({ armed: false, state: 'paused', pausedCode: 'failures', consecutiveFailures: 5, nextFireAt: null, lastFiredAt: '2026-11-11T08:00:00.000Z', lastStatus: 'error', lastError: 'The table is gone.', live: false })] });
        mount(DEF([HOURLY]));
        const row = (await screen.findByText('Paused')).closest('[data-app-trigger]') as HTMLElement;
        expect(row.textContent).toContain('Paused after 5 failed runs in a row');
        expect(row.textContent).toContain('The table is gone.');
        expect(row.textContent).toContain('still runs the old one until you publish again');
        await userEvent.setup().click(within(row).getByRole('button', { name: 'Switch on again' }));
        await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith('app1', 'trigger1', true));
    });
});

describe('serverTriggerOps', () => {
    it('an empty list removes the key and leaves an app without triggers untouched; enabled is only stored as false', () => {
        const bare = DEF();
        expect(setTriggers(bare, [])).toBe(bare);
        expect('triggers' in setTriggers(DEF([HOURLY]), [])).toBe(false);
        expect(withEnabled({ ...HOURLY, enabled: false }, true)).toEqual(HOURLY);
        expect(withEnabled(HOURLY, false)).toEqual({ ...HOURLY, enabled: false });
    });
});
