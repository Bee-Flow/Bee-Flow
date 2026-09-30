import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectActivityItem } from '../../../api/queries/projects';
import { withQueryClient } from '../../../test/queryWrapper';
import ActivityTab from './ActivityTab';
import type { WorkspaceTabProps } from './types';
import { EDITOR_ID, makeFakeApi, makeMembers, makeProject, OWNER_ID, reply } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const at = new Date().toISOString();
const row = (id: string, action: string, over: Partial<ProjectActivityItem> = {}): ProjectActivityItem => ({
    id, action, actorId: OWNER_ID, createdAt: at, ...over,
});

function renderTab(activity: unknown, changeLog: unknown = { items: [], hasMore: false }) {
    const api = makeFakeApi({
        'GET /api/projects/p1/members': makeMembers(),
        'GET /api/projects/p1/activity': activity,
        'GET /api/projects/p1/changes/log': changeLog,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    const props: WorkspaceTabProps = {
        projectId: 'p1', project: makeProject(), role: 'editor', currentUser: { id: EDITOR_ID },
        sub: null, onOpenSub: vi.fn(), onNavigate: vi.fn(),
    };
    render(withQueryClient(<ActivityTab {...props} />));
    return api;
}

beforeEach(() => { fetchMock.mockReset(); });

describe('ActivityTab', () => {
    it('tells what happened in sentences, with member names and "You"', async () => {
        renderTab({
            items: [
                row('a1', 'member_added', { targetType: 'user', targetId: EDITOR_ID, details: { role: 'editor' } }),
                row('a2', 'resource_added', { actorId: EDITOR_ID, targetType: 'document' }),
            ],
            hasMore: false,
        });
        expect(await screen.findByText('Olivia Owner invited you as editor')).toBeInTheDocument();
        expect(screen.getByText('You added a document')).toBeInTheDocument();
    });

    it('filters by kind without another request', async () => {
        const api = renderTab({
            items: [row('a1', 'chat.created'), row('a2', 'file.added', { details: { name: 'plan.pdf' } })],
            hasMore: false,
        });
        const user = userEvent.setup();
        await screen.findByText('Olivia Owner started a team chat');
        await user.click(screen.getByRole('button', { name: 'Content' }));
        expect(screen.queryByText('Olivia Owner started a team chat')).toBeNull();
        expect(screen.getByText('Olivia Owner uploaded “plan.pdf”')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'People' }));
        expect(screen.getByTestId('activity-empty')).toHaveTextContent('Nothing of this kind');
        expect(api.callsTo('GET', '/api/projects/p1/activity')).toHaveLength(1);
    });

    it('loads older entries from the next offset', async () => {
        const api = renderTab((call: { query: URLSearchParams }) => (call.query.get('offset') === '0'
            ? { items: [row('a1', 'project_created')], hasMore: true }
            : { items: [row('a2', 'kb_added')], hasMore: false }));
        const user = userEvent.setup();
        await user.click(await screen.findByTestId('activity-more'));
        expect(await screen.findByText('Olivia Owner linked a knowledge base')).toBeInTheDocument();
        const offsets = api.callsTo('GET', '/api/projects/p1/activity').map((c) => c.query.get('offset'));
        expect(offsets).toEqual(['0', '1']);
        await waitFor(() => expect(screen.queryByTestId('activity-more')).toBeNull());
    });

    it('says the feed could not load instead of claiming nothing happened', async () => {
        renderTab(reply(403, { error: 'Forbidden' }));
        expect(await screen.findByTestId('activity-error')).toBeInTheDocument();
        expect(screen.queryByTestId('activity-empty')).toBeNull();
    });

    it('explains an empty project', async () => {
        renderTab({ items: [], hasMore: false });
        expect(await screen.findByTestId('activity-empty')).toHaveTextContent('Nothing has happened here yet.');
    });
});

describe('ActivityTab — changes only', () => {
    it('shows only content changes from the change log, with titles and counts', async () => {
        const api = renderTab({ items: [row('a1', 'chat.created')], hasMore: false }, {
            items: [
                row('c1', 'content.edited', {
                    actorId: EDITOR_ID, targetType: 'document', targetId: 'd1',
                    details: { stats: { wordsAdded: 40, wordsRemoved: 2 }, changes: 3, aiAssisted: true },
                    ...({ title: 'Launch brief' } as object),
                }),
                row('c2', 'content.created', { targetType: 'notebook', targetId: 'n1', ...({ title: null } as object) }),
            ],
            hasMore: false,
        });
        const user = userEvent.setup();
        await screen.findByText('Olivia Owner started a team chat');
        expect(api.callsTo('GET', '/api/projects/p1/changes/log')).toHaveLength(0);
        await user.click(screen.getByRole('button', { name: 'Changes only' }));
        expect(await screen.findByText('You edited “Launch brief” with AI')).toBeInTheDocument();
        expect(screen.getByText('Olivia Owner created a notebook')).toBeInTheDocument();
        expect(screen.getByTestId('activity-meta')).toHaveTextContent('+40 words · −2 words · 3 saves');
        expect(screen.queryByText('Olivia Owner started a team chat')).toBeNull();
        expect(api.callsTo('GET', '/api/projects/p1/changes/log')).toHaveLength(1);
    });

    it('says when there are no content changes yet, and when the change log failed', async () => {
        renderTab({ items: [row('a1', 'project_created')], hasMore: false });
        const user = userEvent.setup();
        await screen.findByText('Olivia Owner created the project');
        await user.click(screen.getByRole('button', { name: 'Changes only' }));
        expect(await screen.findByTestId('activity-empty')).toHaveTextContent('No changes to notebooks, documents or meetings yet.');
    });

    it('reports a change log that could not load as an error', async () => {
        renderTab({ items: [], hasMore: false }, reply(500, { error: 'boom' }));
        const user = userEvent.setup();
        await screen.findByTestId('activity-empty');
        await user.click(screen.getByRole('button', { name: 'Changes only' }));
        expect(await screen.findByTestId('activity-error')).toBeInTheDocument();
    });
});
