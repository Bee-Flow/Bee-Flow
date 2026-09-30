/**
 * The condition rows keep their own state when a row above them goes: a row
 * whose field was written as an expression hands that choice to no one.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ConditionBuilder } from './ConditionBuilder';

jest.setTimeout(30_000);

const OPTIONS = [{ path: 'trigger.output.subject', label: 'Subject' }];

function Harness({ initial }: { initial: string }) {
    const [value, setValue] = useState(initial);
    return <ConditionBuilder value={value} onChange={setValue} sampleRoot={{}} fieldOptions={OPTIONS} fieldBase="trigger.output" />;
}

describe('ConditionBuilder', () => {
    it('keeps the row below a removed one picked by name', async () => {
        await renderWithProviders(<Harness initial={'trigger.output.subject == "a" && trigger.output.subject == "b"'} />);
        // Row 1 is switched to an expression; row 2 stays picked by name.
        await fireEvent.press(screen.getByTestId('condition-row-1-field'));
        await fireEvent.press(await screen.findByText('Use an expression instead'));
        expect(screen.getByTestId('condition-row-1-expr')).toBeTruthy();
        expect(screen.getByTestId('condition-row-2-field')).toBeTruthy();
        await fireEvent.press(screen.getAllByRole('button', { name: 'Remove condition' })[0]!);
        // Was: row 2 moved into row 1's slot and inherited its "written as an expression".
        expect(screen.getByTestId('condition-row-1-field')).toBeTruthy();
        expect(screen.queryByTestId('condition-row-1-expr')).toBeNull();
    });
});
