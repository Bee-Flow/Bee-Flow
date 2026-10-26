/**
 * The destination menu on an action card (plan M3).
 *
 * ── WHAT THIS FILE IS GUARDING ──────────────────────────────────────
 * A destination is a claim: "this action became a run / a row / a knowledge
 * source". The chip is the only place that claim is ever visible again, and
 * nothing on the card re-checks it. So the ONE rule underneath every test here
 * is that the chip is recorded strictly AFTER the destination's own route
 * answered — never optimistically, never on a failure, and never with a run id
 * that does not exist.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

const run = vi.fn();
const listAutomations = vi.fn();
vi.mock('../../../hooks/useAutomationApi', () => ({
    default: () => ({ listAutomations: (...a) => listAutomations(...a), run: (...a) => run(...a) }),
}));

const tableList = vi.fn();
const getSchema = vi.fn();
const addRow = vi.fn();
vi.mock('../../../components/admin/Studio/Datatables/datatablesApi', () => ({
    datatablesApi: {
        list: (...a) => tableList(...a),
        getSchema: (...a) => getSchema(...a),
        addRow: (...a) => addRow(...a),
    },
}));

const kbList = vi.fn();
const createSource = vi.fn();
vi.mock('../../../components/admin/Studio/KnowledgeStudio/knowledgeApi', () => {
    const api = { list: (...a) => kbList(...a), createSource: (...a) => createSource(...a) };
    return { default: api, knowledgeApi: api };
});

import DestinationPicker from './DestinationPicker';

const item = {
    id: 'u-42',
    text: 'Testlink versturen',
    assignee: 'Tom',
    due: '2026-07-28',
    timestamp: '38:20',
    done: false,
    source: 'user',
    segmentIndex: 12,
};
const meeting = { id: 'm-1', title: 'Weekly sync', createdAt: '2026-07-27T09:30:00.000Z' };

function open(props = {}) {
    const onPicked = vi.fn();
    render(<DestinationPicker item={item} meeting={meeting} onPicked={onPicked} {...props} />);
    fireEvent.click(screen.getByTestId('action-destination-chip'));
    return onPicked;
}

beforeEach(() => {
    for (const fn of [run, listAutomations, tableList, getSchema, addRow, kbList, createSource]) fn.mockReset();
    listAutomations.mockResolvedValue({
        automations: [
            { id: 'a-1', title: 'Testlink versturen', definition: { trigger: { kind: 'manual' } } },
            { id: 'a-2', title: 'Ask the agent', definition: { trigger: { kind: 'agent_call' } } },
            { id: 'a-3', title: 'Nightly digest', definition: { trigger: { kind: 'schedule' } } },
            { id: 'a-4', title: 'On new mail', definition: { trigger: { kind: 'app_event' } } },
        ],
    });
    tableList.mockResolvedValue({
        datatables: [
            { id: 't-1', name: 'Backlog', grade: 'editor' },
            { id: 't-2', name: 'Read only', grade: 'viewer' },
            { id: 't-3', name: 'HTTP cache', grade: 'owner', managedKind: 'http_cache' },
        ],
    });
    getSchema.mockResolvedValue({
        fields: [
            { key: 'title', type: 'text', label: 'Title' },
            { key: 'owner', type: 'text', label: 'Owner' },
            { key: 'amount', type: 'number', label: 'Amount' },
        ],
    });
    addRow.mockResolvedValue({ ok: true, id: 'row-7' });
    kbList.mockResolvedValue([{ id: 'kb-1', name: 'Offertevoorwaarden' }]);
    createSource.mockResolvedValue({ source: { id: 'src-3' } });
});

describe('DestinationPicker — the menu', () => {
    it('offers the three destinations M3 can actually deliver', () => {
        open();
        expect(screen.getByText('Start an automation')).toBeTruthy();
        expect(screen.getByText('Row in a table')).toBeTruthy();
        expect(screen.getByText('To a knowledge base')).toBeTruthy();
    });

    /**
     * The artboard also draws "Taak in Cowork" and "Alles naar taken". There is
     * no task entity behind either, and a menu item that cannot do what it
     * says is worse than a missing one — so their absence is deliberate and
     * pinned, not an oversight for a later reader to "fix".
     */
    it('does NOT offer a Cowork task — there is no task entity to make one out of', () => {
        open();
        expect(screen.queryByText(/task/i)).toBeNull();
        expect(screen.queryByText(/cowork/i)).toBeNull();
    });

    it('loads a branch only when it is opened, and only once', async () => {
        const user = userEvent.setup();
        open();
        expect(listAutomations).not.toHaveBeenCalled();
        await user.click(screen.getByText('Start an automation'));
        await screen.findByText('Testlink versturen');
        await user.click(screen.getByText('Back'));
        await user.click(screen.getByText('Start an automation'));
        await screen.findByText('Testlink versturen');
        expect(listAutomations).toHaveBeenCalledTimes(1);
        expect(tableList).not.toHaveBeenCalled();
        expect(kbList).not.toHaveBeenCalled();
    });
});

describe('DestinationPicker — start an automation', () => {
    it('offers only automations that can be started by hand', async () => {
        const user = userEvent.setup();
        open();
        await user.click(screen.getByText('Start an automation'));
        expect(await screen.findByText('Testlink versturen')).toBeTruthy();
        expect(screen.getByText('Ask the agent')).toBeTruthy();
        expect(screen.queryByText('Nightly digest')).toBeNull();
        expect(screen.queryByText('On new mail')).toBeNull();
    });

    it('leaves out an automation the server says this person may not start (a view share)', async () => {
        const user = userEvent.setup();
        listAutomations.mockResolvedValue({
            automations: [
                { id: 'a-1', title: 'Shared to view', canStart: false, definition: { trigger: { kind: 'manual' } } },
                { id: 'a-2', title: 'Shared to run', canStart: true, definition: { trigger: { kind: 'manual' } } },
                { id: 'a-5', title: 'Older server', definition: { trigger: { kind: 'manual' } } },
            ],
        });
        open();
        await user.click(screen.getByText('Start an automation'));
        expect(await screen.findByText('Shared to run')).toBeTruthy();
        expect(screen.getByText('Older server')).toBeTruthy();
        expect(screen.queryByText('Shared to view')).toBeNull();
    });

    it('says the friendly sentence when the start is still refused (automation_run_forbidden)', async () => {
        const user = userEvent.setup();
        run.mockRejectedValue(Object.assign(new Error('raw'), { code: 'automation_run_forbidden' }));
        const onPicked = open();
        await user.click(screen.getByText('Start an automation'));
        await user.click(await screen.findByText('Testlink versturen'));
        expect(await screen.findByRole('alert')).toHaveTextContent('You can view this automation but not start it. Ask the owner for run access.');
        expect(onPicked).not.toHaveBeenCalled();
    });

    it('runs it with the allow-listed payload and records the run', async () => {
        const user = userEvent.setup();
        run.mockResolvedValue({ accepted: true, run: { id: 'run-9' } });
        const onPicked = open();
        await user.click(screen.getByText('Start an automation'));
        await user.click(await screen.findByText('Testlink versturen'));
        await waitFor(() => expect(onPicked).toHaveBeenCalled());

        const [id, body] = run.mock.calls[0];
        expect(id).toBe('a-1');
        expect(body.triggerPayload.action).toEqual({
            text: 'Testlink versturen', assignee: 'Tom', due: '2026-07-28', timestamp: '38:20',
        });
        expect(body.triggerPayload.meeting).toEqual({ id: 'm-1', title: 'Weekly sync', date: '2026-07-27' });
        // The bookkeeping of an action item is not part of the action.
        expect(JSON.stringify(body)).not.toMatch(/segmentIndex|"u-42"/);

        const dest = onPicked.mock.calls[0][0];
        expect(dest.kind).toBe('automation');
        expect(dest.ref).toBe('a-1');
        expect(dest.itemRef).toBe('run-9');
    });

    it('still records the destination when the run outlived its window (202, no run id)', async () => {
        const user = userEvent.setup();
        // The run really started. Refusing to record it, or inventing an id
        // for the chip to link to, would both be lies.
        run.mockResolvedValue({ accepted: true, pending: true });
        const onPicked = open();
        await user.click(screen.getByText('Start an automation'));
        await user.click(await screen.findByText('Testlink versturen'));
        await waitFor(() => expect(onPicked).toHaveBeenCalled());
        const dest = onPicked.mock.calls[0][0];
        expect(dest.ref).toBe('a-1');
        expect(dest).not.toHaveProperty('itemRef');
    });

    /** THE BITE: a chip is a claim, and a refused run is not one. */
    it('records NOTHING when the run is refused, and says why', async () => {
        const user = userEvent.setup();
        run.mockRejectedValue(new Error('Forbidden'));
        const onPicked = open();
        await user.click(screen.getByText('Start an automation'));
        await user.click(await screen.findByText('Testlink versturen'));
        expect(await screen.findByRole('alert')).toHaveTextContent(/Forbidden/);
        expect(onPicked).not.toHaveBeenCalled();
    });

    it('says so when the list cannot be loaded, instead of showing an empty one', async () => {
        const user = userEvent.setup();
        listAutomations.mockRejectedValue(new Error('offline'));
        open();
        await user.click(screen.getByText('Start an automation'));
        expect(await screen.findByRole('alert')).toHaveTextContent(/offline/);
    });
});

describe('DestinationPicker — row in a table', () => {
    it('offers only tables a row may actually be added to', async () => {
        const user = userEvent.setup();
        open();
        await user.click(screen.getByText('Row in a table'));
        expect(await screen.findByText('Backlog')).toBeTruthy();
        // Below `editor` the insert is refused; a managed table's columns are
        // a platform contract, not a place to file a meeting action.
        expect(screen.queryByText('Read only')).toBeNull();
        expect(screen.queryByText('HTTP cache')).toBeNull();
    });

    it('maps the action text into the first sentence column and writes the row', async () => {
        const user = userEvent.setup();
        const onPicked = open();
        await user.click(screen.getByText('Row in a table'));
        await user.click(await screen.findByText('Backlog'));
        // The default mapping is text → first text column, and nothing else.
        const ownerSelect = await screen.findByLabelText('Owner');
        expect(screen.getByLabelText('Title').value).toBe('text');
        expect(ownerSelect.value).toBe('');
        // A column that cannot hold a string is not offered at all.
        expect(screen.queryByLabelText('Amount')).toBeNull();

        fireEvent.change(ownerSelect, { target: { value: 'assignee' } });
        await user.click(screen.getByText('Add the row'));
        await waitFor(() => expect(addRow).toHaveBeenCalled());
        expect(addRow).toHaveBeenCalledWith('t-1', { title: 'Testlink versturen', owner: 'Tom' });

        const dest = onPicked.mock.calls[0][0];
        expect(dest).toMatchObject({ kind: 'datatable_row', ref: 't-1', label: 'Backlog', itemRef: 'row-7' });
    });

    it('records nothing when the insert is refused', async () => {
        const user = userEvent.setup();
        addRow.mockRejectedValue(new Error('You cannot add rows to this table'));
        const onPicked = open();
        await user.click(screen.getByText('Row in a table'));
        await user.click(await screen.findByText('Backlog'));
        await user.click(await screen.findByText('Add the row'));
        expect(await screen.findByRole('alert')).toHaveTextContent(/cannot add rows/);
        expect(onPicked).not.toHaveBeenCalled();
    });
});

describe('DestinationPicker — to a knowledge base', () => {
    it('files the action as a text source and records the source it made', async () => {
        const user = userEvent.setup();
        const onPicked = open();
        await user.click(screen.getByText('To a knowledge base'));
        await user.click(await screen.findByText('Offertevoorwaarden'));
        await waitFor(() => expect(createSource).toHaveBeenCalled());

        const [kbId, body] = createSource.mock.calls[0];
        expect(kbId).toBe('kb-1');
        expect(body.kind).toBe('text');
        expect(body.config.text).toContain('Testlink versturen');
        expect(body.config.text).toContain('Owner: Tom');
        expect(JSON.stringify(body)).not.toMatch(/segmentIndex|"u-42"/);

        expect(onPicked.mock.calls[0][0]).toMatchObject({ kind: 'kb', ref: 'kb-1', itemRef: 'src-3' });
    });

    it('records nothing when the licence caps the source count', async () => {
        const user = userEvent.setup();
        createSource.mockRejectedValue(new Error('This plan allows 3 knowledge sources per knowledge base.'));
        const onPicked = open();
        await user.click(screen.getByText('To a knowledge base'));
        await user.click(await screen.findByText('Offertevoorwaarden'));
        expect(await screen.findByRole('alert')).toHaveTextContent(/This plan allows 3/);
        expect(onPicked).not.toHaveBeenCalled();
    });
});

describe('DestinationPicker — an existing destination', () => {
    const withDest = {
        ...item,
        destination: { kind: 'datatable_row', ref: 't-1', label: 'Backlog', at: '2026-07-27T10:00:00.000Z', itemRef: 'row-7' },
    };

    it('names it on the chip', () => {
        render(<DestinationPicker item={withDest} meeting={meeting} onPicked={vi.fn()} />);
        expect(screen.getByTestId('action-destination-chip').textContent).toContain('Row in table Backlog');
    });

    it('can forget it — a change to the note, not an undo of the row', async () => {
        const user = userEvent.setup();
        const onPicked = vi.fn();
        render(<DestinationPicker item={withDest} meeting={meeting} onPicked={onPicked} />);
        await user.click(screen.getByTestId('action-destination-chip'));
        await user.click(screen.getByText('Remove destination'));
        await waitFor(() => expect(onPicked).toHaveBeenCalledWith(null));
        // Nothing is deleted anywhere: the row that was written stays written.
        expect(addRow).not.toHaveBeenCalled();
    });

    it('offers nothing to forget when there is no destination', () => {
        open();
        expect(screen.queryByText('Remove destination')).toBeNull();
    });
});
