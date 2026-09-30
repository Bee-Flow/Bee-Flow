/**
 * Notification shapes, taken from the server's own table rather than guessed:
 * server/stores/notificationStore.js — the `notifications` table and
 * createNotification's argument list.
 *
 * The row is returned RAW (`SELECT *`), so it is snake_case and it carries
 * exactly these columns. There is no payload/data blob: everything the client
 * gets to route on is `category`, `task_id` and `link`.
 */

import type { IconName } from '@/shared/ui';

/**
 * The categories the store will actually persist. `createNotification`
 * whitelists them and silently downgrades anything else to 'info', so an
 * unknown value here means the server grew a category and this client has not
 * caught up — which is why every consumer treats an unknown category as 'info'
 * instead of throwing.
 */
export const NOTIFICATION_CATEGORIES = [
    'info',
    'heads_up',
    'urgent',
    'ai_task',
    'cowork',
    'learning',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface AppNotification {
    id: string;
    user_id?: string;
    /**
     * The routine / cowork run this is about. Set for `ai_task` and `cowork`,
     * null for everything else.
     */
    task_id: string | null;
    category: NotificationCategory | (string & {});
    title: string;
    /**
     * The body. For an `ai_task` or `cowork` result this is the run's ENTIRE
     * output — markdown, potentially thousands of words — not a one-line
     * summary. The list truncates; the detail view does not.
     */
    message: string;
    /**
     * An in-app path for the WEB client, e.g. `/app/studio/automations/<id>`.
     * It is not a mobile route: see route.ts for the translation, and for why
     * an untranslatable link is better shown as "open on the web" than as a
     * tap that goes nowhere.
     */
    link: string | null;
    read: boolean;
    created_at: string | null;
}

export interface NotificationListResponse {
    notifications: AppNotification[];
}

/** How a category presents itself. Ported from agent-hub's NotificationCenter. */
export interface CategoryPresentation {
    label: string;
    /** The web's glyph for the category (NotificationCenter's CATEGORY_CONFIG). */
    icon: IconName;
    tone: 'neutral' | 'accent' | 'success' | 'warning' | 'error';
}

export const CATEGORY_PRESENTATION: Record<string, CategoryPresentation> = {
    info: { label: 'Info', icon: 'Info', tone: 'accent' },
    heads_up: { label: 'Heads up', icon: 'TriangleAlert', tone: 'warning' },
    urgent: { label: 'Urgent', icon: 'CircleAlert', tone: 'error' },
    ai_task: { label: 'Routine', icon: 'Bot', tone: 'neutral' },
    // 'cowork' is its own category rather than reusing 'ai_task' because the
    // client labels ai_task "Routine" — a different feature, in a different
    // part of the app — and a cowork result announced itself under someone
    // else's name. Keep the two apart.
    cowork: { label: 'Cowork', icon: 'Handshake', tone: 'neutral' },
    learning: { label: 'Learning', icon: 'GraduationCap', tone: 'warning' },
};

export function presentationFor(category: string | null | undefined): CategoryPresentation {
    const fallback = CATEGORY_PRESENTATION.info as CategoryPresentation;
    if (!category) return fallback;
    return CATEGORY_PRESENTATION[category] ?? fallback;
}

/**
 * Categories whose `message` IS the result of a run rather than a description
 * of one. These get a "Continue in chat" action instead of a link.
 */
export const RESULT_CATEGORIES: ReadonlySet<string> = new Set(['ai_task', 'cowork']);
