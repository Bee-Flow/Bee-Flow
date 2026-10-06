/**
 * BindingField round trips with every path the runtime reads: the Formula ⇄
 * Text switch keeps a reference a reference, a second pick never glues two
 * paths, a structured value never turns into a string, and a plain-text path
 * can be turned back into its value in one click.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import BindingFieldJs from './BindingField';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { FormDensityContext } from '../flow/settings/formDensity';
import { editor, editorValue, typeInEditor } from '../../../../test/refEditor';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const BindingField = BindingFieldJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const labels = new Map([['jira', 'Jira issue'], ['graph', 'Graph'], ['a', 'Step A'], ['b', 'Step B']]);
const ROOT = { steps: { jira: { output: { fields: { 'Story Points': 5 } } }, graph: { output: { '@odata.context': 'ctx' } } } };

type Handle = { insert: (path: string, opts?: Record<string, unknown>) => void };

function setup(value: unknown, props: Record<string, unknown> = {}, mode: 'simple' | 'advanced' = 'advanced') {
    const onChange = vi.fn();
    let handle: Handle | null = null;
    const utils = render(
        <FormDensityContext.Provider value={{ density: 'full', mode, onHiddenSection: null, onShownSection: null } as never}>
            <VariablePickerProvider groups={[]} previewSample={ROOT} stepLabelById={labels} stepTypeById={null}>
                <BindingField label="Points" value={value} onChange={onChange} onFocusField={(h: Handle) => { handle = h; }} {...props} />
            </VariablePickerProvider>
        </FormDensityContext.Provider>,
    );
    return { onChange, utils, handle: () => handle as unknown as Handle };
}

afterEach(() => cleanup());

describe('Formula ⇄ Text keeps a quoted-key reference a reference', () => {
    it.each([
        'steps.jira.output.fields["Story Points"]',
        "steps.graph.output['@odata.context']",
    ])('Formula → Text on %s', async (path) => {
        const user = userEvent.setup();
        // Saved before this fix as kind 'expr' (the old classifier had no quotes).
        const { onChange } = setup({ kind: 'expr', value: path });
        await user.click(screen.getByTitle(/^Plain text/));
        const b = onChange.mock.lastCall?.[0];
        expect(b.kind).toBe('template');
        expect(b.value).toBe(`{{${path.replace(/'/g, '"')}}}`);
        expect(getPath(ROOT, b.value.slice(2, -2))).toBeDefined();
        // …and it is a pill showing the field's own key, not the path text.
        expect(editor(document.body)?.textContent).not.toContain('steps.');
    });

    it('Text → Formula turns the pill into a canonical ref', async () => {
        const user = userEvent.setup();
        const { onChange } = setup({ kind: 'template', value: "{{ steps.graph.output['@odata.context'] }}" });
        await user.click(screen.getByTitle(/^Expression/));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'ref', path: 'steps.graph.output["@odata.context"]' });
    });

    it('the pill names the leaf key', () => {
        setup({ kind: 'ref', path: 'steps.jira.output.fields["Story Points"]' });
        expect(editor(document.body)?.textContent).toContain('Jira issue');
        expect(editor(document.body)?.textContent).toContain('Story points');
    });
});

describe('picking into a Formula field', () => {
    it('a picked quoted path is stored as a ref', async () => {
        const user = userEvent.setup();
        const { onChange, handle } = setup({ kind: 'expr', value: '' });
        await user.click(editor(document.body) as HTMLElement);
        act(() => handle().insert("steps.jira.output.fields['Story Points']"));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'ref', path: 'steps.jira.output.fields["Story Points"]' });
    });

    it('a second pick is a separate operand, never one glued path', async () => {
        const user = userEvent.setup();
        const { onChange, handle } = setup({ kind: 'ref', path: 'steps.a.output.email' });
        await user.click(editor(document.body) as HTMLElement);
        act(() => handle().insert('steps.b.output.email'));
        const b = onChange.mock.lastCall?.[0];
        expect(b.kind).toBe('expr');
        expect(b.value).not.toContain('emailsteps');
        // Wherever the caret was, the two references stay two operands.
        expect(b.value.split(/\s+/).sort()).toEqual(['steps.a.output.email', 'steps.b.output.email']);
    });
});

describe('the formula check', () => {
    it('does not flag a whole path the run reads (unicode, a digit segment)', () => {
        setup({ kind: 'ref', path: 'trigger.output.Größe' });
        expect(screen.queryByText(/Not valid yet/)).toBeNull();
        cleanup();
        setup({ kind: 'expr', value: 'steps.a.output.x +' });
        expect(screen.getByText(/Not valid yet/)).toBeTruthy();
    });
});

describe('a structured value survives the raw editor', () => {
    const map = { Datum: { kind: 'ref', path: 'steps.a.output.date' }, Bedrag: { kind: 'ref', path: 'steps.a.output.amount' } };

    it('a half-typed edit is not saved as a string; valid JSON is saved as the structure', () => {
        const { onChange } = setup(map);
        const el = editor(document.body) as HTMLElement;
        typeInEditor(el, `${JSON.stringify(map)} x`);
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByText(/saved as soon as it is valid JSON/)).toBeTruthy();
        const next = { ...map, Extra: { kind: 'literal', value: 1 } };
        typeInEditor(el, JSON.stringify(next));
        expect(onChange.mock.lastCall?.[0]).toEqual(next);
    });

    it('an object literal stays an object literal', () => {
        const { onChange } = setup({ kind: 'literal', value: { a: 1 } });
        typeInEditor(editor(document.body) as HTMLElement, '{"a":2}');
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'literal', value: { a: 2 } });
    });
});

describe('a path saved as plain text', () => {
    it('offers its value in one click, in Simple mode too', async () => {
        const user = userEvent.setup();
        const { onChange } = setup({ kind: 'literal', value: 'steps.jira.output.fields["Story Points"]' }, {}, 'simple');
        // Simple mode has no Formula switch: this button is the way out.
        expect(screen.queryByTitle(/^Expression/)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Use its value' }));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'template', value: '{{steps.jira.output.fields["Story Points"]}}' });
        expect(editorValue(editor(document.body))).toBe('{{steps.jira.output.fields["Story Points"]}}');
    });

    it('ordinary words are left alone', () => {
        setup({ kind: 'literal', value: 'item' });
        expect(screen.queryByRole('button', { name: 'Use its value' })).toBeNull();
    });
});
