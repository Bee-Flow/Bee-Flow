import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import ThemeContext from '../../components/appearance/ThemeContext';
import AppearanceSection from './AppearanceSection';

/**
 * Settings → Appearance. Pinned: the page title is the same h2 every settings
 * page uses, in both the open and the locked state, and a preset pick goes to
 * the user override.
 */

function renderWith(theme: Record<string, unknown>) {
    return render(
        <ThemeContext.Provider value={theme as never}>
            <AppearanceSection />
        </ThemeContext.Provider>,
    );
}

describe('AppearanceSection', () => {
    it('names the page with an h2 and offers the theme presets', async () => {
        const setUserOverride = vi.fn().mockResolvedValue(undefined);
        renderWith({ allowUserOverride: true, preset: 'dark', setUserOverride });

        expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
        expect(screen.getByText('Customise how Bee Flow looks on this device. Only you see your choice.')).toBeInTheDocument();

        await userEvent.setup().click(screen.getByRole('button', { name: /Light/ }));
        expect(setUserOverride).toHaveBeenCalledWith({ preset: 'light' });
    });

    it('keeps the same title when the organisation locked the appearance', () => {
        renderWith({ allowUserOverride: false, preset: 'paper' });

        expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
        expect(screen.getByText('Paper')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Light/ })).toBeNull();
    });
});
