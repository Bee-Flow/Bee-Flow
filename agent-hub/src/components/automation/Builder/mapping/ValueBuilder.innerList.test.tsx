import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ValueBuilderJs from './ValueBuilder';
import { VariablePickerProvider } from './VariablePickerContext';

// A JS component: its props type from their defaults (`onRequestForEach = null`), looser than what it takes.
const ValueBuilder = ValueBuilderJs as unknown as React.FC<Record<string, unknown>>;

// Orders, each with line items: a list inside a list. Values fictional.
const SAMPLE = { steps: { shop: { output: { orders: [{ id: 1, line_items: [{ sku: 'A' }, { sku: 'B' }] }, { id: 2, line_items: [{ sku: 'C' }] }] } } } };

function renderEditor(props: Record<string, unknown>) {
    const onChange = vi.fn();
    const handle: { current: { insert: (p: string) => void } | null } = { current: null };
    render(
        <VariablePickerProvider groups={[]} previewSample={SAMPLE} stepLabelById={new Map()} stepTypeById={new Map()}>
            <ValueBuilder
                value={{ kind: 'literal', value: '' }}
                onChange={onChange}
                previewSample={SAMPLE}
                expectShape="scalar"
                expectKind="text"
                label="sku"
                onFocusField={(h: { insert: (p: string) => void }) => { handle.current = h; }}
                {...props}
            />
        </VariablePickerProvider>,
    );
    act(() => { (screen.getAllByRole('textbox')[0] as HTMLElement).focus(); });
    return { onChange, insert: (p: string) => act(() => { handle.current?.insert(p); }) };
}

afterEach(() => cleanup());

describe('a column of a list inside a list, into a one-value field', () => {
    it('runs the step once per INNER item, keeping the outer item, never joining', async () => {
        const onRequestForEach = vi.fn();
        const { onChange, insert } = renderEditor({ onRequestForEach });
        insert('steps.shop.output.orders[*].line_items[*].sku');
        expect(onRequestForEach).toHaveBeenCalledWith({
            overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100,
            parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }],
        });
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'ref', path: 'loop.line_item.sku' });
        expect(screen.getByText(/runs once per line item/)).toBeTruthy();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Undo' }));
        expect(onRequestForEach).toHaveBeenLastCalledWith(null);
    });

    it('a step already per order moves down to the line items, also from the full path', () => {
        const apply = vi.fn((..._a: unknown[]) => ({ undo: vi.fn(), orphans: [] }));
        const { onChange, insert } = renderEditor({
            deepenForEach: { itemVar: 'order', forEach: { overRef: 'steps.shop.output.orders', itemVar: 'order' }, apply },
            onRequestForEach: vi.fn(),
            canForEach: false,
        });
        insert('steps.shop.output.orders[*].line_items[*].sku');
        expect(onChange).toHaveBeenLastCalledWith({ kind: 'ref', path: 'loop.line_item.sku' });
        expect(apply.mock.calls[0][0]).toMatchObject({ fromVar: 'order', listTail: 'line_items', itemVar: 'line_item' });
    });
});
