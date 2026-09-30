import { fireEvent } from '@testing-library/react-native';
import React, { useState } from 'react';

import { getByShownText } from '@/features/flow-editor/components/fields/testing';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { TemplateMap, typedTemplateValue } from './TemplateMap';

jest.setTimeout(30_000);

function Harness({ initial, onValue }: { initial: Record<string, unknown>; onValue: (v: Record<string, unknown>) => void }) {
    const [value, setValue] = useState(initial);
    return (
        <TemplateMap
            value={value}
            onChange={(next) => {
                setValue(next);
                onValue(next);
            }}
        />
    );
}

describe('TemplateMap', () => {
    it('stores a number as a number and keeps a decimal point while it is typed', async () => {
        const onValue = jest.fn();
        await renderWithProviders(<Harness initial={{ amount: 4 }} onValue={onValue} />);
        await fireEvent.changeText(getByShownText('4'), '4.');
        expect(onValue).toHaveBeenLastCalledWith({ amount: 4 });
        // Still "4." on screen, not snapped back to "4".
        expect(getByShownText('4.')).toBeTruthy();
        await fireEvent.changeText(getByShownText('4.'), '4.5');
        expect(onValue).toHaveBeenLastCalledWith({ amount: 4.5 });
    });

    it('reads a typed value as the kind that is stored', () => {
        expect(typedTemplateValue('12', 3)).toBe(12);
        expect(typedTemplateValue('true', false)).toBe(true);
        expect(typedTemplateValue('12', 'x')).toBe('12');
    });
});
