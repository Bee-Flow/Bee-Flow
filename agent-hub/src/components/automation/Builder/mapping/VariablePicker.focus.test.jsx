import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import VariablePicker from './VariablePicker';

/**
 * Opened from a pill, the picker shows the options of THAT step first (user
 * request 2026-09-03): "what else can I pick in step 7?" — with the field
 * you clicked marked, and every other step one click away.
 */
const GROUPS = [
    { id: 'a', label: 'Read the figures', basePath: 'steps.a.output', fields: [
        { key: 'summary', path: 'steps.a.output.summary', sample: 'ok' },
    ] },
    { id: 'b', label: 'What scores already', basePath: 'steps.b.output', fields: [
        { key: 'total', path: 'steps.b.output.total', sample: 3 },
        { key: 'gap', path: 'steps.b.output.gap', sample: 'none' },
    ] },
];

const renderPicker = (props = {}) => {
    const onPick = vi.fn();
    render(<VariablePicker open anchorEl={document.body} groups={GROUPS} onPick={onPick} onClose={() => {}} {...props} />);
    return { onPick };
};

describe('VariablePicker — scoped to the clicked pill\'s step', () => {
    beforeEach(cleanup);

    it('shows only that step, names it, and marks the current field', () => {
        renderPicker({ focusPath: 'steps.b.output.total' });
        expect(screen.getByText('What scores already')).toBeTruthy();
        expect(screen.queryByText('Read the figures')).toBeNull();
        expect(screen.getByTestId('picker-scope').textContent).toContain('Fields of What scores already');
        const current = document.querySelector('[aria-current="true"]');
        // Humanised — the marked row reads "Total", never `total`.
        expect(current.textContent).toContain('Total');
    });

    it('"All steps" brings every step back', () => {
        renderPicker({ focusPath: 'steps.b.output.total' });
        fireEvent.click(screen.getByRole('button', { name: 'All steps' }));
        expect(screen.getByText('Read the figures')).toBeTruthy();
        expect(screen.getByText('What scores already')).toBeTruthy();
    });

    it('picking another field of that step hands back its path', () => {
        const { onPick } = renderPicker({ focusPath: 'steps.b.output.total' });
        fireEvent.click(screen.getByText('Gap'));
        expect(onPick).toHaveBeenCalledWith('steps.b.output.gap', expect.anything());
    });

    it('without a focus path nothing is scoped', () => {
        renderPicker();
        expect(screen.queryByTestId('picker-scope')).toBeNull();
        expect(screen.getByText('Read the figures')).toBeTruthy();
    });
});
