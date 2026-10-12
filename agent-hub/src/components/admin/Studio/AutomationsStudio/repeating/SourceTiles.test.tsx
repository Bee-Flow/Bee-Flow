import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ScanSourceGroup } from '../../../../../api/queries/automation/repeating';
import SourceTiles, { ScanAction } from './SourceTiles';
import type { SourceTilesProps } from './SourceTiles';

const GROUPS: ScanSourceGroup[] = [
    { id: 'mail', kind: 'live', connected: true, apps: [{ id: 'gmail', label: 'Gmail', connected: true }, { id: 'outlook', label: 'Outlook', connected: false }] },
    { id: 'calendar', kind: 'stored', connected: false, apps: [{ id: 'teams', label: 'Teams', connected: false }] },
    { id: 'files', kind: 'live', connected: true, apps: [{ id: 'nextcloud', label: 'Nextcloud Files', connected: true }, { id: 'onedrive', label: 'OneDrive', connected: true }] },
];

function renderTiles(over: Partial<SourceTilesProps> = {}) {
    const props: SourceTilesProps = {
        groups: GROUPS, selected: new Set(['mail', 'files']), onToggle: vi.fn(), busy: false,
        focus: '', setFocus: vi.fn(), focusOpen: false, setFocusOpen: vi.fn(),
        action: { scanned: false, lastScannedAt: null, onScan: vi.fn(), disabledReason: null },
        ...over,
    };
    render(<SourceTiles {...props} />);
    return props;
}

describe('SourceTiles', () => {
    it('shows one trigger-shaped tile per source group, live or from history', () => {
        renderTiles();
        const mail = within(screen.getByTestId('source-tile-mail'));
        expect(mail.getByText('Mail')).toBeTruthy();
        expect(mail.getByText('Source')).toBeTruthy();
        expect(mail.getByText('· Live')).toBeTruthy();
        expect(mail.getByText('1 app connected')).toBeTruthy();
        expect(screen.getByTestId('source-tile-mail').className).toContain('!rounded-[36px_');
        expect(within(screen.getByTestId('source-tile-files')).getByText('2 apps connected')).toBeTruthy();
        expect(within(screen.getByTestId('source-tile-calendar')).getByText('· History')).toBeTruthy();
    });

    it('lists only the connected apps of a group', () => {
        renderTiles();
        const mail = within(screen.getByTestId('source-tile-mail'));
        expect(mail.getByText('Gmail')).toBeTruthy();
        expect(mail.queryByText('Outlook')).toBeNull();
    });

    it('draws a group with nothing connected as a dashed placeholder with Connect', () => {
        renderTiles();
        const tile = screen.getByTestId('source-tile-calendar');
        expect(tile.className).toContain('!border-dashed');
        expect(within(tile).getByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/app/settings/integrations');
        expect(within(tile).queryByRole('switch')).toBeNull();
    });

    it('switches a group on and off, but not while a scan runs', async () => {
        const user = userEvent.setup();
        const { onToggle } = renderTiles({ selected: new Set(['files']) });
        const mail = screen.getByRole('switch', { name: 'Include Mail' });
        expect(mail).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByRole('switch', { name: 'Include Files' })).toHaveAttribute('aria-checked', 'true');
        await user.click(mail);
        expect(onToggle).toHaveBeenCalledWith('mail');
    });

    it('disables the switches while busy', () => {
        renderTiles({ busy: true });
        expect(screen.getByRole('switch', { name: 'Include Mail' })).toBeDisabled();
    });

    it('keeps the focus folded behind a chip until asked for', async () => {
        const user = userEvent.setup();
        const { setFocusOpen } = renderTiles();
        expect(screen.queryByRole('textbox')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Focus' }));
        expect(setFocusOpen).toHaveBeenCalledWith(true);
    });

    it('an open focus can be typed into and removed again', async () => {
        const user = userEvent.setup();
        const { setFocus, setFocusOpen } = renderTiles({ focusOpen: true, focus: 'invoices' });
        expect(screen.getByRole('textbox', { name: 'Focus (optional)' })).toHaveValue('invoices');
        await user.click(screen.getByRole('button', { name: 'Remove focus' }));
        expect(setFocus).toHaveBeenCalledWith('');
        expect(setFocusOpen).toHaveBeenCalledWith(false);
    });
});

describe('ScanAction', () => {
    it('is the canvas primary button before the first scan', async () => {
        const user = userEvent.setup();
        const onScan = vi.fn();
        render(<ScanAction scanned={false} lastScannedAt={null} onScan={onScan} disabledReason={null} />);
        const button = screen.getByRole('button', { name: 'Scan my recent work' });
        expect(button.className).toContain('bg-[var(--accent-primary)]');
        await user.click(button);
        expect(onScan).toHaveBeenCalledWith(false);
    });

    it('says why when it cannot scan', () => {
        render(<ScanAction scanned={false} lastScannedAt={null} onScan={vi.fn()} disabledReason="Switch on at least one source to scan." />);
        const button = screen.getByRole('button', { name: 'Scan my recent work' });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription('Switch on at least one source to scan.');
    });

    it('after a scan: when it ran, and a forced Scan again', async () => {
        const user = userEvent.setup();
        const onScan = vi.fn();
        render(<ScanAction scanned lastScannedAt={new Date().toISOString()} onScan={onScan} disabledReason={null} />);
        expect(screen.getByText('Scanned just now')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Scan again' }));
        expect(onScan).toHaveBeenCalledWith(true);
    });
});
