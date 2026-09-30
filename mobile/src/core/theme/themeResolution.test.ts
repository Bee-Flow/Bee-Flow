/**
 * Which theme wins.
 *
 * Every case here is a real report, not a spec check. The app shipped following
 * Android's light/dark switch while the web followed the account, so one person
 * on one account met a white web app and a black phone app at the same moment.
 * The order below is the fix; these tests are what stop it drifting back.
 */

import { resolveActiveTheme, serverPresetTheme, storedPreference } from './resolve';

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
            resolveActiveTheme({ preference: 'light', serverPreset: 'dark', device: 'dark' }),
        ).toBe('light');
        expect(
            resolveActiveTheme({ preference: 'dark', serverPreset: null, device: 'light' }),
        ).toBe('dark');
    });

    it('falls back to the device only when it knows nothing at all', () => {
        expect(
            resolveActiveTheme({ preference: null, serverPreset: null, device: 'light' }),
        ).toBe('light');
        expect(
            resolveActiveTheme({ preference: null, serverPreset: null, device: 'dark' }),
        ).toBe('dark');
    });

    it('paints any other web theme as Day or Night, never as itself', () => {
        // The phone offers Day and Night only; an org admin can still pin
        // `paper` on the web. It lands on its family rather than on a third look.
        expect(
            resolveActiveTheme({ preference: null, serverPreset: serverPresetTheme('paper'), device: 'dark' }),
        ).toBe('light');
        expect(
            resolveActiveTheme({ preference: null, serverPreset: serverPresetTheme('obsidian'), device: 'light' }),
        ).toBe('dark');
    });
});

describe('server presets', () => {
    it("paints 'custom' dark, as the web does", () => {
        // 'custom' has no block in index.css, so the web paints :root — the
        // dark palette — with the org's accent. The phone used to ignore it
        // and follow Android's switch, so a custom-branded org was light on
        // half its phones.
        expect(serverPresetTheme('custom')).toBe('dark');
        expect(
            resolveActiveTheme({ preference: null, serverPreset: serverPresetTheme('custom'), device: 'light' }),
        ).toBe('dark');
    });

    it('maps every web theme to its family and ignores an unknown one, prototype names included', () => {
        expect(serverPresetTheme('light')).toBe('light');
        expect(serverPresetTheme('dark')).toBe('dark');
        expect(serverPresetTheme('glass')).toBe('light');
        expect(serverPresetTheme('glass-dark')).toBe('dark');
        expect(serverPresetTheme('sepia')).toBe('light');
        expect(serverPresetTheme('paper')).toBe('light');
        expect(serverPresetTheme('obsidian')).toBe('dark');
        expect(serverPresetTheme('high-contrast')).toBe('dark');
        expect(serverPresetTheme('drak')).toBeNull();
        expect(serverPresetTheme('toString')).toBeNull();
    });
});

/**
 * The picker used to offer eight themes; it offers Day and Night now. A phone
 * that stored one of the other six must start, paint the family it chose
 * from, and stop carrying the old name.
 */
describe('a stored theme the picker no longer offers', () => {
    it('keeps Day, Night and "match my phone" as they are', () => {
        expect(storedPreference('light')).toEqual({ preference: 'light', rewrite: false });
        expect(storedPreference('dark')).toEqual({ preference: 'dark', rewrite: false });
        expect(storedPreference('system')).toEqual({ preference: 'system', rewrite: false });
    });

    it('rewrites a dark-ink theme to Night', () => {
        for (const name of ['obsidian', 'high-contrast', 'glass-dark']) {
            expect(storedPreference(name)).toEqual({ preference: 'dark', rewrite: true });
        }
    });

    it('rewrites a light theme to Day', () => {
        for (const name of ['paper', 'sepia', 'glass']) {
            expect(storedPreference(name)).toEqual({ preference: 'light', rewrite: true });
        }
    });

    it('drops a name that is no theme, so the account and then the phone decide', () => {
        expect(storedPreference('constructor')).toEqual({ preference: null, rewrite: false });
        expect(storedPreference('neon')).toEqual({ preference: null, rewrite: false });
        expect(storedPreference(null)).toEqual({ preference: null, rewrite: false });
        const { preference } = storedPreference('neon');
        expect(resolveActiveTheme({ preference, serverPreset: null, device: 'light' })).toBe('light');
    });
});
