import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SaveBar from './SaveBar';
import type { SetLeaveGuard } from './useLeaveGuard';

describe('SaveBar', () => {
    it('stays hidden while the form is clean, and appears with the first edit', () => {
        const { rerender } = render(<SaveBar dirty={false} onSave={() => {}} />);
        expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
        rerender(<SaveBar dirty onSave={() => {}} />);
        expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    });

    it('saves, discards, and says the outcome in the tone tokens', async () => {
        const onSave = vi.fn();
        const onDiscard = vi.fn();
        const { rerender } = render(<SaveBar dirty onSave={onSave} onDiscard={onDiscard} />);
        await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onDiscard).toHaveBeenCalledTimes(1);

        rerender(<SaveBar dirty={false} onSave={onSave} message={{ type: 'error', text: 'Could not save' }} />);
        expect(screen.getByRole('status')).toHaveTextContent('Could not save');
        expect(screen.getByRole('status').className).toContain('text-[var(--error-ink)]');
        expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('disables Save while saving and says so', () => {
        render(<SaveBar dirty saving onSave={() => {}} />);
        expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    });

    it('asks before the host navigates away while dirty, and lets go once clean', async () => {
        let guard: (() => Promise<boolean>) | null = null;
        const setLeaveGuard: SetLeaveGuard = (fn) => { guard = fn; };
        const { rerender } = render(<SaveBar dirty onSave={() => {}} setLeaveGuard={setLeaveGuard} />);
        expect(guard).not.toBeNull();

        let answer: Promise<boolean> | undefined;
        act(() => { answer = guard!(); });
        expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
        await expect(answer).resolves.toBe(true);

        rerender(<SaveBar dirty={false} onSave={() => {}} setLeaveGuard={setLeaveGuard} />);
        await waitFor(() => expect(guard).toBeNull());
    });

    it('blocks closing the tab only while dirty', () => {
        const add = vi.spyOn(window, 'addEventListener');
        const remove = vi.spyOn(window, 'removeEventListener');
        const { rerender } = render(<SaveBar dirty onSave={() => {}} />);
        expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function));
        rerender(<SaveBar dirty={false} onSave={() => {}} />);
        expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function));
        add.mockRestore();
        remove.mockRestore();
    });
});
