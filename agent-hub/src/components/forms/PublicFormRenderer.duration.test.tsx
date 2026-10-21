import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormWaitingView } from './PublicFormRenderer';

describe('FormWaitingView — typical duration', () => {
    it('says nothing about the length of the wait when it is not known', () => {
        render(<FormWaitingView progress={['Step one']} />);
        expect(screen.queryByTestId('form-waiting-typical')).toBeNull();
        expect(screen.queryByText(/Usually takes/)).toBeNull();
    });

    it('shows a short wait as under a minute', () => {
        render(<FormWaitingView progress={['Step one']} typicalSeconds={20} />);
        expect(screen.getByTestId('form-waiting-typical').textContent).toBe('Usually takes less than a minute');
    });

    it('rounds a longer one to minutes, then hours', () => {
        const { rerender } = render(<FormWaitingView typicalSeconds={150} />);
        expect(screen.getByTestId('form-waiting-typical').textContent).toBe('Usually takes about 3 minutes');
        rerender(<FormWaitingView typicalSeconds={3 * 3600} />);
        expect(screen.getByTestId('form-waiting-typical').textContent).toBe('Usually takes about 3 hours');
    });

    it('keeps the progress line and the note where they were', () => {
        render(<FormWaitingView progress={['Outer', 'Inner']} note="Looks things up" typicalSeconds={90} />);
        expect(screen.getByText('Inner')).toBeTruthy();
        expect(screen.getByTestId('form-waiting-note').textContent).toBe('Looks things up');
        expect(screen.getByTestId('form-waiting-typical')).toBeTruthy();
    });
});
