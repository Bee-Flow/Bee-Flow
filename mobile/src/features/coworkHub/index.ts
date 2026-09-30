/**
 * The Cowork hub, opened from Studio's Workspace group: automations,
 * schedules, tasks, reminders and approvals in one urgency-ordered page. Import from '@/features/coworkHub'.
 *
 * Its own feature because it composes the others: the task list reads the
 * Cowork schedules (features/tasks/api), so a hub inside features/cowork would
 * make cowork and tasks import each other.
 */

export { CoworkHubScreen } from './screens/CoworkHubScreen';
