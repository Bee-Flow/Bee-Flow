import { screen, waitFor, within } from '@testing-library/react';
import { renderWithClient } from '../../test/render';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import SupportInboxPanel from './SupportInboxPanel';
import { authFetch } from '../../utils/helpers';
import { toast } from '../shared/Toast';
import { ok, fail } from '../../test/http';

/**
 * Characterisation of the support inbox: the thread list and its filters, the
 * bulk bar, the thread detail (banners, activity log, messages), the reply
 * composer with canned responses, the mailbox banner and its disconnect, the
 * view tabs and the live stream. The three sub-panels are stubs.
 */

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../shared/Toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('./SupportAIConfig', () => ({ default: () => <div data-testid="ai-config" /> }));
vi.mock('./SupportConnectionsConfig', () => ({ default: () => <div data-testid="connections" /> }));
vi.mock('./LinkedIssuesPanel', () => ({
    default: ({ thread, onChanged }: { thread: { id: string }; onChanged: () => void }) => (
        <button data-testid="linked-issues" onClick={onChanged}>{`linked ${thread.id}`}</button>
    ),
}));
vi.mock('./EmailHtmlBody', () => ({ default: ({ html }: { html: string }) => <div data-testid="email-html">{html}</div> }));

const fetchMock = vi.mocked(authFetch);

type Json = Record<string, unknown>;
let counts: Json;
let threads: Json[];
let detail: Json;
let mailbox: Json | null;
let canned: Json[];
let events: Json[];
let disconnectStatus: number;

const thread = (over: Json = {}): Json => ({
    id: 't1', status: 'open', priority: 'normal', subject: 'Printer on fire', source: 'app', category: null,
    requester_name: 'Ann', requester_email: 'ann@example.com', requester_org_role: 'org_admin', requester_org_name: 'Acme',
    last_message_at: null, first_response_at: null, csat_score: null, tags: ['vip'], ai_handled: false,
    ai_escalated_reason: null, followup_needed_at: null, followup_reason: null, ...over,
});
const message = (over: Json = {}): Json => ({ id: 'm1', author_kind: 'customer', author_display: 'Ann', internal_note: false, created_at: new Date().toISOString(), body: 'It smokes', body_html: null, email_send_status: null, kb_citations: null, ...over });

/** Every request the panel made, as `METHOD url`. */
const calls = () => fetchMock.mock.calls.map(([url, opts]) => `${(opts as { method?: string } | undefined)?.method ?? 'GET'} ${String(url)}`);
const bodyOf = (needle: string) => {
    const hit = fetchMock.mock.calls.findLast(([url, opts]) => `${(opts as { method?: string } | undefined)?.method ?? 'GET'} ${String(url)}` === needle);
    return JSON.parse(String((hit?.[1] as { body?: string } | undefined)?.body));
};

/** The JSON bodies of every PATCH, in order. */
const patches = () => fetchMock.mock.calls
    .filter(([, o]) => (o as { method?: string } | undefined)?.method === 'PATCH')
    .map(([, o]) => JSON.parse(String((o as { body?: string }).body)));

class FakeEventSource {
    static last: FakeEventSource | null = null;
    listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
    closed = false;
    onerror: (() => void) | null = null;
    constructor(public url: string, public init?: EventSourceInit) { FakeEventSource.last = this; }
    addEventListener(name: string, fn: (e: MessageEvent) => void) { (this.listeners[name] ||= []).push(fn); }
    close() { this.closed = true; }
    emit(name: string, data: unknown = {}) { (this.listeners[name] || []).forEach((fn) => fn({ data: JSON.stringify(data) } as MessageEvent)); }
}

beforeEach(() => {
    counts = { open: 2, ai_responding: 1, awaiting_user: 0, awaiting_agent: 1, resolved: 5, followup: 0 };
    threads = [thread(), thread({ id: 't2', subject: 'Second', status: 'resolved', priority: 'urgent', source: 'marketing', tags: [], requester_org_role: null, requester_org_name: null, csat_score: 4 })];
    detail = { thread: thread(), messages: [message()] };
    mailbox = null;
    canned = [];
    events = [];
    disconnectStatus = 200;
    FakeEventSource.last = null;
    vi.stubGlobal('EventSource', FakeEventSource);
    fetchMock.mockReset();
    vi.mocked(toast.error).mockReset();
    fetchMock.mockImplementation((url, opts) => {
        const key = `${(opts as { method?: string } | undefined)?.method ?? 'GET'} ${String(url)}`;
        if (key.startsWith('GET /api/support/threads?')) return ok({ threads, counts }) as never;
        if (key === 'GET /api/support/mailbox') return ok({ mailbox }) as never;
        if (key === 'GET /api/support/canned') return ok({ responses: canned }) as never;
        if (key === 'POST /api/support/mailbox/disconnect') return (disconnectStatus === 200 ? ok({}) : fail(disconnectStatus, { error: 'nope' })) as never;
        if (/^GET \/api\/support\/threads\/[^/?]+\/events$/.test(key)) return ok({ events }) as never;
        if (/^GET \/api\/support\/threads\/[^/?]+$/.test(key)) return ok(detail) as never;
        if (key === 'POST /api/support/threads/t1/messages') return ok({}) as never;
        if (/^POST \/api\/support\/canned\/[^/]+\/render$/.test(key)) return ok({ rendered: 'Dear Ann' }) as never;
        return ok({}) as never;
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

const openThread = async (user: ReturnType<typeof userEvent.setup>, subject = 'Printer on fire') => {
    await user.click(await screen.findByText(subject));
    await screen.findByText(/^From:/);
};

describe('SupportInboxPanel: list', () => {
    it('shows the counters, the rows and what a row carries', async () => {
        renderWithClient(<SupportInboxPanel />);
        expect(await screen.findByText('Printer on fire')).toBeInTheDocument();
        expect(screen.getByText('Customer Support')).toBeInTheDocument();
        expect(screen.getByText('4 active · 5 resolved')).toBeInTheDocument();
        expect(screen.getByText('Active (4)')).toBeInTheDocument();
        expect(screen.getByText('Awaiting (1)')).toBeInTheDocument();
        expect(screen.getByText('Sent (0)')).toBeInTheDocument();
        expect(screen.getByText('Resolved (5)')).toBeInTheDocument();
        expect(screen.queryByText(/^Follow-up/)).toBeNull();
        expect(screen.getAllByText('ann@example.com')).toHaveLength(2);
        expect(screen.getByText('Org admin')).toBeInTheDocument();
        expect(screen.getByText('Acme')).toBeInTheDocument();
        expect(screen.getByText('#vip')).toBeInTheDocument();
        expect(screen.getByText('marketing')).toBeInTheDocument();
        expect(screen.getByText('Urgent')).toBeInTheDocument();
        expect(screen.getByTitle('Customer rated 4/5')).toBeInTheDocument();
        expect(screen.getByText('Select a thread to view the conversation')).toBeInTheDocument();
        expect(calls()).toContain('GET /api/support/threads?status=open%2Cai_responding%2Cawaiting_user%2Cawaiting_agent');
        expect(FakeEventSource.last?.url).toBe('/api/support/stream');
        expect(FakeEventSource.last?.init).toEqual({ withCredentials: true });
    });

    it('shows an empty list as "No threads"', async () => {
        threads = [];
        renderWithClient(<SupportInboxPanel />);
        expect(await screen.findByText('No threads')).toBeInTheDocument();
    });

    it('queries by the chosen filter, and by the search text on Enter', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        await user.click(screen.getByRole('button', { name: 'Resolved (5)' }));
        await waitFor(() => expect(calls()).toContain('GET /api/support/threads?status=resolved'));
        await user.click(screen.getByRole('button', { name: 'All' }));
        await waitFor(() => expect(calls()).toContain('GET /api/support/threads?'));
        await user.type(screen.getByPlaceholderText('Search subject or email...'), ' smoke {Enter}');
        await waitFor(() => expect(calls()).toContain('GET /api/support/threads?q=smoke'));
    });

    it('offers the follow-up queue when something is waiting, and asks for it with followup=1', async () => {
        counts = { ...counts, followup: 3 };
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await user.click(await screen.findByRole('button', { name: 'Follow-up (3)' }));
        await waitFor(() => expect(calls()).toContain('GET /api/support/threads?followup=1'));
    });

    it('refreshes from the header button', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        const before = calls().filter((c) => c.startsWith('GET /api/support/threads?')).length;
        await user.click(screen.getByTitle('Refresh'));
        await waitFor(() => expect(calls().filter((c) => c.startsWith('GET /api/support/threads?')).length).toBe(before + 1));
    });

    it('switches between the inbox and the two config views', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        await user.click(screen.getByRole('button', { name: /AI configuration/ }));
        expect(screen.getByTestId('ai-config')).toBeInTheDocument();
        expect(screen.queryByText('Printer on fire')).toBeNull();
        expect(screen.queryByTitle('Refresh')).toBeNull();
        await user.click(screen.getByRole('button', { name: /Connections/ }));
        expect(screen.getByTestId('connections')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /^Inbox$/ }));
        expect(await screen.findByText('Printer on fire')).toBeInTheDocument();
    });
});

describe('SupportInboxPanel: bulk', () => {
    it('selects rows, shows the bar and posts the action', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        const boxes = screen.getAllByRole('checkbox');
        await user.click(boxes[0]);
        expect(screen.getByText('1 selected')).toBeInTheDocument();
        expect(screen.queryByText('Select a thread to view the conversation')).not.toBeNull();
        await user.click(screen.getByRole('button', { name: 'Resolve' }));
        await waitFor(() => expect(calls()).toContain('POST /api/support/threads/bulk'));
        expect(bodyOf('POST /api/support/threads/bulk')).toEqual({ ids: ['t1'], action: 'resolve', params: {} });
        await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull());
    });

    it('sends a priority and a tag, and clears the selection', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        const boxes = screen.getAllByRole('checkbox');
        await user.click(boxes[0]);
        await user.click(boxes[1]);
        expect(screen.getByText('2 selected')).toBeInTheDocument();
        await user.selectOptions(screen.getByDisplayValue('Set priority…'), 'high');
        await waitFor(() => expect(bodyOf('POST /api/support/threads/bulk')).toEqual({ ids: ['t1', 't2'], action: 'priority', params: { priority: 'high' } }));
        await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
        await user.click(screen.getAllByRole('checkbox')[0]);
        await user.type(screen.getByPlaceholderText('Add tag + Enter'), 'urgent{Enter}');
        await waitFor(() => expect(bodyOf('POST /api/support/threads/bulk')).toEqual({ ids: ['t1'], action: 'tag', params: { tag: 'urgent' } }));
        await user.click(screen.getAllByRole('checkbox')[1]);
        await user.click(screen.getByRole('button', { name: 'Clear' }));
        expect(screen.queryByText(/selected$/)).toBeNull();
    });
});

describe('SupportInboxPanel: thread detail', () => {
    it('opens a thread and shows its header, messages and citations', async () => {
        detail = {
            thread: thread({ ai_handled: true, ai_escalated_reason: 'angry', category: 'billing', csat_score: 5 }),
            messages: [
                message({ kb_citations: [{ title: 'Guide' }, { title: '' }, { title: 'FAQ' }] }),
                message({ id: 'm2', author_kind: 'staff', author_display: 'Sam', body: 'On it', internal_note: true }),
                message({ id: 'm3', author_kind: 'ai', author_display: null, body: 'Bot says', body_html: '<b>hi</b>' }),
            ],
        };
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        expect(calls()).toContain('GET /api/support/threads/t1');
        expect(screen.getByText('From: Ann <ann@example.com>')).toBeInTheDocument();
        expect(screen.getByText('Source: app')).toBeInTheDocument();
        expect(screen.getByText('AI handled')).toBeInTheDocument();
        expect(screen.getByText('Escalated: angry')).toBeInTheDocument();
        expect(screen.getByText('billing')).toBeInTheDocument();
        expect(screen.getByText('It smokes')).toBeInTheDocument();
        expect(screen.getByText('On it')).toBeInTheDocument();
        expect(screen.getByText('internal note')).toBeInTheDocument();
        expect(screen.getByText('Sam')).toBeInTheDocument();
        expect(screen.getByText('ai')).toBeInTheDocument();
        expect(screen.getByTestId('email-html')).toHaveTextContent('<b>hi</b>');
        expect(screen.getByText('Cited: Guide · FAQ')).toBeInTheDocument();
        expect(screen.getByTestId('linked-issues')).toHaveTextContent('linked t1');
        expect(screen.getByRole('button', { name: /^Resolve$/ })).toBeInTheDocument();
    });

    it('hides the Resolve button on a resolved thread', async () => {
        detail = { thread: thread({ id: 't2', status: 'resolved' }), messages: [] };
        renderWithClient(<SupportInboxPanel focusThreadId="t2" />);
        await screen.findByText(/^From:/);
        expect(calls()).toContain('GET /api/support/threads/t2');
        expect(within(document.body).queryAllByRole('button', { name: 'Resolve' })).toHaveLength(0);
    });

    it('patches status, priority and tags', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        await user.selectOptions(screen.getByDisplayValue('Open'), 'awaiting_user');
        await waitFor(() => expect(patches()).toHaveLength(1));
        await user.selectOptions(screen.getByDisplayValue('Normal'), 'high');
        await waitFor(() => expect(patches()).toHaveLength(2));
        await user.type(screen.getByPlaceholderText('+ tag'), ' new{Enter}');
        await waitFor(() => expect(patches()).toHaveLength(3));
        await user.click(screen.getAllByRole('button', { name: '×' })[0]);
        await waitFor(() => expect(patches()).toHaveLength(4));
        expect(patches()).toEqual([{ status: 'awaiting_user' }, { priority: 'high' }, { tags: ['vip', 'new'] }, { tags: [] }]);
    });

    it('resolves from the header button', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        const resolve = screen.getAllByRole('button', { name: /^Resolve$/ }).at(-1);
        await user.click(resolve as HTMLElement);
        await waitFor(() => expect(patches()).toEqual([{ status: 'resolved' }]));
    });

    it('shows the follow-up banner and clears it', async () => {
        detail = { thread: thread({ followup_needed_at: '2026-01-01', followup_reason: 'issue moved' }), messages: [] };
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        expect(screen.getByText('Needs a follow-up.')).toBeInTheDocument();
        expect(screen.getByText(/issue moved/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Mark followed up' }));
        await waitFor(() => expect(calls()).toContain('POST /api/support/threads/t1/followup-done'));
    });

    it('warns about a message whose email failed to send', async () => {
        detail = { thread: thread(), messages: [message({ email_send_status: { ok: false, error: 'SMTP down' } })] };
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        expect(screen.getByText('Outbound email failed for one of the messages in this thread.')).toBeInTheDocument();
        expect(screen.getByText('SMTP down')).toBeInTheDocument();
    });

    it('falls back to "Unknown error" for a failed send without text', async () => {
        detail = { thread: thread(), messages: [message({ email_send_status: { ok: false } })] };
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        expect(screen.getByText('Unknown error')).toBeInTheDocument();
    });

    it('loads the activity log when opened and refetches the thread from the linked issues panel', async () => {
        events = [{ id: 'e1', created_at: new Date().toISOString(), actor_kind: 'staff', actor_user_id: 'abcdefghijkl', action: 'status', payload: { to: 'resolved' } }];
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        expect(calls()).not.toContain('GET /api/support/threads/t1/events');
        await user.click(screen.getByRole('button', { name: /Activity log/ }));
        expect(await screen.findByText(/— status/)).toHaveTextContent('staff (abcdefgh) — status: {"to":"resolved"}');
        expect(calls()).toContain('GET /api/support/threads/t1/events');
        await user.click(screen.getByRole('button', { name: /Activity log/ }));
        expect(screen.queryByText(/— status/)).toBeNull();
        const before = calls().filter((c) => c === 'GET /api/support/threads/t1').length;
        await user.click(screen.getByTestId('linked-issues'));
        await waitFor(() => expect(calls().filter((c) => c === 'GET /api/support/threads/t1').length).toBe(before + 1));
    });

    it('says so when the log is empty', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        await user.click(screen.getByRole('button', { name: /Activity log/ }));
        expect(await screen.findByText('No events recorded yet.')).toBeInTheDocument();
    });
});

describe('SupportInboxPanel: reply', () => {
    it('sends a reply and an internal note', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        const send = screen.getByRole('button', { name: /Send reply/ });
        expect(send).toBeDisabled();
        const box = screen.getByPlaceholderText(/^Reply to the customer/);
        await user.type(box, '  Hello  ');
        await user.click(send);
        await waitFor(() => expect(bodyOf('POST /api/support/threads/t1/messages')).toEqual({ body: 'Hello', internalNote: false }));
        await waitFor(() => expect(box).toHaveValue(''));

        await user.click(screen.getByRole('checkbox', { name: 'Internal note' }));
        const note = screen.getByPlaceholderText('Internal note (only visible to staff)…');
        await user.type(note, 'psst');
        await user.click(screen.getByRole('button', { name: /Save note/ }));
        await waitFor(() => expect(bodyOf('POST /api/support/threads/t1/messages')).toEqual({ body: 'psst', internalNote: true }));
        await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Internal note' })).not.toBeChecked());
    });

    it('keeps the text when the server refuses the reply', async () => {
        fetchMock.mockImplementation(((url: string, opts?: { method?: string }) => {
            const key = `${opts?.method ?? 'GET'} ${url}`;
            if (key === 'POST /api/support/threads/t1/messages') return fail(500);
            if (key.startsWith('GET /api/support/threads?')) return ok({ threads, counts });
            if (key === 'GET /api/support/threads/t1') return ok(detail);
            return ok({ mailbox: null, responses: [] });
        }) as never);
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        const box = screen.getByPlaceholderText(/^Reply to the customer/);
        await user.type(box, 'Hello');
        await user.click(screen.getByRole('button', { name: /Send reply/ }));
        await waitFor(() => expect(screen.getByRole('button', { name: /Send reply/ })).toBeEnabled());
        expect(box).toHaveValue('Hello');
    });

    it('offers the canned responses on "/" and inserts the rendered one', async () => {
        canned = [{ id: 'c1', title: 'Greeting', shortcut: '/hi', body: 'Hello there' }];
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        const box = screen.getByPlaceholderText(/^Reply to the customer/);
        expect(screen.queryByText('Greeting')).toBeNull();
        await user.click(box);
        await user.keyboard('/');
        const item = await screen.findByRole('button', { name: /Greeting/ });
        expect(item).toHaveTextContent('/hi');
        await user.keyboard('{Escape}');
        expect(screen.queryByText('Greeting')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Templates' }));
        await user.click(await screen.findByRole('button', { name: /Greeting/ }));
        await waitFor(() => expect(bodyOf('POST /api/support/canned/c1/render')).toEqual({ threadId: 't1' }));
        await waitFor(() => expect(box).toHaveValue('/\nDear Ann'));
        expect(screen.queryByText('Greeting')).toBeNull();
    });

    it('inserts the raw body when rendering a canned response fails', async () => {
        canned = [{ id: 'c1', title: 'Greeting', body: 'Hello there' }];
        const base = fetchMock.getMockImplementation();
        fetchMock.mockImplementation(((url: string, opts?: { method?: string }) => (/render$/.test(url) ? Promise.reject(new Error('x')) : base?.(url, opts))) as never);
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        await user.click(await screen.findByRole('button', { name: 'Templates' }));
        await user.click(await screen.findByRole('button', { name: /Greeting/ }));
        await waitFor(() => expect(screen.getByPlaceholderText(/^Reply to the customer/)).toHaveValue('Hello there'));
    });
});

describe('SupportInboxPanel: mailbox', () => {
    beforeEach(() => { mailbox = { connected: true, count: 3, activeCount: 2, lastAt: new Date().toISOString() }; });

    it('shows the banner for a connected mailbox, only in the inbox view', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        expect(await screen.findByText('An email box is feeding this inbox')).toBeInTheDocument();
        expect(screen.getByText(/3 tickets here came in over a connected mailbox \(2 still active\) · last message just now/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Connections/ }));
        expect(screen.queryByText('An email box is feeding this inbox')).toBeNull();
    });

    it('uses the singular for one ticket and omits the empty parts', async () => {
        mailbox = { connected: true, count: 1 };
        renderWithClient(<SupportInboxPanel />);
        expect(await screen.findByText(/1 ticket here came in over a connected mailbox\. Disconnecting removes them/)).toBeInTheDocument();
    });

    it('shows no banner without a connected mailbox', async () => {
        mailbox = { connected: false, count: 3 };
        renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        expect(screen.queryByText('An email box is feeding this inbox')).toBeNull();
    });

    it('asks twice-worded confirmation, then disconnects and reloads', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await user.click(await screen.findByRole('button', { name: /Disconnect mailbox/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Disconnect the email box from Customer Support?' });
        expect(dialog).toHaveTextContent('3 tickets that came in over that mailbox will be permanently deleted');
        const before = calls().filter((c) => c === 'GET /api/support/mailbox').length;
        await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
        await waitFor(() => expect(calls()).toContain('POST /api/support/mailbox/disconnect'));
        await waitFor(() => expect(calls().filter((c) => c === 'GET /api/support/mailbox').length).toBe(before + 1));
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('does nothing when the confirmation is cancelled', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await user.click(await screen.findByRole('button', { name: /Disconnect mailbox/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Disconnect the email box from Customer Support?' });
        await user.click(within(dialog).getByRole('button', { name: /Cancel/ }));
        expect(calls()).not.toContain('POST /api/support/mailbox/disconnect');
    });

    it('toasts the server error when disconnecting fails', async () => {
        disconnectStatus = 500;
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await user.click(await screen.findByRole('button', { name: /Disconnect mailbox/ }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('nope'));
        expect(screen.getByRole('button', { name: /Disconnect mailbox/ })).toBeEnabled();
    });
});

describe('SupportInboxPanel: live stream', () => {
    it('refreshes the list on thread_created, and the open thread on its own update', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        const listCalls = () => calls().filter((c) => c.startsWith('GET /api/support/threads?')).length;
        const threadCalls = () => calls().filter((c) => c === 'GET /api/support/threads/t1').length;
        const l0 = listCalls();
        act(() => FakeEventSource.last?.emit('thread_created'));
        await waitFor(() => expect(listCalls()).toBe(l0 + 1));
        const t0 = threadCalls();
        act(() => FakeEventSource.last?.emit('thread_updated', { threadId: 'other' }));
        await waitFor(() => expect(listCalls()).toBe(l0 + 2));
        expect(threadCalls()).toBe(t0);
        act(() => FakeEventSource.last?.emit('thread_updated', { threadId: 't1' }));
        await waitFor(() => expect(threadCalls()).toBe(t0 + 1));
        expect(listCalls()).toBe(l0 + 3);
    });

    it('drops the selection when the threads were purged', async () => {
        const user = userEvent.setup();
        renderWithClient(<SupportInboxPanel />);
        await openThread(user);
        act(() => FakeEventSource.last?.emit('threads_purged'));
        expect(await screen.findByText('Select a thread to view the conversation')).toBeInTheDocument();
    });

    it('closes the stream on unmount', async () => {
        const { unmount } = renderWithClient(<SupportInboxPanel />);
        await screen.findByText('Printer on fire');
        const es = FakeEventSource.last;
        unmount();
        expect(es?.closed).toBe(true);
    });
});
