import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

/**
 * The Roles screen's editor. The behaviour worth pinning is the boundary: an
 * organisation may switch the feature permissions, and must NOT be offered a
 * toggle for anything else — the server drops those, so a control that reverts
 * on save is worse than no control.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: { calls: [], impl: null } }));

vi.mock('../../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (key, fallback) => fallback || key, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url, opts) => {
        fetchMock.calls.push({ url, opts });
        return fetchMock.impl ? fetchMock.impl(url, opts) : { ok: true, json: async () => ({}) };
    }),
}));

import RolePermissionEditor from './RolePermissionEditor.jsx';

const ROLE = { id: 'member', name: 'Member', color: '#6b7280' };
const EDITABLE = ['manage_agents', 'use_approvals', 'use_forms', 'use_notebooks'];
const MAPPING = [{
    id: 'member',
    // use_datatables is NOT in EDITABLE — it stands in for everything the
    // install fixes and this screen may only display.
    permissions: ['use_datatables', 'use_approvals', 'use_notebooks'],
}];

const renderEditor = (props = {}) => render(
    <RolePermissionEditor
        role={ROLE}
        mapping={MAPPING}
        editablePermissions={EDITABLE}
        canEdit
        onSaved={vi.fn()}
        {...props}
    />,
);

describe('RolePermissionEditor', () => {
    beforeEach(() => {
        cleanup();
        fetchMock.calls = [];
        fetchMock.impl = null;
    });

    it('offers a toggle for every editable permission, checked to match the role', () => {
        renderEditor();
        expect(screen.getByTestId('role-perm-member-use_notebooks').checked).toBe(true);
        expect(screen.getByTestId('role-perm-member-use_approvals').checked).toBe(true);
        expect(screen.getByTestId('role-perm-member-manage_agents').checked).toBe(false);
    });

    it('never offers a toggle for a permission the organisation may not set', () => {
        // It is still SHOWN — under "Fixed by this role" — because it is part
        // of what the role grants; it just cannot be clicked away here.
        renderEditor();
        expect(screen.queryByTestId('role-perm-member-use_datatables')).toBeNull();
        expect(screen.getByText('Fixed by this role')).toBeTruthy();
        expect(screen.getByText('Use Datatables')).toBeTruthy();
    });

    it('shows Save only once something actually changed, and hides it again on undo', () => {
        renderEditor();
        expect(screen.queryByTestId('role-save-member')).toBeNull();
        fireEvent.click(screen.getByTestId('role-perm-member-use_notebooks'));
        expect(screen.getByTestId('role-save-member')).toBeTruthy();
        // Back to where it started — not a change any more.
        fireEvent.click(screen.getByTestId('role-perm-member-use_notebooks'));
        expect(screen.queryByTestId('role-save-member')).toBeNull();
    });

    it('PUTs the full editable choice, not a delta', async () => {
        fetchMock.impl = async () => ({
            ok: true, json: async () => ({ id: 'member', permissions: ['use_approvals'] }),
        });
        const onSaved = vi.fn();
        renderEditor({ onSaved });
        // The reported case: take Notebooks away from Member.
        fireEvent.click(screen.getByTestId('role-perm-member-use_notebooks'));
        fireEvent.click(screen.getByTestId('role-save-member'));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        const { url, opts } = fetchMock.calls[0];
        expect(url).toBe('/auth/org-roles/member');
        expect(opts.method).toBe('PUT');
        expect(JSON.parse(opts.body)).toEqual({ permissions: ['use_approvals'] });
        // The screen adopts what the SERVER stored, not what was clicked.
        expect(onSaved).toHaveBeenCalledWith('member', ['use_approvals']);
    });

    it('keeps the change on screen and says why when the save is refused', async () => {
        fetchMock.impl = async () => ({
            ok: false, json: async () => ({ error: 'Organization admin access required' }),
        });
        const onSaved = vi.fn();
        renderEditor({ onSaved });
        fireEvent.click(screen.getByTestId('role-perm-member-use_notebooks'));
        fireEvent.click(screen.getByTestId('role-save-member'));

        expect(await screen.findByText('Organization admin access required')).toBeTruthy();
        expect(onSaved).not.toHaveBeenCalled();
        // Still unsaved, so Save is still there to retry — a silent revert
        // would look like it worked.
        expect(screen.getByTestId('role-save-member')).toBeTruthy();
    });

    it('shows a read-only list for someone who may not edit', () => {
        renderEditor({ canEdit: false });
        expect(screen.queryByTestId('role-perm-member-use_notebooks')).toBeNull();
        expect(screen.getByText('Permissions')).toBeTruthy();
        // Everything the role grants is listed, editable or not — a viewer
        // still needs the full answer to "what can a Member do".
        expect(screen.getByText('Notebooks')).toBeTruthy();
        expect(screen.getByText('Use Datatables')).toBeTruthy();
    });
});
