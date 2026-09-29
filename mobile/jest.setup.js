/**
 * Jest environment for the mobile package.
 *
 * The mocks here are for native modules that have no JS fallback — calling
 * them in a test would throw "native module not found" rather than fail an
 * assertion, which turns a real failure into a confusing one.
 */

// @testing-library/react-native v13+ registers its matchers on import, so
// there is no separate extend-expect entry point to require any more.

// AsyncStorage is a native module with no JS fallback; the package ships an
// in-memory mock for exactly this.
jest.mock('@react-native-async-storage/async-storage', () =>
    require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// SecureStore is Android Keystore-backed; in tests it is an in-memory map so
// session/keychain code can be exercised end to end.
jest.mock('expo-secure-store', () => {
    const store = new Map();
    return {
        __esModule: true,
        setItemAsync: jest.fn(async (k, v) => void store.set(k, v)),
        getItemAsync: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
        deleteItemAsync: jest.fn(async (k) => void store.delete(k)),
        isAvailableAsync: jest.fn(async () => true),
        WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
        __store: store,
    };
});

jest.mock('expo-local-authentication', () => ({
    __esModule: true,
    hasHardwareAsync: jest.fn(async () => true),
    isEnrolledAsync: jest.fn(async () => true),
    supportedAuthenticationTypesAsync: jest.fn(async () => [1, 2]),
    authenticateAsync: jest.fn(async () => ({ success: true })),
    AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
}));

jest.mock('expo-haptics', () => ({
    __esModule: true,
    impactAsync: jest.fn(async () => {}),
    notificationAsync: jest.fn(async () => {}),
    selectionAsync: jest.fn(async () => {}),
    ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
    NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

// expo-crypto's getRandomValues is the entropy source for the OPAQUE/DEK code.
// Tests need it to be deterministic-capable but real by default.
jest.mock('expo-crypto', () => {
    const nodeCrypto = require('node:crypto');
    return {
        __esModule: true,
        getRandomValues: (arr) => {
            nodeCrypto.randomFillSync(arr);
            return arr;
        },
        randomUUID: () => nodeCrypto.randomUUID(),
    };
});

jest.mock('expo-localization', () => ({
    __esModule: true,
    getLocales: () => [{ languageCode: 'en', languageTag: 'en-GB', regionCode: 'GB' }],
    getCalendars: () => [{ timeZone: 'Europe/Amsterdam' }],
}));

jest.mock('expo-constants', () => ({
    __esModule: true,
    default: {
        expoConfig: { extra: { defaultServerUrl: '', buildProfile: 'test', commitSha: 'test' } },
    },
}));

jest.mock('@react-native-community/netinfo', () => ({
    __esModule: true,
    default: {
        addEventListener: jest.fn(() => jest.fn()),
        fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
    },
    addEventListener: jest.fn(() => jest.fn()),
    fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })),
}));

// Silence the Reanimated startup warning; the layout animations themselves are
// not what these tests assert on.
global.__reanimatedWorkletInit = () => {};
