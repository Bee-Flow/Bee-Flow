import { screen, userEvent } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { LocalDraftBanner } from './LocalDraftBanner';

const draft = { definition: { trigger: null, steps: [], edges: [] } as never, baseVersion: 2, savedAt: 1 };

async function show(conflict: typeof draft | null, resolve = jest.fn()) {
    await renderWithProviders(<LocalDraftBanner local={{ conflict, resolve }} />);
    return resolve;
}

describe('LocalDraftBanner', () => {
    it('draws nothing without a conflict', async () => {
        await show(null);
        expect(screen.queryByTestId('local-draft-banner')).toBeNull();
    });

    it('keeps or discards the phone copy as tapped', async () => {
        const user = userEvent.setup();
        const resolve = await show(draft);
        await user.press(screen.getByTestId('local-draft-keep'));
        expect(resolve).toHaveBeenCalledWith(true);
        await user.press(screen.getByTestId('local-draft-discard'));
        expect(resolve).toHaveBeenCalledWith(false);
    });
});
