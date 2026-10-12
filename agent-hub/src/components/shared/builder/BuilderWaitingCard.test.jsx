import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';
import BuilderWaitingCard from './BuilderWaitingCard';

describe('BuilderWaitingCard', () => {
    it('shows the same Thinking… line as the chat, without the milestone card', () => {
        render(<BuilderWaitingCard />);
        const card = screen.getByTestId('builder-waiting-card');
        expect(card).toHaveAttribute('role', 'status');
        expect(card.querySelector('[data-activity="fallback"]')).not.toBeNull();
        expect(screen.queryByTestId('waiting-bar')).toBeNull();
        expect(screen.queryByTestId('waiting-milestone-sent')).toBeNull();
    });
});
