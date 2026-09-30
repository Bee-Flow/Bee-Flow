/**
 * What the background poll puts on the lock screen.
 *
 * Two things it got wrong: a routine whose credentials lapsed announced
 * itself as "routinereauth:google Your Google access has expired…" (the token
 * went through the markdown stripper, which ate its underscore, before it was
 * split off), and the summary after the first three was always English —
 * "2 more updates waiting." — because a headless launch never loads the
 * catalogue.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

import { _reset, setCatalogue } from '@/core/i18n';

import { listNotifications } from './api/endpoints';
import { pollForNewNotifications, startAnnouncing } from './background';
import type { AppNotification } from './model/types';

jest.mock('expo-notifications', () => ({
    getPermissionsAsync: jest.fn(async () => ({ granted: true })),
    setNotificationChannelAsync: jest.fn(async () => null),
    scheduleNotificationAsync: jest.fn(async () => 'id'),
    AndroidImportance: { DEFAULT: 3, LOW: 2 },
    AndroidNotificationVisibility: { PRIVATE: 0 },
}));
jest.mock('expo-background-task', () => ({
    BackgroundTaskResult: { Success: 1 },
    BackgroundTaskStatus: { Available: 2 },
    getStatusAsync: jest.fn(async () => 2),
    registerTaskAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-task-manager', () => ({ defineTask: jest.fn(), isTaskRegisteredAsync: jest.fn(async () => true) }));
jest.mock('@/core/api/server', () => ({ loadServerUrl: jest.fn(async () => 'https://bee.example') }));
jest.mock('./api/endpoints', () => ({ listNotifications: jest.fn() }));

const note = (id: string, message: string): AppNotification => ({
    id,
    task_id: null,
    category: 'urgent',
    title: 'Reconnect Google',
    message,
    link: null,
    read: false,
    created_at: '2026-09-27T09:00:00Z',
});

const scheduled = () =>
    (Notifications.scheduleNotificationAsync as jest.Mock).mock.calls.map(
        ([request]) => (request as { content: { body: string } }).content.body,
    );

beforeEach(async () => {
    jest.clearAllMocks();
    _reset();
    await AsyncStorage.clear();
});

describe('pollForNewNotifications', () => {
    it('never puts the reauth token on the lock screen', async () => {
        (listNotifications as jest.Mock).mockResolvedValue([
            note('n1', 'routine_reauth:google\n\nYour Google access has expired or been revoked.'),
        ]);
        await pollForNewNotifications();
        expect(scheduled()).toEqual(['Your Google access has expired or been revoked.']);
    });

    it('says the summary in the language the app last rendered, even in a headless launch', async () => {
        setCatalogue('nl', {
            'mobile.notifications.more_waiting': 'Nog {count} update.',
            'mobile.notifications.more_waiting_plural': 'Nog {count} updates.',
        });
        await new Promise((resolve) => setImmediate(resolve));
        _reset(); // a headless launch: nothing in memory, the cache on disk
        (listNotifications as jest.Mock).mockResolvedValue(
            ['a', 'b', 'c', 'd', 'e'].map((id) => note(id, `Message ${id}`)),
        );
        await pollForNewNotifications();
        expect(scheduled()).toEqual(['Message a', 'Message b', 'Message c', 'Nog 2 updates.']);
    });

    it('says one more update in the singular', async () => {
        (listNotifications as jest.Mock).mockResolvedValue(['a', 'b', 'c', 'd'].map((id) => note(id, `Message ${id}`)));
        await pollForNewNotifications();
        expect(scheduled()[3]).toBe('1 more update waiting.');
    });
});

/**
 * Polling is registered at sign-in without the permission, and a poll without
 * it skips before it reads anything. So what arrives meanwhile is still
 * "fresh" when the permission comes — and it can come from outside the app
 * (Android's App info switch), where no `allow()` primes the ledger. The first
 * poll that finds the permission granted after polls that did not is silent.
 */
describe('a permission granted outside the app', () => {
    const permission = Notifications.getPermissionsAsync as jest.Mock;
    const backlog = ['a', 'b', 'c', 'd', 'e'].map((id) => note(id, `Message ${id}`));

    it('does not announce the backlog that arrived while it was off', async () => {
        permission.mockResolvedValueOnce({ granted: false });
        (listNotifications as jest.Mock).mockResolvedValue(backlog);
        expect(await pollForNewNotifications()).toEqual({ announced: 0, skipped: 'no-permission' });

        // Switched on in Android's settings; the next wake has it.
        expect(await pollForNewNotifications()).toEqual({ announced: 0, skipped: 'nothing-new' });
        expect(scheduled()).toEqual([]);

        // From here on, what is new is announced.
        (listNotifications as jest.Mock).mockResolvedValue([note('f', 'Message f'), ...backlog]);
        expect(await pollForNewNotifications()).toEqual({ announced: 1 });
        expect(scheduled()).toEqual(['Message f']);
    });

    it('stays silent when a poll that wanted to catch up could not reach the server', async () => {
        permission.mockResolvedValueOnce({ granted: false });
        await pollForNewNotifications();
        (listNotifications as jest.Mock).mockRejectedValueOnce(new Error('offline'));
        await pollForNewNotifications();
        (listNotifications as jest.Mock).mockResolvedValue(backlog);
        expect(await pollForNewNotifications()).toEqual({ announced: 0, skipped: 'nothing-new' });
        expect(scheduled()).toEqual([]);
    });

    it('announces as usual once allow() has already caught up', async () => {
        permission.mockResolvedValueOnce({ granted: false });
        (listNotifications as jest.Mock).mockResolvedValue(backlog);
        await pollForNewNotifications();
        await startAnnouncing();
        (listNotifications as jest.Mock).mockResolvedValue([note('f', 'Message f'), ...backlog]);
        expect(await pollForNewNotifications()).toEqual({ announced: 1 });
        expect(scheduled()).toEqual(['Message f']);
    });
});
