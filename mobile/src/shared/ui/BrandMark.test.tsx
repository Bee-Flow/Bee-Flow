import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { BrandMark, brandMarkSource } from './BrandMark';

jest.setTimeout(30_000);

describe('BrandMark', () => {
    it('has a different ink for a dark and a light theme', () => {
        // One file for both would be a white bee on Day or a dark one on Night.
        expect(brandMarkSource(true)).not.toEqual(brandMarkSource(false));
    });

    it('names itself unless a title beside it already does', async () => {
        await renderWithProviders(<BrandMark />);
        expect(screen.getByLabelText('Bee Flow')).toBeTruthy();
    });
});
