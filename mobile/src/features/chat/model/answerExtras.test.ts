/** The answer's view helpers: what Copy puts on the clipboard, the text drawn, and each message's neighbours. */

import { answerText, endedEarly, liveMessage, plainTextOf, producedNothing } from './answer';
import { withTurnContext } from './turnContext';
import type { ChatMessage } from './types';

describe('plainTextOf', () => {
    it('keeps the words and drops the marks', () => {
        expect(plainTextOf('## Plan\n**Bold** and `code` see [docs](https://x.nl)\n> quoted\n```js\nrun()\n```')).toBe(
            'Plan\nBold and code see docs (https://x.nl)\nquoted\nrun()',
        );
    });
});

describe('answerText', () => {
    it('drops image markdown only when the turn made images', () => {
        const content = 'Here it is ![cat](data:image/png;base64,AAA)';
        expect(answerText({ content, images: [{ mimeType: 'image/png', url: '/x.png' }] })).toBe('Here it is');
        expect(answerText({ content })).toBe(content);
    });
});

describe('liveMessage and producedNothing', () => {
    it('draws the live turn into the placeholder, leaving empty parts off', () => {
        const shown = liveMessage({ id: 'p', role: 'assistant', content: '', streaming: true }, { text: 'Hi', tools: [], thinking: '' });
        expect(shown).toMatchObject({ content: 'Hi', streaming: true });
        expect(shown.tools).toBeUndefined();
    });

    it('does not call a card-only answer interrupted', () => {
        expect(producedNothing({ text: '' })).toBe(true);
        expect(producedNothing({ text: '', files: [{ name: 'deck.pptx' }] })).toBe(false);
    });
});

describe('endedEarly', () => {
    it('is a turn the server never finished, whatever words it had by then', () => {
        expect(endedEarly({ text: 'Half an answer', error: null, completed: false })).toBe(true);
        expect(endedEarly({ text: '', error: null, completed: false })).toBe(true);
    });

    it('is a finished turn with nothing in it, as before', () => {
        expect(endedEarly({ text: '', error: null, completed: true })).toBe(true);
        expect(endedEarly({ text: 'All of it', error: null, completed: true })).toBe(false);
        expect(endedEarly({ text: '', files: [{ name: 'deck.pptx' }], error: null, completed: true })).toBe(false);
    });

    it('is never a failure: that has its own card', () => {
        expect(endedEarly({ text: 'Half', error: 'The connection to the server was lost.', completed: false })).toBe(false);
    });

    it('is never a refusal: the shield or a guardrail said no, and its notice says why', () => {
        // guardrail_violation or dlp_blocked, then `done`: no words, no error.
        const blocked = { reason: 'A guardrail stopped this response.' };
        expect(endedEarly({ text: '', error: null, completed: true, blocked })).toBe(false);
        expect(endedEarly({ text: '', error: null, completed: false, blocked })).toBe(false);
        expect(endedEarly({ text: '', error: null, completed: true, blocked: null })).toBe(true);
    });
});

describe('withTurnContext', () => {
    it("gives a changed question its answer's token map, and an answer its question", () => {
        const question: ChatMessage = {
            id: 'q',
            role: 'user',
            content: 'Mail anna@example.nl',
            privacy: { tokenizedCount: 1, dlpRedactedCount: 0, categories: [], scanWarnings: [] },
        };
        const answer: ChatMessage = { id: 'a', role: 'assistant', content: 'Done', tokenisation: { count: 1, categories: [], tokenMap: { '[email_1]': 'anna@example.nl' } } };
        const plain: ChatMessage = { id: 'p', role: 'user', content: 'Thanks' };
        const [newest, second, oldest] = withTurnContext([plain, answer, question]);
        expect(newest).toBe(plain);
        expect(second?.questionText).toBe('Mail anna@example.nl');
        expect(oldest?.turnTokenMap).toEqual({ '[email_1]': 'anna@example.nl' });
    });
});
