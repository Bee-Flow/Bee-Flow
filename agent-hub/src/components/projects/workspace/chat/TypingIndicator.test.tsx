import { render, screen } from '@testing-library/react';
import React from 'react';
import { expect, it } from 'vitest';
import TypingIndicator from './TypingIndicator';

it('keeps one polite status region mounted while nobody is busy, so a screen reader hears the first line', () => {
    const { rerender } = render(<TypingIndicator names={[]} aiAnswering={false} aiName="AI assistant" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toBeEmptyDOMElement();
    expect(screen.queryByTestId('team-chat-typing')).not.toBeInTheDocument();

    rerender(<TypingIndicator names={['Ada']} aiAnswering={false} aiName="AI assistant" />);
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Ada is typing…');
    expect(screen.getByTestId('team-chat-typing')).toBe(region);
});
