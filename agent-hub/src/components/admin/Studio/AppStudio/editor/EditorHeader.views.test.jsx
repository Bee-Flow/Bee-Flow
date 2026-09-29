import { DndContext } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// The palette (row 2) reads the component catalog; the views mount panels that
// each run their own fetch. This suite is about the HEADER — its five
// segments, the ⋯ menu and the publish pill — so every panel is stubbed to a
// marker and no test here makes a network call.
vi.mock('../studioAppsApi', () => ({
    studioAppsApi: {
        getCatalog: vi.fn().mockResolvedValue({ components: {} }),
        listVersions: vi.fn().mockResolvedValue({ versions: [] }),
        updateApp: vi.fn(),
        getApp: vi.fn(),
        restoreVersion: vi.fn(),
    },
}));
vi.mock('../tables/TablesManager', () => ({ default: () => <div>tables-manager</div> }));
vi.mock('../variables/VariablesManager', () => ({ default: () => <div>variables-manager</div> }));
vi.mock('../rbac/AccessMatrix', () => ({ default: () => <div>access-matrix</div> }));
vi.mock('../rbac/RowRuleEditor', () => ({ default: () => <div>row-rules</div> }));
vi.mock('../rbac/RolesManager', () => ({
    default: ({ onDirtyChange }) => (
        <div>
            roles-manager
            <button type="button" onClick={() => onDirtyChange?.(true)}>make-dirty</button>
        </div>
    ),
}));

import EditorHeader from './EditorHeader';
import { AppEditorProvider } from '../state/AppEditorContext';

// One screen, one button wired to one automation — so "Logic 1" has something
// to count and the Roles view has a role to list.
const DEF = {
    version: 2,
    meta: { icon: 'LayoutGrid' },
    roles: [{ id: 'seller', name: 'Seller' }],
    homeScreenId: 'scr1',
    screens: [{
        id: 'scr1',
        name: 'New request',
        sections: [{
            id: 'sec1',
            children: [{ id: 'btn1', type: 'button', props: { label: 'Calculate' }, onClick: 'act1' }],
        }],
    }],
    actions: { act1: { kind: 'run_automation', automationId: 'auto1' } },
};

function renderHeader({ app = {}, ...props } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const merged = { id: 'app1', name: 'Quote portal', definition: DEF, version: 12, ...app };
    const utils = render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={merged}>
                <DndContext>
                    <EditorHeader app={merged} onCommit={vi.fn()} {...props} />
                </DndContext>
            </AppEditorProvider>
        </QueryClientProvider>,
    );
    return { app: merged, ...utils };
}

describe('EditorHeader — the five segments are one control', () => {
    it('shows Edit · Preview · Data · Logic n · Roles, with the wired-logic count', () => {
        renderHeader();
        expect(screen.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByRole('radio', { name: 'Preview' })).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'Data' })).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'Roles' })).toBeInTheDocument();
        // The one wired onClick is the count the segment carries.
        expect(screen.getByRole('radio', { name: /^Logic\s*1$/ })).toBeInTheDocument();
    });

    it('row 2 (undo/redo · screens · components) exists in Edit and nowhere else', () => {
        renderHeader();
        expect(screen.getByTestId('editor-tool-row')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: 'Data' }));
        expect(screen.queryByTestId('editor-tool-row')).not.toBeInTheDocument();
    });

    it('Data and Roles are VIEWS, and the shell is told which one is open', () => {
        const onViewChange = vi.fn();
        renderHeader({ onViewChange });
        expect(onViewChange).toHaveBeenCalledWith('edit');

        fireEvent.click(screen.getByRole('radio', { name: 'Data' }));
        expect(onViewChange).toHaveBeenLastCalledWith('data');
        // Variables is a SUBTAB of Data (a deviation from the artboard, which
        // dropped it) — not a segment of its own.
        expect(screen.queryByRole('radio', { name: 'Variables' })).not.toBeInTheDocument();
        expect(screen.getByRole('tab', { name: /Variables/ })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('radio', { name: 'Roles' }));
        expect(onViewChange).toHaveBeenLastCalledWith('roles');
        expect(screen.getByText('roles-manager')).toBeInTheDocument();
    });

    it('keeps the Roles panels MOUNTED across its subtabs (they hold unsaved drafts)', () => {
        renderHeader();
        fireEvent.click(screen.getByRole('radio', { name: 'Roles' }));
        fireEvent.click(screen.getByRole('tab', { name: 'Row rules' }));
        // Still in the tree, merely hidden — unmounting would discard the draft.
        expect(screen.getByText('roles-manager')).toBeInTheDocument();
        expect(screen.getByText('row-rules')).toBeInTheDocument();
    });

    it('guards LEAVING the Roles view while a draft is unsaved', () => {
        const onViewChange = vi.fn();
        renderHeader({ onViewChange });
        fireEvent.click(screen.getByRole('radio', { name: 'Roles' }));
        fireEvent.click(screen.getByRole('button', { name: 'make-dirty' }));

        fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
        expect(screen.getByText('Leave without saving?')).toBeInTheDocument();
        expect(onViewChange).toHaveBeenLastCalledWith('roles');

        fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
        expect(onViewChange).toHaveBeenLastCalledWith('edit');
    });
});

describe('EditorHeader — publish, view-as and the ⋯ menu', () => {
    it('paints LIVE with no next step when the published version IS the canvas', () => {
        renderHeader({ app: { isPublished: true, publishedVersion: 12, version: 12 } });
        const pill = screen.getByTestId('publish-pill');
        expect(pill).toHaveAttribute('data-status', 'live');
        expect(screen.getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    });

    it('paints OUTDATED and offers "Publish changes" when the audience is behind', () => {
        renderHeader({ app: { isPublished: true, publishedVersion: 9, version: 12 } });
        expect(screen.getByTestId('publish-pill')).toHaveAttribute('data-status', 'stale');
        expect(screen.getByRole('button', { name: 'Publish changes' })).toBeInTheDocument();
    });

    it('says DRAFT for an app nobody can use yet', () => {
        renderHeader({ app: { isPublished: false, publishedVersion: null } });
        expect(screen.getByTestId('publish-pill')).toHaveAttribute('data-status', 'draft');
    });

    it('"View as" is a capsule that opens a role menu', () => {
        renderHeader();
        const capsule = screen.getByTestId('view-as-capsule');
        expect(capsule).toHaveTextContent('Owner');
        fireEvent.click(capsule);
        expect(screen.getByRole('menuitemradio', { name: 'Seller' })).toBeInTheDocument();
    });

    it('⌘K, version history and view-as-role live in the ⋯ menu', () => {
        renderHeader();
        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        expect(screen.getByRole('menuitem', { name: /Command palette/ })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'Version history' })).toBeInTheDocument();
        expect(screen.getByRole('menuitem', { name: 'View as role…' })).toBeInTheDocument();
    });

    it('the save chip carries the canvas version', () => {
        renderHeader();
        expect(screen.getByTestId('save-status-chip')).toHaveTextContent('Saved · v12');
    });
});
