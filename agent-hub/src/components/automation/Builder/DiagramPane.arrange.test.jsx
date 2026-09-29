import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import DiagramPane from './DiagramPane';

/**
 * "Wrap to fit", where it meets the canvas.
 *
 * It is an icon in the zoom-control stack — no label, next to zoom in / zoom
 * out / fit — because it is the same kind of act as fitView: one press to get
 * the canvas back on screen. What matters at this seam is that one press is ONE
 * definition change (and therefore one Ctrl+Z), that it really rewrites the
 * positions, and that it is not offered at all when the canvas is not the
 * user's to edit.
 */
const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        { id: 'a', type: 'ai_step', label: 'One', prompt: 'x', position: { x: 900, y: 400 } },
        { id: 'b', type: 'ai_step', label: 'Two', prompt: 'y', position: { x: 40, y: 900 } },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
};

function renderCanvas(props = {}) {
    return render(
        <div style={{ width: 1200, height: 800 }}>
            <DiagramPane definition={DEF} editable {...props} />
        </div>,
    );
}

const wrapButton = () => screen.queryByRole('button', { name: 'Wrap to fit' });

describe('DiagramPane — Wrap to fit', () => {
    beforeEach(cleanup);

    it('sits in the zoom stack, as an icon with no label of its own', () => {
        renderCanvas({ onDefinitionChange: vi.fn() });
        const btn = wrapButton();
        expect(btn).toBeTruthy();
        expect(btn.textContent.trim()).toBe('');
        // Same container as the zoom buttons, not a control group of its own.
        expect(btn.closest('[data-testid="canvas-zoom-stack"]')).toBeTruthy();
    });

    it('commits exactly one definition change, with every position rewritten', () => {
        const onDefinitionChange = vi.fn();
        renderCanvas({ onDefinitionChange });
        fireEvent.click(wrapButton());

        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        const next = onDefinitionChange.mock.calls[0][0];
        // The hand-placed coordinates above are deliberately scattered.
        expect(next.steps.find(s => s.id === 'a').position).not.toEqual({ x: 900, y: 400 });
        expect(next.steps.find(s => s.id === 'b').position).not.toEqual({ x: 40, y: 900 });
        expect(Number.isFinite(next.trigger.position.x)).toBe(true);
    });

    it('folds the flowlets away first', () => {
        // Positions are stored in collapsed space, so wrapping a canvas whose
        // containers are drawn expanded would measure one thing and show
        // another — which is how a wrapped flow came out wider than the screen.
        const onCollapseAllFlowlets = vi.fn();
        renderCanvas({ onDefinitionChange: vi.fn(), onCollapseAllFlowlets });
        fireEvent.click(wrapButton());
        expect(onCollapseAllFlowlets).toHaveBeenCalledTimes(1);
    });

    it('is not offered on a read-only canvas', () => {
        const onDefinitionChange = vi.fn();
        renderCanvas({ editable: false, readOnly: true, onDefinitionChange });
        expect(wrapButton()).toBeNull();
        expect(onDefinitionChange).not.toHaveBeenCalled();
    });

    it('is not offered while the AI holds the canvas', () => {
        // Its commit would race the assistant's own structural edits.
        renderCanvas({ structuralEditsBlocked: true, onDefinitionChange: vi.fn() });
        expect(wrapButton()).toBeNull();
    });
});
