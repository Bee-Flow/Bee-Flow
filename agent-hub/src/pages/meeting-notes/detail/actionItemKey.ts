import type { MeetingActionItem } from './meetingDetailTypes';

/**
 * The handle one action item is addressed by on screen: its id, or, for an
 * item stored before the server minted ids, its position in the note's list.
 *
 * Matching on `item.id` alone made every id-less item match `undefined`, so
 * ticking or editing one of them changed all of them, and the PATCH saved it
 * that way. The position is that of `meeting.actionItems` (not of a sorted
 * copy), so the list view and the write path agree on it; the first save
 * brings back server-minted ids.
 */
export function actionItemKey(item: MeetingActionItem | null | undefined, index: number): string {
    return typeof item?.id === 'string' && item.id ? item.id : `legacy-index:${index}`;
}
