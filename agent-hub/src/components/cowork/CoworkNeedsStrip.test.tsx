// "Needs you": the one slot for what waits for the owner. It says nothing while nothing waits, shows each kind of
// thing that waits as one entry, and the header's badge counts the same entries.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CoworkNeedsStrip, { needsCount } from './CoworkNeedsStrip';

describe('CoworkNeedsStrip', () => {
    it('renders nothing without entries', () => {
        const { container } = render(<CoworkNeedsStrip entries={[]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when every entry counts zero', () => {
        const { container } = render(<CoworkNeedsStrip entries={[{ key: 'review', count: 0, content: <p>Reviews</p> }]} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows each entry that waits under one heading, in order', () => {
        render(
            <CoworkNeedsStrip
                entries={[
                    { key: 'review', count: 2, content: <p>Two runs to review</p> },
                    { key: 'plan', count: 0, content: <p>A plan to approve</p> },
                    { key: 'repair', count: 1, content: <p>A repair is ready</p> },
                ]}
            />,
        );
        const strip = screen.getByRole('region', { name: 'Needs you' });
        expect(strip).toHaveTextContent('Two runs to review');
        expect(strip).toHaveTextContent('A repair is ready');
        expect(strip).not.toHaveTextContent('A plan to approve');
        expect(screen.getByTestId('cowork-needs-review')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-needs-plan')).toBeNull();
    });

    it('the badge count is the sum of what waits', () => {
        expect(needsCount([])).toBe(0);
        expect(needsCount([{ key: 'review', count: 2, content: null }, { key: 'repair', count: 1, content: null }])).toBe(3);
    });
});
