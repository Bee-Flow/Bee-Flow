import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

vi.mock('@xyflow/react', () => ({
    Handle: (props) => <div data-testid={`handle-${props.type}`} />,
    Position: { Left: 'left', Right: 'right' },
}));

import LoopItemNode from './LoopItemNode';

/**
 * "Each item" — the pill an expanded loop starts from.
 *
 * Two things are worth pinning. It must name the variable the body steps bind
 * against EXACTLY (`execLoop` binds a slice when batchSize > 1, so somebody
 * writing `loop.item.name` against a batch gets nothing back), and its two
 * captions must go through t(): a Dutch canvas that says "Each batch of 5" is
 * the same defect class as an English mismatch question — the screen speaking
 * a language the workspace did not choose.
 */
const renderPill = (step) => render(<LoopItemNode data={{ step }} />);

describe('LoopItemNode', () => {
    beforeEach(cleanup);

    it('names the per-item variable the body steps have to bind against', () => {
        renderPill({ itemVar: 'invoice' });
        expect(screen.getByTestId('loop-item-pill').textContent).toContain('loop.invoice');
    });

    it('falls back to `item` when the loop never named its variable', () => {
        renderPill({});
        expect(screen.getByTestId('loop-item-pill').textContent).toContain('loop.item');
    });

    it('says "Each item" for an ordinary loop', () => {
        renderPill({ itemVar: 'bank' });
        expect(screen.getByTestId('loop-item-pill').textContent).toContain('Each item');
    });

    it('says "Each batch of N" once the loop binds a slice', () => {
        // The wording has to change with batchSize or the pill lies about what
        // `loop.<var>` holds.
        renderPill({ itemVar: 'bank', batchSize: 5 });
        const text = screen.getByTestId('loop-item-pill').textContent;
        expect(text).toContain('Each batch of 5');
        expect(text).not.toContain('Each item');
    });

    it('treats batchSize 1 and a nonsense batchSize as "each item"', () => {
        renderPill({ itemVar: 'bank', batchSize: 1 });
        expect(screen.getByTestId('loop-item-pill').textContent).toContain('Each item');
        cleanup();
        renderPill({ itemVar: 'bank', batchSize: 'lots' });
        expect(screen.getByTestId('loop-item-pill').textContent).toContain('Each item');
    });

    it('has an output handle only — nothing connects INTO the start of an iteration', () => {
        renderPill({ itemVar: 'bank' });
        expect(screen.getByTestId('handle-source')).toBeTruthy();
        expect(screen.queryByTestId('handle-target')).toBeNull();
    });

    it('routes both captions through t(), so the canvas is not hard-wired to English', () => {
        const src = String(LoopItemNode);
        // Cheap and blunt on purpose: the failure it catches is a literal
        // creeping back in beside the translated one.
        expect(src).toContain('automations.canvas.loop_each_item');
        expect(src).toContain('automations.canvas.loop_each_batch');
    });
});
