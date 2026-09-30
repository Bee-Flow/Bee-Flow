import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { scrollTargetFor, TabBar } from './TabBar';

jest.setTimeout(30_000);

describe('scrollTargetFor', () => {
    const viewport = { offset: 100, width: 300 };

    it('leaves a tab that is already in view alone', () => {
        expect(scrollTargetFor({ x: 150, width: 80 }, viewport)).toBeNull();
    });

    it('scrolls back to a tab cut off on the left, keeping a gutter', () => {
        expect(scrollTargetFor({ x: 60, width: 80 }, viewport)).toBe(36);
        expect(scrollTargetFor({ x: 10, width: 80 }, viewport)).toBe(0);
    });

    it('scrolls forward just far enough for a tab cut off on the right', () => {
        expect(scrollTargetFor({ x: 380, width: 80 }, viewport)).toBe(100 + 60 + 24);
    });

    it('does nothing before the strip has been measured', () => {
        expect(scrollTargetFor({ x: 900, width: 80 }, { offset: 0, width: 0 })).toBeNull();
    });
});

describe('TabBar', () => {
    const items = [
        { id: 'rows', label: 'Rows', count: 412 },
        { id: 'schema', label: 'Schema' },
        { id: 'used', label: 'Used by', count: null },
        { id: 'off', label: 'Locked', disabled: true },
    ] as const;

    it('marks the active tab, says the count, and reports a press', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TabBar items={items} value="rows" onChange={onChange} />);
        expect(screen.getByRole('tab', { name: 'Rows, 412' }).props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.getByText('412')).toBeTruthy();
        // A null count draws no pill at all.
        expect(screen.getByRole('tab', { name: 'Used by' })).toBeTruthy();
        await fireEvent.press(screen.getByRole('tab', { name: 'Schema' }));
        expect(onChange).toHaveBeenCalledWith('schema');
    });

    it('ignores a disabled tab', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<TabBar items={items} value="rows" onChange={onChange} />);
        await fireEvent.press(screen.getByRole('tab', { name: 'Locked' }));
        expect(onChange).not.toHaveBeenCalled();
    });
});
