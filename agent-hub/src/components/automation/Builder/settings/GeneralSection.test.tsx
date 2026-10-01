import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch }));
vi.mock('../BuilderConfirmContext', () => ({ useBuilderConfirm: () => async () => true }));

import GeneralSection from './GeneralSection';

const json = (body: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => body });

function route(url: string, init?: RequestInit) {
    const method = init?.method || 'GET';
    if (url.endsWith('/folders')) return json({ folders: [{ id: 'f1', name: 'Finance' }] });
    if (url.endsWith('/suggest-description')) return json({ description: 'Collects the folder listing from Nextcloud.' });
    if (url.endsWith('/restore')) return json({ automation: { id: 'a1' } });
    if (url.endsWith('/upgrade-mappings?dryRun=1')) return json(UPGRADE);
    if (url.endsWith('/upgrade-mappings')) return json({ ...UPGRADE, dryRun: false, saved: true, version: 3, automation: { id: 'a1', version: 3, definition: { steps: ['upgraded'] } } });
    if (method === 'DELETE') return json({ success: true, purgeAt: '2026-10-28T00:00:00Z' });
    return json({}, false, 404);
}

const automation = { id: 'a1', title: 'Collect files', description: '', folderId: null, icon: null, definition: {} };
const UPGRADE = {
    dryRun: true, saved: false, version: 2, evidence: { lastRun: true, sample: false },
    changed: [{ stepId: 's', step: 'Send', field: 'inputs.to', kind: 'ref', take: 'one', root: 'trigger', label: 'E-mail' }], kept: [],
};

describe('Settings › General', () => {
    beforeEach(() => { authFetch.mockReset(); authFetch.mockImplementation(route); });

    it('saves the name by itself on blur', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(withQueryClient(<GeneralSection automation={automation} onSave={onSave} />));
        const name = screen.getByLabelText('Name');
        await user.clear(name);
        await user.type(name, 'Fetch files');
        await user.tab();
        await waitFor(() => expect(onSave).toHaveBeenCalledWith({ title: 'Fetch files' }));
    });

    it('never saves a blank name and puts the stored one back on blur', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(withQueryClient(<GeneralSection automation={automation} onSave={onSave} />));
        const name = screen.getByLabelText('Name') as HTMLInputElement;
        await user.clear(name);
        await user.tab();
        expect(onSave).not.toHaveBeenCalled();
        expect(name.value).toBe('Collect files');
    });

    it('turns Bee\'s proposal into the description on Accept', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(withQueryClient(<GeneralSection automation={automation} onSave={onSave} />));
        await user.click(screen.getByRole('button', { name: /Let Bee suggest a description/ }));
        expect(await screen.findByText('Collects the folder listing from Nextcloud.')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Another suggestion/ })).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Accept' }));
        expect(onSave).toHaveBeenCalledWith({ description: 'Collects the folder listing from Nextcloud.' });
        expect((screen.getByLabelText(/What does this automation do/) as HTMLTextAreaElement).value).toBe('Collects the folder listing from Nextcloud.');
    });

    it('files the routine in a folder and sets an icon', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn().mockResolvedValue(undefined);
        render(withQueryClient(<GeneralSection automation={automation} onSave={onSave} />));
        await screen.findByRole('option', { name: 'Finance' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Folder' }), 'f1');
        expect(onSave).toHaveBeenCalledWith({ folderId: 'f1' });
        await user.click(screen.getByRole('button', { name: 'Receipt' }));
        expect(onSave).toHaveBeenCalledWith({ icon: 'Receipt' });
    });

    it('moves the routine to the trash and can undo it', async () => {
        const user = userEvent.setup();
        const onAutomationChange = vi.fn();
        render(withQueryClient(<GeneralSection automation={automation} onSave={vi.fn()} onAutomationChange={onAutomationChange} />));
        expect(screen.getByText('First 30 days in the trash; runs are kept')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Delete…' }));
        expect(await screen.findByText('Moved to the trash.')).toBeTruthy();
        expect(authFetch).toHaveBeenCalledWith('/api/automation/a1', { method: 'DELETE' });
        expect(onAutomationChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a1', isActive: false }));
        await user.click(screen.getByRole('button', { name: 'Undo' }));
        expect(await screen.findByText('Restored.')).toBeTruthy();
        expect(onAutomationChange).toHaveBeenLastCalledWith(expect.objectContaining({ deletedAt: null }));
    });

    it('Update mappings: a dry run in a dialog, and the saved definition goes to onDefinitionReplaced', async () => {
        const user = userEvent.setup();
        const onDefinitionReplaced = vi.fn();
        render(withQueryClient(<GeneralSection automation={automation} onSave={vi.fn()} onDefinitionReplaced={onDefinitionReplaced} />));
        expect(screen.getByText('Show fields as values instead of formulas, wherever the result stays the same')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Check…' }));
        expect(await screen.findByText('1 field(s) can be updated, 0 stay a Formula')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Update 1 field(s)' }));
        await waitFor(() => expect(onDefinitionReplaced).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', version: 3, definition: { steps: ['upgraded'] } })));
    });

    it('Update mappings is for owners and editors only', () => {
        render(withQueryClient(<GeneralSection automation={{ ...automation, myRole: 'view' }} onSave={vi.fn()} />));
        expect(screen.queryByRole('button', { name: 'Check…' })).toBeNull();
    });

    it('says so when a whole-routine action fails', async () => {
        const user = userEvent.setup();
        authFetch.mockImplementation((url: string, init?: RequestInit) => (url.endsWith('/save-as-template')
            ? json({ error: 'Templates are off for this organisation.' }, false, 403)
            : route(url, init)));
        render(withQueryClient(<GeneralSection automation={automation} onSave={vi.fn()} />));
        await user.click(screen.getByRole('button', { name: 'As template' }));
        expect((await screen.findByRole('alert')).textContent).toBe('Templates are off for this organisation.');
    });
});
