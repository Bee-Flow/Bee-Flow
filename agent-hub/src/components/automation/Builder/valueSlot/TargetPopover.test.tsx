import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TargetPopover, { orderTargets } from './TargetPopover';

const TARGETS = [
    { id: 'cc', label: 'Cc' },
    { id: 'to', label: 'To', required: true },
    { id: 'priority', label: 'Priority' },
    { id: 'subject', label: 'Subject', required: true },
];

describe('TargetPopover', () => {
    it('asks where the value should go, empty required fields first', async () => {
        const onChoose = vi.fn();
        render(<TargetPopover targets={TARGETS} valueLabel="E-mail van klant" onChoose={onChoose} onClose={() => {}} />);
        const dialog = screen.getByRole('dialog', { name: 'Where should this go?' });
        expect(within(dialog).getByText('Put E-mail van klant in:')).toBeInTheDocument();
        const items = within(dialog).getAllByRole('listitem').map(li => li.textContent);
        expect(items).toEqual(['ToRequired', 'SubjectRequired', 'Cc', 'Priority']);
        expect(within(dialog).getByRole('button', { name: /^To/ })).toHaveFocus();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cc' }));
        expect(onChoose).toHaveBeenCalledWith('cc');
    });

    it('closes on Escape and on the close button', async () => {
        const onClose = vi.fn();
        render(<TargetPopover targets={TARGETS} onChoose={() => {}} onClose={onClose} />);
        await userEvent.keyboard('{Escape}');
        await userEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('says so when every field is filled', () => {
        render(<TargetPopover targets={[]} onChoose={() => {}} onClose={() => {}} />);
        expect(screen.getByText(/Every field of this step is filled/)).toBeInTheDocument();
    });

    it('orderTargets keeps form order within each group', () => {
        expect(orderTargets(TARGETS).map(x => x.id)).toEqual(['to', 'subject', 'cc', 'priority']);
    });
});

describe('TargetPopover without focus', () => {
    it('leaves focus where it is when asked to (a gallery, a static view)', () => {
        render(<TargetPopover targets={TARGETS} onChoose={() => {}} onClose={() => {}} autoFocus={false} />);
        expect(document.body).toHaveFocus();
    });
});
