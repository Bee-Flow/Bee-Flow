/**
 * BindingInput and the v2 mapping (features/flow-editor/valueSlot): a pick or
 * a composed text stored by the web or the AI builder shows for what it is
 * and is never corrupted by an edit on the phone; where a field stores picks,
 * a legacy reference shows as the chip it lifts to and a value picked into
 * the field is stored as a pick.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';
import { Pressable } from 'react-native';

import type { VariableGroup } from '@/features/flow-editor/bindings';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { VariablePickerProvider } from '../variables';
import { BindingInput, type BindingInputProps } from './BindingInput';
import { shownText } from './testing';

jest.setTimeout(30_000);

const OUTPUT = { total: 2, orders: [{ product: 'Stoel' }, { product: 'Tafel' }] };

const GROUPS: VariableGroup[] = [
    {
        id: 'act_1',
        label: 'gmail search',
        kind: 'step',
        basePath: 'steps.act_1.output',
        sample: OUTPUT,
        fields: [
            { key: 'total', path: 'steps.act_1.output.total', sample: 2 },
            { key: 'product', path: 'steps.act_1.output.orders[*].product', sample: 'Stoel' },
        ],
    },
];

const SAMPLE = { trigger: { output: {} }, steps: { act_1: { output: OUTPUT } } };

const PRODUCTS = { root: 'steps', id: 'act_1', path: ['orders', 'product'] };
const TOTAL = { root: 'steps', id: 'act_1', path: ['total'] };

type HarnessProps = Omit<BindingInputProps, 'value' | 'onChange'> & {
    initial: unknown;
    onValue: (v: unknown) => void;
    /** A value put in from elsewhere (an undo, a sync) on a press of `outside`. */
    outside?: unknown;
};

function Harness({ initial, onValue, outside, ...rest }: HarnessProps) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <VariablePickerProvider groups={GROUPS} sampleRoot={SAMPLE} stepLabelById={new Map([['act_1', 'gmail search']])}>
            <BindingInput
                {...rest}
                value={value}
                onChange={(v) => {
                    setValue(v);
                    onValue(v);
                }}
            />
            {outside !== undefined ? <Pressable testID="outside" onPress={() => setValue(outside)} /> : null}
        </VariablePickerProvider>
    );
}

type Node = ReturnType<typeof screen.getByTestId>;

/** What the field shows, exactly: pill labels with their non-breaking spaces. */
const displayed = (node: Node | string): string =>
    typeof node === 'string' ? node : node.children.map((c) => displayed(c as Node | string)).join('');

const pickProduct = async (testID: string) => {
    await fireEvent.press(screen.getByTestId(`${testID}-insert`));
    await fireEvent.press(screen.getByRole('button', { name: /^Product, / }));
};

describe('a stored pick', () => {
    const pick = { kind: 'pick', v: 1, from: PRODUCTS, take: 'all', as: 'text', join: 'lines' };

    it('shows as a chip with its name, how many it holds and what the field gets — never a path', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Body" initial={pick} onValue={onValue} testID="body" />);
        expect(screen.getByText('Product of all orders')).toBeTruthy();
        expect(screen.getByText('· 2')).toBeTruthy();
        expect(screen.getByTestId('body-pick-preview').props.children).toBe('Stoel\nTafel');
        expect(screen.getByText('Comes as text: all 2, one per line.')).toBeTruthy();
        expect(screen.queryByText(/steps\.|\{\{|\[\*\]/)).toBeNull();
        expect(onValue).not.toHaveBeenCalled();
    });

    it('changes how it is used from the sheet, with a live example per choice', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Body" initial={pick} onValue={onValue} testID="body" />);
        await fireEvent.press(screen.getByTestId('body-pick-open'));
        expect(screen.getByText('How should Product of all orders be used?')).toBeTruthy();
        expect(screen.getByTestId('body-pick-options-all_comma').props.accessibilityHint).toBe('Stoel, Tafel');
        // Choosing what it already is writes nothing.
        await fireEvent.press(screen.getByTestId('body-pick-options-all_lines'));
        expect(onValue).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByTestId('body-pick-open'));
        await fireEvent.press(screen.getByTestId('body-pick-options-first'));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'pick', v: 1, from: PRODUCTS, take: 'first', as: 'text' });
        expect(screen.getByText('Only the first of 2.')).toBeTruthy();
    });

    it('is taken out whole, and a new pick replaces it', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness label="Total" initial={{ ...pick, take: 'count', as: 'native', join: undefined }} onValue={onValue} testID="t" />);
        await fireEvent.press(screen.getByTestId('t-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'native' });
        await fireEvent.press(screen.getByTestId('t-pick-remove'));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: '' });
    });

    it('in a text field that held one (a document value), a new value goes in the way the field always took one', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness mode="template" label="Value" initial={{ ...pick, as: 'native' }} onValue={onValue} testID="v" />);
        expect(screen.getByText('Product of all orders')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('v-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith('{{steps.act_1.output.total}}');
    });

    it('says so when the step it came from is gone', async () => {
        const gone = { kind: 'pick', v: 1, from: { root: 'steps', id: 'removed', path: ['x'] }, take: 'one', as: 'native' };
        await renderWithProviders(<Harness label="X" initial={gone} onValue={jest.fn()} testID="x" />);
        expect(screen.getByText(/^No longer available: /)).toBeTruthy();
        expect(screen.getByTestId('x-pick-repick')).toBeTruthy();
    });
});

describe('a stored composed text', () => {
    const name = { from: TOTAL, take: 'one', as: 'text' };
    const products = { from: PRODUCTS, take: 'all', as: 'text', join: 'lines' };
    const compose = { kind: 'compose', v: 1, parts: ['Beste ', name, ', uw orders:\n', products] };

    it('shows its values as pills in the text, never "[object Object]" or a path', async () => {
        await renderWithProviders(<Harness mode="template" label="Prompt" multiline initial={compose} onValue={jest.fn()} testID="p" />);
        const shown = shownText(screen.getByTestId('p-input'));
        expect(shown).toBe('Beste  Total from gmail search , uw orders:\n Product of all orders · 2 ');
        expect(screen.getAllByTestId('binding-pill')).toHaveLength(2);
        // The list value says how it is used, and can be changed, under the field.
        expect(screen.getByText('Comes as text: all 2, one per line.')).toBeTruthy();
    });

    it('stays the same compose when the words around the values are edited', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness mode="template" label="Prompt" multiline initial={compose} onValue={onValue} testID="p" />);
        const input = screen.getByTestId('p-input');
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
        await fireEvent.changeText(input, `Hoi ${displayed(input)}`);
        const sent = onValue.mock.calls.at(-1)?.[0] as { kind: string; parts: unknown[] };
        expect(sent.kind).toBe('compose');
        expect(sent.parts).toEqual(['Hoi Beste ', name, ', uw orders:\n', products]);
    });

    it('takes a new value at the caret as a part of the text', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness mode="template" label="Prompt" initial={{ kind: 'compose', v: 1, parts: ['Hi ', name] }} onValue={onValue} testID="p" />);
        await pickProduct('p');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'compose', v: 1, parts: ['Hi ', name, { from: PRODUCTS, take: 'all', as: 'text', join: 'comma' }] });
    });

    it('changes how a list in it is used without touching the rest', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness mode="template" label="Prompt" multiline initial={compose} onValue={onValue} testID="p" />);
        await fireEvent.press(screen.getByTestId('p-value-0-open'));
        await fireEvent.press(screen.getByTestId('p-value-0-options-count'));
        expect(onValue).toHaveBeenLastCalledWith({ ...compose, parts: ['Beste ', name, ', uw orders:\n', { from: PRODUCTS, take: 'count', as: 'text' }] });
    });
});

describe('a field that stores picks', () => {
    it('shows a legacy reference as the chip it lifts to, and leaves it as stored until it is changed', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Total" initial={{ kind: 'ref', path: 'steps.act_1.output.total' }} onValue={onValue} testID="t" />);
        expect(screen.getByText('Total from gmail search')).toBeTruthy();
        expect(screen.getByTestId('t-pick-preview').props.children).toBe('2');
        expect(onValue).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByTestId('t-pick-remove'));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'literal', value: '' });
    });

    it('lifts a one-call formula the run reads the same way', async () => {
        const onValue = jest.fn();
        await renderWithProviders(
            <Harness storesPicks label="Products" initial={{ kind: 'expr', value: 'join(steps.act_1.output.orders[*].product, ", ")' }} onValue={onValue} testID="j" />,
        );
        expect(screen.getByText('Product of all orders')).toBeTruthy();
        expect(screen.getByText('Comes as text: all 2, separated by commas.')).toBeTruthy();
        // Advanced › the formula it was, unchanged.
        await fireEvent.press(screen.getByTestId('j-pick-open'));
        await fireEvent.press(screen.getByText('Advanced'));
        await fireEvent.press(screen.getByText('Write a formula instead'));
        expect(shownText(screen.getByTestId('j-input'))).toBe('join( gmail search ▸ Product , ", ")');
    });

    it('shows a formula it cannot lift as a Formula chip, and opens it on a tap', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Big" initial={{ kind: 'expr', value: 'steps.act_1.output.total > 1' }} onValue={onValue} testID="f" />);
        expect(screen.getByText('Formula')).toBeTruthy();
        expect(screen.getByText('‹gmail search › Total› > 1')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('f-formula-open'));
        expect(shownText(screen.getByTestId('f-input'))).toBe(' gmail search ▸ Total  > 1');
        expect(onValue).not.toHaveBeenCalled();
    });

    it('stores a value picked into an empty field as a pick, used the way the field wants it', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks schema={{ type: 'string' }} label="Products" initial={null} onValue={onValue} testID="s" />);
        await pickProduct('s');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'pick', v: 1, from: PRODUCTS, take: 'all', as: 'text', join: 'comma' });
        expect(screen.getByText('Comes as text: all 2, separated by commas.')).toBeTruthy();
    });

    it('a field without a schema gets the value as it is', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Products" initial={null} onValue={onValue} testID="s" />);
        await pickProduct('s');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'pick', v: 1, from: PRODUCTS, take: 'all', as: 'native' });
    });

    it('keeps typed words in a text field: the value goes in at the caret, as a composed text', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks schema={{ type: 'string' }} label="Subject" initial={{ kind: 'literal', value: 'Orders: ' }} onValue={onValue} testID="s" />);
        const input = screen.getByTestId('s-input');
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 8, end: 8 } } });
        await pickProduct('s');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'compose', v: 1, parts: ['Orders: ', { from: PRODUCTS, take: 'all', as: 'text', join: 'comma' }] });
    });

    it('keeps typed words in a field without a schema: the value goes in at the caret, never over them', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Note" initial={{ kind: 'literal', value: 'Order #' }} onValue={onValue} testID="s" />);
        const input = screen.getByTestId('s-input');
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 7, end: 7 } } });
        await fireEvent.press(screen.getByTestId('s-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'template', value: 'Order #{{steps.act_1.output.total}}' });
    });

    it('keeps typed words in a number field too', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks schema={{ type: 'number' }} label="Count" initial={{ kind: 'literal', value: '1' }} onValue={onValue} testID="s" />);
        const input = screen.getByTestId('s-input');
        await fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 0 } } });
        await fireEvent.press(screen.getByTestId('s-insert'));
        await fireEvent.press(screen.getByRole('button', { name: /^Total, 2/ }));
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'template', value: '{{steps.act_1.output.total}}1' });
    });

    it('shows a pick that comes back while the author was typing (an undo) as its chip, not as an empty text', async () => {
        const pick = { kind: 'pick', v: 1, from: TOTAL, take: 'one', as: 'native' };
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Total" initial={{ kind: 'literal', value: '' }} outside={pick} onValue={onValue} testID="s" />);
        await fireEvent.changeText(screen.getByTestId('s-input'), 'x');
        await fireEvent.press(screen.getByTestId('outside'));
        expect(screen.getByText('Total from gmail search')).toBeTruthy();
        expect(screen.queryByTestId('s-input')).toBeNull();
        expect(onValue).toHaveBeenCalledTimes(1);
    });

    it('keeps the text editor while a reference is typed out in full', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Total" initial={{ kind: 'literal', value: '' }} onValue={onValue} testID="s" />);
        await fireEvent.changeText(screen.getByTestId('s-input'), '{{steps.act_1.output.total}}');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'ref', path: 'steps.act_1.output.total' });
        expect(screen.getByTestId('s-input')).toBeTruthy();
        expect(screen.queryByTestId('s-pick-open')).toBeNull();
    });

    it('a legacy template stays a template', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness storesPicks label="Subject" initial={{ kind: 'template', value: 'Re: {{steps.act_1.output.total}}' }} onValue={onValue} testID="s" />);
        await pickProduct('s');
        expect(onValue).toHaveBeenLastCalledWith({ kind: 'template', value: 'Re: {{steps.act_1.output.total}}{{steps.act_1.output.orders[*].product}}' });
    });
});
