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

// expo-audio binds its native players and recorders at import, so any test
// that loads a screen importing it (global search reads the meeting-note list
// through the recording feature) would fail to load. Inert by default; a test
// that drives the recorder mocks it itself.
jest.mock('expo-audio', () => ({
    __esModule: true,
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    getRecordingPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
    requestRecordingPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
    setAudioModeAsync: jest.fn(async () => {}),
    useAudioRecorder: jest.fn(() => ({})),
    useAudioRecorderState: jest.fn(() => ({ isRecording: false, durationMillis: 0 })),
    useAudioPlayer: jest.fn(() => ({})),
    useAudioPlayerStatus: jest.fn(() => ({ playing: false, currentTime: 0, duration: 0 })),
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

// The flow editor's canvas is the app's first direct user of Reanimated and of
// Gesture Handler's Gesture API (everything before it reached them only
// through expo-router). Both need their documented jest setup to load at all:
// Reanimated 4 runs on react-native-worklets, whose native module does not
// exist here — its own mock stands in, running worklets on the JS thread —
// and Gesture Handler ships jestSetup.js for its native module and buttons.
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
require('react-native-gesture-handler/jestSetup');

// react-native-webview is a native view with no JS fallback. The page
// screen's preview renders one; in tests it is a plain View carrying the same
// props, so a test can read what it would load (`source.html`) and how it is
// fenced in (`originWhitelist`, `onShouldStartLoadWithRequest`).
jest.mock('react-native-webview', () => {
    const React = require('react');
    const { View } = require('react-native');
    const WebView = React.forwardRef(function MockWebView(props, ref) {
        return React.createElement(View, { testID: 'webview', ...props, ref });
    });
    return { __esModule: true, WebView, default: WebView };
});
