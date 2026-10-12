import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MiniNode from './MiniNode';

afterEach(cleanup);

describe('MiniNode', () => {
    it('renders eyebrow, name and sub-line like a canvas card', () => {
        render(<MiniNode family="trigger" eyebrow="Trigger · 1" title="New mail in Gmail" sub="Every weekday" />);
        const card = screen.getByTestId('mini-node');
        expect(card).toHaveAttribute('data-family', 'trigger');
        expect(card.className).toContain('shadow-[inset_4px_0_0_var(--type-trigger)');
        expect(card.className).toContain('!rounded-[36px_');
        const eyebrow = screen.getByTestId('mini-node-eyebrow');
        expect(eyebrow).toHaveTextContent('Trigger');
        expect(eyebrow).toHaveTextContent('· 1');
        expect(screen.getByTestId('mini-node-name')).toHaveTextContent('New mail in Gmail');
        expect(screen.getByTestId('mini-node-sub')).toHaveTextContent('Every weekday');
        expect(screen.queryByTestId('mini-node-status')).toBeNull();
    });

    it('uses the standard radius for a non-trigger and honours an explicit trigger shape', () => {
        const { rerender } = render(<MiniNode family="ai" title="Summarise" />);
        expect(screen.getByTestId('mini-node').className).not.toContain('!rounded-[36px_');
        rerender(<MiniNode family="app" trigger title="Source" />);
        expect(screen.getByTestId('mini-node').className).toContain('!rounded-[36px_');
    });

    it('shows the status badge in the corner and the status ring', () => {
        render(<MiniNode family="ai" title="Name patterns" status="done" />);
        expect(screen.getByTestId('mini-node-status')).toHaveTextContent('done');
        expect(screen.getByTestId('mini-node').className).toContain('!border-[var(--success)]');
    });

    it('renders a record pill, a custom icon and children', () => {
        render(
            <MiniNode family="data" title="Read your work" pill="412 events" icon={<span data-testid="own-icon" />}>
                <button type="button">Connect</button>
            </MiniNode>,
        );
        expect(screen.getByTestId('mini-node-pill')).toHaveTextContent('412 events');
        expect(screen.getByTestId('own-icon')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    });

    it('draws a dashed placeholder without the family bar', () => {
        render(<MiniNode family="trigger" title="Trigger to choose" dashed compact />);
        const cls = screen.getByTestId('mini-node').className;
        expect(cls).toContain('!border-dashed');
        expect(cls).toContain('!shadow-none');
    });
});
