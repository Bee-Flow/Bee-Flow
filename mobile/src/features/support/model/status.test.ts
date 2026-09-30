import { authorName, isFinished, statusCopy } from './status';

describe('statusCopy', () => {
    it('names each constrained status', () => {
        expect(statusCopy('ai_responding')).toEqual({ label: 'Bee Flow is answering', tone: 'accent' });
        expect(statusCopy('resolved')).toEqual({ label: 'Resolved', tone: 'success' });
    });

    it('humanises one it does not know, neutrally', () => {
        expect(statusCopy('on_hold')).toEqual({ label: 'On hold', tone: 'neutral' });
    });
});

describe('isFinished', () => {
    it('is true only for resolved and closed', () => {
        expect(isFinished('resolved')).toBe(true);
        expect(isFinished('closed')).toBe(true);
        expect(isFinished('open')).toBe(false);
        expect(isFinished(undefined)).toBe(false);
    });
});

describe('authorName', () => {
    it('says who answered, so nobody thanks a machine for a personal touch', () => {
        expect(authorName('ai', 'whatever')).toBe('Bee Flow');
        expect(authorName('system', null)).toBe('System');
        expect(authorName('staff', null)).toBe('Bee Flow Support');
        expect(authorName('staff', 'Mara')).toBe('Mara');
        expect(authorName('requester', undefined)).toBe('You');
    });
});
