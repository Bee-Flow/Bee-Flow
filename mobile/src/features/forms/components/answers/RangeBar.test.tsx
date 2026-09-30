/** The custom period's two dates open the number pad (it has the "-" a date needs), not the letter keyboard. */

import { cleanup, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { RangeBar } from './RangeBar';

afterEach(async () => {
    await cleanup();
});

it('types a custom period on the number pad', async () => {
    const onChange = jest.fn();
    await renderWithProviders(<RangeBar range={{ preset: 'custom', from: '', to: '' }} onChange={onChange} updated={null} />);
    const [from, to] = screen.getAllByPlaceholderText('YYYY-MM-DD');
    expect(from?.props.keyboardType).toBe('numeric');
    expect(to?.props.keyboardType).toBe('numeric');

    await fireEvent.changeText(from as never, '2026-09-01');
    expect(onChange).toHaveBeenCalledWith({ preset: 'custom', from: '2026-09-01', to: '' });
});
