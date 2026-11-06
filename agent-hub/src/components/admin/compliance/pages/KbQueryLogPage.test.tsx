import { screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderWithClient } from '@/test/render';
import KbQueryLogPage from './KbQueryLogPage';
import { pageFor } from '../data/pages';
import { sectionById, resolveSection } from '../sections';
import { setDemoTransport } from '@/utils/helpers';
import { toast } from '@/components/shared/Toast';
import { pendingAccessAuditActions, presetAccessAuditActions } from '../data/accessAuditPreset';

const fetchJson = vi.fn();

/** The compliance API as the server answers it: a real Response per call, through the app's own transport seam. */
function install() {
    setDemoTransport(async (url: string, init?: { method?: string; body?: unknown }) => {
        try {
            const body = await fetchJson(url, init);
            return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            const err = e as { status?: number; code?: string };
            return new Response(JSON.stringify({ error: 'refused', code: err.code }), { status: err.status ?? 404, headers: { 'Content-Type': 'application/json' } });
        }
    });
}

afterEach(() => { cleanup(); presetAccessAuditActions(null); setDemoTransport(null); vi.restoreAllMocks(); });
beforeEach(() => {
    fetchJson.mockReset();
    // jsdom has no object URLs: the download only needs one to hand to the anchor.
    URL.createObjectURL = vi.fn(() => 'blob:test');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    install();
    vi.spyOn(toast, 'success').mockImplementation(() => undefined as never);
    vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
});

const SECRET_QUESTION = 'What is the salary of Jane Doe?';
const SECRET_ANSWER = 'It is 5000 a month.';

const OVERVIEW = {
    licensed: true,
    anyEnabled: true,
    kbs: [{
        id: 'kb1', name: 'HR handbook', enabled: true, retentionDays: 90, changedAt: '2026-11-01T10:00:00Z', changedBy: 'u9', changedByName: 'Ada Admin',
        managers: [{ id: 'u9', name: 'Ada Admin' }, { id: 'u8', name: 'Bob Manager' }],
        total: 12, byOutcome: { answered: 9, no_results: 3 }, byStatus: { to_review: 7, reviewed: 5 },
        attestation: { purpose: 'ai_quality', dpia: 'done', dpiaId: '7', worksCouncil: 'consent', worksCouncilReason: null, privacyNoticeUpdated: true },
        attestedBy: 'u9', attestedByName: 'Ada Admin', attestedAt: '2026-11-01T10:00:00Z',
        showNames: false, highRisk: true, acknowledgedUsers: 5,
        // A text field that must never reach the screen even if the server sent it.
        query: SECRET_QUESTION, answer: SECRET_ANSWER, queries: [{ query: SECRET_QUESTION }],
    }],
};

const ENTRIES = {
    total: 1, limit: 50, offset: 0,
    rows: [{ id: 'e1', kbId: 'kb1', kbName: 'HR handbook', createdAt: '2026-11-02T09:00:00Z', userId: 'u1', userName: 'Carol User', channel: 'agent_chat', outcome: 'answered', reviewStatus: 'to_review', query: SECRET_QUESTION, answer: SECRET_ANSWER }],
};

const ORG_USERS = [{ id: 'u1', displayName: 'Carol User', email: 'c@example.com' }];
const DSR = [
    { id: 41, status: 'in_progress', request_type: 'access', subject_email_masked: 'c.•••@example.com' },
    { id: 40, status: 'fulfilled', request_type: 'access', subject_email_masked: 'x.•••@example.com' },
];

function refusal(code: string, status = 403) {
    return Object.assign(new Error(`${status} Forbidden`), { status, code });
}

function route(overrides: Record<string, (init?: { method?: string }) => unknown> = {}) {
    fetchJson.mockImplementation((url: string, init?: { method?: string }) => {
        for (const [frag, fn] of Object.entries(overrides)) if (url.includes(frag)) return Promise.resolve().then(() => fn(init));
        if (url.endsWith('/kb-query-log/overview')) return Promise.resolve(OVERVIEW);
        if (url.includes('/kb-query-log/entries')) return Promise.resolve(ENTRIES);
        if (/\/kb-query-log\/subjects\/u1$/.test(url)) return Promise.resolve({ userId: 'u1', userName: 'Carol User', total: 4, byKb: [{ kbId: 'kb1', kbName: 'HR handbook', count: 4 }] });
        return Promise.reject(new Error('404 Not Found'));
    });
}

describe('the section', () => {
    it('is a register for the compliance officer with three tabs, and the hub maps it to this page', () => {
        const s = sectionById('kb_query_log');
        expect(s.group).toBe('registers');
        expect(s.tabs).toEqual(['overview', 'entries', 'requests']);
        expect(resolveSection('kb_query_log')).toBe('kb_query_log');
        expect(pageFor('kb_query_log')).toBe(KbQueryLogPage);
    });

    it('renders for the compliance officer (admin_compliance reaches the hub that mounts it)', async () => {
        route();
        const Page = pageFor('kb_query_log') as unknown as React.ComponentType<{ tab: string }>;
        renderWithClient(<Page tab="overview" />);
        expect(await screen.findByTestId('kql-overview')).toBeTruthy();
    });
});

describe('Overview', () => {
    it('shows logging, term, who changed it, managers and the counts, and never a question or an answer', async () => {
        route();
        const { container } = renderWithClient(<KbQueryLogPage tab="overview" />);
        const row = await screen.findByTestId('kql-kb-kb1');
        expect(within(row).getByText('HR handbook')).toBeTruthy();
        expect(within(row).getByTestId('kql-logging-kb1').textContent).toBe('On');
        expect(row.textContent).toContain('90 days');
        expect(row.textContent).toContain('Ada Admin');
        expect(row.textContent).toContain('Bob Manager');
        expect(within(row).getByTestId('kql-total-kb1').textContent).toBe('12');
        expect(row.textContent).toContain('Answered: 9');
        expect(row.textContent).toContain('To review: 7');
        expect(container.textContent).not.toContain(SECRET_QUESTION);
        expect(container.textContent).not.toContain(SECRET_ANSWER);
    });

    it('shows the attestation, whether managers see names, the AI Act flag and how many users acknowledged', async () => {
        route();
        renderWithClient(<KbQueryLogPage tab="overview" />);
        const row = await screen.findByTestId('kql-kb-kb1');
        const att = within(row).getByTestId('kql-attestation-kb1').textContent ?? '';
        expect(att).toContain('DPIA: done');
        expect(att).toContain('Works council: Consent obtained');
        expect(att).toContain('Privacy notice: updated');
        expect(att).toContain('by Ada Admin');
        expect(att).toContain('Managers see pseudonyms');
        expect(att).toContain('High-risk AI system');
        expect(within(row).getByTestId('kql-ack-kb1').textContent).toBe('5 users');
    });

    it('links to the access log, pre-filtered on the query-log actions', async () => {
        route();
        const navigate = vi.fn();
        renderWithClient(<KbQueryLogPage tab="overview" navigate={navigate} />);
        await userEvent.click(await screen.findByTestId('kql-open-audit'));
        expect(navigate).toHaveBeenCalledWith('access_log');
        expect(pendingAccessAuditActions()).toContain('kb.query_log.enabled');
        expect(pendingAccessAuditActions()).toContain('kb.query_log.subject_deleted');
    });
});

describe('Entries', () => {
    it('lists metadata only, and exports the metadata as CSV with the filter on screen', async () => {
        route();
        const { container } = renderWithClient(<KbQueryLogPage tab="entries" data={{ orgUsers: ORG_USERS }} />);
        const row = await screen.findByTestId('kql-entry-e1');
        expect(row.textContent).toContain('Carol User');
        expect(row.textContent).toContain('Agent chat');
        expect(row.textContent).toContain('Answered');
        expect(row.textContent).toContain('To review');
        expect(container.textContent).not.toContain(SECRET_QUESTION);
        await userEvent.selectOptions(screen.getByTestId('kql-filter-outcome'), 'error');
        await userEvent.click(screen.getByTestId('kql-entries-export'));
        await waitFor(() => expect(fetchJson.mock.calls.some(([u]) => String(u).includes('/kb-query-log/entries/export.csv?outcome=error'))).toBe(true));
    });
});

describe('GDPR requests', () => {
    const renderTab = () => renderWithClient(<KbQueryLogPage tab="requests" data={{ orgUsers: ORG_USERS, dsr: { requests: DSR } }} />);

    it('keeps content, export and erase disabled until a person and an open request are chosen, and offers open requests only', async () => {
        route();
        renderTab();
        const buttons = ['kql-view-content', 'kql-export-json', 'kql-export-csv', 'kql-erase'].map((id) => screen.getByTestId(id) as HTMLButtonElement);
        expect(buttons.every((b) => b.disabled)).toBe(true);
        expect(screen.getByTestId('kql-logged-notice').textContent).toMatch(/recorded in the access log/);

        await userEvent.selectOptions(screen.getByTestId('kql-subject-user'), 'u1');
        expect((await screen.findByTestId('kql-subject-counts')).textContent).toContain('4');
        expect(buttons.every((b) => b.disabled)).toBe(true);

        const options = within(screen.getByTestId('kql-dsr-select')).getAllByRole('option').map((o) => o.textContent);
        expect(options.some((o) => o?.includes('#41'))).toBe(true);
        expect(options.some((o) => o?.includes('#40'))).toBe(false);
        await userEvent.selectOptions(screen.getByTestId('kql-dsr-select'), '41');
        expect((screen.getByTestId('kql-view-content') as HTMLButtonElement).disabled).toBe(false);
        expect((screen.getByTestId('kql-export-json') as HTMLButtonElement).disabled).toBe(false);
        // Erasing also needs a reason.
        expect((screen.getByTestId('kql-erase') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows the content against an open request', async () => {
        route({
            '/content': () => ({ total: 1, limit: 50, offset: 0, rows: [{ id: 'e1', kbName: 'HR handbook', createdAt: '2026-11-02T09:00:00Z', channel: 'agent_chat', outcome: 'answered', query: SECRET_QUESTION, answer: SECRET_ANSWER, chunks: [{ title: 'Pay policy', sourceUri: null }] }] }),
        });
        renderTab();
        await userEvent.selectOptions(screen.getByTestId('kql-subject-user'), 'u1');
        await userEvent.selectOptions(screen.getByTestId('kql-dsr-select'), '41');
        await userEvent.click(screen.getByTestId('kql-view-content'));
        expect((await screen.findByTestId('kql-content-e1')).textContent).toContain(SECRET_QUESTION);
        expect(fetchJson.mock.calls.some(([u]) => String(u).includes('/subjects/u1/content?dsrRequestId=41'))).toBe(true);
    });

    it('erases only with a reason and after a confirm that says it cannot be undone', async () => {
        route({ '/subjects/u1': (init) => (init?.method === 'DELETE' ? { deleted: 4 } : { userId: 'u1', userName: 'Carol User', total: 4, byKb: [] }) });
        renderTab();
        await userEvent.selectOptions(screen.getByTestId('kql-subject-user'), 'u1');
        await userEvent.selectOptions(screen.getByTestId('kql-dsr-select'), '41');
        const erase = screen.getByTestId('kql-erase') as HTMLButtonElement;
        expect(erase.disabled).toBe(true);
        await userEvent.type(screen.getByTestId('kql-reason'), 'Art. 17 request');
        expect(erase.disabled).toBe(false);
        await userEvent.click(erase);

        expect(await screen.findByText(/cannot be undone/)).toBeTruthy();
        expect(fetchJson.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
        await userEvent.click(screen.getByRole('button', { name: 'Erase for good' }));

        await waitFor(() => expect(toast.success).toHaveBeenCalled());
        const call = fetchJson.mock.calls.find(([, init]) => init?.method === 'DELETE');
        expect(call?.[0]).toContain('/kb-query-log/subjects/u1');
        expect(JSON.parse(call?.[1].body)).toEqual({ dsrRequestId: 41, reason: 'Art. 17 request' });
    });

    it('words a 403 dsr_request_required as a clear message', async () => {
        route({ '/content': () => { throw refusal('dsr_request_required'); } });
        renderTab();
        await userEvent.selectOptions(screen.getByTestId('kql-subject-user'), 'u1');
        await userEvent.selectOptions(screen.getByTestId('kql-dsr-select'), '41');
        await userEvent.click(screen.getByTestId('kql-view-content'));
        expect((await screen.findByTestId('kql-dsr-required')).textContent).toMatch(/open data-subject request/);
        expect(screen.queryByTestId('kql-content')).toBeNull();
    });

    it('words the same refusal for an export', async () => {
        route({ '/export': () => { throw refusal('dsr_request_required'); } });
        renderTab();
        await userEvent.selectOptions(screen.getByTestId('kql-subject-user'), 'u1');
        await userEvent.selectOptions(screen.getByTestId('kql-dsr-select'), '41');
        await userEvent.click(screen.getByTestId('kql-export-csv'));
        expect(await screen.findByTestId('kql-dsr-required')).toBeTruthy();
        expect(fetchJson.mock.calls.some(([u]) => String(u).includes('/subjects/u1/export?dsrRequestId=41&format=csv'))).toBe(true);
    });
});
