// The licence grants' dialogs, in place of window.prompt: a date picker for
// the expiry, an organisation picker for an import, and a copy field when the
// clipboard refuses.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyBlobDialog, ExtendDialog, ImportDialog } from './GrantDialogs';

describe('ExtendDialog', () => {
    it('starts on the current expiry and saves the picked date', async () => {
        const user = userEvent.setup();
        const onSave = vi.fn();
        render(<ExtendDialog grant={{ id: 'g1', expiresAt: '2030-05-01T00:00:00Z' }} busy={false} onClose={() => {}} onSave={onSave} />);
        const field = screen.getByLabelText('Valid until');
        expect(field).toHaveValue('2030-05-01');
        await user.clear(field);
        await user.type(field, '2031-01-15');
        await user.click(screen.getByRole('button', { name: 'Save expiry' }));
        expect(onSave).toHaveBeenCalledWith('2031-01-15');
    });

    it('is closed without a grant', () => {
        render(<ExtendDialog grant={null} busy={false} onClose={() => {}} onSave={() => {}} />);
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});

describe('ImportDialog', () => {
    const orgs = [{ id: 'org-a', name: 'Org A' }, { id: 'org-b', name: 'Org B' }];

    it('imports nothing until a blob is pasted, then binds it to the picked organisation', async () => {
        const user = userEvent.setup();
        const onImport = vi.fn();
        render(<ImportDialog open orgs={orgs} busy={false} onClose={() => {}} onImport={onImport} />);
        expect(screen.getByRole('button', { name: 'Import blob' })).toBeDisabled();
        await user.type(screen.getByRole('textbox', { name: 'Licence blob' }), '  beeflow-admin-v1.abc  ');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Organisation' }), 'org-b');
        await user.click(screen.getByRole('button', { name: 'Import blob' }));
        expect(onImport).toHaveBeenCalledWith('beeflow-admin-v1.abc', 'org-b');
    });

    it('leaves the organisation to the blob by default', async () => {
        const user = userEvent.setup();
        const onImport = vi.fn();
        render(<ImportDialog open orgs={orgs} busy={false} onClose={() => {}} onImport={onImport} />);
        expect(screen.getByRole('combobox', { name: 'Organisation' })).toHaveDisplayValue('The organisation named in the blob');
        await user.type(screen.getByRole('textbox', { name: 'Licence blob' }), 'blob');
        await user.click(screen.getByRole('button', { name: 'Import blob' }));
        expect(onImport).toHaveBeenCalledWith('blob', null);
    });
});

describe('CopyBlobDialog', () => {
    it('shows the blob read-only for copying by hand', () => {
        render(<CopyBlobDialog blob="beeflow-admin-v1.xyz" onClose={() => {}} />);
        const field = screen.getByRole('textbox', { name: 'Licence blob' });
        expect(field).toHaveValue('beeflow-admin-v1.xyz');
        expect(field).toHaveAttribute('readonly');
    });
});
