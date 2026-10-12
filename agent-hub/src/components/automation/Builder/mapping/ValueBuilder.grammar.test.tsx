/**
 * The visual value editor with real-world keys: picks land canonically, a
 * table reached through [*] gives a column the run fills, a structured value
 * keeps its shape through the formula escape, the example line follows the
 * slot's listAs, and a path saved as plain text can be fixed in Simple mode.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { SlotListAsContext } from './slotListAs';
import ValueBuilderJs from './ValueBuilder';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { FormDensityContext } from '../flow/settings/formDensity';
import { editor, typeInEditor } from '../../../../test/refEditor';

type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const ValueBuilder = ValueBuilderJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const ROOT = {
    steps: {
        src: {
            output: {
                value: [
                    { from: { emailAddress: { address: 'ada@x.nl' } } },
                    { from: { emailAddress: { address: 'bob@x.nl' } } },
                ],
                headers: { 'content-type': 'application/json' },
                '@odata.nextLink': 'https://next',
            },
        },
    },
};
const LABELS = new Map([['src', 'Graph']]);

type Handle = { insert: (path: string, opts?: Record<string, unknown>) => void };

function setup(value: unknown, props: Record<string, unknown> = {}, { mode = 'advanced', listAs = 'text' }: { mode?: string; listAs?: 'text' | 'json' } = {}) {
    const onChange = vi.fn();
    let handle: Handle | null = null;
    render(
        <FormDensityContext.Provider value={{ density: 'full', mode, onHiddenSection: null, onShownSection: null } as never}>
            <SlotListAsContext.Provider value={listAs}>
                <VariablePickerProvider groups={[]} previewSample={ROOT} stepLabelById={LABELS} stepTypeById={null}>
                    <ValueBuilder value={value} onChange={onChange} label="Field" onFocusField={(h: Handle) => { handle = h; }} {...props} />
                </VariablePickerProvider>
            </SlotListAsContext.Provider>
        </FormDensityContext.Provider>,
    );
    return { onChange, handle: () => handle as unknown as Handle };
}

afterEach(() => cleanup());

describe('picks', () => {
    it('a dragged dotted path with a dash lands as a canonical ref', async () => {
        const user = userEvent.setup();
        const { onChange, handle } = setup(null);
        await user.click(editor(document.body) as HTMLElement);
        act(() => handle().insert('steps.src.output.headers.content-type'));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'ref', path: 'steps.src.output.headers["content-type"]' });
    });

    it('a column of a table reached through [*] is filled at run time', async () => {
        const user = userEvent.setup();
        const { onChange, handle } = setup(null, { label: 'Recipient address', expectShape: 'scalar', expectKind: 'email' });
        await user.click(editor(document.body) as HTMLElement);
        act(() => handle().insert('steps.src.output.value[*].from.emailAddress'));
        const b = onChange.mock.lastCall?.[0];
        expect(b.kind).toBe('expr');
        expect(evaluate(b.value, ROOT)).toBe('ada@x.nl, bob@x.nl');
    });
});

describe('a bare map of bindings through "Edit the formula"', () => {
    const map = { Datum: { kind: 'ref', path: 'steps.a.output.date' } };

    it('never becomes a JSON string', async () => {
        const user = userEvent.setup();
        const { onChange } = setup(map);
        await user.click(screen.getByRole('button', { name: 'Edit the formula' }));
        const el = editor(document.body) as HTMLElement;
        typeInEditor(el, '{"Datum": ');
        expect(onChange).not.toHaveBeenCalled();
        typeInEditor(el, '{"Datum":{"kind":"ref","path":"steps.a.output.day"}}');
        expect(onChange.mock.lastCall?.[0]).toEqual({ Datum: { kind: 'ref', path: 'steps.a.output.day' } });
    });
});

describe('the example line and the chips', () => {
    it('a data slot previews the JSON the tool receives', () => {
        setup({ kind: 'template', value: 'To: {{steps.src.output.value[*].from.emailAddress.address}}' }, {}, { listAs: 'json' });
        expect(screen.getByText('To: ["ada@x.nl","bob@x.nl"]')).toBeTruthy();
    });

    it('the example is long enough for deep values and wraps instead of cutting them off', () => {
        const value = { kind: 'template', value: 'Hello {{steps.src.output.value[0].from.emailAddress.address}}, about {{steps.src.output["@odata.nextLink"]}} and the reason code R-7 at the end' };
        setup(value);
        const line = screen.getByTestId('value-example');
        expect(line.textContent).toContain('R-7 at the end');
        expect(line.querySelector('.line-clamp-2')).toBeTruthy();
    });

    it('a list of plain values previews its values, not "[2 items]"', () => {
        setup({ kind: 'ref', path: 'steps.src.output.value[*].from.emailAddress.address' }, { label: 'cc' });
        expect(screen.getByText('ada@x.nl, bob@x.nl')).toBeTruthy();
    });

    it('two addresses from different parents read differently', () => {
        setup({ kind: 'ref', path: 'steps.src.output.value[*].from.emailAddress.address' });
        expect(screen.getByText('▸ From ▸ Address')).toBeTruthy();
    });

    it('a formula names a quoted key on its chip', () => {
        setup({ kind: 'expr', value: 'concat(steps.src.output["@odata.nextLink"], "?x")' });
        expect(screen.getByText('Graph')).toBeTruthy();
        expect(screen.getByText('▸ @odata next link')).toBeTruthy();
    });

    it('a path saved as text gets its value in one click, in Simple mode', async () => {
        const user = userEvent.setup();
        const { onChange } = setup({ kind: 'literal', value: 'steps.src.output["@odata.nextLink"]' }, {}, { mode: 'simple' });
        await user.click(screen.getByRole('button', { name: 'Use its value' }));
        expect(onChange.mock.lastCall?.[0]).toEqual({ kind: 'ref', path: 'steps.src.output["@odata.nextLink"]' });
    });
});
