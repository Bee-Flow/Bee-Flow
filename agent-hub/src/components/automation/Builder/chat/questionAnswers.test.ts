import { describe, expect, it } from 'vitest';
import { answersToText, parseAnswersText } from './questionAnswers';

describe('answersToText', () => {
    it('writes one Q and one A line per question, separated by a blank line', () => {
        expect(answersToText([{ prompt: 'Which inbox?', answer: 'Finance' }, { prompt: 'Channel?', answer: 'Email' }]))
            .toBe('Q: Which inbox?\nA: Finance\n\nQ: Channel?\nA: Email');
    });

    it('folds a newline inside a prompt or an answer, so no line can start like a list item', () => {
        expect(answersToText([{ prompt: 'Which?\n- a\n- b', answer: 'x\n1. y' }])).toBe('Q: Which? - a - b\nA: x 1. y');
    });
});

describe('parseAnswersText', () => {
    it('reads its own output back', () => {
        const list = [{ prompt: 'Which inbox?', answer: 'Finance' }, { prompt: 'Channel?', answer: 'Email' }];
        expect(parseAnswersText(answersToText(list))).toEqual(list);
    });

    it('leaves anything else alone', () => {
        expect(parseAnswersText('Q: is this a question?')).toBeNull();
        expect(parseAnswersText('Q: one\nA: two\n\nand then some words')).toBeNull();
        expect(parseAnswersText('Add a webhook trigger')).toBeNull();
        expect(parseAnswersText(undefined)).toBeNull();
    });
});
