/**
 * AppState, live, for a test that plays the app leaving for Android's
 * settings and coming back. The React Native jest preset mocks AppState with
 * listeners that never fire; `install()` (in a beforeEach) keeps them, and
 * `emit` plays a change to every one not removed. Test-only.
 */

import { act } from '@testing-library/react-native';
import { AppState, Linking, type AppStateStatus } from 'react-native';

export function appStateEmitter() {
    const listeners = new Set<(state: AppStateStatus) => void>();
    const emit = (state: AppStateStatus) => act(() => listeners.forEach((fn) => fn(state)));
    return {
        listeners,
        /** Keeps AppState's listeners, and makes Linking.openSettings resolve as it does on a phone. */
        install() {
            listeners.clear();
            jest.mocked(AppState.addEventListener).mockImplementation((_type, fn) => {
                const listener = fn as (state: AppStateStatus) => void;
                listeners.add(listener);
                return { remove: () => listeners.delete(listener) } as never;
            });
            jest.mocked(Linking.openSettings).mockReset().mockResolvedValue(undefined);
        },
        emit,
        /** Away (to Android's settings) and back to the front. */
        async roundTrip() {
            await emit('background');
            await emit('active');
        },
    };
}
