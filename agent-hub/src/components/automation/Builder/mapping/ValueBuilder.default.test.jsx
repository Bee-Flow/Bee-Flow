import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ToolInputForm from './ToolInputForm';
import ValueBuilder from './ValueBuilder';
import { VariablePickerProvider } from './VariablePickerContext';

/**
 * ValueBuilder is now the DEFAULT renderer for a step-bound value slot
 * (builder redesign, artboard 2a/2b) — not an opt-in behind a `visualValues`
 * flag whose only caller was the Edit-data step.
 *
 * What that has to mean, and what these tests pin:
 *  - a schema-declared parameter renders as the visual editor, with the SAME
 *    slot chrome the raw editor drew (label, required mark, "expects: …",
 *    "still empty") — a person must not be able to tell which component drew
 *    the label;
 *  - the raw editor stays one click away and keeps the chrome;
 *  - `visualValues={false}` still forces the raw editor, for a surface whose
 *    values are not step bindings;
 *  - nothing is rewritten on the way: rendering a value never calls onChange.
 */
const RESULTS = [{ subject: 'ISV contract', from_email: 'a@b.nl' }];
const GROUPS = [{
    id: 'act_4d4307a',
    label: 'gmail search',
    kind: 'integration_action',
    basePath: 'steps.act_4d4307a.output',
    sample: { total: 201, results: RESULTS },
    fields: [
        { key: 'total', path: 'steps.act_4d4307a.output.total', sample: 201 },
        { key: 'results', path: 'steps.act_4d4307a.output.results', sample: RESULTS },
    ],
}];
const SAMPLE = { steps: { act_4d4307a: { output: { total: 201, results: RESULTS } } } };
const LABELS = new Map([['act_4d4307a', 'gmail search']]);

const SCHEMA = {
    properties: {
        subject: { type: 'string', title: 'Subject', description: 'The mail subject' },
        when: { type: 'string', format: 'date', title: 'Send at' },
    },
    required: ['subject', 'when'],
};

function renderForm(inputs, props = {}) {
    const onChange = vi.fn();
    render(
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS}>
            <ToolInputForm inputs={inputs} inputSchema={SCHEMA} onChange={onChange} previewSample={SAMPLE} {...props} />
        </VariablePickerProvider>,
    );
    return { onChange };
}

describe('a schema-declared parameter renders as the visual editor', () => {
    beforeEach(cleanup);

    it('shows a bound value as a named chip, never the step id or braces', () => {
        const { onChange } = renderForm({ subject: { kind: 'ref', path: 'steps.act_4d4307a.output.total' } });
        expect(screen.getByText('gmail search')).toBeTruthy();
        expect(screen.getByText('▸ Total')).toBeTruthy();
        expect(screen.queryByText(/act_4d4307a/)).toBeNull();
        // Rendering is never a write — the round trip has to be lossless.
        expect(onChange).not.toHaveBeenCalled();
    });

    it('keeps the slot chrome the raw editor drew: label, required, expects', () => {
        renderForm({});
        expect(screen.getByText('Subject')).toBeTruthy();
        expect(screen.getByText('Send at')).toBeTruthy();
        // "expects: date" — the finer kind, only where it is not plain text.
        const expects = screen.getAllByTestId('binding-expects').map(e => e.textContent);
        expect(expects.join(' ')).toContain('date');
        expect(screen.getAllByTitle('Required').length).toBe(2);
    });

    it('says a required slot is still empty, with how many fields would fit', () => {
        renderForm({});
        const notes = screen.getAllByTestId('binding-empty-required');
        expect(notes.length).toBe(2);
        expect(notes[0].textContent).toContain('still empty');
        expect(notes[0].textContent).toMatch(/pick ▸ \d+ fit/);
    });

    it('offers the formula escape, and the chrome survives the switch', () => {
        renderForm({ subject: { kind: 'ref', path: 'steps.act_4d4307a.output.total' } });
        fireEvent.click(screen.getAllByLabelText('Write this value as a formula')[0]);
        expect(screen.getByText('Back to the simple editor')).toBeTruthy();
        // Still labelled — switching editor must not drop the field's identity.
        expect(screen.getByText('Subject')).toBeTruthy();
    });

    it('visualValues={false} still forces the raw editor', () => {
        renderForm({ subject: { kind: 'ref', path: 'steps.act_4d4307a.output.total' } }, { visualValues: false });
        // The raw editor's mode switch, which the visual one does not have.
        expect(screen.getAllByRole('group', { name: 'Value mode' }).length).toBeGreaterThan(0);
        expect(screen.queryByText('Use data from a step')).toBeNull();
    });
});

describe('the visual editor draws no chrome unless it is asked to', () => {
    beforeEach(cleanup);

    it('a bare ValueBuilder is unchanged — label only names the picker', () => {
        render(
            <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS}>
                <ValueBuilder value={null} onChange={() => {}} label="total" required expectKind="date" />
            </VariablePickerProvider>,
        );
        expect(screen.queryByTestId('binding-expects')).toBeNull();
        expect(screen.queryByTestId('binding-empty-required')).toBeNull();
    });
});
