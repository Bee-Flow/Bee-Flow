/**
 * Toggling one action item sends the whole list back, so everything the phone
 * does not render has to survive the tap.
 */

import { toggleActionItem } from './actionItems';
import type { ActionItem } from './types';

const SENT: ActionItem = {
    id: 'ai-1',
    text: 'Send the offer',
    source: 'ai',
    segmentIndex: 0,
    aiText: 'Send the offer to Acme',
    destination: { kind: 'automation', ref: 'auto-1', label: 'CRM', at: '2026-09-01T10:00:00Z' },
};

describe('toggleActionItem', () => {
    it('flips only the tapped item', () => {
        const next = toggleActionItem([SENT, { text: 'Book a room', done: true }], 1);
        expect(next.map((item) => item.done)).toEqual([undefined, false]);
    });

    it('keeps every field the phone does not show, including ones it has no name for', () => {
        const unknown = { ...SENT, futureField: 'kept' } as ActionItem;
        const [toggled] = toggleActionItem([unknown], 0);
        expect(toggled).toEqual({ ...unknown, done: true });
    });

    it('does not mutate the list it was given', () => {
        const items = [SENT];
        toggleActionItem(items, 0);
        expect(items[0]).toBe(SENT);
        expect(SENT.done).toBeUndefined();
    });
});
