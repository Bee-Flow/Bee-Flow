/**
 * A test-run card reads like the same run on the Automations screens: the
 * tool a dry run would have called by its readable name, and the output drawn
 * readably with the exact JSON tree behind "Show raw".
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/flow-editor/components/run/RunStepCard.test.tsx
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import type { RunRowModel } from './runRows';
import { RunStepCard } from './RunStepCard';
import { ValueTree } from './ValueTree';

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

function row(over: Partial<RunRowModel> = {}): RunRowModel {
    return {
        key: 's1-1',
        stepId: 's1',
        name: 'Send the invoice',
        stepType: 'integration_action',
        status: 'success',
        durationMs: 1200,
        sample: null,
        notify: null,
        call: null,
        output: undefined,
        error: null,
        ...over,
    };
}

describe('RunStepCard', () => {
    it('names the tool a dry run would have called, not its id', async () => {
        await renderScreen(<RunStepCard row={row({ call: { tool: 'gmail_send', args: { to: 'ann@x.nl' } } })} onOpenStep={jest.fn()} />);
        expect(screen.getByText('Would call Gmail Send')).toBeTruthy();
        expect(screen.queryByText(/gmail_send/)).toBeNull();
    });

    it('opens the output readably', async () => {
        await renderScreen(<RunStepCard row={row({ output: { invoice_number: 'F-12', paid: false } })} onOpenStep={jest.fn()} />);
        await fireEvent.press(screen.getByText('Output'));
        expect(screen.getByText('Invoice number')).toBeTruthy();
        expect(screen.getByText('No')).toBeTruthy();
        expect(screen.queryByText('"F-12"')).toBeNull();
    });
});

describe('ValueTree', () => {
    it('draws a nested value as a tree in words, and the exact JSON on "Show raw"', async () => {
        await renderScreen(<ValueTree value={{ rows: [{ a: 1 }, { a: 2 }], done: true }} testID="v" />);
        expect(screen.getByText('Rows')).toBeTruthy();
        expect(screen.getByText('2 items')).toBeTruthy();
        expect(screen.getByText('Yes')).toBeTruthy();

        await fireEvent.press(screen.getByTestId('v-raw'));
        expect(screen.getByText('[2]')).toBeTruthy();
        expect(screen.getByText('true')).toBeTruthy();
        expect(screen.getByText('rows')).toBeTruthy();
    });

    it('draws a table as a table, with the raw tree behind the toggle', async () => {
        await renderScreen(<ValueTree value={[{ first_name: 'Ann' }, { first_name: 'Bo' }]} testID="v" />);
        expect(screen.getByText('First name')).toBeTruthy();
        expect(screen.getByText('2 rows')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('v-raw'));
        expect(screen.getByText('Show table')).toBeTruthy();
        expect(screen.getAllByText('{1}')).toHaveLength(2);
    });

    it('draws nothing for nothing', async () => {
        await renderScreen(<ValueTree value={null} testID="v" />);
        expect(screen.queryByTestId('v')).toBeNull();
    });
});
