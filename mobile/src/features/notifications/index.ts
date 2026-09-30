/**
 * The notifications feature's public surface. Import from
 * '@/features/notifications', never from its internals.
 */

export { notificationKeys } from './api/keys';
export { NotificationBell } from './components/NotificationBell';
export { NotificationPlumbing } from './components/NotificationPlumbing';
export { useAlertPermission, type AlertPermissionState, type AllowOutcome } from './hooks/useAlertPermission';
export { useUnreadCount } from './hooks/useUnreadCount';
export { targetForNotification, translateWebLink, type NotificationTarget } from './model/route';
export { NotificationsScreen } from './screens/NotificationsScreen';
/** The device-side preferences, edited by the settings screen. */
export {
    CATEGORY_LABELS,
    DEFAULT_NOTIFICATION_PREFS,
    loadNotificationPrefs,
    NOTIFICATION_CATEGORIES,
    POLL_INTERVALS,
    saveNotificationPrefs,
    type NotificationCategory,
    type NotificationPrefs,
} from './model/prefs';
