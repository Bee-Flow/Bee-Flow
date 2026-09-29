import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
// Both children are stubbed: this file is about the PANEL's bookkeeping —
// which child is mounted, which is merely hidden, and what it reports to the
// URL owner. The table and the run view have their own tests.
const { tableProps, viewProps } = vi.hoisted(() => ({
    tableProps: { current: null },
    viewProps: { current: null },
}));

vi.mock('./ExecutionsTable', () => ({
    default: (props) => {
        tableProps.current = props;
        return (
            <div
                data-testid="table"
                data-scope={String(props.scope)}
                data-automation={String(props.automationId)}
                data-step={String(props.stepId)}
                data-active={String(props.active)}
            >
                <button type="button" onClick={() => props.onOpenRun({ id: 'r1', automationTitle: 'Weekly digest' })}>open r1</button>
                <button type="button" onClick={() => props.onOpenRun({})}>open a run with no id</button>
            </div>
        );
    },
}));

vi.mock('./ExecutionView', () => ({
    default: (props) => {
        viewProps.current = props;
        return (
            <div
                data-testid="view"
                data-run={String(props.runId)}
                data-scope={String(props.scope)}
                data-active={String(props.active)}
                data-initial-step={String(props.initialStepId)}
                data-seed-title={String(props.run?.automationTitle)}
            >
                <button type="button" onClick={() => props.onBack()}>back</button>
                <button type="button" onClick={() => props.onSelectStep('s2')}>select s2</button>
                <button type="button" onClick={() => props.onSelectStep(null)}>clear step</button>
                <button type="button" onClick={() => props.onOpenAnotherRun('r2')}>open r2</button>
            </div>
        );
    },
}));

import ExecutionsPanel from './ExecutionsPanel';

/**
 * CHARACTERISATION — the executions panel exactly as it behaves today.
 *
 * The panel owns three facts: which run is open, which step is selected, and
 * how each of those is reported back to whoever owns the URL (push vs
 * replace). Everything below pins one of those three, including the cases
 * where today's answer is the wrong one.
 */

const renderPanel = (props = {}) => render(
    <ExecutionsPanel
        scope="global"
        automationId={null}
        stepId={null}
        onOpenEditor={vi.fn()}
        onRunIdChange={vi.fn()}
        onRunStateChange={vi.fn()}
        onEditingChange={vi.fn()}
        {...props}
    />,
);

const tableWrapper = () => screen.getByTestId('table').parentElement;

beforeEach(() => {
    cleanup();
    tableProps.current = null;
    viewProps.current = null;
    window.history.replaceState({}, '', '/');
});

// ── list vs open run ────────────────────────────────────────────────────────
describe('ExecutionsPanel — list and run share one mount', () => {
    it('shows the table and no run view when nothing is open', () => {
        renderPanel();
        expect(screen.getByTestId('table')).toBeTruthy();
        expect(screen.queryByTestId('view')).toBeNull();
        expect(tableWrapper().className).toBe('h-full min-h-0');
    });

    it('threads scope, automationId and stepId straight through to the table', () => {
        renderPanel({ scope: 'step', automationId: 'a1', stepId: 's7' });
        const table = screen.getByTestId('table');
        expect(table.getAttribute('data-scope')).toBe('step');
        expect(table.getAttribute('data-automation')).toBe('a1');
        expect(table.getAttribute('data-step')).toBe('s7');
    });

    it('HIDES the table rather than unmounting it while a run is open', () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        // Still mounted — this is what preserves filters, scroll and pages.
        expect(screen.getByTestId('table')).toBeTruthy();
        expect(tableWrapper().className).toBe('hidden');
        expect(screen.getByTestId('view').getAttribute('data-run')).toBe('r1');
    });

    it('stands the table down (active=false) while a run is open, but leaves the run view active', () => {
        renderPanel({ active: true });
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        expect(screen.getByTestId('table').getAttribute('data-active')).toBe('false');
        expect(screen.getByTestId('view').getAttribute('data-active')).toBe('true');
    });

    it('passes active=false to both when the whole panel is inactive', () => {
        renderPanel({ active: false, initialRunId: 'r1' });
        expect(screen.getByTestId('table').getAttribute('data-active')).toBe('false');
        expect(screen.getByTestId('view').getAttribute('data-active')).toBe('false');
    });

    it('hands the clicked row to the run view as a seed, so the bar can paint before the fetch lands', () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        expect(screen.getByTestId('view').getAttribute('data-seed-title')).toBe('Weekly digest');
    });

    it('opens straight to initialRunId at mount (deep link)', () => {
        renderPanel({ initialRunId: 'deep-1', initialStepId: 'sX' });
        expect(screen.getByTestId('view').getAttribute('data-run')).toBe('deep-1');
        expect(screen.getByTestId('view').getAttribute('data-initial-step')).toBe('sX');
        expect(tableWrapper().className).toBe('hidden');
    });

    it('ignores initialStepId when no run is deep-linked', () => {
        renderPanel({ initialRunId: null, initialStepId: 'sX' });
        expect(screen.queryByTestId('view')).toBeNull();
    });
});

// ── reporting to the URL owner ──────────────────────────────────────────────
describe('ExecutionsPanel — what it reports back', () => {
    it('reports the open run id on mount and on every change', () => {
        const onRunIdChange = vi.fn();
        renderPanel({ onRunIdChange });
        expect(onRunIdChange).toHaveBeenLastCalledWith(null);
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        expect(onRunIdChange).toHaveBeenLastCalledWith('r1');
    });

    it('PUSHES when a run opens, so Back closes it', () => {
        const onRunStateChange = vi.fn();
        renderPanel({ onRunStateChange });
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        expect(onRunStateChange).toHaveBeenCalledWith({ runId: 'r1', stepId: null }, { replace: false });
    });

    it('REPLACES when a step is selected — same place, refined', () => {
        const onRunStateChange = vi.fn();
        renderPanel({ onRunStateChange });
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        onRunStateChange.mockClear();
        fireEvent.click(screen.getByRole('button', { name: 'select s2' }));
        expect(onRunStateChange).toHaveBeenCalledWith({ runId: 'r1', stepId: 's2' }, { replace: true });
        expect(screen.getByTestId('view').getAttribute('data-initial-step')).toBe('s2');
    });

    it('normalises a cleared step selection to null', () => {
        const onRunStateChange = vi.fn();
        renderPanel({ onRunStateChange, initialRunId: 'r1', initialStepId: 's2' });
        fireEvent.click(screen.getByRole('button', { name: 'clear step' }));
        expect(onRunStateChange).toHaveBeenCalledWith({ runId: 'r1', stepId: null }, { replace: true });
    });

    it('REPLACES when the run closes', () => {
        const onRunStateChange = vi.fn();
        renderPanel({ onRunStateChange, initialRunId: 'r1' });
        fireEvent.click(screen.getByRole('button', { name: 'back' }));
        expect(onRunStateChange).toHaveBeenLastCalledWith({ runId: null, stepId: null }, { replace: true });
        expect(screen.queryByTestId('view')).toBeNull();
    });

    it('drops the selected step when another run is opened from inside the view', () => {
        renderPanel({ initialRunId: 'r1', initialStepId: 's2' });
        fireEvent.click(screen.getByRole('button', { name: 'open r2' }));
        const view = screen.getByTestId('view');
        expect(view.getAttribute('data-run')).toBe('r2');
        expect(view.getAttribute('data-initial-step')).toBe('null');
    });

    it('pushes a history entry for a run it cannot open when the row carries no id (wrat)', () => {
        // openRunAndReport reports before checking that the run is openable:
        // the view never mounts, but the owner is told to PUSH runId:null.
        const onRunStateChange = vi.fn();
        renderPanel({ onRunStateChange });
        fireEvent.click(screen.getByRole('button', { name: 'open a run with no id' }));
        expect(screen.queryByTestId('view')).toBeNull();
        expect(onRunStateChange).toHaveBeenCalledWith({ runId: null, stepId: null }, { replace: false });
    });
});

// ── closing through real history ────────────────────────────────────────────
describe('ExecutionsPanel — closing prefers real history navigation', () => {
    let back;
    beforeEach(() => { back = vi.spyOn(window.history, 'back').mockImplementation(() => {}); });
    afterEach(() => { back.mockRestore(); });

    it('calls history.back() and changes NOTHING itself when this run was the last push', () => {
        const onRunStateChange = vi.fn();
        window.history.replaceState({ page: 'studio', beeflowRunOpen: 'r1' }, '', '/');
        renderPanel({ onRunStateChange, initialRunId: 'r1' });
        fireEvent.click(screen.getByRole('button', { name: 'back' }));
        expect(back).toHaveBeenCalledTimes(1);
        // The run stays open until the popstate actually arrives — the owner
        // is expected to move ?run= and feed a new initialRunId back in.
        expect(screen.getByTestId('view')).toBeTruthy();
        expect(onRunStateChange).not.toHaveBeenCalled();
    });

    it('closes locally when the stamped history entry belongs to a DIFFERENT run', () => {
        const onRunStateChange = vi.fn();
        window.history.replaceState({ page: 'studio', beeflowRunOpen: 'r9' }, '', '/');
        renderPanel({ onRunStateChange, initialRunId: 'r1' });
        fireEvent.click(screen.getByRole('button', { name: 'back' }));
        expect(back).not.toHaveBeenCalled();
        expect(screen.queryByTestId('view')).toBeNull();
        expect(onRunStateChange).toHaveBeenLastCalledWith({ runId: null, stepId: null }, { replace: true });
    });

    it('closes locally when nothing stamped the history entry', () => {
        window.history.replaceState({ page: 'studio' }, '', '/');
        renderPanel({ initialRunId: 'r1' });
        fireEvent.click(screen.getByRole('button', { name: 'back' }));
        expect(back).not.toHaveBeenCalled();
        expect(screen.queryByTestId('view')).toBeNull();
    });
});

// ── deep-link adoption ──────────────────────────────────────────────────────
describe('ExecutionsPanel — adopting Back/Forward', () => {
    it('adopts a changed initialRunId without reporting it back (it came FROM the URL)', () => {
        const onRunStateChange = vi.fn();
        const { rerender } = renderPanel({ onRunStateChange, initialRunId: 'r1' });
        onRunStateChange.mockClear();
        rerender(
            <ExecutionsPanel scope="global" onRunStateChange={onRunStateChange} initialRunId="r5" initialStepId="s9" />,
        );
        expect(screen.getByTestId('view').getAttribute('data-run')).toBe('r5');
        expect(screen.getByTestId('view').getAttribute('data-initial-step')).toBe('s9');
        expect(onRunStateChange).not.toHaveBeenCalled();
    });

    it('closes the run when initialRunId goes back to null', () => {
        const { rerender } = renderPanel({ initialRunId: 'r1' });
        rerender(<ExecutionsPanel scope="global" initialRunId={null} />);
        expect(screen.queryByTestId('view')).toBeNull();
        expect(tableWrapper().className).toBe('h-full min-h-0');
    });

    it('ignores an initialStepId that changes on its own — the selected step is not adopted', () => {
        // The adoption effect is guarded on initialRunId alone, so a URL that
        // moves only ?step= (Back/Forward across step selections) does not
        // reach the view.
        const { rerender } = renderPanel({ initialRunId: 'r1', initialStepId: 's1' });
        expect(screen.getByTestId('view').getAttribute('data-initial-step')).toBe('s1');
        rerender(<ExecutionsPanel scope="global" initialRunId="r1" initialStepId="s4" />);
        expect(screen.getByTestId('view').getAttribute('data-initial-step')).toBe('s1');
    });
});

// ── studio chrome ───────────────────────────────────────────────────────────
describe('ExecutionsPanel — collapsing the studio chrome', () => {
    it('reports editing=false at mount and true once a run is open (global scope only)', () => {
        const onEditingChange = vi.fn();
        renderPanel({ scope: 'global', onEditingChange });
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
        fireEvent.click(screen.getByRole('button', { name: 'open r1' }));
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
    });

    it('releases the chrome again on unmount', () => {
        const onEditingChange = vi.fn();
        const { unmount } = renderPanel({ scope: 'global', onEditingChange, initialRunId: 'r1' });
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        unmount();
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
    });

    it('says nothing about the chrome outside the global scope', () => {
        const onEditingChange = vi.fn();
        renderPanel({ scope: 'automation', automationId: 'a1', onEditingChange, initialRunId: 'r1' });
        expect(onEditingChange).not.toHaveBeenCalled();
    });
});
