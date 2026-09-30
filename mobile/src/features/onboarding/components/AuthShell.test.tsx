/**
 * The signed-out frame, rendered for real.
 *
 * Two things this catches that nothing else does. The backdrop draws in
 * react-native-svg and animates through RN's Animated — neither of which the
 * type checker or the linter can tell you mounts, and the login screen is the
 * one screen where a crash means nobody can use the app at all. And the mark
 * at the head of the card: the login screen showed a generic glyph on a flat
 * background for long enough to be reported as a bug, so "the logo is what you
 * get unless a screen asks for something else" is written down here.
 */

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { Text as RNText } from 'react-native';

import { ThemeProvider } from '@/core/theme/ThemeProvider';

import { AuthShell } from './AuthShell';

// `render` is ASYNC in @testing-library/react-native 14 — it returns a promise
// and the queries only exist once it resolves. Forgetting the await produces
// "`render` function has not been called", which reads like a setup problem
// and is not one.
async function renderShell(ui: React.ReactElement): Promise<void> {
    await render(<ThemeProvider>{ui}</ThemeProvider>);
}

// The first render mounts react-native-svg and Animated from cold; jest's
// 5-second default was a coin flip under full-suite load.
jest.setTimeout(30_000);

describe('AuthShell', () => {
    it('mounts the whole frame, backdrop included', async () => {
        await renderShell(
            <AuthShell title="Sign in to Bee Flow" subtitle="beeflow.nl">
                <RNText>the form</RNText>
            </AuthShell>,
        );
        expect(screen.getByText('Sign in to Bee Flow')).toBeTruthy();
        expect(screen.getByText('beeflow.nl')).toBeTruthy();
        expect(screen.getByText('the form')).toBeTruthy();
    });

    it('leads with the Bee Flow mark by default', async () => {
        await renderShell(
            <AuthShell title="Sign in">
                <RNText>the form</RNText>
            </AuthShell>,
        );
        expect(screen.getByTestId('auth-shell-logo')).toBeTruthy();
        expect(screen.queryByTestId('auth-shell-icon')).toBeNull();
    });

    it('gives way to a glyph when the screen has something specific to say', async () => {
        await renderShell(
            <AuthShell icon="TriangleAlert" tone="error" title="That connection is not encrypted">
                <RNText>the warning</RNText>
            </AuthShell>,
        );
        expect(screen.getByTestId('auth-shell-icon')).toBeTruthy();
        expect(screen.queryByTestId('auth-shell-logo')).toBeNull();
    });

    it('announces the title as the screen’s heading', async () => {
        await renderShell(
            <AuthShell title="Two-factor code">
                <RNText>the code field</RNText>
            </AuthShell>,
        );
        expect(screen.getByRole('header', { name: 'Two-factor code' })).toBeTruthy();
    });
});
