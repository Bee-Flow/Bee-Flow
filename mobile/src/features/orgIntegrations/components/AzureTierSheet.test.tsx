/**
 * A tier's temperature typed on a phone: "0." and "0," survive on the way to
 * 0.7, a decimal comma is a decimal, and a number past the range is brought
 * back within it when the field is left.
 */

import { cleanup, fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AzureTierSheet } from './AzureTierSheet';
import { blankTier } from '../model/azure';
import type { AzureTier } from '../model/azureTypes';

const patches: Partial<AzureTier>[] = [];

/** The sheet over a tier it really edits, as the Azure models screen holds it. */
function Harness() {
    const [tier, setTier] = useState<AzureTier>(blankTier('fast'));
    return (
        <AzureTierSheet
            tierKey="fast"
            title="Fast"
            tier={tier}
            models={['gpt-5-mini']}
            onChange={(patch) => {
                patches.push(patch);
                setTier((prev) => ({ ...prev, ...patch }));
            }}
            onClose={() => undefined}
        />
    );
}

const field = () => screen.getByTestId('azure-tier-temperature');

async function typeInto(text: string) {
    for (let i = 1; i <= text.length; i += 1) await fireEvent.changeText(field(), text.slice(0, i));
}

beforeEach(() => {
    patches.length = 0;
});

afterEach(async () => {
    await cleanup();
});

it('keeps "0." while 0.7 is typed, and stores 0.7', async () => {
    await renderWithProviders(<Harness />);
    await typeInto('0.7');
    expect(field().props.value).toBe('0.7');
    expect(patches.map((p) => p.temperature)).toEqual([0, 0, 0.7]);
});

it('reads a decimal comma, and shows the stored number once the field is left', async () => {
    await renderWithProviders(<Harness />);
    await typeInto('0,');
    expect(field().props.value).toBe('0,');
    await fireEvent.changeText(field(), '0,7');
    expect(patches.at(-1)).toEqual({ temperature: 0.7 });
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('0.7');
});

it('brings a temperature past the range back within it', async () => {
    await renderWithProviders(<Harness />);
    await typeInto('15');
    expect(patches.at(-1)).toEqual({ temperature: 2 });
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('2');
});

it('leaves an emptied field to the tier’s default', async () => {
    await renderWithProviders(<Harness />);
    await typeInto('1');
    await fireEvent.changeText(field(), '');
    expect(patches.at(-1)).toEqual({ temperature: null });
    await fireEvent(field(), 'blur');
    expect(field().props.value).toBe('');
});
