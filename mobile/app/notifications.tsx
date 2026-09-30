/**
 * The notification inbox. The screen lives in features/notifications.
 *
 * Importing the feature here is load-bearing, not incidental: its index pulls
 * in `background`, which defines the WorkManager task at module scope, and
 * expo-router eagerly requires every route file — so the task exists by the
 * time Android tries to run it.
 */

import React from 'react';

import { NotificationsScreen } from '@/features/notifications';

export default function NotificationsRoute() {
    return <NotificationsScreen />;
}
