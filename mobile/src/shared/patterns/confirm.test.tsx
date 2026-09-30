/**
 * useConfirm turns the themed ConfirmSheet into an awaitable yes/no. Every
 * path must settle the promise — a confirm that never resolves leaves a delete
 * button spinning forever.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Pressable, Text } from 'react-native';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ConfirmProvider, useConfirm, type ConfirmOptions } from './confirm';

jest.setTimeout(30_000);

const OPTIONS: ConfirmOptions = {
    title: 'Delete this automation?',
    message: 'Its runs go with it.',
    confirmLabel: 'Delete',
};

function Harness({ onAnswer, options = OPTIONS }: { onAnswer: (ok: boolean) => void; options?: ConfirmOptions }) {
    const confirm = useConfirm();
    return (
        <Pressable onPress={() => void confirm(options).then(onAnswer)}>
            <Text>Ask</Text>
        </Pressable>
    );
}

async function ask(options?: ConfirmOptions) {
    const onAnswer = jest.fn();
    const view = await renderWithProviders(
        <ConfirmProvider>
            <Harness onAnswer={onAnswer} options={options} />
        </ConfirmProvider>,
    );
    await fireEvent.press(screen.getByText('Ask'));
    return { onAnswer, ...view };
}

describe('useConfirm', () => {
    it('shows the sheet and resolves true on confirm', async () => {
        const { onAnswer } = await ask();
        expect(screen.getByText('Delete this automation?')).toBeTruthy();
        expect(screen.getByText('Its runs go with it.')).toBeTruthy();
        await fireEvent.press(screen.getByLabelText('Delete'));
        expect(onAnswer).toHaveBeenCalledWith(true);
    });

    it('resolves false on cancel', async () => {
        const { onAnswer } = await ask();
        await fireEvent.press(screen.getByText('Cancel'));
        expect(onAnswer).toHaveBeenCalledWith(false);
    });

    it('answers an older request "no" when a newer one replaces it', async () => {
        const { onAnswer } = await ask();
        await fireEvent.press(screen.getByText('Ask'));
        expect(onAnswer).toHaveBeenCalledWith(false);
        await fireEvent.press(screen.getByLabelText('Delete'));
        expect(onAnswer).toHaveBeenLastCalledWith(true);
    });

    it('renders a primary confirm for a safe action', async () => {
        const { onAnswer } = await ask({ ...OPTIONS, confirmLabel: 'Sign out', tone: 'primary' });
        await act(async () => {
            await fireEvent.press(screen.getByText('Sign out'));
        });
        expect(onAnswer).toHaveBeenCalledWith(true);
    });

    it('throws outside the provider rather than silently never asking', async () => {
        const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(renderWithProviders(<Harness onAnswer={jest.fn()} />)).rejects.toThrow(
            'useConfirm must be used inside <ConfirmProvider>',
        );
        spy.mockRestore();
    });
});
