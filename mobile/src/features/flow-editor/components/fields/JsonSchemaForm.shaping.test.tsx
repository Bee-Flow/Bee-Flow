import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';

import type { JsonSchema, VariableGroup } from '@/features/flow-editor/bindings';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { VariablePickerProvider } from '../variables';
import { JsonSchemaForm } from './JsonSchemaForm';

/**
 * An app action's one-value input on the phone takes a picked list the way
 * the web's ToolInputForm does: joined into a text, never stored as the raw
 * list — except a value from a list inside a list, which stays a path so the
 * step's write runs it once per inner item (deepenInputs.ts).
 */

jest.setTimeout(30_000);

const ORDERS = [
    { id: 'o1', line_items: [{ sku: 'A' }, { sku: 'B' }] },
    { id: 'o2', line_items: [{ sku: 'C' }] },
];
const ROOT = { steps: { shop: { output: { orders: ORDERS, tags: ['red', 'blue'] } } } };
const NESTED = 'steps.shop.output.orders[*].line_items[*].sku';
const GROUPS: VariableGroup[] = [
    {
        id: 'shop',
        label: 'shop',
        kind: 'step',
        basePath: 'steps.shop.output',
        sample: ROOT.steps.shop.output,
        fields: [
            { key: 'tags', path: 'steps.shop.output.tags', sample: ['red', 'blue'] },
            { key: 'line item skus', path: NESTED, sample: ['A', 'B', 'C'] },
        ],
    },
];
const SCHEMA = {
    type: 'object',
    properties: { subject: { type: 'string', title: 'Subject' }, labels: { type: 'array', items: { type: 'string' }, title: 'Labels' } },
    required: ['subject', 'labels'],
} as JsonSchema;

function Harness({ onInputs }: { onInputs: (next: Record<string, unknown>) => void }) {
    const [inputs, setInputs] = useState<Record<string, unknown>>({});
    return (
        <VariablePickerProvider groups={GROUPS} sampleRoot={ROOT} stepLabelById={new Map([['shop', 'shop']])}>
            <JsonSchemaForm
                inputSchema={SCHEMA}
                inputs={inputs}
                forEach={null}
                onChange={(next) => {
                    setInputs(next as Record<string, unknown>);
                    onInputs(next as Record<string, unknown>);
                }}
            />
        </VariablePickerProvider>
    );
}

async function pick(field: string, row: RegExp) {
    await fireEvent.press(screen.getByTestId(`input-${field}-insert`));
    await fireEvent.press(screen.getAllByRole('button', { name: row })[0]!);
}

describe('JsonSchemaForm picks into one-value inputs', () => {
    it('joins a list picked into a text input', async () => {
        const onInputs = jest.fn();
        await renderWithProviders(<Harness onInputs={onInputs} />);
        await pick('subject', /^Tags/);
        const subject = onInputs.mock.lastCall?.[0].subject;
        expect(subject).toMatchObject({ kind: 'expr' });
        expect(subject.value).toContain('join(steps.shop.output.tags');
    });

    it('keeps a value from a list inside a list as its path, so the step runs per inner item', async () => {
        const onInputs = jest.fn();
        await renderWithProviders(<Harness onInputs={onInputs} />);
        await pick('subject', /^Line item skus/);
        expect(onInputs.mock.lastCall?.[0].subject).toEqual({ kind: 'ref', path: NESTED });
    });

    it('a list input takes the list as it is', async () => {
        const onInputs = jest.fn();
        await renderWithProviders(<Harness onInputs={onInputs} />);
        await pick('labels', /^Tags/);
        expect(onInputs.mock.lastCall?.[0].labels).toEqual({ kind: 'ref', path: 'steps.shop.output.tags' });
    });
});
