import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsFormJs from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import scopedStorage from '../../../../utils/scopedStorage';

// A JS component: its props type from their defaults, looser than what it takes.
const SettingsForm = SettingsFormJs as unknown as React.FC<Record<string, unknown>>;

/**
 * A step that runs once per ORDER, given a line item's sku by its full path
 * (`steps.shop.output.orders[*].line_items[*].sku`, as the tree of the step
 * that produced it offers it): one run per line item, the order kept as the
 * outer item. Values fictional.
 */
const CATALOG = {
    apps: [{ id: 'x', actions: [{ name: 'stock_check', inputSchema: { type: 'object', required: ['sku', 'orderId'], properties: { sku: { type: 'string' }, orderId: { type: 'string' } } } }] }],
};
const ORDERS = [{ id: 'o1', line_items: [{ sku: 'A' }, { sku: 'B' }] }, { id: 'o2', line_items: [{ sku: 'C' }] }];
const PREVIEW = { steps: { shop: { output: { orders: ORDERS } } }, loop: { order: ORDERS[0] } };
const STEP = {
    id: 'chk', type: 'integration_action', label: 'Check stock', tool: 'stock_check',
    forEach: { overRef: 'steps.shop.output.orders', itemVar: 'order', maxIterations: 100 },
    inputs: { orderId: { kind: 'ref', path: 'loop.order.id' } },
};

beforeEach(() => {
    scopedStorage.setCurrentUser('test-user');
    try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => cleanup());

describe('SettingsForm — a list inside the item, picked by its full path', () => {
    it('moves the step down to the line items and keeps the order', async () => {
        const onPatch = vi.fn();
        const handles: Array<{ label?: string; insert: (p: string) => void }> = [];
        render(
            <VariablePickerProvider groups={[]} previewSample={PREVIEW} stepLabelById={new Map()} stepTypeById={new Map()}>
                <SettingsForm
                    step={STEP} modelTiers={{}} stepIssues={{ errors: [], warnings: [] }} saving={false} saveError={null}
                    onPatch={onPatch} catalog={CATALOG} groups={[]} previewSample={PREVIEW}
                    onFocusField={(h: { label?: string; insert: (p: string) => void }) => handles.push(h)}
                />
            </VariablePickerProvider>,
        );
        const sku = await screen.findByRole('textbox', { name: /sku/i });
        act(() => { sku.focus(); });
        const handle = handles.filter(h => /sku/i.test(String(h.label))).at(-1);
        expect(handle).toBeTruthy();
        act(() => { handle!.insert('steps.shop.output.orders[*].line_items[*].sku'); });
        await waitFor(() => expect(onPatch).toHaveBeenCalled(), { timeout: 3000 });
        const patch = onPatch.mock.calls.at(-1)?.[0];
        expect(patch.forEach).toEqual({
            overRef: 'steps.shop.output.orders[*].line_items', itemVar: 'line_item', maxIterations: 100,
            parents: [{ itemVar: 'order', overRef: 'steps.shop.output.orders' }],
        });
        expect(patch.inputs.sku).toEqual({ kind: 'ref', path: 'loop.line_item.sku' });
        expect(patch.inputs.orderId).toEqual({ kind: 'ref', path: 'loop.order.id' });
    });
});
