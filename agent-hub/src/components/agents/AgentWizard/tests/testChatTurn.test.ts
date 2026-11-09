import { describe, expect, it } from 'vitest';
import { lastCompletedTurn } from './testChatTurn';

const user = (content: string) => ({ id: 'u', role: 'user', content });
const bot = (extra: Record<string, unknown> = {}) => ({ id: 'a', role: 'assistant', content: 'The answer.', ...extra });

describe('lastCompletedTurn', () => {
    it('is null for an empty chat', () => {
        expect(lastCompletedTurn([])).toBeNull();
    });

    it('returns the question, the answer and the finished tools once each', () => {
        const turn = lastCompletedTurn([
            user(' What is the return policy? '),
            bot({ toolHistory: [
                { name: 'search_kb', status: 'done' },
                { name: 'search_kb', status: 'done' },
                { name: 'send_mail', status: 'error' },
                { name: 'calendar', status: 'running' },
            ] }),
        ]);
        expect(turn).toEqual({ question: 'What is the return policy?', answer: 'The answer.', toolsUsed: ['search_kb'] });
    });

    it('is null while the answer streams, after an error, or when it is empty', () => {
        expect(lastCompletedTurn([user('q'), bot({ isStreaming: true })])).toBeNull();
        expect(lastCompletedTurn([user('q'), bot({ isError: true })])).toBeNull();
        expect(lastCompletedTurn([user('q'), bot({ content: '  ' })])).toBeNull();
    });

    it('is null when the last message is the question or no question precedes the answer', () => {
        expect(lastCompletedTurn([user('q')])).toBeNull();
        expect(lastCompletedTurn([bot()])).toBeNull();
    });
});
