/**
 * The checkbox on an action item.
 *
 * A tap PATCHes the WHOLE list back, so the edit is a spread of the item as it
 * arrived: `destination`, `source`, `id` and `aiText` are not rendered, and an
 * item rebuilt field by field would drop them from the note (see ActionItem in
 * model/types.ts for what each one costs).
 */

import type { ActionItem } from './types';

export function toggleActionItem(items: readonly ActionItem[], index: number): ActionItem[] {
    return items.map((item, i) => (i === index ? { ...item, done: !item.done } : item));
}
