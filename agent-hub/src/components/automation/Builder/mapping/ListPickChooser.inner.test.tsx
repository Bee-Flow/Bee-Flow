import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ListPickChooserJs from './ListPickChooser';
import { pathListShape } from './listShape';

// A JS component: its props type from their defaults, looser than what it takes.
const ListPickChooser = ListPickChooserJs as unknown as React.FC<Record<string, unknown>>;

const ROOT = { steps: { shop: { output: { orders: [{ id: 1, line_items: [{ sku: 'A' }, { sku: 'B' }] }, { id: 2, line_items: [{ sku: 'C' }] }] } } } };

afterEach(() => cleanup());

describe('ListPickChooser: a column of a list inside a list', () => {
    it('offers one run per inner item instead of a dead end, keeping the outer item', async () => {
        const onChoose = vi.fn();
        const path = 'steps.shop.output.orders[*].line_items[*].sku';
        render(<ListPickChooser open anchorEl={null} path={path} shape={pathListShape(path, ROOT)} sampleRoot={ROOT} expectShape="scalar" allowForEach onChoose={onChoose} onCancel={vi.fn()} />);
        const row = screen.getByText('Run this step once for each line item');
        expect(screen.getByText(/runs 3 times — once per line item/)).toBeTruthy();
        await userEvent.setup().click(row);
        expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({
            mode: 'foreach',
            binding: { kind: 'ref', path: 'loop.line_item.sku' },
            forEach: { overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100, parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }] },
        }));
    });
});
