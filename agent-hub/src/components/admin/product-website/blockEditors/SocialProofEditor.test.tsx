import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SocialProofEditor } from './SocialProofEditor';

describe('SocialProofEditor variants', () => {
    afterEach(() => cleanup());

    it('offers the four layouts', () => {
        render(<SocialProofEditor data={{ variant: 'classic' }} onChange={() => {}} />);
        for (const name of ['Classic', 'Numbers', 'Stats only', 'Chips']) {
            expect(screen.getByRole('button', { name })).toBeInTheDocument();
        }
    });

    it('chips: edits chips, no logo list', () => {
        render(<SocialProofEditor data={{ variant: 'chips', chips: [{ label: 'GDPR' }] }} onChange={() => {}} />);
        expect(screen.getByText(/Add chip/)).toBeInTheDocument();
        expect(screen.queryByText(/Logos \(/)).toBeNull();
        expect(screen.queryByText(/Add number/)).toBeNull();
    });

    it('stats: numbers only, no logo list', () => {
        render(<SocialProofEditor data={{ variant: 'stats' }} onChange={() => {}} />);
        expect(screen.getByText(/Add number/)).toBeInTheDocument();
        expect(screen.queryByText(/Logos \(/)).toBeNull();
    });

    it('numbers keeps both lists, classic only the logos', () => {
        const { rerender } = render(<SocialProofEditor data={{ variant: 'numbers' }} onChange={() => {}} />);
        expect(screen.getByText(/Add number/)).toBeInTheDocument();
        expect(screen.getByText(/Logos \(/)).toBeInTheDocument();
        rerender(<SocialProofEditor data={{ variant: 'classic' }} onChange={() => {}} />);
        expect(screen.queryByText(/Add number/)).toBeNull();
        expect(screen.getByText(/Logos \(/)).toBeInTheDocument();
    });

    it('picking Chips writes variant chips and keeps the rest', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<SocialProofEditor data={{ variant: 'classic', eyebrow: 'Proof' }} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: 'Chips' }));
        expect(onChange).toHaveBeenCalledWith({ variant: 'chips', eyebrow: 'Proof' });
    });
});
