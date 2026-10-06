import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import StepOutputTab from './StepOutputTab';

const KEPT = { items: [{ subject: 'Invoice 1' }], count: 1, inputCount: 4, rejectedCount: 3 };

beforeEach(() => cleanup());

describe('StepOutputTab route line', () => {
    it('renders the route sentence above the output when given a route', () => {
        render(<StepOutputTab stepId="cond" liveOutput={KEPT} route={{ unit: 'messages' }} />);
        expect(screen.getByTestId('output-route-note').textContent).toBe('Kept 1 of 4 messages');
    });

    it('no route, or an output without route numbers: no line', () => {
        render(<StepOutputTab stepId="cond" liveOutput={KEPT} />);
        expect(screen.queryByTestId('output-route-note')).toBeNull();
        cleanup();
        render(<StepOutputTab stepId="cond" liveOutput={{ items: [1] }} route={{ unit: 'messages' }} />);
        expect(screen.queryByTestId('output-route-note')).toBeNull();
    });
});
