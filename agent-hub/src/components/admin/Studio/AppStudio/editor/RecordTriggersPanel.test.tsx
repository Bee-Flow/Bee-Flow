import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecordTriggersPanel from './RecordTriggersPanel';
import ServerTriggersPanel from './ServerTriggersPanel';
import type { TriggersApi } from './serverTriggersApi';
import type { AppTable } from '../bi/useAppTables';
import { definitionTriggers } from '../state/serverTriggerOps';
import { withEvent, withField, withTable, type RecordTrigger } from '../state/recordTriggerOps';
import type { AppDefinition } from '../inspector/appDefinition';
import { renderWithClient } from '@/test/render';

const TABLES: AppTable[] = [
    { id: 'tbl_orders', key: 'orders', name: 'Orders', fields: [{ key: 'title', name: 'Title', type: 'text' }, { key: 'status', name: 'Status', type: 'text' }] },
    { id: 'tbl_log', key: 'log', name: 'Log', fields: [{ key: 'note', name: 'Note', type: 'text' }] },
];
const DEF = (triggers?: unknown[]): AppDefinition => ({
    schemaVersion: 3, screens: [], actions: { act_job1: { kind: 'sequence', steps: [] }, act_other: { kind: 'sequence', steps: [] } },
    ...(triggers ? { triggers } : {}),
} as unknown as AppDefinition);
const ON_ORDERS: RecordTrigger = { id: 'trigger1', kind: 'record', actionId: 'act_job1', tableId: 'tbl_orders', on: ['create'] };
const HOURLY = { id: 'tick', kind: 'schedule', actionId: 'act_job1', schedule: { everyMinutes: 60 } };

let api: { list: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> };
function mount(definition: AppDefinition, tables: AppTable[] = TABLES) {
    const onCommit = vi.fn();
    renderWithClient(<RecordTriggersPanel appId="app1" definition={definition} onCommit={onCommit} api={api as unknown as TriggersApi} tables={tables} />);
    return onCommit;
}
const last = (onCommit: ReturnType<typeof vi.fn>) => definitionTriggers(onCommit.mock.calls.at(-1)?.[0]);

beforeEach(() => {
    cleanup();
    api = { list: vi.fn().mockResolvedValue({ published: false, triggers: [] }), setEnabled: vi.fn() };
});

describe('<RecordTriggersPanel>', () => {
    it('says that the action runs as the owner whoever changed the row, and which changes start it; without a record trigger it asks the server nothing', () => {
        mount(DEF([HOURLY]));
        expect(screen.getByTestId('record-triggers-runs-as').textContent).toContain('runs as the owner of this app, whoever changed the row');
        const fires = screen.getByTestId('record-triggers-fires-on').textContent ?? '';
        expect(fires).toContain('a change someone makes in the app');
        expect(fires).toContain('does not start on imports');
        expect(fires).toContain('never starts on a row its own run changed');
        expect(api.list).not.toHaveBeenCalled();
        expect(document.querySelector('[data-app-trigger="tick"]')).toBeNull();
    });

    it('adds a record trigger on the first table and action, after the triggers of other kinds', async () => {
        const onCommit = mount(DEF([HOURLY]));
        await userEvent.setup().click(screen.getByRole('button', { name: 'Add a record trigger' }));
        expect(last(onCommit)).toEqual([HOURLY, ON_ORDERS]);
    });

    it('an app without tables cannot add one and says why', () => {
        mount(DEF(), []);
        expect(screen.queryByRole('button', { name: 'Add a record trigger' })).toBeNull();
        expect(screen.getByTestId('logic-record-triggers').textContent).toContain('Add a table to the app first');
    });

    it('edits the table, the events, the watched fields, the condition and the opt-in for public writes; the schedule beside it is left alone', async () => {
        const user = userEvent.setup();
        const onCommit = mount(DEF([HOURLY, ON_ORDERS]));
        const row = within(document.querySelector('[data-app-trigger="trigger1"]') as HTMLElement);
        await user.click(row.getByLabelText('Changed'));
        expect(last(onCommit)[1].on).toEqual(['create', 'update']);
        expect(last(onCommit)[0]).toEqual(HOURLY);
        await user.type(row.getByLabelText('Only if (formula)'), 'x');
        expect(last(onCommit)[1].when).toBe('x');
        await user.click(row.getByLabelText('Also start on changes by visitors of a public page'));
        expect(last(onCommit)[1].allowPublicWrites).toBe(true);
        await user.selectOptions(row.getByLabelText('Table to watch'), 'tbl_log');
        expect(last(onCommit)[1].tableId).toBe('tbl_log');
        await user.click(row.getByRole('button', { name: 'Remove this trigger' }));
        expect(last(onCommit)).toEqual([HOURLY]);
    });

    it('shows the watched fields only for the update event, and the warning only with the opt-in', () => {
        mount(DEF([{ ...ON_ORDERS, on: ['update'], fields: ['status'], allowPublicWrites: true }]));
        expect((screen.getByLabelText('Status') as HTMLInputElement).checked).toBe(true);
        expect((screen.getByLabelText('Title') as HTMLInputElement).checked).toBe(false);
        expect(screen.getByRole('note').textContent).toContain('may not send e-mail');
    });

    it('the schedule panel lists no record trigger and keeps it when it edits its own', async () => {
        const onCommit = vi.fn();
        renderWithClient(<ServerTriggersPanel appId="app1" definition={DEF([ON_ORDERS, HOURLY])} onCommit={onCommit} api={api as unknown as TriggersApi} />);
        expect(document.querySelector('[data-app-trigger="trigger1"]')).toBeNull();
        await userEvent.setup().click(screen.getByLabelText('On when published'));
        expect(last(onCommit)).toEqual([ON_ORDERS, { ...HOURLY, enabled: false }]);
    });
});

describe('recordTriggerOps', () => {
    it('the last event stays on, and the watched fields go with the update event and with the table', () => {
        expect(withEvent(ON_ORDERS, 'create', false)).toBe(ON_ORDERS);
        const watching = withField(withEvent(ON_ORDERS, 'update', true), 'status', true);
        expect(watching.fields).toEqual(['status']);
        expect('fields' in withEvent(watching, 'update', false)).toBe(false);
        expect('fields' in withTable(watching, 'tbl_log')).toBe(false);
        expect('fields' in withField(watching, 'status', false)).toBe(false);
    });
});
