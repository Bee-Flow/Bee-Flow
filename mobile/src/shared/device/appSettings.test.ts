/**
 * The way back from a permission Android will no longer ask for: when that
 * point is reached, the settings page that resolves only once the person is
 * back in the app, and the re-read on every return to the front.
 */

import { act, renderHook } from '@testing-library/react-native';
import { Linking } from 'react-native';

import { appStateEmitter } from '@/shared/testing/appState';

import { deniedForGood, openAppSettings, useOnForeground } from './appSettings';

const appState = appStateEmitter();
const { emit, listeners } = appState;

beforeEach(() => appState.install());

describe('deniedForGood', () => {
    it.each([
        [{ granted: true, canAskAgain: false }, false],
        [{ granted: false, canAskAgain: true }, false],
        [{ granted: false, canAskAgain: false }, true],
    ])('%j → %s', (permission, blocked) => {
        expect(deniedForGood(permission)).toBe(blocked);
    });
});

describe('openAppSettings', () => {
    it('opens the settings page and resolves only once the app is back in front', async () => {
        let back = false;
        const done = openAppSettings().then(() => {
            back = true;
        });
        await act(async () => undefined);
        expect(Linking.openSettings).toHaveBeenCalledTimes(1);

        await emit('active'); // never left yet: not a return
        await emit('background');
        await act(async () => undefined);
        expect(back).toBe(false);

        await emit('active');
        await done;
        expect(back).toBe(true);
        expect(listeners.size).toBe(0);
    });

    it('resolves at once when the page cannot be opened', async () => {
        jest.mocked(Linking.openSettings).mockRejectedValue(new Error('no settings app'));
        await openAppSettings();
        expect(listeners.size).toBe(0);
    });
});

describe('useOnForeground', () => {
    it('re-reads each time the app comes back to the front, and stops on unmount', async () => {
        const onActive = jest.fn();
        const { unmount } = await renderHook(() => useOnForeground(onActive));
        await emit('background');
        expect(onActive).not.toHaveBeenCalled();
        await emit('active');
        await emit('background');
        await emit('active');
        expect(onActive).toHaveBeenCalledTimes(2);
        await unmount();
        await emit('active');
        expect(onActive).toHaveBeenCalledTimes(2);
    });

    it('does not listen while disabled', async () => {
        const onActive = jest.fn();
        await renderHook(() => useOnForeground(onActive, false));
        await emit('active');
        expect(onActive).not.toHaveBeenCalled();
    });
});
