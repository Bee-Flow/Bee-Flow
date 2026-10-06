/**
 * Switching the form between Simple and All options re-renders every value
 * editor with different chrome. It must never write: no binding is dropped,
 * reshaped or re-canonicalised just because the view changed — and a value
 * Simple mode cannot edit as pills still offers its way out.
 */
import { cleanup, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BindingFieldJs from './BindingField';
import ValueBuilderJs from './ValueBuilder';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { FormDensityContext } from '../flow/settings/formDensity';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const BindingField = BindingFieldJs as unknown as Loose;
const ValueBuilder = ValueBuilderJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const ROOT = { steps: { jira: { output: { fields: { 'Story Points': 5 } } } } };
const BINDINGS: unknown[] = [
    { kind: 'ref', path: "steps.jira.output.fields['Story Points']" },
    { kind: 'expr', value: 'steps.jira.output.fields["Story Points"]' },
    { kind: 'template', value: 'Points: {{ steps.jira.output.fields["Story Points"] }}' },
    { kind: 'expr', value: 'lower(steps.jira.output.fields["Story Points"])' },
    { kind: 'expr', value: 'steps.a.output.x > 3 ? "a" : "b"' },
    { kind: 'literal', value: { a: 1 } },
    { Datum: { kind: 'ref', path: 'steps.a.output.date' } },
    { kind: 'literal', value: 'steps.jira.output.fields["Story Points"]' },
];

function tree(Editor: typeof BindingField | typeof ValueBuilder, value: unknown, onChange: () => void, mode: string) {
    return (
        <FormDensityContext.Provider value={{ density: 'full', mode, onHiddenSection: null, onShownSection: null } as never}>
            <VariablePickerProvider groups={[]} previewSample={ROOT} stepLabelById={new Map()} stepTypeById={null}>
                <Editor label="Points" value={value} onChange={onChange} />
            </VariablePickerProvider>
        </FormDensityContext.Provider>
    );
}

afterEach(() => cleanup());

describe.each([['BindingField', BindingField], ['ValueBuilder', ValueBuilder]] as const)('%s', (_name, Editor) => {
    it.each(BINDINGS.map(b => [JSON.stringify(b), b]))('Simple ⇄ All options never writes %s', (_label, value) => {
        const onChange = vi.fn();
        const { rerender } = render(tree(Editor, value, onChange, 'simple'));
        rerender(tree(Editor, value, onChange, 'advanced'));
        rerender(tree(Editor, value, onChange, 'simple'));
        expect(onChange).not.toHaveBeenCalled();
    });
});

describe('Simple mode keeps the way out', () => {
    it('a formula field keeps its switch back to Text', () => {
        render(tree(BindingField, { kind: 'expr', value: 'steps.a.output.x > 3' }, vi.fn(), 'simple'));
        expect(screen.getByTitle(/^Plain text/)).toBeTruthy();
    });

    it('a formula the visual editor cannot show offers "Edit the formula"', () => {
        render(tree(ValueBuilder, { kind: 'expr', value: 'steps.a.output.x > 3 ? "a" : "b"' }, vi.fn(), 'simple'));
        expect(screen.getByRole('button', { name: 'Edit the formula' })).toBeTruthy();
    });
});
