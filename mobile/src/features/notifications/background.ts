/**
 * Background notification polling.
 *
 * There is no Firebase in this app and there will not be one — the reasoning,
 * the trade-off and the migration path for an operator who wants true push are
 * written up in README.md next to this file. Read that first; this module is
 * the implementation of the decision, not the decision.
 *
 * The shape:
 *
 *   Android's WorkManager wakes the app on its own schedule (expo-background-task
 *   is a thin wrapper over it). The task asks the user's OWN server which
 *   notifications are unread, works out which of them this device has not
 *   announced yet, and raises a LOCAL notification for each. Nothing is sent
 *   anywhere; nothing third-party is involved.
 *
 * Three rules this file exists to enforce:
 *
 *   1. `defineTask` runs at MODULE SCOPE. WorkManager launches the app in a
 *      headless state and looks the task up by name; a task defined inside a
 *      component's effect does not exist yet at that moment and the run is
 *      dropped with a console warning nobody sees. So this module must be
 *      imported from the app's entry path — see README.md.
 *   2. The task NEVER announces something twice. The ids it has already shown
 *      are persisted, because the process does not survive between runs.
 *   3. The task fails silently and returns Success. A background task that
 *      throws is penalised by WorkManager's backoff, and "the server was
 *      unreachable at 03:12" is not a failure worth being punished for.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';


import { loadServerUrl } from '@/core/api/server';
import { ensureHydrated, translate } from '@/core/i18n';

import { listNotifications } from './api/endpoints';
import { announcementBody, moreWaiting } from './model/format';
import { loadNotificationPrefs, type NotificationPrefs } from './model/prefs';
import type { AppNotification } from './model/types';

export const NOTIFICATION_POLL_TASK = 'beeflow.notifications.poll';

/** Ids already surfaced on this device, so a poll never repeats itself. */
const SEEN_KEY = 'beeflow.notifications.announced.v1';
/** When the last poll actually ran — shown in the inbox's footer. */
const LAST_RUN_KEY = 'beeflow.notifications.lastPoll.v1';
/**
 * Set by a poll that found no permission: what arrives until the permission
 * comes belongs to the past. Cleared by the next prime of the ledger.
 */
const NEEDS_PRIME_KEY = 'beeflow.notifications.needsPrime.v1';

/**
 * How many ids to remember. Enough to cover a long gap between polls, small
 * enough that the read/write cost stays trivial.
 */
const SEEN_LIMIT = 200;

/**
 * Android's floor is 15 minutes and WorkManager treats any value as a MINIMUM,
 * not a promise — see the README on what that means for the user.
 */
export const POLL_INTERVAL_MINUTES = 15;

/**
 * The channels the local notifications land on. Created before the first one.
 *
 * Two of them, because Android freezes a channel's importance and sound the
 * moment it is created — a later `setNotificationChannelAsync` with the same id
 * silently does nothing, so the "Play a sound" switch in settings cannot be
 * honoured by editing one channel. A second, quiet channel is the platform's
 * own answer, and it has the side benefit that the user can override both from
 * Android's notification settings without the app arguing back.
 */
const CHANNEL_ID = 'beeflow-activity';
const SILENT_CHANNEL_ID = 'beeflow-activity-silent';

// ── Persistence ──────────────────────────────────────────────────────

async function loadSeen(): Promise<Set<string>> {
    try {
        const raw = await AsyncStorage.getItem(SEEN_KEY);
        if (!raw) return new Set();
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    } catch {
        return new Set();
    }
}

async function saveSeen(ids: string[]): Promise<void> {
    try {
        await AsyncStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(0, SEEN_LIMIT)));
    } catch {
        /* a lost ledger costs one duplicate notification, not a crash */
    }
}

export async function getLastPollAt(): Promise<number | null> {
    try {
        const raw = await AsyncStorage.getItem(LAST_RUN_KEY);
        const value = raw ? Number.parseInt(raw, 10) : NaN;
        return Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Treat everything currently unread as already announced.
 *
 * Called when polling is first enabled, so switching it on does not fire ten
 * notifications for things the user read on their laptop last week — and
 * whenever the permission arrives (see NEEDS_PRIME_KEY), which the ledger is
 * then current for.
 */
export async function primeAnnouncedIds(notifications: AppNotification[]): Promise<void> {
    const existing = await loadSeen();
    for (const n of notifications) existing.add(n.id);
    await saveSeen([...existing]);
    await AsyncStorage.removeItem(NEEDS_PRIME_KEY).catch(() => {});
}

async function needsPrime(): Promise<boolean> {
    try {
        return (await AsyncStorage.getItem(NEEDS_PRIME_KEY)) === '1';
    } catch {
        return false;
    }
}

/**
 * The first poll with the permission after polls without it. The permission
 * can come from anywhere — Android's App info switch included, where no
 * `startAnnouncing` runs — so the poll itself makes the grant silent: it
 * primes the ledger with what is unread and announces nothing. A failed read
 * leaves the flag, and the next poll tries again.
 */
async function catchUpAfterGrant(): Promise<PollOutcome> {
    try {
        await primeAnnouncedIds(await listNotifications({ unreadOnly: true, limit: 50 }));
    } catch {
        return { announced: 0, skipped: 'not-signed-in' };
    }
    await AsyncStorage.setItem(LAST_RUN_KEY, String(Date.now())).catch(() => {});
    return { announced: 0, skipped: 'nothing-new' };
}

// ── The channel ──────────────────────────────────────────────────────

/**
 * Android 8+ refuses to show a notification on a channel that does not exist,
 * and creating one is idempotent, so this runs before every post rather than
 * once at startup — the headless task has no startup to hook.
 */
async function ensureChannel(withSound: boolean): Promise<string> {
    const channelId = withSound ? CHANNEL_ID : SILENT_CHANNEL_ID;
    try {
        await Notifications.setNotificationChannelAsync(channelId, {
            // Android shows this name in the app's notification settings, and
            // lets an existing channel be renamed — so it follows the language.
            name: withSound
                ? translate('mobile.notifications.channel', 'Bee Flow activity')
                : translate('mobile.notifications.channel_silent', 'Bee Flow activity (silent)'),
            importance: withSound
                ? Notifications.AndroidImportance.DEFAULT
                : Notifications.AndroidImportance.LOW,
            // No CUSTOM sound either way: this is a work app, and a routine
            // finishing at 02:00 should not have its own ringtone. `null` means
            // the device's default; LOW importance is what makes the quiet
            // channel quiet.
            sound: null,
            vibrationPattern: withSound ? [0, 200] : undefined,
            lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
            showBadge: true,
        });
    } catch {
        /* channel creation failing is not worth losing the poll over */
    }
    return channelId;
}

/**
 * Is this category one the user still wants to be interrupted by?
 *
 * A category the server grows that this release has never heard of is announced
 * rather than swallowed — the same default the preference loader applies when
 * it merges a stored blob over the defaults. Silence is the worse failure: an
 * unknown category is far more likely to be a new kind of alert than a new kind
 * of noise.
 */
function wantsCategory(prefs: NotificationPrefs, category: string): boolean {
    return prefs.categories[category as keyof typeof prefs.categories] ?? true;
}

// ── The poll ─────────────────────────────────────────────────────────

export interface PollOutcome {
    /** How many local notifications were raised. */
    announced: number;
    /** Why nothing happened, when nothing happened. For the dev screen. */
    skipped?: 'no-server' | 'not-signed-in' | 'no-permission' | 'nothing-new' | 'muted';
}

/**
 * One poll. Exported so the inbox can run it on demand (pull-to-refresh does a
 * foreground fetch; this is the same code path the background wake takes,
 * which is what makes the background path testable at all).
 */
export async function pollForNewNotifications(): Promise<PollOutcome> {
    // The module cache is empty in a headless launch, so the configured server
    // has to be read back off disk before any request can build a URL.
    const server = await loadServerUrl();
    if (!server) return { announced: 0, skipped: 'no-server' };

    // Read from disk for the same reason: the settings screen wrote these and
    // this process has never seen them. Until this call existed the whole of
    // Settings → Notifications was decorative — every switch on it was stored
    // and then ignored, so a user who turned notifications off kept getting
    // them, which is the one bug in a notification system nobody forgives.
    const prefs = await loadNotificationPrefs();
    if (!prefs.enabled) return { announced: 0, skipped: 'muted' };

    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
        // Nothing is read without it, so what arrives meanwhile would be
        // "fresh" on the first poll after the grant: mark that poll to catch up.
        await AsyncStorage.setItem(NEEDS_PRIME_KEY, '1').catch(() => {});
        return { announced: 0, skipped: 'no-permission' };
    }
    if (await needsPrime()) return catchUpAfterGrant();

    let unread: AppNotification[];
    try {
        unread = await listNotifications({ unreadOnly: true, limit: 20 });
    } catch {
        // A 401 (session lapsed), an offline device, a self-hoster's server
        // that is off overnight. None of these is an error the user needs at
        // 03:00; the inbox will tell them when they next open it.
        return { announced: 0, skipped: 'not-signed-in' };
    }

    await AsyncStorage.setItem(LAST_RUN_KEY, String(Date.now())).catch(() => {});

    const seen = await loadSeen();
    const fresh = unread.filter((n) => !seen.has(n.id));
    // A switched-off category is filtered here rather than at the server: the
    // inbox still lists everything, because muting a notification is a decision
    // about being interrupted, not about being told.
    const announceable = fresh.filter((n) => wantsCategory(prefs, n.category));
    if (announceable.length === 0) {
        // Still fold the current ids in, so a notification read elsewhere and
        // later re-marked unread does not re-announce — and so that switching a
        // category back on starts with the next one rather than replaying the
        // backlog it was muted for.
        await saveSeen([...unread.map((n) => n.id), ...seen]);
        return { announced: 0, skipped: 'nothing-new' };
    }

    // A headless launch has no catalogue in memory: read the cached one, or
    // the channel names and the summary below are English whatever the
    // language.
    await ensureHydrated();
    const channelId = await ensureChannel(prefs.sound);

    // One notification each up to three, then a single summary. Nine separate
    // buzzes for one overnight batch is how an app gets its notifications
    // turned off permanently.
    const individually = announceable.slice(0, 3);
    for (const item of individually) {
        await Notifications.scheduleNotificationAsync({
            content: {
                title: item.title,
                body: announcementBody(item.message),
                // `data` comes back on the tap; the inbox is the landing place
                // either way, so this only carries what it needs to deep-link.
                data: { notificationId: item.id, link: item.link ?? null },
                autoDismiss: true,
            },
            // A channel-aware trigger means "deliver now, on this channel".
            // A plain `null` would deliver now on the DEFAULT channel and the
            // importance/vibration set above would silently not apply.
            trigger: { channelId },
        }).catch(() => {});
    }
    if (announceable.length > individually.length) {
        const rest = announceable.length - individually.length;
        await Notifications.scheduleNotificationAsync({
            content: {
                title: 'Bee Flow',
                body: moreWaiting(rest, translate),
                data: { notificationId: null, link: null },
            },
            trigger: { channelId },
        }).catch(() => {});
    }

    await saveSeen([...unread.map((n) => n.id), ...seen]);
    return { announced: announceable.length };
}

// ── Registration ─────────────────────────────────────────────────────

/**
 * Defined at module scope — see rule 1 at the top of this file. `defineTask`
 * is idempotent per name, so importing this module more than once is safe.
 */
TaskManager.defineTask(NOTIFICATION_POLL_TASK, async () => {
    try {
        await pollForNewNotifications();
    } catch {
        /* deliberately swallowed — see rule 3 */
    }
    // Always Success. Reporting Failed makes WorkManager back off, which
    // punishes the user for their server being asleep.
    return BackgroundTask.BackgroundTaskResult.Success;
});

export interface RegistrationState {
    registered: boolean;
    /** False when the OS has background work restricted for this app. */
    available: boolean;
}

export async function getPollingState(): Promise<RegistrationState> {
    const [status, registered] = await Promise.all([
        BackgroundTask.getStatusAsync(),
        TaskManager.isTaskRegisteredAsync(NOTIFICATION_POLL_TASK),
    ]);
    return {
        registered,
        available: status === BackgroundTask.BackgroundTaskStatus.Available,
    };
}

/**
 * Turn polling on. Safe to call on every app start: registering an already
 * registered task is a no-op.
 *
 * It never asks for the notification permission. Asked cold, right after
 * sign-in, the dialog comes with no reason and is refused, and after two
 * refusals Android stops showing it. The permission is asked only where the
 * screen says why (Settings → Notifications, the empty inbox: see
 * hooks/useAlertPermission), and a poll without it skips on its own
 * ('no-permission'), so registering first costs nothing.
 *
 * Returns false only when the OS will not run background work for this app —
 * a battery-saver profile, or "Restricted" background usage. That is a real
 * state the settings screen should be able to explain rather than a failure.
 */
export async function registerNotificationPolling(): Promise<boolean> {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;

    // Created up front so the channel exists in Android's settings before the
    // first notification does — a user who goes looking for the per-channel
    // controls right after switching this on should find them. The poll calls
    // this again with whatever the pref says at the time.
    await ensureHydrated();
    await ensureChannel((await loadNotificationPrefs()).sound);

    if (await TaskManager.isTaskRegisteredAsync(NOTIFICATION_POLL_TASK)) return true;

    // Everything unread right now belongs to the past. Prime the ledger before
    // the first wake so enabling this is silent.
    try {
        await primeAnnouncedIds(await listNotifications({ unreadOnly: true, limit: 50 }));
    } catch {
        /* not signed in yet — the first poll will prime nothing and announce,
           which is the correct behaviour for a genuinely new install */
    }
    // Registered before the permission: whatever arrives until it is granted
    // (possibly in Android's own settings) is caught up silently, not
    // announced as a burst — even if no poll ran without it in between.
    if (!(await Notifications.getPermissionsAsync()).granted) {
        await AsyncStorage.setItem(NEEDS_PRIME_KEY, '1').catch(() => {});
    }

    await BackgroundTask.registerTaskAsync(NOTIFICATION_POLL_TASK, {
        minimumInterval: POLL_INTERVAL_MINUTES,
    });
    return true;
}

/**
 * Android has just allowed notifications. What is unread now arrived while
 * the phone could not say so and belongs to the past, as when polling is
 * first switched on, so allowing them is silent: the next poll announces only
 * what is new from here. Polling is registered too, in case the OS had
 * refused it before. Returns what registering returns.
 */
export async function startAnnouncing(): Promise<boolean> {
    try {
        await primeAnnouncedIds(await listNotifications({ unreadOnly: true, limit: 50 }));
    } catch {
        /* offline or signed out: the first poll starts from what it finds */
    }
    return registerNotificationPolling();
}

export async function unregisterNotificationPolling(): Promise<void> {
    if (await TaskManager.isTaskRegisteredAsync(NOTIFICATION_POLL_TASK)) {
        await BackgroundTask.unregisterTaskAsync(NOTIFICATION_POLL_TASK);
    }
    try {
        await AsyncStorage.multiRemove([SEEN_KEY, LAST_RUN_KEY, NEEDS_PRIME_KEY]);
    } catch {
        /* ignore */
    }
}
