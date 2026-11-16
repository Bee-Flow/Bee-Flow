import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SaveFooter from './SaveFooter';

describe('SaveFooter', () => {
    it('saves and cancels with the shared Button, Save as the primary action', async () => {
        const onSave = vi.fn();
        const onCancel = vi.fn();
        render(<SaveFooter onSave={onSave} onCancel={onCancel} />);
        const save = screen.getByRole('button', { name: 'Save' });
        expect(save.className).toContain('bg-[var(--button-primary-bg)]');
        await userEvent.click(save);
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('keeps Save off while nothing changed, and leaves Cancel out without onCancel', () => {
        render(<SaveFooter onSave={() => {}} dirty={false} />);
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    });

    it('shows the save in flight in the button and the status chip', () => {
        render(<SaveFooter onSave={() => {}} saving />);
        expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
        expect(screen.getByRole('status')).toHaveTextContent('Saving…');
    });

    it('turns a failed save into a retry', async () => {
        const onRetry = vi.fn();
        render(<SaveFooter onSave={() => {}} saveState="error" onRetry={onRetry} />);
        await userEvent.click(screen.getByRole('button', { name: /retry/i }));
        expect(onRetry).toHaveBeenCalledTimes(1);
    });
});
