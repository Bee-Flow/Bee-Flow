import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import MiniFlow from './MiniFlow';
import type { MiniNodeProps } from './MiniNode';

afterEach(cleanup);

const NODES: MiniNodeProps[] = [
    { family: 'data', title: 'Read your work', pill: '412 events', status: 'done' },
    { family: 'data', title: 'Find templates', pill: '9 templates', status: 'running' },
    { family: 'branch', title: 'Spot repeats' },
    { family: 'ai', title: 'Name patterns', pill: '3 patterns' },
];

describe('MiniFlow', () => {
    it('renders every node in order with a connector between each pair', () => {
        render(<MiniFlow nodes={NODES} />);
        const names = screen.getAllByTestId('mini-node-name').map(n => n.textContent);
        expect(names).toEqual(['Read your work', 'Find templates', 'Spot repeats', 'Name patterns']);
        expect(screen.getAllByTestId('mini-flow-connector')).toHaveLength(3);
    });

    it('moves a node pill onto its outgoing connector; the last node keeps its own', () => {
        render(<MiniFlow nodes={NODES} />);
        const connectors = screen.getAllByTestId('mini-flow-connector');
        expect(within(connectors[0]).getAllByText('412 events').length).toBeGreaterThan(0);
        expect(within(connectors[1]).getAllByText('9 templates').length).toBeGreaterThan(0);
        expect(within(connectors[2]).queryByText(/./)).toBeNull();
        const pills = screen.getAllByTestId('mini-node-pill');
        expect(pills).toHaveLength(1);
        expect(pills[0]).toHaveTextContent('3 patterns');
    });

    it('dashes the connectors from dashedFrom on', () => {
        render(<MiniFlow nodes={NODES} dashedFrom={2} />);
        const dashed = screen.getAllByTestId('mini-flow-connector').map(c => c.getAttribute('data-dashed'));
        expect(dashed).toEqual([null, 'true', 'true']);
    });

    it('is a container so it can stack on a narrow width, and passes compact down', () => {
        render(<MiniFlow nodes={NODES.slice(0, 2)} compact />);
        expect(screen.getByTestId('mini-flow').className).toContain('@container/miniflow');
        for (const card of screen.getAllByTestId('mini-node')) expect(card.className).toContain('min-h-[48px]');
    });
});
