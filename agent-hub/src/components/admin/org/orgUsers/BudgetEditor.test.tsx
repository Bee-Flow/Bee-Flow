import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import BudgetEditor from './BudgetEditor';
import { toast } from '@/components/shared/Toast';

const LABEL = 'Monthly AI budget (€)';

function setup(value: number | null | undefined = null) {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BudgetEditor value={value} label={LABEL} suffix="/mo" onSave={onSave} />);
    return onSave;
}

afterEach(() => vi.restoreAllMocks());

describe('BudgetEditor', () => {
    it('shows "No limit" without a value and the amount with one', () => {
        setup(null);
        expect(screen.getByText('No limit')).toBeInTheDocument();
    });

    it('shows the amount with its suffix', () => {
        setup(25);
        expect(screen.getByText('€25.00/mo')).toBeInTheDocument();
    });

    it('saves the typed amount on Enter', async () => {
        const user = userEvent.setup();
        const onSave = setup(null);
        await user.click(screen.getByTitle(LABEL));
        await user.type(screen.getByLabelText(LABEL), '25{Enter}');
        expect(onSave).toHaveBeenCalledWith(25);
    });

    it('rejects zero with an error and does not save', async () => {
        const user = userEvent.setup();
        const err = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
        const onSave = setup(null);
        await user.click(screen.getByTitle(LABEL));
        await user.type(screen.getByLabelText(LABEL), '0{Enter}');
        expect(err).toHaveBeenCalled();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('saves null for an empty field', async () => {
        const user = userEvent.setup();
        const onSave = setup(25);
        await user.click(screen.getByTitle(LABEL));
        await user.clear(screen.getByLabelText(LABEL));
        await user.keyboard('{Enter}');
        expect(onSave).toHaveBeenCalledWith(null);
    });

    it('cancels on Escape', async () => {
        const user = userEvent.setup();
        const onSave = setup(25);
        await user.click(screen.getByTitle(LABEL));
        await user.keyboard('{Escape}');
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText('€25.00/mo')).toBeInTheDocument();
    });
});
