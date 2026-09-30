/**
 * The module mocks a screen test needs, as factories — so a test writes
 *
 *   jest.mock('expo-router', () => require('@/shared/testing/screenMocks').expoRouter(() => mockPush));
 *   jest.mock('@/core/api/client', () => require('@/shared/testing/screenMocks').apiClient());
 *
 * instead of copying the same object literals into every file. Test-only.
 */

import { act } from '@testing-library/react-native';

/** expo-router with a router whose push the test can read (passed lazily: the factory runs before the test's own consts). */
export function expoRouter(push: () => jest.Mock = () => jest.fn()) {
    return {
        useRouter: () => ({
            push: push(),
            replace: jest.fn(),
            back: jest.fn(),
            navigate: jest.fn(),
            dismissTo: jest.fn(),
            canDismiss: () => false,
        }),
        useLocalSearchParams: () => ({}),
        Stack: { Screen: () => null },
    };
}

/** core/api/client with every verb a mock and everything else real (ApiError, the types). */
export function apiClient() {
    return {
        ...jest.requireActual('@/core/api/client'),
        api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
    };
}

/** The run stream, open and silent for as long as the test lasts. */
export function silentSse() {
    return { streamSse: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };
}

/**
 * expo-router for a screen that also reads its navigation: always focused, a
 * leave listener that is never called. The router is the test's own object,
 * passed lazily like `push` above.
 */
export function focusedRouter(router: () => unknown) {
    return {
        useRouter: () => router(),
        useNavigation: () => ({ isFocused: () => true, addListener: () => () => undefined, dispatch: jest.fn() }),
        useFocusEffect: jest.fn(),
    };
}

/** core/access/api answering nothing, so every gate falls back to what the session alone allows. */
export function noAccess() {
    return { fetchEntitlements: jest.fn(async () => null), fetchLicenseInfo: jest.fn(async () => null) };
}

/**
 * The screen's leave listener (useLeaveGuard's `beforeRemove`), held where a
 * test can play Back against it: `listener` is null while nothing is dirty,
 * and `dispatch` hears a removal the guard let through.
 */
export interface HeldLeave {
    listener: ((event: { preventDefault: () => void; data: { action: unknown } }) => void) | null;
    dispatch: jest.Mock;
}

/** `useNavigation` for expo-router's mock, keeping the leave listener in `held()` (passed lazily, like `push`). */
export function leaveNavigation(held: () => HeldLeave) {
    return () => ({
        isFocused: () => true,
        addListener: (_name: string, fn: HeldLeave['listener']) => {
            held().listener = fn;
            return () => {
                if (held().listener === fn) held().listener = null;
            };
        },
        dispatch: (action: unknown) => held().dispatch(action),
    });
}

/** Plays Back: returns the event, so a test can see whether the guard held it. */
export async function pressBack(held: HeldLeave) {
    const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
    await act(async () => held.listener?.(event));
    return event;
}
