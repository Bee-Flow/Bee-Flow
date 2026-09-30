/** Which screens show a deleted conversation, and where the person goes instead. */

import { CHAT_ROUTE, DETAILS_ROUTE, deletedChatDepth, leaveDeletedChat, type StackEntry } from './deletedChat';

const chat = (id: string): StackEntry => ({ name: CHAT_ROUTE, params: { id } });
const details = (id: string): StackEntry => ({ name: DETAILS_ROUTE, params: { id } });
const DRAWER: StackEntry = { name: '(drawer)' };
const LIST: StackEntry = { name: 'chats/index' };

function fakeRouter() {
    return { dismiss: jest.fn(), replace: jest.fn() };
}

describe('deletedChatDepth', () => {
    it('counts the details screen and the chat under it', () => {
        expect(deletedChatDepth([DRAWER, LIST, chat('c1'), details('c1')], 'c1')).toBe(2);
    });

    it('counts a chat opened as /chat/new whose details are this conversation', () => {
        expect(deletedChatDepth([DRAWER, chat('new'), details('c1')], 'c1')).toBe(2);
    });

    it('stops at the first screen that is not this conversation', () => {
        expect(deletedChatDepth([DRAWER, chat('c2'), details('c1')], 'c1')).toBe(1);
        expect(deletedChatDepth([chat('c1'), LIST, chat('c1'), details('c1')], 'c1')).toBe(2);
        // A `new` chat further down is another conversation.
        expect(deletedChatDepth([DRAWER, chat('new'), chat('c1'), details('c1')], 'c1')).toBe(2);
    });

    it('is nothing for a stack that does not show it', () => {
        expect(deletedChatDepth([DRAWER, LIST], 'c1')).toBe(0);
        expect(deletedChatDepth([], 'c1')).toBe(0);
    });
});

describe('leaveDeletedChat', () => {
    it("pops only the deleted chat's screens, back to where it was opened from", () => {
        const router = fakeRouter();
        leaveDeletedChat(router, [DRAWER, LIST, chat('c1'), details('c1')], 'c1');
        expect(router.dismiss).toHaveBeenCalledWith(2);
        expect(router.replace).not.toHaveBeenCalled();
    });

    it('pops at least the screen doing the deleting', () => {
        const router = fakeRouter();
        leaveDeletedChat(router, [DRAWER, LIST], 'c1');
        expect(router.dismiss).toHaveBeenCalledWith(1);
    });

    it('lands on the Chat tab only when nothing is underneath, without keeping the deleted chat', () => {
        const router = fakeRouter();
        leaveDeletedChat(router, [chat('c1'), details('c1')], 'c1');
        expect(router.dismiss).toHaveBeenCalledWith(1);
        expect(router.replace).toHaveBeenCalledWith('/');

        const alone = fakeRouter();
        leaveDeletedChat(alone, [details('c1')], 'c1');
        expect(alone.dismiss).not.toHaveBeenCalled();
        expect(alone.replace).toHaveBeenCalledWith('/');
    });
});
