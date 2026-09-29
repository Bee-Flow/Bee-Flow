import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SouthBar from './CanvasSouthBar';

// The component is JavaScript with `= null` defaults, which TypeScript reads as
// "always null"; the props below are the ones DiagramPane passes.
const CanvasSouthBar = SouthBar as unknown as React.ComponentType<Record<string, unknown>>;

/**
 * The selection bar and the step drawer. With the drawer open on the one
 * selected step, its header already carries that step's actions; the bar
 * would repeat them in the thin strip of canvas above it. So it steps aside,
 * and nothing takes its place. A banner that outranks it still shows.
 */
describe('CanvasSouthBar — the selection bar under an open drawer', () => {
    beforeEach(cleanup);

    it('shows for a selection on the canvas', () => {
        render(<CanvasSouthBar editable selectedCount={1} onDeleteSelection={vi.fn()} onClearSelection={vi.fn()} />);
        expect(screen.getByTestId('canvas-selection-bar')).toBeTruthy();
    });

    it('steps aside when the selected step is the one in the drawer, and the hint does not take its place', () => {
        render(<CanvasSouthBar editable selectedCount={1} selectionInDrawer onDeleteSelection={vi.fn()} />);
        expect(screen.queryByTestId('canvas-selection-bar')).toBeNull();
        expect(screen.queryByTestId('canvas-hint')).toBeNull();
    });

    it('a run still shows over it', () => {
        const runFocus = { stepId: 's1', label: 'Ask', done: 1, total: 3, state: 'running', startedAt: null, awaitingForm: false };
        render(<CanvasSouthBar editable selectedCount={1} selectionInDrawer runFocus={runFocus} />);
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
    });
});
