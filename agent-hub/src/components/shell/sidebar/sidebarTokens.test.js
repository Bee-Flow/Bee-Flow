/**
 * Sidebar collapse state is stored per user as '1'/'0'. The read is an
 * allow-list: anything else (junk, a truncated write) falls back to the
 * section's default instead of silently reading as "collapsed".
 *
 * Run: cd agent-hub && npx vitest run src/components/shell/sidebar/sidebarTokens.test.js
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readExpanded, writeExpanded } from './sidebarTokens';
import scopedStorage, { setCurrentUser } from '../../../utils/scopedStorage';

beforeEach(() => {
    localStorage.clear();
    setCurrentUser('sidebar-test-user');
});
afterEach(() => {
    localStorage.clear();
    setCurrentUser(null);
});

describe('sidebar expanded state', () => {
    it('round-trips through writeExpanded/readExpanded', () => {
        writeExpanded('chats', true);
        expect(readExpanded('chats', false)).toBe(true);
        writeExpanded('chats', false);
        expect(readExpanded('chats', true)).toBe(false);
    });

    it('falls back to the section default on a value it never writes', () => {
        scopedStorage.setItem('sidebar_chats_expanded', 'maybe');
        expect(readExpanded('chats', true)).toBe(true);
        expect(readExpanded('chats', false)).toBe(false);
    });

    it('falls back to the section default when nothing is stored (or no user is active)', () => {
        expect(readExpanded('projects', true)).toBe(true);
        setCurrentUser(null);
        expect(readExpanded('projects', false)).toBe(false);
    });
});
