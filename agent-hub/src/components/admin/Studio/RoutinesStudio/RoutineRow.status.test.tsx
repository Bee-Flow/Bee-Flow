import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RoutineRow from './RoutineRow';

/**
 * Handoff 5: a library row says what the builder header says, and a routine
 * shared with the caller shows the caller's role and only the actions that
 * role may take.
 */
const routine = (over: Record<string, unknown> = {}) => ({
    id: 'r1', title: 'Invoices', isActive: true, isDraft: false, triggerType: 'manual',
    neverLive: false, liveVersion: 3, pendingChanges: 0, ...over,
});

function renderRow(over: Record<string, unknown> = {}) {
    const handlers = {
        onSelect: vi.fn(), onDuplicate: vi.fn(), onExportJson: vi.fn(), onCopyId: vi.fn(),
        onDelete: vi.fn(), onToggleActive: vi.fn(), onOpenRuns: vi.fn(), onMoveToFolder: vi.fn(),
    };
    render(<RoutineRow routine={routine(over)} kind="automation" selected={false} {...handlers} />);
    return handlers;
}

const meta = () => screen.getByTestId('routine-row-meta').textContent;

describe('RoutineRow status wording', () => {
    afterEach(cleanup);

    it('reads "Draft · never live" for a routine that was never published', () => {
        renderRow({ neverLive: true, liveVersion: null, isActive: false, isDraft: true });
        expect(meta()).toContain('Draft · never live');
        // The old DRAFT chip is gone: the status says it.
        expect(screen.queryByText('draft')).toBeNull();
    });

    it('reads "Live · v3" and the pending changes', () => {
        renderRow({ pendingChanges: 2 });
        expect(meta()).toContain('Live · v3 · 2 changes not live');
    });

    it('reads "Paused" for a switched-off live routine', () => {
        renderRow({ isActive: false });
        expect(meta()).toMatch(/^Paused/);
    });
});

describe('RoutineRow shared with me', () => {
    afterEach(cleanup);

    it('shows no role chip on the caller\'s own routine', () => {
        renderRow();
        expect(screen.queryByTestId('routine-role-chip')).toBeNull();
        expect(screen.getByTitle('Move to trash')).toBeTruthy();
    });

    it.each([['run', 'Can run'], ['view', 'Can view'], ['edit', 'Can edit']])('shows "%s" as %s', (role, label) => {
        renderRow({ myRole: role });
        expect(screen.getByTestId('routine-role-chip').textContent).toBe(label);
    });

    it('offers a "Can run" row only runs and the id, never delete or duplicate', async () => {
        const user = userEvent.setup();
        renderRow({ myRole: 'run' });
        expect(screen.queryByTitle('Move to trash')).toBeNull();
        await user.click(screen.getByLabelText('More options'));
        expect(screen.getByText('View executions')).toBeTruthy();
        expect(screen.getByText('Copy ID')).toBeTruthy();
        expect(screen.queryByText('Duplicate')).toBeNull();
        expect(screen.queryByText('Delete')).toBeNull();
        expect(screen.queryByText('Pause')).toBeNull();
    });

    it('lets a viewer copy it but not change or delete it', async () => {
        const user = userEvent.setup();
        renderRow({ myRole: 'view' });
        await user.click(screen.getByLabelText('More options'));
        expect(screen.getByText('Duplicate')).toBeTruthy();
        expect(screen.queryByText('Pause')).toBeNull();
        expect(screen.queryByText('Delete')).toBeNull();
    });

    it('lets an editor change it but not delete it', async () => {
        const user = userEvent.setup();
        renderRow({ myRole: 'edit' });
        await user.click(screen.getByLabelText('More options'));
        expect(screen.getByText('Pause')).toBeTruthy();
        expect(screen.getByText('Duplicate')).toBeTruthy();
        expect(screen.queryByText('Delete')).toBeNull();
    });
});
