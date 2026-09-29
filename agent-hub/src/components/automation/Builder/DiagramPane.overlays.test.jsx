import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import DiagramPane from './DiagramPane';
import { flowSummary } from './flow/FlowSummaryChip';

/**
 * The four overlay zones and the south edge (design 1a).
 *
 * What matters at this seam: every zone renders exactly once, the south bar
 * shows ONE thing by precedence (run > selection > hint), the validation chip
 * sits in the north-west corner rather than on the minimap, and the legend
 * opens from its help button.
 */
const DEF = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        { id: 'a', type: 'condition', label: 'Is it big?', expr: 'x > 1', position: { x: 320, y: 0 } },
        { id: 'b', type: 'loop', label: 'Per item', overRef: 'trigger.output.items', body: [], position: { x: 640, y: 0 } },
        { id: 'c', type: 'set', label: 'Shape', position: { x: 960, y: 0 } },
        { id: 'n', type: 'note', text: 'hi', position: { x: 0, y: 300 } },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b', label: 'then' }, { from: 'b', to: 'c' }],
};

function renderCanvas(props = {}) {
    return render(
        <div style={{ width: 1200, height: 800 }}>
            <DiagramPane definition={DEF} editable onDefinitionChange={vi.fn()} {...props} />
        </div>,
    );
}

describe('flowSummary — what the north-west chip counts', () => {
    it('counts numbered cards: triggers and steps, not notes', () => {
        expect(flowSummary(DEF)).toEqual({ steps: 4, branches: 1, loops: 1, empty: false });
    });
    it('is empty without a trigger', () => {
        expect(flowSummary(null).empty).toBe(true);
        expect(flowSummary({ steps: [] }).empty).toBe(true);
    });
});

describe('DiagramPane — overlay zones', () => {
    beforeEach(cleanup);

    it('north-west: the summary chip names what the canvas holds', () => {
        renderCanvas();
        expect(screen.getByTestId('flow-summary').textContent).toBe('4 steps · 1 branch · 1 loop');
    });

    it('north-west: the validation chip sits beside the summary, not over the minimap', () => {
        renderCanvas({ validation: { errors: [{ code: 'x.missing', path: 'steps[c].value', message: 'value is required.', severity: 'error' }], warnings: [] } });
        const pill = screen.getByTestId('validation-pill');
        expect(pill.closest('.react-flow__panel.top.left')).toBeTruthy();
        expect(screen.getByTestId('flow-summary').closest('.react-flow__panel.top.left')).toBeTruthy();
    });

    it('south-west: the zoom stack shows the percentage and Wrap to fit', () => {
        renderCanvas();
        const stack = screen.getByTestId('canvas-zoom-stack');
        expect(stack.closest('.react-flow__panel.bottom.left')).toBeTruthy();
        expect(screen.getByTestId('canvas-zoom-pct').textContent).toMatch(/^\d+%$/);
        expect(screen.getByRole('button', { name: 'Wrap to fit' }).closest('[data-testid="canvas-zoom-stack"]')).toBe(stack);
        expect(screen.getByRole('button', { name: /arrange/i })).toBeTruthy();
    });

    it('south-west: the Flowlets button appears only when the host wires it, and reports its state', () => {
        renderCanvas();
        expect(screen.queryByTitle(/Flowlets — manage/)).toBeNull();
        cleanup();
        const onToggleFlowlets = vi.fn();
        renderCanvas({ onToggleFlowlets, flowletCount: 2, flowletsOpen: true });
        const btn = screen.getByTitle(/Flowlets — manage/);
        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(btn.textContent).toContain('2');
        fireEvent.click(btn);
        expect(onToggleFlowlets).toHaveBeenCalledTimes(1);
    });

    it('north-east: the legend opens and closes from the help button', async () => {
        const user = userEvent.setup();
        renderCanvas();
        const toggle = screen.getByRole('button', { name: /what the marks/i });
        expect(toggle.closest('.react-flow__panel.top.right')).toBeTruthy();
        // Closed on a canvas narrower than LEGEND_ROOM_PX until someone opens
        // it (flow/useLegendPreference.test.ts has the widths and the choice).
        expect(screen.queryByTestId('canvas-legend')).toBeNull();
        await user.click(toggle);
        expect(screen.getByTestId('canvas-legend')).toBeTruthy();
        await user.click(toggle);
        expect(screen.queryByTestId('canvas-legend')).toBeNull();
    });

    it('south: shows the gesture hint when nothing is selected and nothing runs', () => {
        renderCanvas();
        expect(screen.getByTestId('canvas-hint').closest('.react-flow__panel.bottom.center')).toBeTruthy();
        expect(screen.queryByTestId('canvas-run-banner')).toBeNull();
        expect(screen.queryByTestId('canvas-selection-bar')).toBeNull();
    });

    it('south: the run banner replaces the hint while a run is in flight — never both', () => {
        renderCanvas({
            runInFlight: true,
            runSteps: [
                { stepId: 'trg', status: 'success', finishedAt: '2026-09-03T10:00:00Z' },
                { stepId: 'a', status: 'running', startedAt: '2026-09-03T10:00:01Z' },
            ],
        });
        const banner = screen.getByTestId('canvas-run-banner');
        expect(banner.textContent).toContain('Live run');
        expect(banner.textContent).toContain('Is it big?');
        expect(screen.getByTestId('canvas-run-progress')).toBeTruthy();
        expect(screen.queryByTestId('canvas-hint')).toBeNull();
        expect(screen.queryByTestId('canvas-selection-bar')).toBeNull();
    });

    it('south-east: the minimap is the design size', () => {
        const { container } = renderCanvas();
        const map = container.querySelector('.react-flow__minimap');
        expect(map).toBeTruthy();
        expect(map.style.width).toBe('160px');
        expect(map.style.height).toBe('96px');
    });

    it('north-west: while a step is being edited, the chip says where you are and how to leave', () => {
        renderCanvas({ editingStepId: 'b' });
        const chip = screen.getByTestId('editing-chip');
        expect(chip.textContent).toMatch(/^Step 3 of 4/);
        expect(chip.textContent).toContain('Esc');
        expect(screen.queryByTestId('flow-summary')).toBeNull();
    });

    it('every zone renders exactly once', () => {
        const { container } = renderCanvas({ onToggleFlowlets: vi.fn() });
        for (const sel of ['.react-flow__panel.top.left', '.react-flow__panel.top.right', '.react-flow__panel.bottom.left', '.react-flow__panel.bottom.center']) {
            expect(container.querySelectorAll(sel).length, sel).toBe(1);
        }
    });
});
