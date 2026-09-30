/**
 * A Studio form's number and date fields as a Dutch phone types them: a
 * decimal comma is a decimal, a half-typed number keeps its separator, the
 * keyboards have digits, and text that is not a number is refused at the
 * button instead of being sent as the last number it resembled.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { FormCard } from './FormCard';
import type { AppBlock } from '../model/appDefinition';
import type { AppInput } from '../model/inputs';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const post = api.post as jest.Mock;

const input = (patch: Partial<AppInput> & Pick<AppInput, 'name' | 'type'>): AppInput => ({
    node: { id: patch.name, type: patch.type },
    label: patch.name,
    placeholder: null,
    required: false,
    options: [],
    min: null,
    max: null,
    rows: 4,
    inputType: 'text',
    initial: null,
    ...patch,
});

const block = (inputs: AppInput[]): Extract<AppBlock, { kind: 'form' }> => ({
    kind: 'form',
    id: 'f1',
    title: null,
    description: null,
    submitLabel: 'Send',
    inputs,
    action: { actionId: 'a1', action: { kind: 'run_automation' }, runnable: true, label: 'Send' },
});

async function draw(inputs: AppInput[]) {
    await renderWithProviders(<FormCard appId="app1" block={block(inputs)} />);
}

/** Types the text a key at a time, as a keyboard does. */
async function typeInto(testID: string, text: string) {
    for (let i = 1; i <= text.length; i += 1) {
        await fireEvent.changeText(screen.getByTestId(testID), text.slice(0, i));
    }
}

beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ runId: 'r1', status: 'success', output: 'ok' });
});

afterEach(async () => {
    await cleanup();
});

it('reads a decimal comma as a decimal and sends 1.5, not 15', async () => {
    await draw([input({ name: 'amount', type: 'input_number', label: 'Amount' })]);
    await typeInto('app-input-amount', '1,5');
    expect(screen.getByTestId('app-input-amount').props.value).toBe('1,5');

    await fireEvent.press(screen.getByText('Send'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toEqual({ formValues: { amount: 1.5 } });
});

it('keeps "0." and "0.0" on the way to 0.05, and shows the number once the field is left', async () => {
    await draw([input({ name: 'rate', type: 'input_number', label: 'Rate' })]);
    await typeInto('app-input-rate', '0.0');
    expect(screen.getByTestId('app-input-rate').props.value).toBe('0.0');
    await fireEvent.changeText(screen.getByTestId('app-input-rate'), '0.05');
    await fireEvent(screen.getByTestId('app-input-rate'), 'blur');
    expect(screen.getByTestId('app-input-rate').props.value).toBe('0.05');

    await fireEvent.press(screen.getByText('Send'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[1]).toEqual({ formValues: { rate: 0.05 } });
});

it('refuses text that is not a number instead of sending the number before it', async () => {
    await draw([input({ name: 'amount', type: 'input_number', label: 'Amount' })]);
    await typeInto('app-input-amount', '1.2.3');
    expect(screen.getByText('Not a number: Amount')).toBeTruthy();

    await fireEvent.press(screen.getByText('Send'));
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a number.')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('app-input-amount'), '');
    expect(screen.queryByText('Not a number: Amount')).toBeNull();
});

it('opens number keyboards for numbers and dates', async () => {
    await draw([input({ name: 'amount', type: 'input_number', label: 'Amount' }), input({ name: 'start', type: 'input_date', label: 'Start' })]);
    expect(screen.getByTestId('app-input-amount').props.keyboardType).toBe('numeric');
    expect(screen.getByPlaceholderText('YYYY-MM-DD').props.keyboardType).toBe('numeric');
});
