/**
 * Which notifications this device is allowed to raise.
 *
 * These preferences live ON THE DEVICE, not on the server, and that is a
 * decision rather than an omission. The server has no notification-preference
 * table — `notifications` (server/stores/notificationStore.js) is a log of
 * things that happened, with a three-value `category` column and nothing that
 * says who wants to be told about what. Bee Flow's client polls that log and
 * decides locally whether to raise an OS notification, so the decision belongs
 * where it is made.
 *
 * The categories are the server's own, and there are SIX of them — the list in
 * `validCategories`, server/stores/notificationStore.js:73. This file used to
 * declare its own three-value copy ('urgent' | 'heads_up' | 'info') alongside
 * the six-value one in ./types.ts, with a comment insisting there was no fourth
 * category to invent. There were three: `ai_task`, `cowork` and `learning` —
 * and between them they are most of what this app ever announces, because a
 * finished automation is the notification people actually get. So the screen
 * offered switches for the three categories nobody receives and none for the
 * three they do.
 *
 * The type now has one declaration, in ./types.ts, next to the payload it
 * describes. A category added on the server appears there, gets a label here,
 * and defaults to on.
 *
 * This file lives in the notifications feature rather than in settings because
 * background.ts reads it on every poll; the settings screen is only its editor.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { NOTIFICATION_CATEGORIES, type NotificationCategory } from './types';

export { NOTIFICATION_CATEGORIES, type NotificationCategory };

export interface NotificationPrefs {
    /** Master switch. Off means the app never schedules a local notification. */
    enabled: boolean;
    /** Per-category opt-in. Urgent defaults on; info defaults on but is the
     *  first thing people turn off, which is exactly why it is separable. */
    categories: Record<NotificationCategory, boolean>;
    /** Play a sound. Off still shows the notification silently. */
    sound: boolean;
    /**
     * How often the app checks for new notifications while it is in the
     * foreground, in seconds. Exposed because the trade-off (freshness against
     * battery) is the user's to make on a polling client.
     */
    pollSeconds: number;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
    enabled: true,
    categories: {
        urgent: true,
        heads_up: true,
        info: true,
        ai_task: true,
        cowork: true,
        learning: true,
    },
    sound: true,
    pollSeconds: 60,
};

/** The intervals worth offering. Anything under a minute is a battery bill
 *  with no perceptible benefit; anything over an hour is not a notification. */
export const POLL_INTERVALS: { seconds: number; label: string; hint: string }[] = [
    { seconds: 60, label: 'Every minute', hint: 'Most responsive. Slightly more battery.' },
    { seconds: 300, label: 'Every 5 minutes', hint: 'The balanced default for most people.' },
    { seconds: 900, label: 'Every 15 minutes', hint: 'Quiet. Good on a slow day.' },
    { seconds: 3600, label: 'Every hour', hint: 'Barely there. You will check manually.' },
];

export const CATEGORY_LABELS: Record<NotificationCategory, { label: string; description: string }> = {
    urgent: {
        label: 'Urgent',
        description: 'A run failed, or a connection needs re-authorising.',
    },
    heads_up: {
        label: 'Needs you',
        description: 'An approval is waiting, or something looked unusual.',
    },
    info: {
        label: 'Finished work',
        description: 'A task completed and its answer is ready.',
    },
    ai_task: {
        label: 'Automations',
        description: 'A scheduled automation ran and has something for you.',
    },
    cowork: {
        label: 'Cowork results',
        // Its own category: a cowork result should not announce itself under
        // the automations' name.
        description: 'A cowork run finished and its result is ready.',
    },
    learning: {
        label: 'Learning Center',
        description: 'A nudge to review something you asked to be reminded of.',
    },
};

const STORAGE_KEY = 'beeflow.notifications.prefs';

/** Read the stored preferences, falling back to the defaults on anything
 *  unreadable — a corrupt blob must not stop notifications entirely. */
export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_NOTIFICATION_PREFS;
        const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
        return {
            ...DEFAULT_NOTIFICATION_PREFS,
            ...parsed,
            // Merged rather than replaced so a category added in a later
            // release arrives switched on instead of undefined.
            categories: {
                ...DEFAULT_NOTIFICATION_PREFS.categories,
                ...(parsed.categories ?? {}),
            },
        };
    } catch {
        return DEFAULT_NOTIFICATION_PREFS;
    }
}

export async function saveNotificationPrefs(prefs: NotificationPrefs): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}
