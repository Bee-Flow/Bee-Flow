import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NdvHeader, { type NdvHeaderProps } from './NdvHeader';

function props(over: Partial<NdvHeaderProps> = {}): NdvHeaderProps {
    return {
        step: { id: 's2', type: 'integration_action', tool: 'nc_read' },
        family: 'app',
        kicker: 'Action',
        title: 'Read invoice',
        position: { index: 2, total: 8, prevId: 's1', nextId: 's3' },
        canNavigate: true,
        goPrev: vi.fn(),
        goNext: vi.fn(),
        pill: { tone: 'error', label: 'Failed on last run' },
        save: { state: 'idle', lastSavedAt: null, onRetry: null },
        onRetryStep: vi.fn(),
        retryDisabled: false,
        onTest: vi.fn(),
        testBusy: false,
        testDisabled: false,
        menu: {
            pinned: false, canPin: true, pinTitle: 'Pin this output', onTogglePin: vi.fn(),
            disabled: false, onToggleDisabled: vi.fn(), onDuplicate: vi.fn(), onDelete: vi.fn(),
        },
        columns: { quick: false, inputOpen: true, outputOpen: true, onInput: vi.fn(), onOutput: vi.fn() },
        modeToggle: null,
        onExpand: null,
        onShrink: vi.fn(),
        onClose: vi.fn(),
        ...over,
    };
}

describe('NdvHeader — the round-4 step drawer header', () => {
    beforeEach(cleanup);

    it('reads "Action · Step 2 of 8" over the title, with the last run in a pill', () => {
        render(<NdvHeader {...props()} />);
        expect(screen.getByTestId('ndv-kicker').textContent).toBe('Action · Step 2 of 8');
        expect(screen.getByTestId('ndv-title').textContent).toBe('Read invoice');
        const pill = screen.getByTestId('ndv-status-pill');
        expect(pill.textContent).toBe('Failed on last run');
        expect(pill.getAttribute('data-tone')).toBe('error');
    });

    it('makes Test step the primary action and offers Retry beside it', async () => {
        const p = props();
        render(<NdvHeader {...p} />);
        const test = screen.getByRole('button', { name: 'Test step' });
        expect(test.className).toContain('bg-[var(--accent-primary)]');
        await userEvent.click(test);
        expect(p.onTest).toHaveBeenCalled();
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(p.onRetryStep).toHaveBeenCalled();
    });

    it('keeps Pin / Duplicate / Disable / Delete in the ⋯ menu', async () => {
        const p = props();
        render(<NdvHeader {...p} />);
        expect(screen.queryByRole('menuitem', { name: /Duplicate/ })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'More step actions' }));
        const items = screen.getAllByRole('menuitem').map(el => el.textContent?.trim());
        expect(items).toEqual(['Pin', 'Duplicate', 'Disable', 'Delete']);
        await userEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
        expect(p.menu?.onDelete).toHaveBeenCalled();
        expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('leaves the pill out when there is nothing to say, and the menu out when it is empty', () => {
        render(<NdvHeader {...props({ pill: null, menu: null, onRetryStep: null })} />);
        expect(screen.queryByTestId('ndv-status-pill')).toBeNull();
        expect(screen.queryByRole('button', { name: 'More step actions' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
});
