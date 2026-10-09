import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import DocumentSharingDialog from './DocumentSharingDialog';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../documentsApi', () => ({ documentRequest: request }));

beforeEach(() => {
    request.mockReset().mockImplementation(async (path, _body, method) => {
        if (method === 'PUT') return { sharing: {} };
        if (path.endsWith('/principals')) return { users: [{ id: 'bob', name: 'Bob' }], groups: [{ id: 'finance', name: 'Finance' }] };
        return { sharing: { audience: 'private', sharedGroups: [], sharedUserIds: [], organizationId: 'org1' } };
    });
});

it.each(['page', 'document', 'presentation', 'spreadsheet', 'notebook'])('shares a %s with users and groups through its own endpoint', async (docType) => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(withQueryClient(<DocumentSharingDialog row={{ id: 'd1', userId: 'alice', name: 'Plan', docType }} onClose={onClose} />));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Who has access' }), 'restricted');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.click(await screen.findByRole('checkbox', { name: 'Finance' }));
    await user.click(screen.getByRole('tab', { name: 'Users (1)' }));
    await user.click(screen.getByRole('checkbox', { name: 'Bob' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const prefix = docType === 'notebook' ? '/notebooks' : '';
    await waitFor(() => expect(request).toHaveBeenCalledWith(`${prefix}/d1/sharing`, { audience: 'restricted', sharedUserIds: ['bob'], sharedGroups: ['finance'], ...(docType === 'notebook' ? {} : { access: 'view' }) }, 'PUT'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it('keeps the dialog open when the organisation encryption key is unavailable', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const original = request.getMockImplementation()!;
    request.mockImplementation((path, body, method) => method === 'PUT'
        ? Promise.reject(new Error('The encryption key for this document is unavailable.')) : original(path, body, method));
    render(withQueryClient(<DocumentSharingDialog row={{ id: 'd1', userId: 'alice', name: 'Plan', docType: 'page' }} onClose={onClose} />));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Who has access' }), 'organisation');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('encryption key');
    expect(onClose).not.toHaveBeenCalled();
});

it('keeps selections across searches, recipient types and pages in a large directory', async () => {
    const groups = Array.from({ length: 45 }, (_, i) => ({ id: `g${i}`, name: `Group ${String(i).padStart(2, '0')}` }));
    const users = Array.from({ length: 1000 }, (_, i) => ({ id: `u${i}`, name: `Person ${String(i).padStart(4, '0')}` }));
    const original = request.getMockImplementation()!;
    request.mockImplementation((path, body, method) => path.endsWith('/principals') ? Promise.resolve({ groups, users }) : original(path, body, method));
    const user = userEvent.setup();
    render(withQueryClient(<DocumentSharingDialog row={{ id: 'd1', userId: 'alice', name: 'Plan', docType: 'page' }} onClose={vi.fn()} />));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Who has access' }), 'restricted');
    await screen.findByRole('checkbox', { name: 'Group 00' });
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    await user.click(screen.getByRole('checkbox', { name: 'Group 00' }));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByRole('checkbox', { name: 'Group 06' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Remove Group 00' })).toBeVisible();
    const search = screen.getByRole('searchbox', { name: 'Search users and groups' });
    await user.type(search, 'Group 44');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: 'Group 44' }));
    await user.clear(search);
    await user.click(screen.getByRole('tab', { name: 'Users (1000)' }));
    await user.type(search, 'Person 0999');
    await user.click(screen.getByRole('checkbox', { name: 'Person 0999' }));
    await user.click(screen.getByRole('tab', { name: 'Selected (3)' }));
    await user.click(screen.getByRole('button', { name: 'Remove Group 00' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/d1/sharing', { audience: 'restricted', sharedUserIds: ['u999'], sharedGroups: ['g44'], access: 'view' }, 'PUT'));
});

it('collapses a long existing selection and keeps pagination valid after removal', async () => {
    const users = Array.from({ length: 7 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }));
    request.mockImplementation(async (path) => path.endsWith('/principals') ? { groups: [], users }
        : { sharing: { audience: 'restricted', sharedUserIds: users.map((u) => u.id), sharedGroups: [], organizationId: 'org1' } });
    const user = userEvent.setup();
    render(withQueryClient(<DocumentSharingDialog row={{ id: 'd1', userId: 'alice', name: 'Plan', docType: 'page' }} onClose={vi.fn()} />));
    await user.click(await screen.findByRole('button', { name: '+4 more' }));
    expect(screen.getAllByRole('button', { name: /^Remove Person/ })).toHaveLength(3);
    expect(screen.getAllByRole('checkbox')).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await user.click(screen.getByRole('checkbox', { name: /^Person 6/ }));
    expect(screen.getByText('1–6 of 6')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByRole('tab', { name: 'Selected (0)' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

it('offers keyboard navigation between recipient tabs', async () => {
    const user = userEvent.setup();
    render(withQueryClient(<DocumentSharingDialog row={{ id: 'd1', userId: 'alice', name: 'Plan', docType: 'page' }} onClose={vi.fn()} />));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Who has access' }), 'restricted');
    const groups = screen.getByRole('tab', { name: 'Groups (1)' });
    groups.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Users (1)' })).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: 'Bob' })).toBeVisible();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Selected (0)' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(groups).toHaveFocus();
});

it('sends can edit for a document, keeps the select off while private, and hides it for a notebook', async () => {
    const user = userEvent.setup();
    const { unmount } = render(withQueryClient(<DocumentSharingDialog row={{ id: 'd1', userId: 'alice', name: 'Plan', docType: 'page' }} onClose={vi.fn()} />));
    const access = await screen.findByRole('combobox', { name: 'What they can do' });
    expect(access).toBeDisabled();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Who has access' }), 'organisation');
    await user.selectOptions(access, 'edit');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/d1/sharing', { audience: 'organisation', sharedGroups: [], sharedUserIds: [], access: 'edit' }, 'PUT'));
    unmount();
    render(withQueryClient(<DocumentSharingDialog row={{ id: 'n1', userId: 'alice', name: 'Book', docType: 'notebook' }} onClose={vi.fn()} />));
    await screen.findByRole('combobox', { name: 'Who has access' });
    expect(screen.queryByRole('combobox', { name: 'What they can do' })).toBeNull();
});
