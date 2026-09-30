/**
 * Closing the never-hide sheet keeps a term that is still typed: Close is the
 * sheet's only way out and does not take the focus, so the field never sees
 * its own blur. The term lands in the screen's draft, which only its Save
 * sends.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { AllowTermsSheet } from './AllowTermsSheet';

async function draw(terms: string[]) {
    const onTerms = jest.fn();
    const onClose = jest.fn();
    await renderWithProviders(
        <AllowTermsSheet visible terms={terms} publicOrgs onTerms={onTerms} onPublicOrgs={jest.fn()} onClose={onClose} />,
    );
    return { onTerms, onClose };
}

describe('AllowTermsSheet', () => {
    it('adds a typed term when the sheet is closed', async () => {
        const { onTerms, onClose } = await draw(['Shell']);
        await fireEvent.changeText(screen.getByTestId('allow-input'), 'PostNL');
        await fireEvent.press(screen.getByText('Close'));
        expect(onTerms).toHaveBeenLastCalledWith(['Shell', 'PostNL']);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes without a change when nothing is typed, or when the term is refused', async () => {
        const { onTerms, onClose } = await draw(['Shell']);
        await fireEvent.press(screen.getByText('Close'));
        await fireEvent.changeText(screen.getByTestId('allow-input'), 'shell');
        await fireEvent.press(screen.getByText('Close'));
        expect(onTerms).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
