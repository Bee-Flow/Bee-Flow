import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import screenThemeEntry, { nextScreenTheme } from './screenTheme';
import designTokensEntry, { parseTokenValue } from './designTokens';
import type { AppDefinition } from '../appDefinition';

const start = (): AppDefinition => ({
    theme: { primary: '#0F766E' },
    screens: [{ id: 'scr_one', name: 'One', sections: [] }],
} as unknown as AppDefinition);

function Panel({ which }: { which: 'screen' | 'tokens' }) {
    const [def, setDef] = useState(start());
    const { Section } = which === 'screen' ? screenThemeEntry : designTokensEntry;
    return (
        <div>
            <Section definition={def} onCommit={setDef} disabled={false} screenId="scr_one" />
            <pre data-testid="out">{JSON.stringify(which === 'screen' ? def.screens?.[0]?.theme ?? null : def.design ?? null)}</pre>
        </div>
    );
}

const out = () => JSON.parse(screen.getByTestId('out').textContent || 'null');

describe('theme scope sections', () => {
    it('sets and clears one key of the screen theme', async () => {
        const user = userEvent.setup();
        render(<Panel which="screen" />);
        await user.selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), 'dark');
        expect(out()).toEqual({ appearance: 'dark' });
        await user.selectOptions(screen.getByRole('combobox', { name: 'Appearance' }), '');
        expect(out()).toBeNull();
        expect(nextScreenTheme({ density: 'compact' }, 'density', '')).toBeUndefined();
    });

    it('adds a colour token and sets the pixel radius', async () => {
        const user = userEvent.setup();
        render(<Panel which="tokens" />);
        await user.type(screen.getByPlaceholderText('brand-soft'), 'brand-soft');
        await user.type(screen.getByPlaceholderText('#e0f2fe'), '#e0f2fe');
        await user.click(screen.getByRole('button', { name: 'Add token' }));
        expect(out()).toMatchObject({ tokens: { 'brand-soft': '#e0f2fe' }, preset: 'custom' });
        await user.type(screen.getByRole('spinbutton'), '6');
        expect(out()).toMatchObject({ radiusPx: 6 });
        expect(parseTokenValue('24')).toBe(24);
        expect(parseTokenValue('red')).toBeNull();
    });
});
