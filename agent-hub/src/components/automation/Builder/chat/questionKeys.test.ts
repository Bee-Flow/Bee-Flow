import { describe, expect, it } from 'vitest';
import { questionKeyAction, type QuestionKeyContext } from './questionKeys';

const ctx = (over: Partial<QuestionKeyContext>): QuestionKeyContext => ({ key: '', shiftKey: false, modified: false, inOther: false, onButton: false, onTextarea: false, optionCount: 3, ...over });

describe('questionKeyAction', () => {
    it('digits pick an option, the digit after the last one focuses Other, anything further is ignored', () => {
        expect(questionKeyAction(ctx({ key: '2' }))).toEqual({ type: 'pick', index: 1 });
        expect(questionKeyAction(ctx({ key: '4' }))).toEqual({ type: 'focus-other' });
        expect(questionKeyAction(ctx({ key: '5' }))).toBeNull();
        expect(questionKeyAction(ctx({ key: '0' }))).toBeNull();
    });

    it('digits typed in a field are text', () => {
        expect(questionKeyAction(ctx({ key: '2', inOther: true }))).toBeNull();
        expect(questionKeyAction(ctx({ key: '2', onTextarea: true }))).toBeNull();
    });

    it('Enter is next, Shift+Enter is back, and a focused button keeps its own Enter', () => {
        expect(questionKeyAction(ctx({ key: 'Enter' }))).toEqual({ type: 'next' });
        expect(questionKeyAction(ctx({ key: 'Enter', shiftKey: true }))).toEqual({ type: 'back' });
        expect(questionKeyAction(ctx({ key: 'Enter', onButton: true }))).toBeNull();
        expect(questionKeyAction(ctx({ key: 'Enter', inOther: true }))).toEqual({ type: 'next' });
    });

    it('Escape leaves Other and does nothing elsewhere; a modifier (Alt+M) is never ours', () => {
        expect(questionKeyAction(ctx({ key: 'Escape', inOther: true }))).toEqual({ type: 'leave-other' });
        expect(questionKeyAction(ctx({ key: 'Escape' }))).toBeNull();
        expect(questionKeyAction(ctx({ key: '1', modified: true }))).toBeNull();
        expect(questionKeyAction(ctx({ key: 'Enter', modified: true }))).toBeNull();
    });
});
