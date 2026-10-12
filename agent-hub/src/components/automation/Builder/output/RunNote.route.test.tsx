import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import RunNote from './RunNote';

const FILTER_OUT = { items: [{ id: 1 }, { id: 2 }, { id: 3 }], count: 3, inputCount: 4, rejectedCount: 1 };
const SPLIT_OUT = {
    mode: 'collection', branches: ['case:pdf'], matchesByCase: {},
    counts: { pdf: 4, word: 2, powerpoint: 1, default: 4 }, total: 11,
};

beforeEach(() => cleanup());

describe('RunNote with a route (P1/P2)', () => {
    it('a filter: "Kept 3 of 4 messages"', () => {
        render(<RunNote value={FILTER_OUT} route={{ unit: 'messages' }} />);
        expect(screen.getByTestId('output-route-note').textContent).toBe('Kept 3 of 4 messages');
    });

    it('a filter that kept nothing: "Kept none of 4 messages"', () => {
        render(<RunNote value={{ items: [], count: 0, inputCount: 4, rejectedCount: 4 }} route={{ unit: 'messages' }} />);
        expect(screen.getByTestId('output-route-note').textContent).toBe('Kept none of 4 messages');
    });

    it('a list switch: one part per output, then Otherwise, and the total', () => {
        render(<RunNote value={SPLIT_OUT} route={{ unit: 'attachments', caseOrder: ['pdf', 'word', 'powerpoint'], fanOut: true }} />);
        expect(screen.getByTestId('output-route-note').textContent)
            .toBe('pdf 4 · word 2 · powerpoint 1 · Otherwise 4 (11 attachments in all) · one item can go down several outputs');
    });

    it('a route with an output that has no route numbers says nothing, not the per-item note', () => {
        const { container } = render(<RunNote value={{ iterations: 3, succeeded: 3, failed: 0, results: [] }} route={{ unit: 'items' }} />);
        expect(container.textContent).toBe('');
    });
});
