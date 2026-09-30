/**
 * The notification readers feed the background announcer as well as the
 * inbox, so a malformed row must degrade rather than throw — and a row with
 * no id is dropped, because nothing can be done with it.
 */

import { readMarkedCount, readNotifications, readUnreadCount } from './readers';

describe('readNotifications', () => {
    it('degrades a thin row to something renderable and drops id-less rows', () => {
        expect(readNotifications({ notifications: [{ id: 'n1' }, { title: 'no id' }, 'junk'] })).toEqual([
            {
                id: 'n1',
                task_id: null,
                category: 'info',
                title: 'Notification',
                message: '',
                link: null,
                read: false,
                created_at: null,
            },
        ]);
    });

    it('answers an empty list for anything that is not one', () => {
        expect(readNotifications(null)).toEqual([]);
        expect(readNotifications({ notifications: {} })).toEqual([]);
    });
});

describe('the counts', () => {
    it('reads the unread count from `count` or `unread`, including a numeric string', () => {
        expect(readUnreadCount({ count: 4 })).toBe(4);
        expect(readUnreadCount({ unread: '7' })).toBe(7);
        expect(readUnreadCount({})).toBe(0);
        expect(readUnreadCount(null)).toBe(0);
    });

    it('reads how many rows read-all changed', () => {
        expect(readMarkedCount({ success: true, marked: 3 })).toBe(3);
        expect(readMarkedCount({ success: true })).toBe(0);
    });
});
