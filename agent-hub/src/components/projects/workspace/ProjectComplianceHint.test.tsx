import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import ProjectComplianceHint, { tabOfTarget } from './ProjectComplianceHint';
import { makeFakeApi, reply } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const HINT = {
    key: 'project_files_unscanned',
    severity: 'low',
    titleKey: 'compliance.project_hint.project_files_unscanned',
    params: { count: 3 },
    action: { kind: 'navigate', target: '/app/projects/p1/knowledge' },
};
const BASE = '/api/projects/p1/compliance-hints';

function setup(routes: Record<string, unknown>, props: Partial<React.ComponentProps<typeof ProjectComplianceHint>> = {}) {
    const api = makeFakeApi(routes);
    fetchMock.mockImplementation(api.fetchImpl);
    const onOpenTab = vi.fn();
    render(withQueryClient(<ProjectComplianceHint projectId="p1" role="owner" onOpenTab={onOpenTab} {...props} />));
    return { api, onOpenTab, user: userEvent.setup() };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('ProjectComplianceHint', () => {
    it('shows the one hint with its count, and Review opens the tab it points at', async () => {
        const { onOpenTab, user } = setup({ [`GET ${BASE}`]: { hint: HINT } });
        const strip = await screen.findByTestId('project-compliance-hint');
        expect(strip).toHaveAccessibleName('Suggestion for this project');
        expect(strip).toHaveTextContent('Files not yet checked for personal data (3)');
        await user.click(screen.getByTestId('project-compliance-hint-review'));
        expect(onOpenTab).toHaveBeenCalledWith('knowledge');
    });

    it('offers no Review that would go nowhere: a target on the section the hint stands on', async () => {
        // An older server pointed "items of people who left" at the project
        // itself, which is the overview this strip is on.
        const orphaned = { ...HINT, key: 'project_orphaned_content', titleKey: 'compliance.project_hint.project_orphaned_content', action: { kind: 'navigate', target: '/app/projects/p1' } };
        setup({ [`GET ${BASE}`]: { hint: orphaned } }, { here: 'overview' });
        const strip = await screen.findByTestId('project-compliance-hint');
        expect(strip).toHaveTextContent('Items that belong to people who have left (3)');
        expect(within(strip).queryByTestId('project-compliance-hint-review')).toBeNull();
        expect(within(strip).getByTestId('project-compliance-hint-dismiss')).toBeInTheDocument();
    });

    it('Review of items of people who left opens the chats they shared', async () => {
        const orphaned = { ...HINT, key: 'project_orphaned_content', titleKey: 'compliance.project_hint.project_orphaned_content', action: { kind: 'navigate', target: '/app/projects/p1/chats' } };
        const { onOpenTab, user } = setup({ [`GET ${BASE}`]: { hint: orphaned } }, { here: 'overview' });
        await user.click(await screen.findByTestId('project-compliance-hint-review'));
        expect(onOpenTab).toHaveBeenCalledWith('chats');
    });

    it('without a tab to open, Review follows only a path inside the app', async () => {
        const assign = vi.fn();
        vi.stubGlobal('location', { ...window.location, assign });
        try {
            const outside = { ...HINT, action: { kind: 'navigate', target: 'https://elsewhere.example/p1' } };
            const { user } = setup({ [`GET ${BASE}`]: { hint: outside } }, { onOpenTab: undefined });
            await user.click(await screen.findByTestId('project-compliance-hint-review'));
            expect(assign).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('without a tab to open, Review goes to the in-app page', async () => {
        const assign = vi.fn();
        vi.stubGlobal('location', { ...window.location, assign });
        try {
            const { user } = setup({ [`GET ${BASE}`]: { hint: HINT } }, { onOpenTab: undefined });
            await user.click(await screen.findByTestId('project-compliance-hint-review'));
            expect(assign).toHaveBeenCalledWith('/app/projects/p1/knowledge');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('renders nothing without a hint, and nothing when the read fails — never an "all good"', async () => {
        const { api } = setup({ [`GET ${BASE}`]: { hint: null } });
        await waitFor(() => expect(api.callsTo('GET', BASE)).toHaveLength(1));
        expect(screen.queryByTestId('project-compliance-hint')).toBeNull();
        fetchMock.mockReset();
        const failing = makeFakeApi({ [`GET ${BASE}`]: reply(500, { error: 'boom' }) });
        fetchMock.mockImplementation(failing.fetchImpl);
        render(withQueryClient(<ProjectComplianceHint projectId="p1" role="owner" />));
        await waitFor(() => expect(failing.callsTo('GET', BASE)).toHaveLength(1));
        expect(screen.queryByTestId('project-compliance-hint')).toBeNull();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('a viewer is never asked and sees nothing', async () => {
        const { api } = setup({ [`GET ${BASE}`]: { hint: HINT } }, { role: 'viewer' });
        await new Promise((r) => setTimeout(r, 20));
        expect(api.calls).toHaveLength(0);
        expect(screen.queryByTestId('project-compliance-hint')).toBeNull();
    });

    it('dismiss puts it away at once and tells the server', async () => {
        const { api, user } = setup({
            [`GET ${BASE}`]: { hint: HINT },
            [`POST ${BASE}/project_files_unscanned/dismiss`]: { ok: true },
        });
        await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
        await waitFor(() => expect(screen.queryByTestId('project-compliance-hint')).toBeNull());
        expect(api.callsTo('POST', `${BASE}/project_files_unscanned/dismiss`)).toHaveLength(1);
        expect(api.callsTo('POST', `${BASE}/project_files_unscanned/dismiss`)[0].body).toEqual({});
    });

    it('snooze sends 7 or 30 days', async () => {
        const { api, user } = setup({
            [`GET ${BASE}`]: { hint: HINT },
            [`POST ${BASE}/project_files_unscanned/snooze`]: { ok: true },
        });
        await user.click(await screen.findByTestId('project-compliance-hint-snooze-30'));
        await waitFor(() => expect(api.callsTo('POST', `${BASE}/project_files_unscanned/snooze`)).toHaveLength(1));
        expect(api.callsTo('POST', `${BASE}/project_files_unscanned/snooze`)[0].body).toEqual({ days: 30 });
    });
});

// A refused dismiss or snooze puts the hint back; the note has to be next to it.
describe('ProjectComplianceHint — a decision the server refused', () => {
    it('a refused dismissal brings the hint back with a quiet note', async () => {
        const { user } = setup({
            [`GET ${BASE}`]: { hint: HINT },
            [`POST ${BASE}/project_files_unscanned/dismiss`]: reply(500, { error: 'nope' }),
        });
        await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
        const strip = await screen.findByTestId('project-compliance-hint');
        expect(await within(strip).findByTestId('project-compliance-hint-failed')).toHaveTextContent('That did not save. Try again.');
        expect(within(strip).getByRole('status')).toBeInTheDocument();
    });

    it('a refused snooze says so next to the hint, and a retry that works puts it away', async () => {
        let refuse = true;
        const { user } = setup({
            [`GET ${BASE}`]: { hint: HINT },
            [`POST ${BASE}/project_files_unscanned/snooze`]: () => (refuse ? reply(500, { error: 'nope' }) : { ok: true }),
        });
        await user.click(await screen.findByTestId('project-compliance-hint-snooze-7'));
        expect(await screen.findByTestId('project-compliance-hint-failed')).toBeInTheDocument();
        refuse = false;
        await user.click(screen.getByTestId('project-compliance-hint-snooze-7'));
        await waitFor(() => expect(screen.queryByTestId('project-compliance-hint')).toBeNull());
        expect(screen.queryByTestId('project-compliance-hint-failed')).toBeNull();
    });
});

describe('tabOfTarget', () => {
    it('reads the workspace tab from a hint target', () => {
        expect(tabOfTarget('/app/projects/p1/members', 'p1')).toBe('members');
        expect(tabOfTarget('/app/projects/p1', 'p1')).toBe('overview');
        expect(tabOfTarget('/app/admin/compliance', 'p1')).toBeNull();
    });
});
