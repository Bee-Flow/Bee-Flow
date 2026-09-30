/**
 * useThemedStyles is the documented way to write themed styles, so its two
 * promises are pinned: the sheet is built from the current theme, and it is
 * rebuilt when — and only when — the theme changes.
 */

import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { perTheme, ThemeProvider, useTheme, useThemedStyles, type Theme } from './ThemeProvider';

const makeStyles = (theme: Theme) => ({
    card: { backgroundColor: theme.colors.bgCard, padding: theme.spacing.lg },
});

function wrapper({ children }: { children: ReactNode }) {
    return <ThemeProvider>{children}</ThemeProvider>;
}

async function setup() {
    const factory = jest.fn(makeStyles);
    const hook = await renderHook(
        () => ({ styles: useThemedStyles(factory), theme: useTheme() }),
        { wrapper },
    );
    return { ...hook, factory };
}

describe('useThemedStyles', () => {
    it('builds the styles from the current theme', async () => {
        const { result } = await setup();
        const { styles, theme } = result.current;
        expect(styles.card).toEqual({ backgroundColor: theme.colors.bgCard, padding: theme.spacing.lg });
    });

    it('keeps the same object across renders of the same theme', async () => {
        const { result, rerender, factory } = await setup();
        const first = result.current.styles;
        const calls = factory.mock.calls.length;
        await rerender(undefined);
        expect(result.current.styles).toBe(first);
        expect(factory.mock.calls.length).toBe(calls);
    });

    it('rebuilds when the theme changes', async () => {
        const { result } = await setup();
        const before = result.current.styles;
        const target = result.current.theme.name === 'light' ? 'dark' : 'light';
        await act(async () => result.current.theme.setPreference(target));
        expect(result.current.theme.name).toBe(target);
        expect(result.current.styles).not.toBe(before);
        expect(result.current.styles.card.backgroundColor).toBe(result.current.theme.colors.bgCard);
    });
});

describe('perTheme', () => {
    it('builds a sheet once per theme, however many components ask for it', async () => {
        const seen = new Set<Theme>();
        const factory = jest.fn((theme: Theme) => {
            seen.add(theme);
            return makeStyles(theme);
        });
        const shared = perTheme(factory);
        const { result } = await renderHook(
            () => ({ a: useThemedStyles(shared), b: useThemedStyles(shared), c: useThemedStyles(shared), theme: useTheme() }),
            { wrapper },
        );
        expect(result.current.a).toBe(result.current.b);
        expect(result.current.b).toBe(result.current.c);
        expect(factory).toHaveBeenCalledTimes(seen.size);
        const target = result.current.theme.name === 'light' ? 'dark' : 'light';
        await act(async () => result.current.theme.setPreference(target));
        expect(result.current.a).toBe(result.current.c);
        expect(result.current.a.card.backgroundColor).toBe(result.current.theme.colors.bgCard);
        expect(factory).toHaveBeenCalledTimes(seen.size);
    });
});
