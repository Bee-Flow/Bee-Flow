/**
 * The notification permission, asked only where it is explained: read on
 * mount and again on every return to the front, the system dialog while
 * Android still shows it, Android's settings only once it will not, and a
 * grant that starts the announcing quietly.
 */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { Linking } from 'react-native';

import { appStateEmitter } from '@/shared/testing/appState';

import { useAlertPermission } from './useAlertPermission';
import { registerNotificationPolling, startAnnouncing } from '../background';

jest.mock('expo-notifications', () => ({
    getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(),
}));
jest.mock('../background', () => ({
    registerNotificationPolling: jest.fn(async () => true),
    startAnnouncing: jest.fn(async () => true),
}));

const NEVER_ASKED = { status: 'undetermined', granted: false, canAskAgain: true };
const REFUSED_ONCE = { status: 'denied', granted: false, canAskAgain: true };
const REFUSED_FOR_GOOD = { status: 'denied', granted: false, canAskAgain: false };
const GRANTED = { status: 'granted', granted: true, canAskAgain: true };

const appState = appStateEmitter();
const answers = (...seq: object[]) => {
    const mock = jest.mocked(Notifications.getPermissionsAsync);
    mock.mockReset();
    for (const answer of seq) mock.mockResolvedValueOnce(answer as never);
    mock.mockResolvedValue(seq[seq.length - 1] as never);
};

beforeEach(() => {
    jest.clearAllMocks();
    appState.install();
});

async function mount() {
    const { result } = await renderHook(() => useAlertPermission());
    await waitFor(() => expect(result.current.permission.unknown).toBe(false));
    return result;
}

it('reads the permission without asking, and again when the app comes back to the front', async () => {
    answers(REFUSED_FOR_GOOD, GRANTED);
    const result = await mount();
    expect(result.current.blocked).toBe(true);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    await appState.roundTrip();
    await waitFor(() => expect(result.current.permission.granted).toBe(true));
    expect(result.current.blocked).toBe(false);
});

it('shows the system dialog while Android still will, and never opens settings after a first refusal', async () => {
    answers(NEVER_ASKED);
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue(REFUSED_ONCE as never);
    const result = await mount();
    let outcome: Awaited<ReturnType<typeof result.current.allow>> | null = null;
    await act(async () => {
        outcome = await result.current.allow();
    });
    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(Linking.openSettings).not.toHaveBeenCalled();
    expect(outcome).toEqual({ permission: { granted: false, canAskAgain: true, unknown: false }, polling: null });
    expect(result.current.blocked).toBe(false);
    expect(startAnnouncing).not.toHaveBeenCalled();
});

it('starts announcing quietly once granted', async () => {
    answers(NEVER_ASKED);
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue(GRANTED as never);
    const result = await mount();
    let outcome: Awaited<ReturnType<typeof result.current.allow>> | null = null;
    await act(async () => {
        outcome = await result.current.allow();
    });
    expect(startAnnouncing).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ permission: { granted: true }, polling: true });
});

it('opens Android settings once Android will not ask, and reads the answer on return', async () => {
    answers(REFUSED_FOR_GOOD, REFUSED_FOR_GOOD, GRANTED);
    const result = await mount();
    let allowing: Promise<unknown> = Promise.resolve();
    await act(async () => {
        allowing = result.current.allow();
    });
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();

    await appState.roundTrip();
    await act(() => allowing);
    expect(result.current.permission.granted).toBe(true);
    expect(startAnnouncing).toHaveBeenCalledTimes(1);
});

it('only re-registers the poll when the permission was already there', async () => {
    answers(GRANTED);
    const result = await mount();
    await act(async () => {
        await result.current.allow();
    });
    expect(registerNotificationPolling).toHaveBeenCalledTimes(1);
    expect(startAnnouncing).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});
