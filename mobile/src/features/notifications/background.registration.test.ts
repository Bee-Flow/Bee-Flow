/**
 * Registering the background poll, apart from asking for the permission.
 *
 * It used to ask right after sign-in, with nothing on screen saying why, and
 * again on every launch after a refusal. Now registering never shows the
 * dialog (the poll skips on its own without the permission), it fails only
 * when the OS refuses background work, and allowing notifications later
 * starts quietly: what is unread then is not announced as new.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';

import { listNotifications } from './api/endpoints';
import { pollForNewNotifications, registerNotificationPolling, startAnnouncing } from './background';
import type { AppNotification } from './model/types';

jest.mock('expo-notifications', () => ({
    getPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, canAskAgain: true })),
    requestPermissionsAsync: jest.fn(),
    setNotificationChannelAsync: jest.fn(async () => null),
    scheduleNotificationAsync: jest.fn(async () => 'id'),
    AndroidImportance: { DEFAULT: 3, LOW: 2 },
    AndroidNotificationVisibility: { PRIVATE: 0 },
}));
jest.mock('expo-background-task', () => ({
    BackgroundTaskResult: { Success: 1 },
    BackgroundTaskStatus: { Restricted: 1, Available: 2 },
    getStatusAsync: jest.fn(async () => 2),
    registerTaskAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn(), isTaskRegisteredAsync: jest.fn(async () => false) }));
jest.mock('@/core/api/server', () => ({ loadServerUrl: jest.fn(async () => 'https://bee.example') }));
jest.mock('./api/endpoints', () => ({ listNotifications: jest.fn(async () => []) }));

const note = (id: string): AppNotification => ({
    id,
    task_id: null,
    category: 'urgent',
    title: `Note ${id}`,
    message: 'Something happened',
    link: null,
    read: false,
    created_at: '2026-09-27T09:00:00Z',
});

beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
});

describe('registerNotificationPolling', () => {
    it('registers the poll without ever showing the permission dialog, granted or not', async () => {
        jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true } as never);
        await expect(registerNotificationPolling()).resolves.toBe(true);
        expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledTimes(1);
    });

    it('fails only when the OS refuses background work', async () => {
        jest.mocked(BackgroundTask.getStatusAsync).mockResolvedValueOnce(1 as never);
        await expect(registerNotificationPolling()).resolves.toBe(false);
        expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
        expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('catches up silently when the permission is granted outside the app before any poll ran without it', async () => {
        // Signed in without the permission: registered, backlog empty.
        jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'denied', granted: false, canAskAgain: true } as never);
        await registerNotificationPolling();
        // Allowed in Android's App info while items arrived; the first poll runs with it.
        jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true } as never);
        jest.mocked(listNotifications).mockResolvedValue([note('a1'), note('a2'), note('a3')]);
        await pollForNewNotifications();
        expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
        // What comes after that is announced.
        jest.mocked(listNotifications).mockResolvedValue([note('b1'), note('a1'), note('a2'), note('a3')]);
        await pollForNewNotifications();
        expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    });

    it('leaves an already registered poll as it is', async () => {
        jest.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValueOnce(true);
        await expect(registerNotificationPolling()).resolves.toBe(true);
        expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
    });
});

describe('startAnnouncing', () => {
    it('keeps what was unread before notifications were allowed quiet, and announces what comes after', async () => {
        jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ status: 'granted', granted: true, canAskAgain: true } as never);
        // Registered while the phone could not notify; the backlog grew meanwhile.
        jest.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValue(true);
        jest.mocked(listNotifications).mockResolvedValue([note('old1'), note('old2')]);

        await expect(startAnnouncing()).resolves.toBe(true);
        await pollForNewNotifications();
        expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();

        jest.mocked(listNotifications).mockResolvedValue([note('new1'), note('old1'), note('old2')]);
        await pollForNewNotifications();
        expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
        expect(jest.mocked(Notifications.scheduleNotificationAsync).mock.calls[0]?.[0]).toMatchObject({ content: { title: 'Note new1' } });
    });
});
