import { DndContext } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * An app a Solution stage manages (design 9): the header holds the canvas in
 * Preview, says who manages it and where to change it, takes Restore and the
 * AI builder away, and turns Publish into the audience picker alone.
 */
vi.mock('../studioAppsApi', () => {
    const studioAppsApi = {
        getCatalog: vi.fn().mockResolvedValue({ components: {} }),
        listVersions: vi.fn().mockResolvedValue({ versions: [{ id: 'v1', version: 1, createdAt: '2026-10-01T10:00:00Z' }] }),
        updateApp: vi.fn(),
        getApp: vi.fn(),
        restoreVersion: vi.fn(),
        publish: vi.fn(),
        checkApp: vi.fn(),
        setNextcloudMenu: vi.fn(),
    };
    return { default: studioAppsApi, studioAppsApi };
});
vi.mock('../rbac/useAppRoles', () => ({
    default: vi.fn(() => ({ model: null, tables: [], roles: [], roleMapping: null, members: [], isLoading: false, isError: false, hasModel: false })),
    useOrgDirectory: vi.fn(() => ({ groups: [], users: [], isLoading: false, available: true })),
}));
vi.mock('../tables/TablesManager', () => ({ default: () => <div>tables-manager</div> }));
vi.mock('../variables/VariablesManager', () => ({ default: () => <div>variables-manager</div> }));
vi.mock('../rbac/AccessMatrix', () => ({ default: () => <div>access-matrix</div> }));
vi.mock('../rbac/RowRuleEditor', () => ({ default: () => <div>row-rules</div> }));
vi.mock('../rbac/RolesManager', () => ({ default: () => <div>roles-manager</div> }));

import EditorHeader from './EditorHeader';
import { AppEditorProvider } from '../state/AppEditorContext';
import { studioAppsApi } from '../studioAppsApi';

const DEF = {
    version: 2,
    meta: { icon: 'LayoutGrid' },
    roles: [],
    homeScreenId: 'scr1',
    screens: [{ id: 'scr1', name: 'New request', sections: [{ id: 'sec1', children: [] }] }],
    actions: {},
};
const MANAGED = { solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: { kind: 'app', id: 'dev-app' } };

// EditorHeader is a .jsx component with ~20 props; the suite passes the few it measures.
const Header = EditorHeader as unknown as React.ComponentType<Record<string, unknown>>;

function renderHeader(app: Record<string, unknown> = {}, props: Record<string, unknown> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const merged = { id: 'app1', name: 'Quote portal', definition: DEF, version: 12, ...app };
    return render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={merged}>
                <DndContext>
                    <Header app={merged} onCommit={vi.fn()} onFlush={vi.fn()} {...props} />
                </DndContext>
            </AppEditorProvider>
        </QueryClientProvider>,
    );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('EditorHeader on a managed app', () => {
    it('says who manages it, with the way to Dev', () => {
        renderHeader({ managed: MANAGED });
        expect(screen.getByTestId('managed-part-banner')).toHaveTextContent('Managed by Intake · Production · Release 7.');
        expect(screen.getByRole('link', { name: 'Open in Dev' })).toHaveAttribute('href', '/app/studio/apps/dev-app');
    });

    it('holds the canvas in Preview: Edit is disabled and the editor mode is left', async () => {
        const onViewChange = vi.fn();
        renderHeader({ managed: MANAGED }, { onViewChange });
        expect(screen.getByRole('radio', { name: 'Edit' })).toBeDisabled();
        await waitFor(() => expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true'));
        expect(onViewChange).toHaveBeenLastCalledWith('preview');
    });

    it('the name is not an input', () => {
        renderHeader({ managed: MANAGED });
        fireEvent.click(screen.getByText('Quote portal'));
        expect(screen.queryByLabelText('App name')).toBeNull();
    });

    it('version history lists versions without a Restore', async () => {
        renderHeader({ managed: MANAGED });
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Version history/ }));
        expect(await screen.findByText('Version 1')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    });

    it('Publish opens the audience picker alone: no flush, no pre-flight check', async () => {
        const onFlush = vi.fn();
        renderHeader({ managed: MANAGED, isPublished: true, sharedGroups: [] }, { onFlush });
        fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
        expect(await screen.findByText('Choose who can use this app', { selector: 'p' })).toBeInTheDocument();
        expect(onFlush).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: /Check this app/ })).toBeNull();
        expect(screen.getByText('Currently:')).toBeInTheDocument();
    });

    it('the AI builder is not in the command palette', () => {
        renderHeader({ managed: MANAGED }, { commandOpen: true });
        expect(screen.queryByText('Ask the AI builder')).toBeNull();
        expect(screen.queryByText('Switch to Edit')).toBeNull();
    });
});

describe('EditorHeader on an app nobody manages', () => {
    it('is unchanged: editable, restorable, the AI builder listed, a plain Publish', async () => {
        renderHeader({}, { commandOpen: true });
        expect(screen.queryByTestId('managed-part-banner')).toBeNull();
        expect(screen.getByRole('radio', { name: 'Edit' })).toBeEnabled();
        expect(screen.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByText('Ask the AI builder')).toBeInTheDocument();
        expect(studioAppsApi.restoreVersion).not.toHaveBeenCalled();
    });

    it('a restore the stage refuses turns the header read-only and shows the banner', async () => {
        vi.mocked(studioAppsApi.restoreVersion).mockRejectedValue(Object.assign(new Error('refused'), {
            status: 409, code: 'managed_part',
            body: { error: 'refused', code: 'managed_part', details: { solutionId: 's2', stage: 'uat' } },
        }));
        renderHeader();
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Version history/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Restore' }));
        expect(await screen.findByTestId('managed-part-banner')).toHaveTextContent('UAT.');
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull());
    });
});
