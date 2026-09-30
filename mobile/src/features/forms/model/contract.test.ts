/**
 * The phone's one addition to the server's answer rules: a number typed with
 * a decimal comma ("1,5") is a number, checked and sent with a dot. The rest
 * of the contract is held to the server by contract.lockstep.test.ts.
 */

import { answerProblem, answersBody } from './contract';
import type { FillField } from './fillTypes';

const amount: FillField = {
    name: 'amount',
    type: 'number',
    label: 'Amount',
    required: false,
    placeholder: '',
    help: '',
    options: [],
    accept: '',
    maxSizeMb: 10,
    source: '',
    app: '',
    sourceLabel: '',
    searchHint: '',
    multiple: false,
    maxItems: 1,
    fileId: '',
    filename: '',
    mimeType: '',
    size: null,
};

describe('a number answer', () => {
    it.each(['1,5', ' 1,5 ', '-0,25', '1.5', '42'])('accepts %j', (text) => {
        expect(answerProblem(amount, text)).toBeNull();
    });

    it.each(['1.000,5', '1,2,3', 'forty'])('refuses %j', (text) => {
        expect(answerProblem(amount, text)).toBe('number');
    });

    it('sends a decimal comma as a dot, and anything else as it was typed', () => {
        expect(answersBody([amount], { amount: ' 1,5 ' })).toEqual({ amount: '1.5' });
        expect(answersBody([amount], { amount: '2.25' })).toEqual({ amount: '2.25' });
        expect(answersBody([amount], { amount: '' })).toEqual({ amount: null });
    });
});
