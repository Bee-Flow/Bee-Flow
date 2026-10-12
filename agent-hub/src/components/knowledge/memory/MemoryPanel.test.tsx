import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { Toaster } from '../../shared/Toast';
import MemoryPanel, { type MemoryPanelProps } from './MemoryPanel';
import { mem, mockApi, page, respond } from './testApi';

const M1 = mem({ id: 'm1', content: 'I prefer Dutch', type: 'preference', origin: 'explicit', last_used_at: '2026-08-02T00:00:00Z' });
const M2 = mem({
    id: 'm2', content: 'Works at Bee Flow', origin: 'inferred', agent_id: 'a1', agent_name: 'Helper',
    source_conversation_id: 'c9', source_conversation_kind: 'direct',
});
const M3 = mem({
    id: 'm3', content: 'Uses Postgres', origin: 'tool', project_id: 'p1', project_name: 'Atlas',
    source_conversation_id: 'c7', source_conversation_kind: 'agent', agent_id: 'a2',
});
const LIST = [M1, M2];

const listRoute = (items = LIST, extra = {}) => ({ 'GET /': () => page(items, extra) });

const setup = (props: Partial<MemoryPanelProps> = {}) => render(
    <>
        <MemoryPanel onClose={vi.fn()} {...props} />
        <Toaster />
    </>,
);

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('MemoryPanel: rows', () => {
    it('shows content, type, origin, last used and links to the source chat', async () => {
        mockApi({ 'GET /': () => page([M1, M2, M3]) });
        setup();
        const r1 = await screen.findByTestId('memory-item-m1');
        expect(within(r1).getByText('I prefer Dutch')).toBeInTheDocument();
        expect(within(r1).getByText('Preference')).toBeInTheDocument();
        expect(within(r1).getByText('You added')).toBeInTheDocument();
        expect(within(r1).getByText(/Last used/)).toBeInTheDocument();
        expect(within(r1).queryByRole('link')).not.toBeInTheDocument();

        const r2 = screen.getByTestId('memory-item-m2');
        expect(within(r2).getByText('Learned in chat')).toBeInTheDocument();
        expect(within(r2).getByText('Never used')).toBeInTheDocument();
        expect(within(r2).getByText('Helper')).toBeInTheDocument();
        expect(within(r2).getByRole('link', { name: /Learned in this chat/ })).toHaveAttribute('href', '/app/d/c9');

        const r3 = screen.getByTestId('memory-item-m3');
        expect(within(r3).getByText('Saved by assistant')).toBeInTheDocument();
        expect(within(r3).getByText('Atlas')).toBeInTheDocument();
        expect(within(r3).getByRole('link', { name: /Open source chat/ })).toHaveAttribute('href', '/app/a/a2/c7');
    });

    it('has a labelled region with a heading that takes focus', async () => {
        mockApi(listRoute());
        setup();
        const region = await screen.findByRole('region', { name: 'Memory' });
        expect(region).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Memory' })).toHaveFocus();
    });

    it('closes on Escape only when it is a full page', async () => {
        mockApi(listRoute());
        const user = userEvent.setup();
        const onClose = vi.fn();
        const { unmount } = setup({ onClose });
        await screen.findByTestId('memory-item-m1');
        await user.keyboard('{Escape}');
        expect(onClose).toHaveBeenCalledTimes(1);
        unmount();

        const embeddedClose = vi.fn();
        setup({ onClose: embeddedClose, embedded: true });
        await screen.findByTestId('memory-item-m1');
        await user.keyboard('{Escape}');
        expect(embeddedClose).not.toHaveBeenCalled();
    });

    it('keeps edit and delete visible and reachable with the keyboard', async () => {
        mockApi(listRoute());
        const user = userEvent.setup();
        setup();
        const row = await screen.findByTestId('memory-item-m1');
        const edit = within(row).getByRole('button', { name: /Edit memory: I prefer Dutch/ });
        expect(edit).toBeVisible();
        expect(edit.parentElement?.className).not.toMatch(/opacity-0|hidden/);
        edit.focus();
        await user.tab();
        expect(within(row).getByRole('button', { name: /Delete memory/ })).toHaveFocus();
    });
});

describe('MemoryPanel: loading and errors', () => {
    it('recovers from a failed load with Retry', async () => {
        const api = mockApi({ 'GET /': () => respond({}, 500) });
        const user = userEvent.setup();
        setup();
        expect(await screen.findByText('Failed to load memories')).toBeInTheDocument();
        api.spy.mockClear();
        mockApi(listRoute());
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByTestId('memory-item-m1')).toBeInTheDocument();
        expect(screen.queryByText('Failed to load memories')).not.toBeInTheDocument();
    });

    it('treats a 403 as lost access and drops stale rows', async () => {
        mockApi({ 'GET /': () => respond({ error: 'nope' }, 403) });
        setup();
        expect(await screen.findByText(/no longer have access/)).toBeInTheDocument();
        expect(screen.queryByTestId('memory-item-m1')).not.toBeInTheDocument();
    });

    it('shows the empty state', async () => {
        mockApi(listRoute([]));
        setup();
        expect(await screen.findByText('No memories yet')).toBeInTheDocument();
    });
});

describe('MemoryPanel: filters', () => {
    it('sends type, source, sort and a debounced search to the server', async () => {
        const api = mockApi(listRoute());
        const user = userEvent.setup();
        setup();
        await screen.findByTestId('memory-item-m1');
        expect(api.lastList()?.query.get('scope')).toBe('personal');
        expect(api.lastList()?.query.get('status')).toBe('active');
        expect(api.lastList()?.query.get('sort')).toBe('recent');

        await user.click(await screen.findByRole('button', { name: /Facts/ }));
        await waitFor(() => expect(api.lastList()?.query.get('type')).toBe('fact'));

        await user.click(screen.getByRole('radio', { name: 'Agents' }));
        await waitFor(() => expect(api.lastList()?.query.get('scope')).toBe('agent'));

        await user.selectOptions(screen.getByLabelText('Sort by'), 'importance');
        await waitFor(() => expect(api.lastList()?.query.get('sort')).toBe('importance'));

        const before = api.calls.length;
        await user.type(screen.getByLabelText('Search memories'), 'dutch');
        expect(api.calls.length).toBe(before); // debounced: nothing yet
        await waitFor(() => expect(api.lastList()?.query.get('search')).toBe('dutch'), { timeout: 2000 });
    });

    it('marks the active type pill with aria-pressed', async () => {
        mockApi(listRoute());
        const user = userEvent.setup();
        setup();
        const facts = await screen.findByRole('button', { name: /Facts/ });
        expect(facts).toHaveAttribute('aria-pressed', 'false');
        await user.click(facts);
        await waitFor(() => expect(screen.getByRole('button', { name: /Facts/ })).toHaveAttribute('aria-pressed', 'true'));
    });

    it('offers the Project source only inside a project', async () => {
        mockApi(listRoute());
        const { unmount } = setup();
        await screen.findByTestId('memory-item-m1');
        expect(screen.queryByRole('radio', { name: 'Project' })).not.toBeInTheDocument();
        unmount();
        const api = mockApi(listRoute());
        setup({ projectId: 'p1' });
        await screen.findByTestId('memory-item-m1');
        expect(screen.getByRole('radio', { name: 'Project' })).toBeChecked();
        expect(api.lastList()?.query.get('scope')).toBe('project');
        expect(api.lastList()?.query.get('projectId')).toBe('p1');
    });
});

describe('MemoryPanel: edit', () => {
    it('PUTs the changed content, type and importance', async () => {
        const api = mockApi({
            ...listRoute(),
            'PUT /m1': (c) => respond({ success: true, memory: { ...M1, ...(c.body as object) } }),
        });
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('button', { name: /Edit memory: I prefer Dutch/ }));
        const box = screen.getByRole('textbox', { name: 'Memory' });
        await user.clear(box);
        await user.type(box, 'I prefer English');
        await user.selectOptions(screen.getByLabelText('Type'), 'instruction');
        fireEvent.change(screen.getByLabelText(/Importance/), { target: { value: '0.9' } });
        await user.click(screen.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(api.find('PUT', '/m1')).toHaveLength(1));
        expect(api.find('PUT', '/m1')[0].body).toEqual({ content: 'I prefer English', type: 'instruction', importance: 0.9 });
        expect(await screen.findByText('I prefer English')).toBeInTheDocument();
        expect(await screen.findByText('Memory saved')).toBeInTheDocument();
    });

    it('rolls back and says so when the save fails', async () => {
        mockApi({ ...listRoute(), 'PUT /m1': () => respond({}, 500) });
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('button', { name: /Edit memory: I prefer Dutch/ }));
        const box = screen.getByRole('textbox', { name: 'Memory' });
        await user.clear(box);
        await user.type(box, 'Changed');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText(/Could not save this memory/)).toBeInTheDocument();
        expect(screen.getByText('I prefer Dutch')).toBeInTheDocument();
    });

    it('cancels with Escape without closing the panel', async () => {
        mockApi(listRoute());
        const onClose = vi.fn();
        const user = userEvent.setup();
        setup({ onClose });
        await user.click(await screen.findByRole('button', { name: /Edit memory: I prefer Dutch/ }));
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('textbox', { name: 'Memory' })).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('MemoryPanel: delete and bulk', () => {
    const confirmBtn = () => screen.findByTestId('confirm-dialog-confirm');

    it('asks in the app dialog, then deletes', async () => {
        const native = vi.fn(() => true);
        vi.stubGlobal('confirm', native);
        const api = mockApi(listRoute());
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('button', { name: /Delete memory: I prefer Dutch/ }));
        expect(await screen.findByText(/It will no longer be used in your chats/)).toBeInTheDocument();
        await user.click(await confirmBtn());
        await waitFor(() => expect(api.find('DELETE', '/m1')).toHaveLength(1));
        // An ordinary delete never asks the server to restore a predecessor.
        expect(api.find('DELETE', '/m1')[0].query.has('undo')).toBe(false);
        await waitFor(() => expect(screen.queryByTestId('memory-item-m1')).not.toBeInTheDocument());
        expect(native).not.toHaveBeenCalled();
    });

    it('keeps the row and reports a failed delete', async () => {
        mockApi({ ...listRoute(), 'DELETE /m1': () => respond({}, 500) });
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('button', { name: /Delete memory: I prefer Dutch/ }));
        await user.click(await confirmBtn());
        expect(await screen.findByText(/Could not delete this memory/)).toBeInTheDocument();
        expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument();
    });

    it('selects with real checkboxes and deletes the selection', async () => {
        const api = mockApi(listRoute());
        const user = userEvent.setup();
        setup();
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: /Select all/ }));
        expect(screen.getByText('2 selected')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete selected' }));
        await user.click(await confirmBtn());
        await waitFor(() => expect(api.find('POST', '/bulk-delete')).toHaveLength(1));
        expect(api.find('POST', '/bulk-delete')[0].body).toEqual({ ids: ['m1', 'm2'] });
        expect(api.find('POST', '/bulk-delete')[0].query.has('undo')).toBe(false);
        await waitFor(() => expect(screen.queryByTestId('memory-item-m1')).not.toBeInTheDocument());
    });

    it('changes the type of the selection', async () => {
        const api = mockApi(listRoute());
        const user = userEvent.setup();
        setup();
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('checkbox', { name: /Select memory: I prefer Dutch/ }));
        await user.selectOptions(screen.getByLabelText('New type for the selected memories'), 'workflow');
        await user.click(screen.getByRole('button', { name: 'Change type' }));
        await waitFor(() => expect(api.find('POST', '/bulk-update')).toHaveLength(1));
        expect(api.find('POST', '/bulk-update')[0].body).toEqual({ ids: ['m1'], type: 'workflow' });
    });
});

describe('MemoryPanel: add', () => {
    it('adds a personal memory without a projectId', async () => {
        const api = mockApi({ ...listRoute(), 'POST /': () => respond({ id: 'new1' }) });
        const user = userEvent.setup();
        setup();
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('button', { name: 'Add memory' }));
        await user.type(screen.getByRole('textbox', { name: 'Memory' }), 'Remember this');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(api.find('POST', '/')).toHaveLength(1));
        expect(api.find('POST', '/')[0].body).toEqual({ content: 'Remember this', type: 'fact' });
    });

    it('adds a project memory with the projectId', async () => {
        const api = mockApi({ ...listRoute(), 'POST /': () => respond({ id: 'new1' }) });
        const user = userEvent.setup();
        setup({ projectId: 'p1' });
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('button', { name: 'Add memory' }));
        await user.type(screen.getByRole('textbox', { name: 'Memory' }), 'Shared fact');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(api.find('POST', '/')).toHaveLength(1));
        expect(api.find('POST', '/')[0].body).toEqual({ content: 'Shared fact', type: 'fact', projectId: 'p1' });
    });
});

describe('MemoryPanel: refused writes', () => {
    const refuse = (status: number, code: string) => respond({ error: 'x', code }, status);
    const addText = async (text: string) => {
        const user = userEvent.setup();
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('button', { name: 'Add memory' }));
        await user.type(screen.getByRole('textbox', { name: 'Memory' }), text);
        await user.click(screen.getByRole('button', { name: 'Save' }));
    };

    it('says an identifier is never stored', async () => {
        mockApi({ ...listRoute(), 'POST /': () => refuse(422, 'sensitive_identifier') });
        setup();
        await addText('my IBAN');
        expect(await screen.findByText('This looks like a password, account or ID number. Those are never stored.')).toBeInTheDocument();
    });

    it('points to Settings for a sensitive topic', async () => {
        mockApi({ ...listRoute(), 'POST /': () => refuse(422, 'sensitive_not_allowed') });
        setup();
        await addText('my diagnosis');
        expect(await screen.findByText(/This is about a sensitive topic\. Turn on sensitive topics in Settings → Memory/)).toBeInTheDocument();
    });

    it('says memory is off when the organisation turned it off', async () => {
        mockApi({ ...listRoute(), 'POST /': () => refuse(403, 'memory_disabled') });
        setup();
        await addText('anything');
        expect(await screen.findByText(/Memory is turned off for your organisation/)).toBeInTheDocument();
    });

    it('hides Add when the organisation turned memory off', async () => {
        mockApi(listRoute());
        setup({ orgMemoryOff: true });
        await screen.findByTestId('memory-item-m1');
        expect(screen.queryByRole('button', { name: 'Add memory' })).not.toBeInTheDocument();
    });

    it('a 409 on save says the memory can only be deleted', async () => {
        mockApi({ ...listRoute(), 'PUT /m1': () => refuse(409, 'memory_unreadable') });
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('button', { name: /Edit memory: I prefer Dutch/ }));
        const box = await screen.findByRole('textbox', { name: 'Memory' });
        await user.clear(box);
        await user.type(box, 'changed');
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('This memory can no longer be opened; you can delete it.')).toBeInTheDocument();
    });
});

describe('MemoryPanel: review queue', () => {
    const withPending = (extra = {}) => ({
        'GET /stats': () => respond({ total: 2, pendingReview: 2, typeDistribution: { labels: [], data: [] } }),
        'GET /review': () => page([mem({ id: 'r1', content: 'Has a health condition', status: 'pending_review', sensitivity: 'art9' }),
            mem({ id: 'r2', content: 'Is religious', status: 'pending_review', sensitivity: 'art9' })], { total: 2 }),
        ...listRoute(),
        ...extra,
    });

    it('is hidden without pending items or opt-in', async () => {
        mockApi(listRoute());
        setup();
        await screen.findByTestId('memory-item-m1');
        expect(screen.queryByRole('radio', { name: /To review/ })).not.toBeInTheDocument();
    });

    it('is shown for an opt-in even when empty', async () => {
        mockApi(listRoute());
        setup({ sensitiveOptIn: true });
        expect(await screen.findByRole('radio', { name: /To review/ })).toBeInTheDocument();
    });

    it('approves and rejects with an explanation of what the items are', async () => {
        const api = mockApi(withPending());
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('radio', { name: /To review/ }));
        expect(await screen.findByText(/sensitive topics, which you chose to allow/)).toBeInTheDocument();
        await user.click(await screen.findByRole('button', { name: /Approve: Has a health/ }));
        await waitFor(() => expect(api.find('POST', '/review/r1/approve')).toHaveLength(1));
        await user.click(screen.getByRole('button', { name: /Reject: Is religious/ }));
        await waitFor(() => expect(api.find('POST', '/review/r2/reject')).toHaveLength(1));
        await waitFor(() => expect(screen.getByText('Nothing to review')).toBeInTheDocument());
    });

    it('opens straight into review when asked', async () => {
        const api = mockApi(withPending());
        setup({ initialView: 'review' });
        expect(await screen.findByText('Has a health condition')).toBeInTheDocument();
        expect(api.find('GET', '/review').length).toBeGreaterThan(0);
    });
});

describe('MemoryPanel: archived', () => {
    it('lists archived memories and restores one', async () => {
        const api = mockApi({
            'GET /': (c) => page(c.query.get('status') === 'archived' ? [mem({ id: 'a1', content: 'Old fact', status: 'archived' })] : LIST),
        });
        const user = userEvent.setup();
        setup();
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('radio', { name: 'Archived' }));
        expect(await screen.findByText('Old fact')).toBeInTheDocument();
        expect(api.lastList()?.query.get('status')).toBe('archived');
        await user.click(screen.getByRole('button', { name: /Restore/ }));
        await waitFor(() => expect(api.find('POST', '/a1/restore')).toHaveLength(1));
        await waitFor(() => expect(screen.queryByText('Old fact')).not.toBeInTheDocument());
    });
});

describe('MemoryPanel: a project viewer cannot write', () => {
    it('hides every write control', async () => {
        mockApi(listRoute([M3]));
        setup({ projectId: 'p1', canEdit: false });
        await screen.findByTestId('memory-item-m3');
        expect(screen.queryByRole('button', { name: 'Select' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Add memory' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Edit memory/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Delete memory/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Clear All' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Export JSON' })).toBeInTheDocument();
    });

    it('lets an editor select', async () => {
        mockApi(listRoute([M3]));
        setup({ projectId: 'p1', canEdit: true });
        await screen.findByTestId('memory-item-m3');
        expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
    });
});

describe('MemoryPanel: Clear All clears the memory on the screen', () => {
    const open = async (props: Partial<MemoryPanelProps>, routes = {}) => {
        const api = mockApi({ ...listRoute(), ...routes });
        const user = userEvent.setup();
        setup(props);
        await screen.findByTestId('memory-item-m1');
        await user.click(screen.getByRole('button', { name: 'Clear All' }));
        const dialog = await screen.findByRole('dialog');
        return { api, user, dialog };
    };

    it('in a project, clears THAT project', async () => {
        const { api, user } = await open({ projectId: 'p1', canEdit: true });
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(api.find('POST', '/clear')).toHaveLength(1));
        expect(api.find('POST', '/clear')[0].body).toEqual({ projectId: 'p1' });
    });

    it('in Settings, sends the personal clear with no body', async () => {
        const { api, user } = await open({});
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(api.find('POST', '/clear')).toHaveLength(1));
        expect(api.find('POST', '/clear')[0].hasBody).toBe(false);
    });

    it('names whose memory goes', async () => {
        const project = await open({ projectId: 'p1', canEdit: true });
        expect(project.dialog).toHaveTextContent(/this project/i);
        expect(project.dialog).toHaveTextContent(/all members/i);
        expect(project.dialog).toHaveTextContent(/personal memories are not affected/i);
    });

    it('says personal in Settings', async () => {
        const { dialog } = await open({});
        expect(dialog).toHaveTextContent(/personal memories/i);
        expect(dialog).toHaveTextContent(/project memories are not affected/i);
    });

    it('keeps the rows and names what failed when the server refuses', async () => {
        const { user } = await open({ projectId: 'p1', canEdit: true }, { 'POST /clear': () => respond({}, 403) });
        await user.click(screen.getByTestId('confirm-dialog-confirm'));
        expect(await screen.findByText(/this project's memories/i)).toBeInTheDocument();
        expect(screen.getByTestId('memory-item-m1')).toBeInTheDocument();
    });
});

describe('MemoryPanel: pagination', () => {
    it('asks for the rows it has not seen yet, after a delete', async () => {
        // The offset is the number of rows in hand: the server's set shrank by one too.
        const api = mockApi({
            'GET /': () => page(LIST, { total: 10 }),
            'DELETE /m1': () => respond({ success: true }),
        });
        const user = userEvent.setup();
        setup();
        await user.click(await screen.findByRole('button', { name: /Delete memory: I prefer Dutch/ }));
        await user.click(await screen.findByTestId('confirm-dialog-confirm'));
        await waitFor(() => expect(screen.queryByTestId('memory-item-m1')).not.toBeInTheDocument());
        await user.click(screen.getByRole('button', { name: /Load more \(8 remaining\)/ }));
        await waitFor(() => expect(api.lastList()?.query.get('offset')).toBe('1'));
    });
});
