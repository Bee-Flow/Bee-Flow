import { fireEvent, screen } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import React from 'react';

import type { VariableGroup } from '@/features/flow-editor/bindings';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { BindingInput } from '../fields';
import { VariablePickerProvider } from '../variables';
import { InputPane } from './InputPane';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.setTimeout(30_000);

const GROUPS = [
    {
        id: 's1',
        label: 'Search email',
        kind: 'step',
        basePath: 'steps.s1.output',
        sample: { subject: 'Invoice' },
        fields: [{ key: 'subject', path: 'steps.s1.output.subject', sample: 'Invoice' }],
    },
] as unknown as VariableGroup[];

async function mount({ withField }: { withField: boolean }) {
    const onInserted = jest.fn();
    const onChange = jest.fn();
    await renderWithProviders(
        <ToastProvider>
            <VariablePickerProvider groups={GROUPS} sampleRoot={null} stepLabelById={new Map([['s1', 'Search email']])}>
                {withField ? <BindingInput label="Message" mode="template" value="" onChange={onChange} testID="message" /> : null}
                <InputPane onInserted={onInserted} />
            </VariablePickerProvider>
        </ToastProvider>,
    );
    return { onInserted, onChange };
}

afterEach(() => jest.clearAllMocks());

describe('InputPane', () => {
    it('copies a field as a reference when no field is waiting for it, and says how to insert it directly', async () => {
        const { onInserted } = await mount({ withField: false });
        await fireEvent.press(screen.getByLabelText(/^Subject, /));
        // `{{…}}`, not the bare path: pasted into a text field it is data, not the words "steps.s1.output.subject".
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('{{steps.s1.output.subject}}');
        expect(screen.getByText(/tap a field there first/)).toBeTruthy();
        expect(onInserted).not.toHaveBeenCalled();
    });

    it('puts a field into the one the author was typing in', async () => {
        const { onInserted, onChange } = await mount({ withField: true });
        await fireEvent(screen.getByTestId('message-input'), 'focus');
        await fireEvent.press(screen.getByLabelText(/^Subject, /));
        expect(onChange).toHaveBeenLastCalledWith('{{steps.s1.output.subject}}');
        expect(onInserted).toHaveBeenCalled();
        expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    });
});
