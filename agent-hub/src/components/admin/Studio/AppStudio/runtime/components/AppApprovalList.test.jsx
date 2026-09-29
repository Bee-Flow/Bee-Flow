import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppApprovalList from './AppApprovalList';
import { DataProvider } from '../DataContext';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * 'approval_list' — the in-app decide surface.
 *
 * The three security-relevant behaviours are what get pinned:
 *   • anonymous/public runtime → a sign-in wall and NO fetch at all;
 *   • reads/decides go to the session-authed /api/automation/approvals
 *     routes (the viewer's own cookie — never an owner-scoped app route);
 *   • a decision fires the wired onDecided sequence with the recorded facts.
 */

vi.mock('../../../../../../utils/helpers', () => ({
    API_BASE: 'https://api.test',
    authFetch: (...args) => globalThis.__authFetch(...args),
}));

function node(props = {}, events = {}) {
    return {
        id: 'cmp_ap01', type: 'approval_list',
        props: { scope: 'mine', show: 'waiting', limit: 10, emptyText: 'No approvals right now.', showDetails: true, ...props },
        style: {},
        ...events,
    };
}

const ROW = {
    id: 'apr_1', status: 'pending', prompt: 'Approve the quote?',
    automationTitle: 'Quote portal', createdAt: '2026-08-20T10:00:00Z', expiresAt: null,
    fields: null, attachments: null, detailsMd: null,
};

function renderList(n = node(), { mode = 'run', currentUser = { id: 'u1', name: 'Sam' }, runAction = vi.fn(), appId = 'app_7' } = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-08-22T00:00:00.000Z' }), mode, currentUser, runAction };
    const utils = render(
        <RuntimeProvider value={value}>
            <DataProvider appId={appId}>
                <AppApprovalList node={n} />
            </DataProvider>
        </RuntimeProvider>,
    );
    return { ...utils, runAction };
}

function jsonReply(body, ok = true) {
    return { ok, json: async () => body };
}

beforeEach(() => {
    globalThis.__authFetch = vi.fn(async (url) => {
        if (String(url).includes('/decide')) return jsonReply({ accepted: true, approval: { ...ROW, status: 'approved', decisionReason: null, answers: null, context: { recordId: 'rec_9' } } });
        if (/\/approvals\/apr_1$/.test(String(url).split('?')[0])) return jsonReply({ approval: ROW, canDecide: true });
        return jsonReply({ approvals: [ROW], nextCursor: null });
    });
});
afterEach(() => { delete globalThis.__authFetch; });

describe('AppApprovalList', () => {
    it('anonymous public runtime: sign-in wall, zero fetches', async () => {
        renderList(node(), { currentUser: null });
        expect(await screen.findByText(/Sign in to see and decide approvals/)).toBeInTheDocument();
        expect(globalThis.__authFetch).not.toHaveBeenCalled();
    });

    it('editor canvas: static sample, zero fetches', () => {
        renderList(node(), { mode: 'edit', currentUser: null });
        expect(screen.getByText(/Preview — signed-in viewers/)).toBeInTheDocument();
        expect(globalThis.__authFetch).not.toHaveBeenCalled();
    });

    it('a signed-in viewer reads the session-authed approvals route (viewer scope)', async () => {
        renderList();
        expect(await screen.findByText('Approve the quote?')).toBeInTheDocument();
        const url = String(globalThis.__authFetch.mock.calls[0][0]);
        expect(url).toContain('/api/automation/approvals?');
        expect(url).toContain('scope=mine');
        expect(url).toContain('status=pending');
        expect(url).not.toContain('appId=');
    });

    it('scope "app" narrows by this app id — still through the viewer session', async () => {
        renderList(node({ scope: 'app' }));
        await screen.findByText('Approve the quote?');
        expect(String(globalThis.__authFetch.mock.calls[0][0])).toContain('appId=app_7');
    });

    it('deciding posts to the shared decide route and fires onDecided', async () => {
        const { runAction } = renderList(node({}, { onDecided: 'act_after' }));
        fireEvent.click(await screen.findByTestId('approval-list-row'));
        // The detail fetch resolves with canDecide → the shared controls mount.
        fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
        await waitFor(() => {
            const urls = globalThis.__authFetch.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => u.endsWith('/approvals/apr_1/decide'))).toBe(true);
        });
        await waitFor(() => expect(runAction).toHaveBeenCalledTimes(1));
        const [actionId, opts] = runAction.mock.calls[0];
        expect(actionId).toBe('act_after');
        expect(opts.formValues).toMatchObject({ approvalId: 'apr_1', decision: 'approved', context: { recordId: 'rec_9' } });
    });

    it('a staged row says which stage is waiting, and where in the chain it sits', async () => {
        // An approver seated in stage 3 is asked only once 1 and 2 have
        // passed. Without this line the request just appears one day with no
        // explanation of why it arrived now.
        const staged = {
            ...ROW,
            stage: 's3',
            stages: [
                { key: 's1', name: 'Team lead', approvers: [{ userId: 'u9' }], rule: 'all' },
                { key: 's2', name: 'Finance', approvers: [{ userId: 'u8' }], rule: 'all', skipped: true },
                { key: 's3', name: 'Director', approvers: [{ userId: 'u1' }], rule: 'all' },
            ],
        };
        globalThis.__authFetch = vi.fn(async () => jsonReply({ approvals: [staged], nextCursor: null }));
        renderList();
        // Two ACTIVE stages, not three: the skipped one was never a step
        // anybody waited on, so counting it would describe a chain that never
        // existed.
        expect(await screen.findByTestId('approval-list-stage')).toHaveTextContent('Stage 2 of 2');
        expect(screen.getByTestId('approval-list-stage')).toHaveTextContent('Director');
    });

    it('a row with no stages shows no stage line at all', async () => {
        renderList();
        await screen.findByText('Approve the quote?');
        expect(screen.queryByTestId('approval-list-stage')).not.toBeInTheDocument();
    });

    it('a decided row leaves the "waiting" slice', async () => {
        renderList();
        fireEvent.click(await screen.findByTestId('approval-list-row'));
        fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
        await waitFor(() => expect(screen.queryByTestId('approval-list-row')).not.toBeInTheDocument());
    });
});
