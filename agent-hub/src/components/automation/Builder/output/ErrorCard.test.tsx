import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ErrorCard, { type StepErrorInfo } from './ErrorCard';

const NOT_SHARED: StepErrorInfo = {
    code: 'nextcloud_forbidden',
    title: 'Bee may not open this folder',
    cause: 'The file was found, but the account bee-bot has no access to the folder /Invoices.',
    settingKey: 'connection',
    fixes: [
        { id: 'share_folder', label: null, params: { folder: '/Invoices', account: 'bee-bot' } },
        { id: 'switch_account', label: null, params: null },
    ],
    technical: 'HTTP 403 Forbidden: PROPFIND /remote.php/dav/files/bee-bot/Invoices',
};

beforeEach(() => cleanup());

describe('why the step stopped (artboard 4a)', () => {
    it('leads with a plain title and cause, the raw message one click away', async () => {
        const user = userEvent.setup();
        render(<ErrorCard info={NOT_SHARED} error="HTTP 403" />);
        expect(screen.getByText('Bee may not open this folder')).toBeTruthy();
        expect(screen.getByText(/has no access to the folder/)).toBeTruthy();
        expect(screen.queryByText(/PROPFIND/)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'technical message' }));
        expect(screen.getByText(/PROPFIND/)).toBeTruthy();
    });

    it('names the fixes, the first as the primary button', () => {
        render(<ErrorCard info={NOT_SHARED} error="HTTP 403" />);
        const share = screen.getByRole('button', { name: 'Share the folder with bee-bot' });
        expect(share.className).toContain('bg-[var(--accent-primary)]');
        expect(screen.getByRole('button', { name: 'Other account' })).toBeTruthy();
    });

    it('explains how to share when there is no link to open', async () => {
        const user = userEvent.setup();
        render(<ErrorCard info={NOT_SHARED} error="HTTP 403" />);
        await user.click(screen.getByRole('button', { name: 'Share the folder with bee-bot' }));
        expect(screen.getByRole('status').textContent).toContain('/Invoices');
    });

    it('opens the share when the server knows its address', async () => {
        const user = userEvent.setup();
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        const info = { ...NOT_SHARED, fixes: [{ id: 'share_folder', params: { shareUrl: 'https://cloud.example/f/12' } }] };
        render(<ErrorCard info={info} error="HTTP 403" />);
        await user.click(screen.getByRole('button', { name: 'Share the folder' }));
        expect(open).toHaveBeenCalledWith('https://cloud.example/f/12', '_blank', 'noopener');
        open.mockRestore();
    });

    it('hands setting fixes and retry to the drawer', async () => {
        const user = userEvent.setup();
        const onFix = vi.fn();
        const onRetry = vi.fn();
        const info = { ...NOT_SHARED, fixes: [...(NOT_SHARED.fixes || []), { id: 'retry' }] };
        render(<ErrorCard info={info} error="HTTP 403" onFix={onFix} onRetry={onRetry} />);
        await user.click(screen.getByRole('button', { name: 'Other account' }));
        expect(onFix).toHaveBeenCalledWith(expect.objectContaining({ id: 'switch_account' }), info);
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(onRetry).toHaveBeenCalled();
    });

    it('shows the message itself when the server did not classify it', () => {
        render(<ErrorCard info={null} error="Timed out after 30 s" />);
        expect(screen.getByText('This step stopped with an error')).toBeTruthy();
        expect(screen.getByText('Timed out after 30 s')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'technical message' })).toBeNull();
    });

});

describe('the fixes as the server sends them (D4s)', () => {
    it('reads the server shape: a label key first, the English label only as fallback', () => {
        const info: StepErrorInfo = {
            ...NOT_SHARED,
            fixes: [
                { id: 'share_folder', label: 'Share the folder with bee-bot', labelKey: 'routines.output.fix_share_with', params: { folder: '/Invoices', account: 'bee-bot' } },
                { id: 'custom_fix', label: 'Ask IT' },
            ],
        };
        render(<ErrorCard info={info} error="HTTP 403" />);
        expect(screen.getByRole('button', { name: 'Share the folder with bee-bot' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Ask IT' })).toBeTruthy();
    });

    it('opens the integrations page for reconnect, even when the drawer takes setting fixes', async () => {
        const user = userEvent.setup();
        const open = vi.spyOn(window, 'open').mockReturnValue(null);
        const onFix = vi.fn();
        const info = { ...NOT_SHARED, fixes: [{ id: 'reconnect', params: { service: 'Nextcloud' } }] };
        render(<ErrorCard info={info} error="401" onFix={onFix} />);
        await user.click(screen.getByRole('button', { name: 'Reconnect' }));
        expect(open).toHaveBeenCalledWith('/app/settings/integrations', '_blank', 'noopener');
        expect(onFix).not.toHaveBeenCalled();
        open.mockRestore();
    });

    it('names the setting in words when the drawer cannot show it', async () => {
        const user = userEvent.setup();
        const info: StepErrorInfo = {
            code: 'not_found', title: 'Not found', settingKey: 'inputs.path',
            fixes: [{ id: 'pick_other', params: { settingKey: 'inputs.path' } }],
        };
        render(<ErrorCard info={info} error="404" onFix={() => false} />);
        await user.click(screen.getByRole('button', { name: 'Pick another' }));
        expect(screen.getByRole('status').textContent).toContain('"path"');
    });
});
