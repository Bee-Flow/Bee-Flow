/**
 * Which theme wins.
 *
 * Every case here is a real report, not a spec check. The app shipped following
 * Android's light/dark switch while the web followed the account, so one person
 * on one account met a white web app and a black phone app at the same moment.
 * The order below is the fix; these tests are what stop it drifting back.
 */

import { resolveActiveTheme } from './ThemeProvider';

describe('resolveActiveTheme', () => {
    it('follows the account when nobody has chosen on this device', () => {
        // THE BUG. Account says light, phone is in dark mode, nothing stored.
        // This returned 'dark' and produced the two screenshots.
        expect(
            resolveActiveTheme({ preference: null, serverPreset: 'light', device: 'dark' }),
        ).toBe('light');
    });

    it('still follows the account when the device is light and the account is dark', () => {
        // The same bug in the other direction — it is a precedence error, not a
        // light-specific one.
        expect(
            resolveActiveTheme({ preference: null, serverPreset: 'dark', device: 'light' }),
        ).toBe('dark');
    });

    it('lets an explicit "match my phone" beat the account', () => {
        // 'system' has no server representation, so if the account could
        // override it the setting would be a button that does nothing.
        expect(
            resolveActiveTheme({ preference: 'system', serverPreset: 'light', device: 'dark' }),
        ).toBe('dark');
        expect(
            resolveActiveTheme({ preference: 'system', serverPreset: 'dark', device: 'light' }),
        ).toBe('light');
    });

    it('lets a choice made on this phone outrank the account', () => {
        // The Appearance screen tells a user whose admin pinned the org theme
        // that "your choice stays on this phone". If the account overrode it on
        // the next cold start, that sentence would be a lie.
        expect(
            resolveActiveTheme({ preference: 'paper', serverPreset: 'sepia', device: 'dark' }),
        ).toBe('paper');
        expect(
            resolveActiveTheme({ preference: 'paper', serverPreset: null, device: 'dark' }),
        ).toBe('paper');
    });

    it('falls back to the device only when it knows nothing at all', () => {
        expect(
            resolveActiveTheme({ preference: null, serverPreset: null, device: 'light' }),
        ).toBe('light');
        expect(
            resolveActiveTheme({ preference: null, serverPreset: null, device: 'dark' }),
        ).toBe('dark');
    });

    it('collapses the two glass presets, which this client has no palette for', () => {
        // The server's vocabulary is wider than the phone's. An unmapped preset
        // must land on a real palette rather than crash or paint nothing.
        expect(
            resolveActiveTheme({ preference: 'glass', serverPreset: null, device: 'dark' }),
        ).toBe('light');
        expect(
            resolveActiveTheme({ preference: 'glass-dark', serverPreset: null, device: 'light' }),
        ).toBe('dark');
    });
});
